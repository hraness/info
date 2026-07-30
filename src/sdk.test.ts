import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitHistoryIndex } from "./git.js";
import {
  openKnowledgeBase,
  packSearchContext,
} from "./sdk.js";
import type {
  SemanticSearchHit,
  SemanticSearchResult,
  SemanticSearchSession,
  SemanticSessionSearchOptions,
} from "./semantic.js";
import { recommendedEmbeddingModel } from "./semantic.js";
import { scanVault } from "./vault.js";

const update = {
  collections: 1,
  indexed: 0,
  updated: 0,
  unchanged: 3,
  removed: 0,
  needsEmbedding: 0,
} as const;

function semanticHit(
  path: string,
  title: string,
  snippet: string,
  metadata: Readonly<Record<string, string>> = {},
): SemanticSearchHit {
  return {
    path,
    title,
    score: 0.8,
    source: "hybrid",
    docid: path,
    line: 4,
    snippet,
    signals: { keyword: true, semantic: true },
    tags: ["capture"],
    metadata,
    inboundContextualCount: 0,
    outboundContextualCount: 0,
    backlinks: [],
  };
}

async function fixture(): Promise<{
  readonly temporary: string;
  readonly root: string;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-sdk-"));
  const root = join(temporary, "kb");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
  await writeFile(
    join(root, "notes", "exact.md"),
    [
      "---",
      "title: Alpha Switch",
      "tags: [capture]",
      "status: active",
      "---",
      "# Alpha Switch",
      "",
      "The exact identifier remains searchable before the local model runs.",
      "",
      "[[notes/semantic]]",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "notes", "semantic.md"),
    [
      "---",
      "title: Browser Memory",
      "tags: [capture]",
      "status: active",
      "---",
      "# Browser Memory",
      "",
      "A signed-in browser surface can preserve knowledge for later agents. 🧠",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "notes", "archived.md"),
    [
      "---",
      "title: Old Capture",
      "tags: [capture]",
      "status: archived",
      "---",
      "# Old Capture",
      "",
      "This result must be removed by the live metadata filter.",
      "",
    ].join("\n"),
    "utf8",
  );
  return { temporary, root };
}

function fakeSemanticSession(
  root: string,
  search: (options: SemanticSessionSearchOptions) => Promise<SemanticSearchResult>,
  close: () => Promise<void>,
): SemanticSearchSession {
  return {
    root,
    database: join(root, "qmd.sqlite"),
    model: recommendedEmbeddingModel,
    update,
    search,
    close,
  };
}

