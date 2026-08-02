import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_GIT_HISTORY_NOTES,
  MAX_GIT_NOTE_ID_UTF8_BYTES,
  type GitHistoryIndex,
} from "./git.js";
import { MAX_QUERY_FILTERS } from "./query.js";
import {
  MAX_SEARCH_RELATED_SEEDS,
  openKnowledgeBase,
  packSearchContext,
} from "./sdk.js";
import {
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_TERMS,
} from "./search.js";
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
      "repository_scopes: [packages/kb]",
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
      "repository_scopes: [packages/KB]",
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
      "repository_scopes: [packages/kb]",
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
    const embeddingModelFile = join(temporary, "verified-model.gguf");
    let scans = 0;
    let opens = 0;
    let searches = 0;
    let closes = 0;
    let gitIndexes = 0;
    const coldLaneStarts: string[] = [];
    const startColdLane = (lane: string): void => {
      coldLaneStarts.push(lane);
    };
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary, embeddingModelFile },
        {
          scanVault: async (requestedRoot, options) => {
            scans += 1;
            return await scanVault(requestedRoot, options);
          },
          openSemanticSearchSession: (options) => {
            opens += 1;
            expect(options.embeddingModelFile).toBe(embeddingModelFile);
            startColdLane("qmd");
            return Promise.resolve(fakeSemanticSession(
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
            ));
          },
          indexGitHistory: (options): Promise<GitHistoryIndex> => {
            gitIndexes += 1;
            startColdLane("git");
            return Promise.resolve({
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
            });
          },
        },
      );
      const result = await kb.search({
        query: "Alpha Switch",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["capture"],
        history: "auto",
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
        line: 11,
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
      expect(coldLaneStarts).toEqual(["qmd", "git"]);
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

  test("applies exact repository scopes consistently to list, exact, and QMD lanes", async () => {
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
                results: [
                  semanticHit("notes/semantic.md", "Browser Memory", "Wrong case scope."),
                  semanticHit("notes/exact.md", "Alpha Switch", "Exact scope."),
                ],
              });
            },
            () => Promise.resolve(),
          )),
        },
      );
      expect(kb.list({ repositoryScopes: ["packages/kb"] }).map(({ id }) => id))
        .toEqual(["notes/archived", "notes/exact"]);
      const result = await kb.search({
        query: "Alpha Switch",
        repositoryScopes: ["packages/kb"],
        graph: false,
        history: false,
      });
      expect(result.results.map(({ id }) => id)).toEqual(["notes/exact"]);
      expect(seen).toHaveLength(1);
      expect(kb.search({
        query: "Alpha Switch",
        repositoryScopes: ["packages//kb"],
        graph: false,
        history: false,
      })).rejects.toThrow("exact NFC-normalized POSIX form");
      await kb.close();
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

  test("localizes incomplete Git detail across automatic and required history policies", async () => {
    const { temporary, root } = await fixture();
    let indexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          indexGitHistory: (options): Promise<GitHistoryIndex> => {
            indexes += 1;
            const limitedHash = "c".repeat(40);
            const head = "e".repeat(40);
            return Promise.resolve({
              status: "ready",
              repository: temporary,
              root,
              vaultPrefix: "kb",
              head,
              scannedCommits: 2,
              notes: options.notes.map((note) => ({
                id: note.id,
                path: note.path,
                repositoryPath: `kb/${note.path}`,
                commits: note.id === "notes/exact"
                  ? [
                      {
                        hash: head,
                        committedAt: "2026-07-30T13:00:00.000Z",
                        subject: "Normal note update",
                        changedPaths: [`kb/${note.path}`],
                      },
                      {
                        hash: limitedHash,
                        committedAt: "2026-07-30T12:00:00.000Z",
                        subject: "Large repository rename",
                        changedPaths: [`kb/${note.path}`],
                        changedPathDetailsLimited: true,
                      },
                    ]
                  : [{
                      hash: "d".repeat(40),
                      committedAt: "2026-07-30T13:00:00.000Z",
                      subject: "Normal note update",
                      changedPaths: [`kb/${note.path}`],
                    }],
              })),
              limitedCommits: [{
                hash: limitedHash,
                committedAt: "2026-07-30T12:00:00.000Z",
                subject: "Large repository rename",
                reason: "changed-path-limit",
                pathLimit: 2_000,
                observedPathRecords: 3_142,
                affectedNoteIds: ["notes/exact"],
              }],
            });
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
        status: "ready",
        notes: [{
          id: "notes/exact",
          commits: [
            { subject: "Normal note update" },
            { subject: "Large repository rename", cochangeDetailsLimited: true },
          ],
        }],
        limitedCommits: [{ hash: "c".repeat(40), observedPathRecords: 3_142 }],
      });
      expect(automatic.partial).toBe(true);
      expect(automatic.diagnostics.lanes).toContainEqual({
        lane: "git",
        status: "degraded",
        results: 1,
        message: "1 Git commit exceeded the 2,000 changed-path detail limit; co-change evidence is incomplete.",
      });
      expect(packSearchContext(automatic, { maxBytes: 4_000 }).content).toContain(
        "> Partial: 1 Git commit exceeded the 2,000 changed-path detail limit",
      );

      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "required",
      })).rejects.toThrow("Required Git history is incomplete");
      const boundedRequired = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: { policy: "required", noteLimit: 1, commitsPerNote: 1 },
      });
      expect(boundedRequired.partial).toBe(false);
      expect(boundedRequired.history).not.toHaveProperty("limitedCommits");
      expect(kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: { policy: "required", noteLimit: 1, commitsPerNote: 2 },
      })).rejects.toThrow("Required Git history is incomplete");

      const unaffected = await kb.search({
        query: "Browser Memory",
        mode: "exact",
        graph: false,
        history: "required",
      });
      expect(unaffected.partial).toBe(false);
      expect(unaffected.history).toMatchObject({ status: "ready" });
      expect(unaffected.history).not.toHaveProperty("limitedCommits");
      expect(await kb.history(["notes/exact"])).toMatchObject({
        status: "ready",
        limitedCommits: [{ hash: "c".repeat(40) }],
      });
      expect(await kb.history(["notes/semantic"])).not.toHaveProperty("limitedCommits");
      expect(indexes).toBe(1);
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
    let semanticOpens = 0;
    let gitIndexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          openSemanticSearchSession: () => {
            semanticOpens += 1;
            return Promise.reject(new Error("must not open"));
          },
          indexGitHistory: () => {
            gitIndexes += 1;
            return Promise.reject(new Error("must not index"));
          },
        },
      );
      const invalid = [
        [{ policy: "sometimes" as never }, 'Search history policy must be "auto" or "required"'],
        [true as never, 'Search history must be false, "auto", "required"'],
        [{ noteLimit: 21 }, "Git history note limit must be an integer from 1 through 20"],
        [{ commitsPerNote: 0 }, "Per-note commit limit must be an integer from 1 through 50"],
        [{ commitsPerNote: 51 }, "Per-note commit limit must be an integer from 1 through 50"],
        [{ cochangedPathsPerCommit: -1 }, "Cochanged-path limit must be an integer from 0 through 100"],
        [{ cochangedPathsPerCommit: 101 }, "Cochanged-path limit must be an integer from 0 through 100"],
      ] as const;
      for (const [history, message] of invalid) {
        expect(kb.search({
          query: "Alpha Switch",
          history,
        })).rejects.toThrow(message);
      }
      expect({ semanticOpens, gitIndexes }).toEqual({ semanticOpens: 0, gitIndexes: 0 });
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects invalid direct Git requests before indexing", async () => {
    const { temporary, root } = await fixture();
    let gitIndexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          indexGitHistory: () => {
            gitIndexes += 1;
            return Promise.reject(new Error("must not index"));
          },
        },
      );
      expect(kb.history(
        Array.from({ length: MAX_GIT_HISTORY_NOTES + 1 }, () => "duplicate"),
      )).rejects.toThrow(`At most ${MAX_GIT_HISTORY_NOTES} note IDs`);
      expect(kb.history([
        "x".repeat(MAX_GIT_NOTE_ID_UTF8_BYTES + 1),
      ])).rejects.toThrow(
        `${MAX_GIT_NOTE_ID_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`,
      );
      expect(kb.history(
        ["notes/exact"],
        { commitsPerNote: 0 },
      )).rejects.toThrow("Per-note commit limit must be an integer from 1 through 50");
      expect(kb.searchHistory({ query: "\n" })).rejects.toThrow("one to 500 characters");
      expect(kb.searchHistory({
        query: "memory",
        allowedNoteIds: Array.from(
          { length: MAX_GIT_HISTORY_NOTES + 1 },
          () => "duplicate",
        ),
      })).rejects.toThrow(`at most ${MAX_GIT_HISTORY_NOTES} allowed note IDs`);
      expect(kb.searchHistory({
        query: "memory",
        limit: 101,
      })).rejects.toThrow("Git search limit must be an integer from 1 through 100");
      expect(kb.searchHistory({
        query: "memory",
        commitsPerHit: 51,
      })).rejects.toThrow("Per-note commit limit must be an integer from 1 through 50");
      expect(kb.searchHistory({
        query: "memory",
        cochangedPathsPerCommit: 101,
      })).rejects.toThrow("Cochanged-path limit must be an integer from 0 through 100");
      expect(gitIndexes).toBe(0);
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("uses validated Git snapshots after asynchronous indexing", async () => {
    const { temporary, root } = await fixture();
    let releaseIndex: ((index: GitHistoryIndex) => void) | undefined;
    const pendingIndex = new Promise<GitHistoryIndex>((resolve) => {
      releaseIndex = resolve;
    });
    let indexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          indexGitHistory: () => {
            indexes += 1;
            return pendingIndex;
          },
        },
      );
      const noteIds = ["notes/exact"];
      const historyOptions = { commitsPerNote: 1 };
      const allowedNoteIds = ["notes/exact"];
      const searchOptions = {
        query: "capture",
        allowedNoteIds,
        limit: 1,
      };
      const history = kb.history(noteIds, historyOptions);
      const search = kb.searchHistory(searchOptions);
      expect(indexes).toBe(1);

      noteIds[0] = "notes/missing";
      historyOptions.commitsPerNote = 0;
      searchOptions.query = "\n";
      allowedNoteIds[0] = "notes/missing";
      releaseIndex?.({
        status: "ready",
        repository: temporary,
        root,
        vaultPrefix: "kb",
        head: "a".repeat(40),
        scannedCommits: 1,
        notes: [{
          id: "notes/exact",
          path: "notes/exact.md",
          repositoryPath: "kb/notes/exact.md",
          commits: [{
            hash: "a".repeat(40),
            committedAt: "2026-07-31T00:00:00.000Z",
            subject: "Preserve capture evidence",
            changedPaths: ["kb/notes/exact.md"],
          }],
        }],
      });

      expect(await history).toMatchObject({
        status: "ready",
        notes: [{ id: "notes/exact", commits: [{ subject: "Preserve capture evidence" }] }],
      });
      expect(await search).toMatchObject({
        status: "ready",
        query: "capture",
        hits: [{ id: "notes/exact" }],
      });
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

  test("overfetches selective QMD searches and exposes an exhausted candidate window", async () => {
    const { temporary, root } = await fixture();
    let opens = 0;
    const notePaths = Array.from({ length: 101 }, (_, index) =>
      `notes/filter-${String(index).padStart(3, "0")}.md`);
    try {
      await Promise.all(notePaths.map((path, index) => writeFile(
        join(root, path),
        [
          "---",
          "tags: [selective]",
          `status: ${index === 100 ? "active" : "archived"}`,
          "---",
          `# Filter ${index}`,
          "",
          `Candidate ${index} remains available to QMD.`,
          "",
        ].join("\n"),
        "utf8",
      )));
      const hits = notePaths.map((path, index) =>
        semanticHit(path, `Filter ${index}`, `Semantic candidate ${index}.`));
      const seen: SemanticSessionSearchOptions[] = [];
      const kb = await openKnowledgeBase(
        { root },
        {
          openSemanticSearchSession: () => {
            opens += 1;
            return Promise.resolve(fakeSemanticSession(
              root,
              (options) => {
                seen.push(options);
                const ranked = options.query === "all eligible recovered"
                  ? [hits[100]!, ...hits.slice(0, 99)]
                  : hits;
                const staleRawWindow = options.query === "stale raw window";
                const exhaustedRawWindow = options.query === "deduped exhausted window";
                const validUnderfilledWindow = options.query === "valid underfilled window";
                const rawLimit = options.limit ?? 10;
                return Promise.resolve({
                  root,
                  database: join(root, "qmd.sqlite"),
                  model: recommendedEmbeddingModel,
                  mode: options.mode ?? "semantic",
                  query: options.query,
                  update,
                  embedding: null,
                  ...(staleRawWindow || exhaustedRawWindow || validUnderfilledWindow
                    ? {
                        rawWindow: {
                          requested: rawLimit,
                          returned: staleRawWindow ? rawLimit : 1,
                          discarded: validUnderfilledWindow ? 0 : staleRawWindow ? rawLimit : 1,
                          thresholdRejected: 0,
                          exhausted: !staleRawWindow,
                        },
                      }
                    : {}),
                  results: staleRawWindow || exhaustedRawWindow
                    ? []
                    : validUnderfilledWindow
                      ? [hits[100]!]
                      : ranked.slice(0, rawLimit),
                });
              },
              () => Promise.resolve(),
            ));
          },
        },
      );

      const noEligible = await kb.search({
        query: "nothing eligible",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "missing" }],
        tags: ["selective"],
        graph: false,
      });
      expect(opens).toBe(0);
      expect(noEligible.partial).toBe(false);
      expect(noEligible.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "ready",
        results: 0,
      });

      const recovered = await kb.search({
        query: "rank 101",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["selective"],
        limit: 1,
        graph: false,
      });
      expect(recovered.results.map(({ id }) => id)).toEqual(["notes/filter-100"]);
      expect(recovered.partial).toBe(false);
      expect(seen[0]).toMatchObject({ limit: 500, candidateLimit: 500 });

      const exhausted = await kb.search({
        query: "rank 101",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["selective"],
        limit: 1,
        candidateLimit: 100,
        graph: false,
      });
      expect(exhausted.results).toEqual([]);
      expect(exhausted.partial).toBe(true);
      expect(exhausted.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "degraded",
        results: 0,
        message: "QMD's bounded 100-candidate retrieval discarded 100 row(s) during live reconciliation or metadata filtering and accepted 0 of 1 eligible requested result(s); this bounded reconciliation cannot certify a complete eligible result set.",
      });

      const staleRawWindow = await kb.search({
        query: "stale raw window",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["selective"],
        limit: 1,
        candidateLimit: 100,
        graph: false,
      });
      expect(staleRawWindow.results).toEqual([]);
      expect(staleRawWindow.partial).toBe(true);
      expect(staleRawWindow.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "degraded",
        results: 0,
        message: "QMD's bounded 100-candidate retrieval discarded 100 row(s) during live reconciliation or metadata filtering and accepted 0 of 1 eligible requested result(s); this bounded reconciliation cannot certify a complete eligible result set.",
      });

      const dedupedExhaustedWindow = await kb.search({
        query: "deduped exhausted window",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["selective"],
        limit: 1,
        candidateLimit: 100,
        graph: false,
      });
      expect(dedupedExhaustedWindow.results).toEqual([]);
      expect(dedupedExhaustedWindow.partial).toBe(true);
      expect(dedupedExhaustedWindow.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "degraded",
        results: 0,
        message: "QMD's bounded 100-candidate retrieval discarded 1 row(s) during live reconciliation or metadata filtering and accepted 0 of 1 eligible requested result(s); this bounded reconciliation cannot certify a complete eligible result set.",
      });

      const validUnderfilledWindow = await kb.search({
        query: "valid underfilled window",
        mode: "semantic",
        limit: 10,
        candidateLimit: 100,
        graph: false,
      });
      expect(validUnderfilledWindow.results.map(({ id }) => id))
        .toEqual(["notes/filter-100"]);
      expect(validUnderfilledWindow.partial).toBe(false);
      expect(validUnderfilledWindow.diagnostics.lanes).toContainEqual({
        lane: "qmd",
        status: "ready",
        results: 1,
      });

      const allEligibleRecovered = await kb.search({
        query: "all eligible recovered",
        mode: "semantic",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["selective"],
        limit: 10,
        candidateLimit: 100,
        graph: false,
      });
      expect(allEligibleRecovered.results.map(({ id }) => id))
        .toEqual(["notes/filter-100"]);
      expect(allEligibleRecovered.partial).toBe(false);
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("uses neutral fusion without crowding QMD rank one out of the default slate", async () => {
    const { temporary, root } = await fixture();
    try {
      const exactPaths = Array.from({ length: 10 }, (_, index) =>
        `notes/fusion-${String(index).padStart(2, "0")}.md`);
      await Promise.all([
        ...exactPaths.map((path, index) => writeFile(
          join(root, path),
          `# Fusion ${index}\n\nShared retrieval phrase.\n`,
          "utf8",
        )),
        writeFile(
          join(root, "notes", "zz-semantic.md"),
          "# Semantic only\n\nMeaning without the literal words.\n",
          "utf8",
        ),
      ]);
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
              results: [
                semanticHit("notes/zz-semantic.md", "Semantic only", "Semantic rank one."),
                semanticHit(exactPaths[9]!, "Fusion 9", "Both lanes agree."),
              ],
            }),
            () => Promise.resolve(),
          )),
        },
      );
      const result = await kb.search({
        query: "shared retrieval phrase",
        graph: false,
      });
      expect(result.results).toHaveLength(10);
      expect(result.results[0]?.id).toBe("notes/fusion-09");
      expect(result.results.find(({ id }) => id === "notes/fusion-09")?.evidence)
        .toHaveLength(2);
      expect(result.results.find(({ id }) => id === "notes/zz-semantic")?.evidence)
        .toEqual([expect.objectContaining({ kind: "qmd", rank: 1 })]);
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects bounded query violations before semantic or Git work", async () => {
    const { temporary, root } = await fixture();
    let semanticOpens = 0;
    let gitIndexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          openSemanticSearchSession: () => {
            semanticOpens += 1;
            return Promise.reject(new Error("must not open"));
          },
          indexGitHistory: () => {
            gitIndexes += 1;
            return Promise.reject(new Error("must not index"));
          },
        },
      );
      expect(kb.search({
        query: "🧠".repeat(Math.floor(MAX_SEARCH_QUERY_BYTES / 4) + 1),
        history: "required",
      })).rejects.toThrow("UTF-8 bytes");
      expect(kb.search({
        query: Array.from(
          { length: MAX_SEARCH_QUERY_TERMS + 1 },
          (_, index) => `term${index}`,
        ).join(" "),
        history: "required",
      })).rejects.toThrow("unique normalized terms");
      const filters = Array.from(
        { length: MAX_QUERY_FILTERS + 1 },
        () => ({ kind: "exists", path: "status" }) as const,
      );
      expect(() => kb.list({ filters })).toThrow(`at most ${MAX_QUERY_FILTERS} entries`);
      expect(kb.search({
        query: "Alpha Switch",
        filters,
        history: "required",
      })).rejects.toThrow(`at most ${MAX_QUERY_FILTERS} entries`);
      expect(kb.search({
        query: "Alpha Switch",
        graph: {
          related: Array.from(
            { length: MAX_SEARCH_RELATED_SEEDS + 1 },
            () => "notes/exact",
          ),
        },
        history: "required",
      })).rejects.toThrow(`at most ${MAX_SEARCH_RELATED_SEEDS} explicit related-note seeds`);
      expect(kb.search({
        query: "Alpha Switch",
        graph: { depth: 3 },
        history: "required",
      })).rejects.toThrow("Graph context depth");
      expect(kb.search({
        query: "Alpha Switch",
        graph: { related: ["notes/missing"] },
        history: "required",
      })).rejects.toThrow('Graph context seed "notes/missing" was not found');
      expect({ semanticOpens, gitIndexes }).toEqual({ semanticOpens: 0, gitIndexes: 0 });
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("uses validated search option snapshots after QMD opens", async () => {
    const { temporary, root } = await fixture();
    let releaseSemantic: ((session: SemanticSearchSession) => void) | undefined;
    const pendingSemantic = new Promise<SemanticSearchSession>((resolve) => {
      releaseSemantic = resolve;
    });
    const seen: SemanticSessionSearchOptions[] = [];
    try {
      const kb = await openKnowledgeBase(
        { root },
        { openSemanticSearchSession: () => pendingSemantic },
      );
      const related = ["notes/exact"];
      const graph = { related, depth: 1, neighborsPerSeed: 3, limit: 20 };
      const options = {
        query: "browser memory",
        mode: "semantic" as const,
        minScore: 0.25,
        graph,
        history: false as const,
      };
      const result = kb.search(options);

      options.minScore = 2;
      graph.depth = 3;
      graph.neighborsPerSeed = 21;
      graph.limit = 101;
      related[0] = "notes/missing";
      releaseSemantic?.(fakeSemanticSession(
        root,
        (searchOptions) => {
          seen.push(searchOptions);
          return Promise.resolve({
            root,
            database: join(root, "qmd.sqlite"),
            model: recommendedEmbeddingModel,
            mode: searchOptions.mode ?? "semantic",
            query: searchOptions.query,
            update,
            embedding: null,
            results: [semanticHit(
              "notes/semantic.md",
              "Browser Memory",
              "The live semantic result remains available.",
            )],
          });
        },
        () => Promise.resolve(),
      ));

      const settled = await result;
      expect(seen).toHaveLength(1);
      expect(seen[0]?.minScore).toBe(0.25);
      expect(settled.results[0]?.id).toBe("notes/semantic");
      expect(settled.graph).not.toBeNull();
      expect(settled.diagnostics.lanes).toContainEqual({
        lane: "graph",
        status: "ready",
        results: settled.graph?.related.length ?? 0,
      });
      await kb.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps search history opt-in and avoids indexing when no primary result exists", async () => {
    const { temporary, root } = await fixture();
    let indexes = 0;
    try {
      const kb = await openKnowledgeBase(
        { root, repository: temporary },
        {
          indexGitHistory: (options): Promise<GitHistoryIndex> => {
            indexes += 1;
            return Promise.resolve({
              status: "ready",
              repository: temporary,
              root,
              vaultPrefix: "kb",
              head: "a".repeat(40),
              scannedCommits: 0,
              notes: options.notes.map((note) => ({
                id: note.id,
                path: note.path,
                repositoryPath: `kb/${note.path}`,
                commits: [],
              })),
            });
          },
        },
      );
      const omitted = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
      });
      expect(omitted.history).toBeNull();
      expect(indexes).toBe(0);

      const emptyRequired = await kb.search({
        query: "definitely absent unique phrase",
        mode: "exact",
        graph: false,
        history: "required",
      });
      expect(emptyRequired.results).toEqual([]);
      expect(emptyRequired.history).toBeNull();
      expect(emptyRequired.partial).toBe(false);
      expect(indexes).toBe(0);

      const explicit = await kb.search({
        query: "Alpha Switch",
        mode: "exact",
        graph: false,
        history: "auto",
      });
      expect(explicit.history).toMatchObject({ status: "ready" });
      expect(indexes).toBe(1);
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

      const first = exact.results[0];
      expect(first).toBeDefined();
      let unreadTitleReads = 0;
      let graphReads = 0;
      let historyReads = 0;
      const lazyResult = {
        ...exact,
        results: [
          { ...first!, snippet: "🧠".repeat(1_000) },
          {
            ...first!,
            get title() {
              unreadTitleReads += 1;
              return "Must remain unread";
            },
          },
        ],
        get graph() {
          graphReads += 1;
          return exact.graph;
        },
        get history() {
          historyReads += 1;
          return exact.history;
        },
      };
      const lazyPacked = packSearchContext(lazyResult, { maxBytes: 180 });
      expect(Buffer.byteLength(lazyPacked.content)).toBeLessThanOrEqual(180);
      expect(Buffer.from(lazyPacked.content, "utf8").toString("utf8"))
        .toBe(lazyPacked.content);
      expect(lazyPacked.content).not.toContain("�");
      expect(lazyPacked.truncated).toBe(true);
      expect({ unreadTitleReads, graphReads, historyReads }).toEqual({
        unreadTitleReads: 0,
        graphReads: 0,
        historyReads: 0,
      });
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
