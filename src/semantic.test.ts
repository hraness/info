import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  indexSemanticVault,
  openSemanticSearchSession,
  recommendedEmbeddingModel,
  searchSemanticVault,
  semanticDatabasePath,
  type SemanticDependencies,
  type SemanticStoreOptions,
  type SemanticUpdateResult,
} from "./semantic.js";
import { scanVault } from "./vault.js";

type SearchResultFixture = {
  readonly filepath: string;
  readonly displayPath: string;
  readonly title: string;
  readonly context: string | null;
  readonly hash: string;
  readonly docid: string;
  readonly collectionName: string;
  readonly modifiedAt: string;
  readonly bodyLength: number;
  readonly score: number;
  readonly source: "fts" | "vec";
  readonly chunkPos?: number;
};

type FakeStore = {
  readonly close: () => Promise<unknown>;
  readonly embed: (options?: {
    readonly collection?: string;
    readonly force?: boolean;
    readonly model?: string;
    readonly chunkStrategy?: "regex";
  }) => Promise<unknown>;
  readonly getDocumentBody: (path: string) => Promise<unknown>;
  readonly searchLex: (
    query: string,
    options?: { readonly collection?: string; readonly limit?: number },
  ) => Promise<unknown>;
  readonly searchVector: (
    query: string,
    options?: { readonly collection?: string; readonly limit?: number },
  ) => Promise<unknown>;
  readonly search?: (options?: unknown) => Promise<unknown>;
  readonly update: (options?: { readonly collections?: readonly string[] }) => Promise<unknown>;
};

