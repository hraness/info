import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  indexSemanticVault,
  openSemanticSearchSession,
  recommendedEmbeddingModel,
  recommendedEmbeddingModelSha256,
  searchSemanticVault,
  semanticDatabasePath,
  type SemanticDependencies,
  type SemanticStoreOptions,
  type SemanticUpdateResult,
} from "./semantic.js";
import { MAX_NOTE_UTF8_BYTES, scanVault } from "./vault.js";

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
  readonly internal?: {
    readonly getHashesNeedingEmbedding: (model?: string) => unknown;
    readonly llm: {
      readonly embed: (text: string, options?: { readonly model?: string }) => Promise<unknown>;
    };
    readonly searchVec: (
      query: string,
      model: string,
      limit?: number,
      collection?: string,
      session?: {
        readonly embed: (
          text: string,
          options?: { readonly model?: string },
        ) => Promise<unknown>;
      },
    ) => Promise<unknown>;
  };
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
  test("keeps QMD document tokenization on the store-local embedding model", async () => {
    const installedStore = await readFile(
      join(dirname(fileURLToPath(import.meta.resolve("@tobilu/qmd"))), "store.js"),
      "utf8",
    );

    expect(installedStore).toContain(
      "chunkDocumentByTokensWithLlm(llm, doc.body",
    );
    expect(installedStore).toContain(
      "chunkDocumentByTokensWithLlm(llm, sample.body",
    );
    expect(installedStore).toContain(
      "chunkDocumentByTokensWithLlm(getDefaultLlamaCpp(), content",
    );
  });

  test("pins QMD's recommended embedding model, incrementally updates, embeds, and closes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const optionsSeen: SemanticStoreOptions[] = [];
    const calls: string[] = [];
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
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
      const projectionRoot = optionsSeen[0]?.config.collections.kb?.path;
      expect(projectionRoot).toBeString();
      expect(projectionRoot).not.toBe(canonicalRoot);
      expect(projectionRoot).toStartWith(await realpath(join(temporary, "cache")));
      expect(optionsSeen[0]).toMatchObject({
        config: {
          collections: { kb: { path: projectionRoot, pattern: "**/*.md" } },
          models: { embed: recommendedEmbeddingModel },
        },
      });
      expect(recommendedEmbeddingModel).toEndWith(
        "#0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("indexes an immutable validated projection with an auditable path manifest", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const cache = join(temporary, "cache");
    const database = join(cache, "projection.sqlite");
    const notePath = join(root, "notes", "projection.md");
    const original = "# Projection\n\nBounded snapshot content.\n";
    const changed = "# Projection\n\nChanged after the scan.\n";
    const optionsSeen: SemanticStoreOptions[] = [];
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(notePath, original, "utf8");
    const store = {
      update: () => Promise.resolve(unchanged),
      embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
      searchLex: () => Promise.resolve([]),
      searchVector: () => Promise.resolve([]),
      getDocumentBody: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      await indexSemanticVault(
        { root, database },
        {
          ...fakeDependencies(store, optionsSeen, cache),
          scanVault: async (requestedRoot) => {
            const snapshot = await scanVault(requestedRoot, { mentionScope: false });
            await writeFile(notePath, changed, "utf8");
            return snapshot;
          },
        },
      );
      const projectionRoot = optionsSeen[0]?.config.collections.kb?.path;
      expect(projectionRoot).toBeString();
      expect(await readFile(join(projectionRoot as string, "notes", "projection.md"), "utf8"))
        .toBe(original);
      expect(await readFile(notePath, "utf8")).toBe(changed);
      const manifest = JSON.parse(
        await readFile(`${database}.snapshot/manifest.json`, "utf8"),
      ) as {
        root: string;
        generation: string;
        indexIdentity: {
          indexer: { package: string; version: string };
          embedding: { model: string; chunkStrategy: string };
        };
        notes: { path: string; sha256: string; bytes: number }[];
      };
      expect(manifest.root).toBe(await realpath(root));
      expect(projectionRoot).toEndWith(manifest.generation);
      expect(manifest.notes).toContainEqual({
        path: "notes/projection.md",
        sha256: contentHash(original),
        bytes: Buffer.byteLength(original),
      });
      expect(manifest.indexIdentity).toMatchObject({
        indexer: {
          package: "@tobilu/qmd",
          version:
            "2.5.3+hraness.aa993dceb3ef8cfb71d470554ca437570f5a2b3c",
        },
        embedding: {
          model: `${recommendedEmbeddingModel}@sha256:${recommendedEmbeddingModelSha256}`,
          chunkStrategy: "regex",
        },
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects an oversized live note before creating QMD database content", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "cache", "oversized.sqlite");
    let creates = 0;
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(
      join(root, "oversized.md"),
      `# Oversized\n${"x".repeat(MAX_NOTE_UTF8_BYTES)}`,
      "utf8",
    );
    try {
      expect(indexSemanticVault(
        { root, database },
        {
          createStore: () => {
            creates += 1;
            return Promise.reject(new Error("QMD must not open"));
          },
        },
      )).rejects.toThrow("exceeds the");
      expect(creates).toBe(0);
      expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
      expect(stat(`${database}.snapshot`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects an in-vault database before scanning or writing cache state", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-overlap-"));
    const root = join(temporary, "vault");
    const database = join(root, "cache", "index.sqlite");
    let scans = 0;
    let creates = 0;
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    try {
      expect(indexSemanticVault(
        { root, database },
        {
          scanVault: async (requestedRoot) => {
            scans += 1;
            return await scanVault(requestedRoot, { mentionScope: false });
          },
          createStore: () => {
            creates += 1;
            return Promise.reject(new Error("QMD must not open"));
          },
        },
      )).rejects.toThrow("must not overlap the vault root");
      expect({ scans, creates }).toEqual({ scans: 0, creates: 0 });
      expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
      expect(stat(`${database}.snapshot`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("closes the store when indexing fails", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const cache = `${temporary}-cache`;
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
      await writeFile(join(temporary, "index.md"), "# Knowledge base\n", "utf8");
      expect(indexSemanticVault(
        { root: temporary },
        fakeDependencies(store, [], cache),
      )).rejects.toThrow("index failed");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("rejects malformed stores and closes the foreign resource when possible", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const cache = `${temporary}-cache`;
    let closed = false;
    const dependencies: SemanticDependencies = {
      cacheHome: cache,
      createStore: () => Promise.resolve({
        close: () => {
          closed = true;
          return Promise.resolve();
        },
        update: () => Promise.resolve(unchanged),
      }),
    };
    try {
      await writeFile(join(temporary, "index.md"), "# Knowledge base\n", "utf8");
      expect(indexSemanticVault({ root: temporary }, dependencies))
        .rejects.toThrow("QMD store.embed must be a function");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("rejects malformed QMD results before they enter the owned API", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const cache = `${temporary}-cache`;
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
      await writeFile(join(temporary, "index.md"), "# Knowledge base\n", "utf8");
      expect(indexSemanticVault(
        { root: temporary },
        fakeDependencies(store, [], cache),
      )).rejects.toThrow("QMD update result.needsEmbedding must be a finite number");
      expect(closed).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  });
});

describe("QMD search", () => {
  test("loads verified local model bytes without exposing their path as model identity", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-model-"));
    const root = join(temporary, "vault");
    const modelFile = join(temporary, "private-model.gguf");
    const optionsSeen: SemanticStoreOptions[] = [];
    const embedModels: string[] = [];
    const pendingModels: string[] = [];
    const queryModels: string[] = [];
    const queryEmbedModels: string[] = [];
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    const store = {
      internal: {
        getHashesNeedingEmbedding: (model?: string) => {
          pendingModels.push(String(model));
          return 1;
        },
        llm: {
          embed: (_text: string, options?: { readonly model?: string }) => {
            queryEmbedModels.push(String(options?.model));
            return Promise.resolve({ embedding: [0.25], model: options?.model });
          },
        },
        searchVec: async (
          query: string,
          model: string,
          limit?: number,
          collection?: string,
          session?: {
            readonly embed: (
              text: string,
              options?: { readonly model?: string },
            ) => Promise<unknown>;
          },
        ) => {
          queryModels.push(`${query}:${model}:${String(limit)}:${String(collection)}`);
          await session?.embed("formatted query", { model });
          return [];
        },
      },
      update: () => Promise.resolve({ ...unchanged, needsEmbedding: 1 }),
      embed: (options?: Parameters<FakeStore["embed"]>[0]) => {
        embedModels.push(String(options?.model));
        return Promise.resolve({
          docsProcessed: 0,
          chunksEmbedded: 0,
          errors: 0,
          durationMs: 0,
        });
      },
      searchLex: () => Promise.resolve([]),
      searchVector: () => Promise.reject(new Error("public vector search must not run")),
      getDocumentBody: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      const session = await openSemanticSearchSession(
        { root, embeddingModelFile: modelFile },
        {
          ...fakeDependencies(store, optionsSeen, join(temporary, "cache")),
          digestEmbeddingModelFile: (path) => {
            expect(path).toBe(modelFile);
            return Promise.resolve(recommendedEmbeddingModelSha256);
          },
        },
      );
      const result = await session.search({ query: "local bytes", mode: "semantic" });
      await session.close();

      expect(optionsSeen[0]?.config.models?.embed).toBe(modelFile);
      expect(embedModels).toEqual([recommendedEmbeddingModel]);
      expect(pendingModels).toEqual([
        recommendedEmbeddingModel,
        recommendedEmbeddingModel,
      ]);
      expect(queryModels).toEqual([
        `local bytes:${recommendedEmbeddingModel}:40:kb`,
      ]);
      expect(queryEmbedModels).toEqual([recommendedEmbeddingModel]);
      expect(session.model).toBe(recommendedEmbeddingModel);
      expect(result.model).toBe(recommendedEmbeddingModel);
      expect(JSON.stringify({ session: session.model, result: result.model }))
        .not.toContain(modelFile);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects unpinned local model bytes before opening QMD", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-model-"));
    const root = join(temporary, "vault");
    const modelFile = join(temporary, "wrong-model.gguf");
    let creates = 0;
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(modelFile, "not the pinned model", "utf8");
    try {
      expect(openSemanticSearchSession(
        { root, embeddingModelFile: modelFile },
        {
          createStore: () => {
            creates += 1;
            return Promise.reject(new Error("must not open QMD"));
          },
        },
      )).rejects.toThrow("does not match the pinned recommended model SHA-256");
      expect(creates).toBe(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

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
        updates: 2,
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

  test("allows same-generation sessions and their keyword reads to overlap", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "cache", "shared.sqlite");
    const body = "# Shared generation\n\nParallel readers stay coherent.\n";
    let creates = 0;
    let activeSearches = 0;
    let maximumSearches = 0;
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(root, "note.md"), body, "utf8");
    const dependencies: SemanticDependencies = {
      writerLease: { waitMs: 2_000, pollMs: 5 },
      createStore: async () => {
        await Promise.resolve();
        creates += 1;
        return {
          update: () => Promise.resolve(unchanged),
          embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
          searchLex: async () => {
            activeSearches += 1;
            maximumSearches = Math.max(maximumSearches, activeSearches);
            await Bun.sleep(25);
            activeSearches -= 1;
            return [result("qmd://kb/note.md", {
              title: "Shared generation",
              source: "fts",
              hash: contentHash(body),
            })];
          },
          searchVector: () => Promise.resolve([]),
          getDocumentBody: () => Promise.resolve(body),
          close: () => Promise.resolve(),
        } satisfies FakeStore;
      },
    };
    let sessions: readonly Awaited<ReturnType<typeof openSemanticSearchSession>>[] = [];
    try {
      sessions = await Promise.all([
        openSemanticSearchSession({ root, database }, dependencies),
        openSemanticSearchSession({ root, database }, dependencies),
      ]);
      expect(creates).toBe(2);
      const results = await Promise.all(sessions.map((session) =>
        session.search({ query: "parallel", mode: "keyword" })));
      expect(results.every((found) => found.results[0]?.path === "note.md")).toBe(true);
      expect(maximumSearches).toBe(2);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("serializes semantic sessions that name one database through directory aliases", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-alias-"));
    const root = join(temporary, "vault");
    const realCache = join(temporary, "cache-real");
    const aliasCache = join(temporary, "cache-alias");
    const database = join(realCache, "shared.sqlite");
    let activeUpdates = 0;
    let maximumUpdates = 0;
    await mkdir(root);
    await mkdir(realCache);
    await symlink(realCache, aliasCache, "dir");
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(root, "note.md"), "# Aliased database\n", "utf8");
    const dependencies: SemanticDependencies = {
      writerLease: { waitMs: 2_000, pollMs: 5 },
      createStore: () => Promise.resolve({
        update: async () => {
          activeUpdates += 1;
          maximumUpdates = Math.max(maximumUpdates, activeUpdates);
          await Bun.sleep(30);
          activeUpdates -= 1;
          return unchanged;
        },
        embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
        searchLex: () => Promise.resolve([]),
        searchVector: () => Promise.resolve([]),
        getDocumentBody: () => Promise.resolve(null),
        close: () => Promise.resolve(),
      } satisfies FakeStore),
    };
    let sessions: readonly Awaited<ReturnType<typeof openSemanticSearchSession>>[] = [];
    try {
      sessions = await Promise.all([
        openSemanticSearchSession({ root, database }, dependencies),
        openSemanticSearchSession({
          root,
          database: join(aliasCache, "shared.sqlite"),
        }, dependencies),
      ]);
      expect(maximumUpdates).toBe(1);
      expect(new Set(sessions.map(({ database: path }) => path)))
        .toEqual(new Set([join(await realpath(realCache), "shared.sqlite")]));
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("waits for same-generation readers before a forced re-embed", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-force-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "cache", "shared.sqlite");
    let creates = 0;
    let forceEmbeds = 0;
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(root, "note.md"), "# Force exclusion\n", "utf8");
    const dependencies: SemanticDependencies = {
      writerLease: { waitMs: 2_000, pollMs: 5 },
      createStore: () => {
        creates += 1;
        return Promise.resolve({
          update: () => Promise.resolve(unchanged),
          embed: (options?: { readonly force?: boolean }) => {
            if (options?.force === true) forceEmbeds += 1;
            return Promise.resolve({ docsProcessed: 1, chunksEmbedded: 1, errors: 0, durationMs: 1 });
          },
          searchLex: () => Promise.resolve([]),
          searchVector: () => Promise.resolve([]),
          getDocumentBody: () => Promise.resolve(null),
          close: () => Promise.resolve(),
        } satisfies FakeStore);
      },
    };
    let reader: Awaited<ReturnType<typeof openSemanticSearchSession>> | undefined;
    try {
      reader = await openSemanticSearchSession({ root, database }, dependencies);
      const forced = indexSemanticVault({ root, database, force: true }, dependencies);
      await Bun.sleep(50);
      expect({ creates, forceEmbeds }).toEqual({ creates: 1, forceEmbeds: 0 });
      await reader.close();
      reader = undefined;
      await forced;
      expect({ creates, forceEmbeds }).toEqual({ creates: 2, forceEmbeds: 1 });
    } finally {
      await reader?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps different-generation sessions coherent by leasing through close", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const firstRoot = join(temporary, "first");
    const secondRoot = join(temporary, "second");
    const database = join(temporary, "cache", "shared.sqlite");
    let creates = 0;
    for (const [root, body] of [
      [firstRoot, "# Alpha snapshot\n\nOnly alpha evidence.\n"],
      [secondRoot, "# Beta snapshot\n\nOnly beta evidence.\n"],
    ] as const) {
      await mkdir(root);
      await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
      await writeFile(join(root, "note.md"), body, "utf8");
    }
    const dependencies: SemanticDependencies = {
      writerLease: { waitMs: 2_000, pollMs: 5 },
      createStore: async (options) => {
        creates += 1;
        const projection = options.config.collections.kb?.path;
        if (projection === undefined) throw new Error("missing projection");
        const body = await readFile(join(projection, "note.md"), "utf8");
        return {
          update: () => Promise.resolve(unchanged),
          embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
          searchLex: () => Promise.resolve([
            result("qmd://kb/note.md", {
              title: body.includes("Alpha") ? "Alpha snapshot" : "Beta snapshot",
              source: "fts",
              hash: contentHash(body),
            }),
          ]),
          searchVector: () => Promise.resolve([]),
          getDocumentBody: () => Promise.resolve(body),
          close: () => Promise.resolve(),
        } satisfies FakeStore;
      },
    };
    try {
      const first = await openSemanticSearchSession(
        { root: firstRoot, database },
        dependencies,
      );
      const secondOpening = openSemanticSearchSession(
        { root: secondRoot, database },
        dependencies,
      );
      await Bun.sleep(50);
      expect(creates).toBe(1);
      const firstResult = await first.search({ query: "alpha", mode: "keyword" });
      expect(firstResult.results[0]?.snippet).toContain("Only alpha evidence");
      await first.close();

      const second = await secondOpening;
      try {
        expect(creates).toBe(2);
        const secondResult = await second.search({ query: "beta", mode: "keyword" });
        expect(secondResult.results[0]?.snippet).toContain("Only beta evidence");
      } finally {
        await second.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("runs concurrent fresh and warm real QMD keyword sessions without lock errors", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-real-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "cache", "real.sqlite");
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(
      join(root, "note.md"),
      "# Real QMD concurrency\n\nFresh and warm readers share WAL-backed evidence.\n",
      "utf8",
    );
    const dependencies: SemanticDependencies = {
      writerLease: { waitMs: 5_000, pollMs: 5 },
    };
    let sessions: readonly Awaited<ReturnType<typeof openSemanticSearchSession>>[] = [];
    try {
      sessions = await Promise.all([
        openSemanticSearchSession({ root, database }, dependencies),
        openSemanticSearchSession({ root, database }, dependencies),
      ]);
      const fresh = await Promise.all(sessions.map((session) =>
        session.search({ query: "WAL evidence", mode: "keyword" })));
      expect(fresh.every((found) => found.results.some(({ path }) => path === "note.md")))
        .toBe(true);
      await Promise.all(sessions.map((session) => session.close()));
      sessions = [];

      sessions = await Promise.all([
        openSemanticSearchSession({ root, database }, dependencies),
        openSemanticSearchSession({ root, database }, dependencies),
      ]);
      const warm = await Promise.all(sessions.map((session) =>
        session.search({ query: "warm readers", mode: "keyword" })));
      expect(warm.every((found) => found.results.some(({ path }) => path === "note.md")))
        .toBe(true);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(temporary, { recursive: true, force: true });
    }
  }, 15_000);

  test("runs typed lexical and vector queries through QMD hybrid fusion", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const root = join(temporary, "vault");
    const note = join(root, "notes", "hybrid.md");
    const virtualPath = "qmd://kb/notes/hybrid.md";
    const seen: string[] = [];
    let bodyReads = 0;
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
      searchLex: (query: string, options?: { readonly limit?: number }) => {
        seen.push(`keyword:${query}:${String(options?.limit)}`);
        const match = result(virtualPath, {
          title: "Hybrid retrieval",
          source: "fts",
          hash: contentHash(body),
          chunkPos: body.indexOf("Exact"),
        });
        return Promise.resolve(overReturn ? Array.from({ length: 41 }, () => match) : [match]);
      },
      searchVector: (query: string, options?: { readonly limit?: number }) => {
        seen.push(`semantic:${query}:${String(options?.limit)}`);
        return Promise.resolve([result(virtualPath, {
          title: "Hybrid retrieval",
          source: "vec",
          hash: contentHash(body),
          chunkPos: body.indexOf("related"),
        })]);
      },
      getDocumentBody: () => {
        bodyReads += 1;
        return Promise.reject(new Error("live note content should satisfy reconciliation"));
      },
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
        "keyword:hybrid evidence:40",
        "semantic:hybrid evidence:40",
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
      expect(bodyReads).toBe(0);
      expect(found.rawWindow).toEqual({
        requested: 40,
        returned: 1,
        discarded: 0,
        thresholdRejected: 0,
        exhausted: true,
      });

      overReturn = true;
      expect(searchSemanticVault(
        { root, query: "hybrid evidence", mode: "hybrid", limit: 1 },
        fakeDependencies(store, [], join(temporary, "cache")),
      )).rejects.toThrow("more than the requested 40 results");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("retrieves hybrid candidates below QMD's former twenty-row structured cap", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-window-"));
    const root = join(temporary, "vault");
    const bodies = new Map<string, string>();
    const limits: number[] = [];
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    const matches = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const path = `note-${String(index + 1).padStart(2, "0")}.md`;
      const virtualPath = `qmd://kb/${path}`;
      const body = `# Candidate ${index + 1}\n\nHybrid evidence ${index + 1}.\n`;
      bodies.set(virtualPath, body);
      await writeFile(join(root, path), body, "utf8");
      return result(virtualPath, {
        title: `Candidate ${index + 1}`,
        hash: contentHash(body),
        chunkPos: body.indexOf("Hybrid"),
      });
    }));
    const store = {
      update: () => Promise.resolve(unchanged),
      embed: () => Promise.resolve({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }),
      searchLex: (_query: string, options?: { readonly limit?: number }) => {
        limits.push(options?.limit ?? 0);
        return Promise.resolve(matches.map((match) => ({ ...match, source: "fts" as const })));
      },
      searchVector: (_query: string, options?: { readonly limit?: number }) => {
        limits.push(options?.limit ?? 0);
        return Promise.resolve(matches.map((match) => ({ ...match, source: "vec" as const })));
      },
      getDocumentBody: (path: string) => Promise.resolve(bodies.get(path) ?? null),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      const found = await searchSemanticVault(
        {
          root,
          query: "hybrid evidence",
          mode: "hybrid",
          limit: 25,
          candidateLimit: 25,
        },
        fakeDependencies(store, [], join(temporary, "cache")),
      );
      expect(limits).toEqual([25, 25]);
      expect(found.results).toHaveLength(25);
      expect(found.results[24]).toMatchObject({
        path: "note-25.md",
        source: "hybrid",
        signals: { keyword: true, semantic: true },
      });
      expect(found.rawWindow?.exhausted).toBe(false);
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
          result(virtualPath, {
            hash: contentHash(body),
            score: 0.1,
          }),
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
      expect(found.rawWindow).toEqual({
        requested: 40,
        returned: 3,
        discarded: 1,
        thresholdRejected: 1,
        exhausted: true,
      });
      expect(calls).toEqual(["embed", "vector:concept discovery:40:kb", "close"]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("disambiguates handelized collisions by live content and rejects stale virtual hits", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const cache = `${temporary}-cache`;
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
        result(bodyCheckedPath, { hash: contentHash("# Body checked\n\nStale body.\n"), source: "fts" }),
      ]),
      searchVector: () => Promise.reject(new Error("unexpected vector search")),
      getDocumentBody: () => Promise.reject(new Error("unexpected body read")),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    try {
      const found = await searchSemanticVault(
        { root: temporary, query: "collision", mode: "keyword" },
        fakeDependencies(store, [], cache),
      );
      expect(found.results).toEqual([
        expect.objectContaining({ path: "plans/collision.v1.md", source: "fts" }),
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("keyword mode stays model-free and validates bounds", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const cache = `${temporary}-cache`;
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
          result("qmd://kb/note.md", {
            source: "fts",
            score: 0.99,
            hash: contentHash("# Stale phrase\n"),
          }),
          result("qmd://kb/note.md", {
            source: "fts",
            hash: contentHash("# Exact phrase\n"),
          }),
        ]);
      },
      searchVector: () => Promise.reject(new Error("unexpected vector search")),
      getDocumentBody: () => Promise.resolve("# Exact phrase\n"),
      close: () => Promise.resolve(),
    } satisfies FakeStore;
    const dependencies = fakeDependencies(store, [], cache);
    try {
      const found = await searchSemanticVault(
        {
          root: temporary,
          query: "exact",
          mode: "keyword",
          limit: 1,
          candidateLimit: 2,
        },
        dependencies,
      );
      expect(found.results).toHaveLength(1);
      expect(found.results[0]).toMatchObject({ path: "note.md", source: "fts" });
      expect(found.rawWindow).toEqual({
        requested: 2,
        returned: 2,
        discarded: 1,
        thresholdRejected: 0,
        exhausted: false,
      });
      expect(embeds).toBe(0);
      expect(lexicalLimit).toBe(2);
      const session = await openSemanticSearchSession(
        { root: temporary },
        dependencies,
      );
      try {
        await session.search({
          query: "exact",
          mode: "keyword",
          limit: 500,
          candidateLimit: 500,
        });
        expect(lexicalLimit).toBe(500);
      } finally {
        await session.close();
      }
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
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("rejects an oversized shared query before opening QMD", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-semantic-"));
    const database = join(temporary, "cache", "query.sqlite");
    let creates = 0;
    try {
      expect(searchSemanticVault(
        {
          root: temporary,
          database,
          query: "x".repeat(16 * 1_024 + 1),
        },
        {
          createStore: () => {
            creates += 1;
            return Promise.reject(new Error("QMD must not open"));
          },
        },
      )).rejects.toThrow("at most 16,384 UTF-8 bytes");
      expect(creates).toBe(0);
      expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