describe("knowledge-base session", () => {
  test("shares one scan and semantic session while fusing, filtering, and enriching", async () => {
    const { temporary, root } = await fixture();
    let scans = 0;
    let opens = 0;
    let searches = 0;
    let closes = 0;
    let gitIndexes = 0;
    const coldLaneStarts = new Set<string>();
    let releaseColdLanes: (() => void) | undefined;
    const coldLaneBarrier = new Promise<void>((resolve) => {
      releaseColdLanes = resolve;
    });
    const startColdLane = (lane: string): void => {
      coldLaneStarts.add(lane);
      if (coldLaneStarts.size === 2) releaseColdLanes?.();
    };
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          scanVault: async (requestedRoot, options) => {
            scans += 1;
            return await scanVault(requestedRoot, options);
          },
          openSemanticSearchSession: async () => {
            opens += 1;
            startColdLane("qmd");
            await coldLaneBarrier;
            return fakeSemanticSession(
              root,
              (options) => {
                searches += 1;
                const hits = [
                  semanticHit("notes/semantic.md", "Browser Memory", "Semantic browser context."),
                  semanticHit("notes/archived.md", "Old Capture", "A stale filtered candidate."),
                  semanticHit("notes/exact.md", "Alpha Switch", "Exact and semantic agree."),
                ];
                return Promise.resolve({
                  root,
                  database: join(root, "qmd.sqlite"),
                  model: recommendedEmbeddingModel,
                  mode: options.mode ?? "semantic",
                  query: options.query,
                  update,
                  embedding: null,
                  results: hits,
                });
              },
              () => {
                closes += 1;
                return Promise.resolve();
              },
            );
          },
          indexGitHistory: async (options): Promise<GitHistoryIndex> => {
            gitIndexes += 1;
            startColdLane("git");
            await coldLaneBarrier;
            return {
              status: "ready",
              repository: temporary,
              root,
              vaultPrefix: "kb",
              head: "a".repeat(40),
              scannedCommits: 1,
              notes: options.notes.map((note) => ({
                id: note.id,
                path: note.path,
                repositoryPath: `kb/${note.path}`,
                commits: [{
                  hash: "a".repeat(40),
                  committedAt: "2026-07-30T12:00:00.000Z",
                  subject: "Explain capture decisions",
                  changedPaths: [`kb/${note.path}`, "packages/browser.ts"],
                }],
              })),
            };
          },
        },
      );
      const result = await kb.search({
        query: "Alpha Switch",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["capture"],
      });
      expect(result.results.map(({ id }) => id)).toEqual([
        "notes/exact",
        "notes/semantic",
      ]);
      expect(result.results[0]).toMatchObject({
        identity: true,
        rank: 1,
        evidence: [
          { kind: "exact", identity: true },
          { kind: "qmd", source: "hybrid" },
        ],
      });
      expect(result.graph?.linksAmongResults).toContainEqual({
        source: "notes/exact.md",
        target: "notes/semantic.md",
        line: 10,
      });
      expect(result.history?.status).toBe("ready");
      if (result.history?.status === "ready") {
        expect(result.history.notes[0]?.id).toBe("notes/exact");
        expect(result.history.notes[0]?.commits[0]?.subject)
          .toBe("Explain capture decisions");
      }
      expect(result.partial).toBe(false);
      expect(result.diagnostics.lanes).toContainEqual({
        lane: "git",
        status: "ready",
        results: 2,
      });
      expect(coldLaneStarts).toEqual(new Set(["git", "qmd"]));
      const boundedRequiredHistory = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: {
          policy: "required",
          noteLimit: 1,
          commitsPerNote: 1,
          cochangedPathsPerCommit: 0,
        },
      });
      expect(boundedRequiredHistory.partial).toBe(false);
      expect(boundedRequiredHistory.history).toMatchObject({
        status: "ready",
        notes: [{
          id: "notes/exact",
          commits: [{ cochangedPaths: [] }],
        }],
      });
      expect(boundedRequiredHistory.diagnostics.lanes).toContainEqual({
        lane: "git",
        status: "ready",
        results: 1,
      });
      const semanticOnly = await kb.search({
        query: "browser memory",
        mode: "semantic",
        history: false,
        graph: false,
      });
      expect(semanticOnly.results.every(({ evidence }) =>
        evidence.every(({ kind }) => kind === "qmd"))).toBe(true);
      expect({ scans, opens, searches, gitIndexes }).toEqual({
        scans: 1,
        opens: 1,
        searches: 2,
        gitIndexes: 1,
      });
      await Promise.all([kb.close(), kb.close()]);
      expect(closes).toBe(1);
      expect(() => kb.list()).toThrow("session is closed");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("makes optional Git unavailability explicit and preserves direct history behavior", async () => {
    const { temporary, root } = await fixture();
    try {
      const kb = await openKnowledgeBase({ root });
      const automatic = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "auto",
      });
      expect(automatic.history).toMatchObject({
        status: "unavailable",
        reason: "No repository root was configured for this knowledge-base session.",
      });
      expect(automatic.partial).toBe(true);
      expect(automatic.diagnostics.lanes).toContainEqual({
        lane: "git",
        status: "unavailable",
        results: 0,
        message: "No repository root was configured for this knowledge-base session.",
      });

      const requested = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: { noteLimit: 1 },
      });
      expect(requested.partial).toBe(true);
      expect(requested.diagnostics.lanes.some(({ lane, status }) =>
        lane === "git" && status === "unavailable")).toBe(true);

      const disabled = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: false,
      });
      expect(disabled.history).toBeNull();
      expect(disabled.partial).toBe(false);
      expect(disabled.diagnostics.lanes.some(({ lane }) => lane === "git")).toBe(false);

      expect(await kb.history(["notes/exact"])).toMatchObject({
        status: "unavailable",
        reason: "No repository root was configured for this knowledge-base session.",
      });
      expect(await kb.searchHistory({ query: "capture" })).toMatchObject({
        status: "unavailable",
        reason: "No repository root was configured for this knowledge-base session.",
      });
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "required",
      })).rejects.toThrow(
        "Required Git history is unavailable: No repository root was configured",
      );
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("degrades optional Git index errors but rejects both required forms", async () => {
    const { temporary, root } = await fixture();
    let indexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          indexGitHistory: () => {
            indexes += 1;
            return Promise.reject(new Error("history index exploded"));
          },
        },
      );
      const automatic = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "auto",
      });
      expect(automatic.history).toMatchObject({
        status: "unavailable",
        reason: "history index exploded",
      });
      expect(automatic.partial).toBe(true);
      expect(automatic.diagnostics.lanes).toContainEqual({
        lane: "git",
        status: "unavailable",
        results: 0,
        message: "history index exploded",
      });
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "required",
      })).rejects.toThrow("history index exploded");
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: {
          policy: "required",
          noteLimit: 1,
          commitsPerNote: 1,
        },
      })).rejects.toThrow("history index exploded");
      expect(kb.history(["notes/exact"])).rejects.toThrow("history index exploded");
      expect(kb.searchHistory({ query: "capture" })).rejects.toThrow(
        "history index exploded",
      );
      expect(indexes).toBe(1);
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects malformed and unbounded search history policies before retrieval", async () => {
    const { temporary, root } = await fixture();
    try {
      const kb = await openKnowledgeBase({ root });
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        history: { policy: "sometimes" as never },
      })).rejects.toThrow('Search history policy must be "auto" or "required"');
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        history: true as never,
      })).rejects.toThrow('Search history must be false, "auto", "required"');
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        history: { noteLimit: 21 },
      })).rejects.toThrow("Git history note limit must be an integer from 1 through 20");
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("returns live exact evidence when QMD is unavailable", async () => {
    const { temporary, root } = await fixture();
    try {
      const kb = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => Promise.reject(new Error("model unavailable")),
        },
      );
      const result = await kb.search({
        query: "exact identifier",
        graph: false,
        history: false,
      });
      expect(result.partial).toBe(true);
      expect(result.results[0]?.id).toBe("notes/exact");
      expect(result.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "unavailable",
        results: 0,
        message: "model unavailable",
      });
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("preserves explicit candidate work bounds in every primary mode", async () => {
    const { temporary, root } = await fixture();
    const seen: SemanticSessionSearchOptions[] = [];
    try {
      const kb = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => Promise.resolve(fakeSemanticSession(
            root,
            (options) => {
              seen.push(options);
              return Promise.resolve({
                root,
                database: join(root, "qmd.sqlite"),
                model: recommendedEmbeddingModel,
                mode: options.mode ?? "semantic",
                query: options.query,
                update,
                embedding: null,
                results: [],
              });
            },
            () => Promise.resolve(),
          )),
        },
      );
      for (const mode of ["hybrid", "keyword", "semantic"] as const) {
        await kb.search({
          query: "Alpha Switch",
          mode,
          filters: [{ kind: "equals", path: "status", value: "active" }],
          limit: 1,
          candidateLimit: 1,
          minScore: 0.2,
          graph: false,
          history: false,
        });
      }
      await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        limit: 1,
        candidateLimit: 1,
        graph: false,
        history: false,
      });
      expect(seen.map(({ mode, limit, candidateLimit, minScore }) => ({
        mode,
        limit,
        candidateLimit,
        minScore,
      }))).toEqual([
        { mode: "hybrid", limit: 1, candidateLimit: 1, minScore: 0.2 },
        { mode: "keyword", limit: 1, candidateLimit: 1, minScore: 0.2 },
        { mode: "semantic", limit: 1, candidateLimit: 1, minScore: 0.2 },
      ]);
      expect(kb.search({
        query: "Alpha Switch",
        mode: "invalid" as never,
        history: false,
      })).rejects.toThrow("Knowledge-base search mode must be");
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        minScore: 0.2,
        history: false,
      })).rejects.toThrow("applies only to hybrid, keyword, or semantic");
      expect(seen).toHaveLength(3);
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("marks retained embedding failures as degraded QMD evidence", async () => {
    const { temporary, root } = await fixture();
    try {
      const kb = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => Promise.resolve(fakeSemanticSession(
            root,
            (options) => Promise.resolve({
              root,
              database: join(root, "qmd.sqlite"),
              model: recommendedEmbeddingModel,
              mode: options.mode ?? "semantic",
              query: options.query,
              update: { ...update, needsEmbedding: 1 },
              embedding: {
                docsProcessed: 1,
                chunksEmbedded: 0,
                errors: 1,
                failures: [{
                  path: "notes/semantic.md",
                  hash: "abc",
                  seq: 0,
                  attempts: 1,
                  reason: "model failure",
                }],
                durationMs: 1,
              },
              results: [semanticHit(
                "notes/semantic.md",
                "Browser Memory",
                "Verified lexical evidence remains usable.",
              )],
            }),
            () => Promise.resolve(),
          )),
        },
      );
      const result = await kb.search({
        query: "browser memory",
        graph: false,
        history: false,
      });
      expect(result.results[0]?.id).toBe("notes/semantic");
      expect(result.partial).toBe(true);
      expect(result.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "degraded",
        results: 1,
        message: "QMD embedding reported 1 error(s) and 1 retained failure record(s).",
      });
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps primary results when optional graph context exceeds its work budget", async () => {
    const { temporary, root } = await fixture();
    try {
      const snapshot = await scanVault(root, { mentionScope: false });
      const repeated = Array.from({ length: 100_001 }, () => ({
        source: "notes/exact.md",
        target: "notes/semantic.md",
        line: 1,
      }));
      const kb = await openKnowledgeBase(
        { root },
        {
          scanVault: () => Promise.resolve({
            ...snapshot,
            analysis: { ...snapshot.analysis, contextualLinks: repeated },
          }),
        },
      );
      const result = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        history: false,
      });
      expect(result.results[0]?.id).toBe("notes/exact");
      expect(result.graph).toBeNull();
      expect(result.partial).toBe(true);
      expect(result.diagnostics.lanes.some(({ lane, status }) =>
        lane === "graph" && status === "unavailable")).toBe(true);
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: { depth: 3 },
        history: false,
      })).rejects.toThrow("Graph context depth");
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("shares one awaitable close and propagates a store close failure", async () => {
    const { temporary, root } = await fixture();
    let releaseClose: (() => void) | undefined;
    const deferredClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    try {
      const kb = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => Promise.resolve(fakeSemanticSession(
            root,
            (options) => Promise.resolve({
              root,
              database: join(root, "qmd.sqlite"),
              model: recommendedEmbeddingModel,
              mode: options.mode ?? "semantic",
              query: options.query,
              update,
              embedding: null,
              results: [],
            }),
            () => deferredClose,
          )),
        },
      );
      await kb.search({ query: "memory", mode: "semantic", graph: false, history: false });
      const first = kb.close();
      const second = kb.close();
      expect(second).toBe(first);
      let settled = false;
      void second.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      releaseClose?.();
      await Promise.all([first, second]);
      expect(settled).toBe(true);

      const rejecting = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => Promise.resolve(fakeSemanticSession(
            root,
            (options) => Promise.resolve({
              root,
              database: join(root, "qmd.sqlite"),
              model: recommendedEmbeddingModel,
              mode: options.mode ?? "semantic",
              query: options.query,
              update,
              embedding: null,
              results: [],
            }),
            () => Promise.reject(new Error("close failed")),
          )),
        },
      );
      await rejecting.search({
        query: "memory",
        mode: "semantic",
        graph: false,
        history: false,
      });
      expect(rejecting.close()).rejects.toThrow("close failed");
      expect(rejecting.close()).rejects.toThrow("close failed");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps structural navigation, metadata listing, reads, and packing bounded", async () => {
    const { temporary, root } = await fixture();
    try {
      const kb = await openKnowledgeBase({ root });
      expect(kb.list({ tags: ["capture"] })).toHaveLength(3);
      expect(kb.links("notes/exact").nodes.map(({ id }) => id)).toContain("notes/semantic");
      expect(kb.backlinks("notes/semantic").nodes.map(({ id }) => id)).toContain("notes/exact");
      const read = kb.read("notes/semantic", { maxBytes: 20 });
      expect(read.truncated).toBe(true);
      expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(20);
      expect(read.content).not.toContain("�");

      const exact = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        history: false,
      });
      const packed = packSearchContext(exact, { maxBytes: 180 });
      expect(Buffer.byteLength(packed.content)).toBeLessThanOrEqual(180);
      expect(packed.content).toContain("Knowledge-base context");
      expect(packed.truncated).toBe(true);
      expect(kb.search({
        query: "context",
        mode: "exact",
        graph: { related: ["a", "b", "c", "d", "e", "f"] },
        history: false,
      })).rejects.toThrow("at most 5 explicit");
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