const unchanged: SemanticUpdateResult = {
  collections: 1,
  indexed: 0,
  updated: 0,
  unchanged: 1,
  removed: 0,
  needsEmbedding: 0,
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function result(
  filepath: string,
  overrides: Partial<SearchResultFixture> = {},
): SearchResultFixture {
  return {
    filepath,
    displayPath: "kb/note.md",
    title: "Local retrieval",
    context: null,
    hash: "abcdef012345",
    docid: "abcdef",
    collectionName: "kb",
    modifiedAt: "2026-07-22T12:00:00.000Z",
    bodyLength: 42,
    score: 0.88,
    source: "vec",
    chunkPos: 17,
    ...overrides,
  };
}

function fakeDependencies(
  store: FakeStore,
  optionsSeen: SemanticStoreOptions[],
  cacheHome: string,
): SemanticDependencies {
  return {
    cacheHome,
    createStore: (options) => {
      optionsSeen.push(options);
      return Promise.resolve(store);
    },
  };
}

describe("semantic index paths", () => {
  test("uses a stable per-vault database below the configured cache home", () => {
    const first = semanticDatabasePath("/vault/one", { cacheHome: "/cache" });
    expect(first).toStartWith("/cache/hraness-kb/indexes/");
    expect(first).toEndWith(".sqlite");
    expect(semanticDatabasePath("/vault/one", { cacheHome: "/cache" })).toBe(first);
    expect(semanticDatabasePath("/vault/two", { cacheHome: "/cache" })).not.toBe(first);
  });
});

describe("QMD indexing", () => {
  test("pins QMD's recommended embedding model, incrementally updates, embeds, and closes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const optionsSeen: SemanticStoreOptions[] = [];
    const calls: string[] = [];
    await mkdir(root);
    const store = {
      update: () => {
        calls.push("update");
        return Promise.resolve({ ...unchanged, indexed: 1, unchanged: 0, needsEmbedding: 1 });
      },
      embed: (options?: Parameters<FakeStore["embed"]>[0]) => {
        calls.push(`embed:${String(options?.model)}`);
        return Promise.resolve({ docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 });
      },
      searchLex: () => Promise.resolve([]),
      searchVector: () => Promise.resolve([]),
      getDocumentBody: () => Promise.resolve(null),
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    } satisfies FakeStore;
    try {
      const indexed = await indexSemanticVault(
        { root },
        fakeDependencies(store, optionsSeen, join(temporary, "cache")),
      );
      expect(indexed.model).toBe(recommendedEmbeddingModel);
      expect(indexed.embedding).toMatchObject({ docsProcessed: 1, chunksEmbedded: 1 });
      expect(calls).toEqual(["update", `embed:${recommendedEmbeddingModel}`, "close"]);
      const canonicalRoot = await realpath(root);
      expect(optionsSeen[0]).toMatchObject({
        config: {
          collections: { kb: { path: canonicalRoot, pattern: "**/*.md" } },
          models: { embed: recommendedEmbeddingModel },
        },
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("closes the store when indexing fails", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    let closed = false;
    const store = {
      update: () => Promise.reject(new Error("index failed")),
      embed: () => Promise.reject(new Error("unexpected")),
      searchLex: () => Promise.resolve([]),
      searchVector: () => Promise.resolve([]),
      getDocumentBody: () => Promise.resolve(null),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } satisfies FakeStore;
    try {
      expect(indexSemanticVault(
        { root: temporary },
        fakeDependencies(store, [], join(temporary, "cache")),
      )).rejects.toThrow("index failed");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects malformed stores and closes the foreign resource when possible", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    let closed = false;
    const dependencies: SemanticDependencies = {
      cacheHome: join(temporary, "cache"),
      createStore: () => Promise.resolve({
        close: () => {
          closed = true;
          return Promise.resolve();
        },
        update: () => Promise.resolve(unchanged),
      }),
    };
    try {
      expect(indexSemanticVault({ root: temporary }, dependencies))
        .rejects.toThrow("QMD store.embed must be a function");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects malformed QMD results before they enter the owned API", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    let closed = false;
    const store = {
      update: () => Promise.resolve({ ...unchanged, needsEmbedding: "one" }),
      embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
      searchLex: () => Promise.resolve([]),
      searchVector: () => Promise.resolve([]),
      getDocumentBody: () => Promise.resolve(null),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } satisfies FakeStore;
    try {
      expect(indexSemanticVault(
        { root: temporary },
        fakeDependencies(store, [], join(temporary, "cache")),
      )).rejects.toThrow("QMD update result.needsEmbedding must be a finite number");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("QMD search", () => {
  test("shares one scan, update, embedding, and serialized store across a session", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(root, "note.md"), "# Shared session\n", "utf8");
    let scans = 0;
    let updates = 0;
    let embeddings = 0;
    let searches = 0;
    let active = 0;
    let maximumActive = 0;
    let closes = 0;
    const store = {
      update: () => {
        updates += 1;
        return Promise.resolve({ ...unchanged, needsEmbedding: 1 });
      },
      embed: () => {
        embeddings += 1;
        return Promise.resolve({
          docsProcessed: 1,
          chunksEmbedded: 1,
          errors: 0,
          durationMs: 1,
        });
      },
      searchLex: () => Promise.resolve([]),
      searchVector: async () => {
        searches += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(5);
        active -= 1;
        return [];
      },
      getDocumentBody: () => Promise.resolve(null),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    } satisfies FakeStore;
    try {
      const session = await openSemanticSearchSession(
        { root },
        {
          ...fakeDependencies(store, [], join(temporary, "cache")),
          scanVault: async (requestedRoot) => {
            scans += 1;
            return await scanVault(requestedRoot, { mentionScope: false });
          },
        },
      );
      await Promise.all([
        session.search({ query: "shared", mode: "semantic" }),
        session.search({ query: "session", mode: "semantic" }),
      ]);
      await Promise.all([session.close(), session.close()]);
      expect({ scans, updates, embeddings, searches, maximumActive, closes }).toEqual({
        scans: 1,
        updates: 1,
        embeddings: 1,
        searches: 2,
        maximumActive: 1,
        closes: 1,
      });
      expect(session.search({ query: "closed" })).rejects.toThrow("session is closed");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("runs fast typed lexical and vector queries through QMD hybrid fusion", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const note = join(root, "notes", "hybrid.md");
    const virtualPath = "qmd://kb/notes/hybrid.md";
    const seen: unknown[] = [];
    let invalidPosition = false;
    let overReturn = false;
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(
      note,
      "# Hybrid retrieval\n\nExact words and related meaning reinforce each other.\n",
      "utf8",
    );
    const body = await Bun.file(note).text();
    const store = {
      update: () => Promise.resolve(unchanged),
      embed: () => Promise.resolve({
        docsProcessed: 0,
        chunksEmbedded: 0,
        errors: 0,
        durationMs: 0,
      }),
      search: (options?: unknown) => {
        seen.push(options);
        const match = {
            file: virtualPath,
            displayPath: "notes/hybrid.md",
            title: "Hybrid retrieval",
            body,
            bestChunk: "Forged text that is not present in the note.",
            bestChunkPos: invalidPosition ? body.length + 1 : body.indexOf("Exact"),
            score: 0.82,
            context: null,
            docid: "abc123",
            explain: {
              ftsScores: [4.2],
              vectorScores: [0.76],
              rrf: {
                rank: 1,
                positionScore: 1,
                weight: 1,
                baseScore: 1,
                topRankBonus: 0.05,
                totalScore: 1.05,
                contributions: [],
              },
              rerankScore: 0,
              blendedScore: 0.82,
            },
          };
        return Promise.resolve(overReturn ? [match, match] : [match]);
      },
      searchLex: () => Promise.reject(new Error("unexpected keyword search")),
      searchVector: () => Promise.reject(new Error("unexpected vector search")),
      getDocumentBody: () => Promise.reject(new Error("hybrid body is returned inline")),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      const found = await searchSemanticVault(
        {
          root,
          query: "hybrid evidence",
          mode: "hybrid",
          limit: 5,
          candidateLimit: 40,
        },
        fakeDependencies(store, [], join(temporary, "cache")),
      );
      expect(seen).toEqual([
        {
          queries: [
            { type: "lex", query: "hybrid evidence" },
            { type: "vec", query: "hybrid evidence" },
          ],
          collection: "kb",
          limit: 5,
          candidateLimit: 40,
          minScore: 0,
          rerank: false,
          explain: true,
          chunkStrategy: "regex",
        },
      ]);
      expect(found.results).toEqual([
        expect.objectContaining({
          path: "notes/hybrid.md",
          source: "hybrid",
          line: 3,
          signals: { keyword: true, semantic: true },
        }),
      ]);
      expect(found.results[0]?.snippet).toContain("Exact words and related meaning");
      expect(found.results[0]?.snippet).not.toContain("Forged text");

      invalidPosition = true;
      expect(searchSemanticVault(
        { root, query: "hybrid evidence", mode: "hybrid", limit: 5 },
        fakeDependencies(store, [], join(temporary, "cache")),
      )).rejects.toThrow("bestChunkPos must fall within the verified document body");
      invalidPosition = false;
      overReturn = true;
      expect(searchSemanticVault(
        { root, query: "hybrid evidence", mode: "hybrid", limit: 1 },
        fakeDependencies(store, [], join(temporary, "cache")),
      )).rejects.toThrow("more than the requested 1 results");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("incrementally embeds and returns bounded vault-relative semantic evidence", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const note = join(root, "plans", "mine-auth-context-v0.5.md");
    const virtualPath = "qmd://kb/plans/mine-auth-context-v0-5.md";
    const calls: string[] = [];
    await mkdir(join(root, "plans"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(note, "# Local retrieval\n\nSemantic search finds concepts without exact words.\n", "utf8");
    const body = await Bun.file(note).text();
    const store = {
      update: () => Promise.resolve({ ...unchanged, updated: 1, unchanged: 0, needsEmbedding: 1 }),
      embed: () => {
        calls.push("embed");
        return Promise.resolve({ docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 });
      },
      searchLex: () => Promise.reject(new Error("unexpected keyword search")),
      searchVector: (query: string, options?: { limit?: number; collection?: string }) => {
        calls.push(`vector:${query}:${options?.limit}:${options?.collection}`);
        return Promise.resolve([
          result(virtualPath, {
            chunkPos: body.indexOf("Semantic"),
            hash: contentHash(body),
            score: 0.91,
          }),
          result(join(temporary, "outside.md"), { score: 0.99 }),
        ]);
      },
      getDocumentBody: (path: string) => Promise.resolve(path === virtualPath ? body : "outside"),
      close: () => {
        calls.push("close");
        return Promise.resolve();
      },
    } satisfies FakeStore;
    try {
      const found = await searchSemanticVault(
        { root, query: "concept discovery", limit: 4, minScore: 0.9 },
        fakeDependencies(store, [], join(temporary, "cache")),
      );
      expect(found.mode).toBe("semantic");
      expect(found.results).toEqual([
        expect.objectContaining({
          path: "plans/mine-auth-context-v0.5.md",
          score: 0.91,
          source: "vec",
          line: 3,
        }),
      ]);
      expect(found.results[0]?.snippet).toContain("Semantic search finds concepts");
      expect(calls).toEqual(["embed", "vector:concept discovery:40:kb", "close"]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("disambiguates handelized collisions by live content and rejects stale virtual hits", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const plans = join(temporary, "plans");
    const dottedBody = "# Dotted plan\n\nCurrent collision evidence.\n";
    const dashedBody = "# Dashed plan\n\nDifferent collision evidence.\n";
    const bodyCheckedBody = "# Body checked\n\nCurrent body.\n";
    const collisionPath = "qmd://kb/plans/collision-v1.md";
    const bodyCheckedPath = "qmd://kb/plans/body-checked.md";
    await mkdir(plans, { recursive: true });
    await writeFile(join(temporary, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(plans, "collision.v1.md"), dottedBody, "utf8");
    await writeFile(join(plans, "collision-v1.md"), dashedBody, "utf8");
    await writeFile(join(plans, "body-checked.md"), bodyCheckedBody, "utf8");
    const store = {
      update: () => Promise.resolve(unchanged),
      embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
      searchLex: () => Promise.resolve([
        result(collisionPath, { hash: contentHash(dottedBody), source: "fts" }),
        result(collisionPath, { hash: contentHash("stale collision body"), source: "fts" }),
        result("qmd://other/plans/collision-v1.md", {
          hash: contentHash(dashedBody),
          source: "fts",
        }),
        result(bodyCheckedPath, { hash: contentHash(bodyCheckedBody), source: "fts" }),
      ]),
      searchVector: () => Promise.reject(new Error("unexpected vector search")),
      getDocumentBody: (path: string) => Promise.resolve(
        path === collisionPath ? dottedBody : "# Body checked\n\nStale body.\n",
      ),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      const found = await searchSemanticVault(
        { root: temporary, query: "collision", mode: "keyword" },
        fakeDependencies(store, [], join(temporary, "cache")),
      );
      expect(found.results).toEqual([
        expect.objectContaining({ path: "plans/collision.v1.md", source: "fts" }),
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keyword mode stays model-free and validates bounds", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const note = join(temporary, "note.md");
    let embeds = 0;
    let lexicalLimit = 0;
    await writeFile(join(temporary, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(note, "# Exact phrase\n", "utf8");
    const store = {
      update: () => Promise.resolve({ ...unchanged, needsEmbedding: 1 }),
      embed: () => {
        embeds += 1;
        return Promise.resolve({ docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 });
      },
      searchLex: (_query: string, options?: { readonly limit?: number }) => {
        lexicalLimit = options?.limit ?? 0;
        return Promise.resolve([
          result(note, { source: "fts", score: 0.99, hash: contentHash("# Stale phrase\n") }),
          result(note, { source: "fts", hash: contentHash("# Exact phrase\n") }),
        ]);
      },
      searchVector: () => Promise.reject(new Error("unexpected vector search")),
      getDocumentBody: () => Promise.resolve("# Exact phrase\n"),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    const dependencies = fakeDependencies(store, [], join(temporary, "cache"));
    try {
      const found = await searchSemanticVault(
        {
          root: temporary,
          query: "exact",
          mode: "keyword",
          limit: 1,
          candidateLimit: 3,
        },
        dependencies,
      );
      expect(found.results).toHaveLength(1);
      expect(found.results[0]).toMatchObject({ path: "note.md", source: "fts" });
      expect(embeds).toBe(0);
      expect(lexicalLimit).toBe(3);
      expect(searchSemanticVault({ root: temporary, query: "x", limit: 0 }, dependencies))
        .rejects.toThrow("integer from 1 through 100");
      expect(searchSemanticVault({ root: temporary, query: "x", minScore: 2 }, dependencies))
        .rejects.toThrow("number from 0 through 1");
      expect(searchSemanticVault({
        root: temporary,
        query: "x",
        mode: "invalid" as never,
      }, dependencies)).rejects.toThrow("Search mode must be");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
