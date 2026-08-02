import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextNotePath,
} from "./agent-context.js";
import {
  FrozenEvaluationSnapshotError,
  knowledgeBaseEvaluationRetrieverIds,
  openKnowledgeBaseEvaluation,
  verifyFrozenEvaluationSnapshot,
  type KnowledgeBaseEvaluation,
} from "./evaluation-kb.js";
import {
  parseRetrievalEvaluationCorpus,
  type EvaluationQuery,
  type EvaluationRetrievalInputs,
  type EvaluationRetrieverResult,
  type RetrievalEvaluationCorpus,
} from "./evaluation.js";
import type {
  GitCommandProvider,
  GitCommandRequest,
  GitHistoryIndex,
} from "./git.js";
import type {
  SemanticSearchHit,
  SemanticSearchResult,
  SemanticSearchSession,
  SemanticSessionSearchOptions,
} from "./semantic.js";
import { scanVault } from "./vault.js";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function corpus(
  repositoryCommit = HEAD,
  vaultTree = TREE,
): RetrievalEvaluationCorpus {
  return parseRetrievalEvaluationCorpus({
    schemaVersion: 1,
    id: "adapter-fixture",
    description: "Built-in retrieval adapter fixture",
    frozen: { repositoryCommit, vaultTree, vaultRoot: "kb" },
    assessment: {
      rubricVersion: "test-v1",
      assessors: [{ id: "assessor" }],
    },
    queries: [
      {
        id: "development",
        text: "Human prose is not executable",
        class: "exact-identifier",
        split: "development",
        answer: "answerable",
        inputs: { text: "structured development text" },
        qrels: [{ documentId: "notes/exact", relevance: 3 }],
        assessorIds: ["assessor"],
        adjudication: { status: "not-required" },
      },
      {
        id: "test",
        text: "Human prose is not executable",
        class: "conceptual-recall",
        split: "test",
        answer: "answerable",
        inputs: { text: "structured test text" },
        qrels: [{ documentId: "notes/semantic", relevance: 3 }],
        assessorIds: ["assessor"],
        adjudication: { status: "not-required" },
      },
    ],
  });
}

type GitFixture = {
  readonly provider: GitCommandProvider;
  readonly requests: GitCommandRequest[];
};

function gitFixture(options: {
  readonly prefix?: string;
  readonly head?: string;
  readonly tree?: string;
  readonly type?: string;
  readonly status?: string;
} = {}): GitFixture {
  const requests: GitCommandRequest[] = [];
  const provider: GitCommandProvider = (request) => {
    requests.push(request);
    const args = request.arguments;
    if (args[0] === "rev-parse" && args[1] === "--show-prefix") {
      return Promise.resolve({ status: "ok", stdout: `${options.prefix ?? ""}\n` });
    }
    if (args[0] === "rev-parse" && args[2] === "HEAD") {
      return Promise.resolve({ status: "ok", stdout: `${options.head ?? HEAD}\n` });
    }
    if (args[0] === "rev-parse") {
      return Promise.resolve({ status: "ok", stdout: `${options.tree ?? TREE}\n` });
    }
    if (args[0] === "cat-file") {
      return Promise.resolve({ status: "ok", stdout: `${options.type ?? "tree"}\n` });
    }
    if (args[0] === "status") {
      return Promise.resolve({ status: "ok", stdout: options.status ?? "" });
    }
    return Promise.resolve({ status: "failed", message: `Unexpected Git argv: ${args.join(" ")}` });
  };
  return { provider, requests };
}

async function emptyRepositoryFixture(): Promise<{
  readonly repository: string;
  readonly root: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "hraness-kb-evaluation-snapshot-"));
  temporaryRoots.push(repository);
  const root = join(repository, "kb");
  await mkdir(root);
  return { repository, root };
}

describe("frozen evaluation snapshot", () => {
  test("verifies canonical confinement, HEAD, vault tree type, and scoped clean status", async () => {
    const { repository, root } = await emptyRepositoryFixture();
    const git = gitFixture();
    const verified = await verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root,
      runGit: git.provider,
    });
    const canonicalRepository = await realpath(repository);
    const canonicalRoot = await realpath(root);

    expect(verified).toEqual({
      repository: canonicalRepository,
      root: canonicalRoot,
      vaultRoot: "kb",
      repositoryCommit: HEAD,
      vaultTree: TREE,
    });
    expect(git.requests.map((request) => request.arguments)).toEqual([
      ["rev-parse", "--show-prefix"],
      ["rev-parse", "--verify", "HEAD"],
      ["rev-parse", "--verify", "HEAD:kb"],
      ["cat-file", "-t", "HEAD:kb"],
      ["status", "--porcelain=v1", "--untracked-files=all", "--", "kb"],
    ]);
    expect(git.requests.every(({ cwd }) => cwd === canonicalRepository)).toBe(true);
    expect(git.requests.every(({ timeoutMs, maxOutputBytes }) =>
      timeoutMs > 0 && maxOutputBytes > 0)).toBe(true);
  });

  test("rejects the wrong HEAD before inspecting the vault object", async () => {
    const { repository, root } = await emptyRepositoryFixture();
    const git = gitFixture({ head: "c".repeat(40) });
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root,
      runGit: git.provider,
    })).rejects.toThrow("does not match HEAD");
    expect(git.requests).toHaveLength(2);
  });

  test("rejects the wrong vault tree and a non-tree vault object", async () => {
    const first = await emptyRepositoryFixture();
    const wrongTree = gitFixture({ tree: "c".repeat(40) });
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository: first.repository,
      root: first.root,
      runGit: wrongTree.provider,
    })).rejects.toThrow("does not match HEAD:kb");
    expect(wrongTree.requests).toHaveLength(3);

    const second = await emptyRepositoryFixture();
    const blob = gitFixture({ type: "blob" });
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository: second.repository,
      root: second.root,
      runGit: blob.provider,
    })).rejects.toThrow("must identify a Git tree");
  });

  test("rejects both tracked and untracked vault changes", async () => {
    for (const status of [" M kb/note.md\n", "?? kb/untracked.md\n"]) {
      const { repository, root } = await emptyRepositoryFixture();
      const git = gitFixture({ status });
      expect(verifyFrozenEvaluationSnapshot({
        corpus: corpus(),
        repository,
        root,
        runGit: git.provider,
      })).rejects.toThrow("tracked or untracked changes");
      expect(git.requests.at(-1)?.arguments).toEqual([
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        "kb",
      ]);
    }
  });

  test("rejects roots outside the repository, mismatched roots, and symlink escapes before Git", async () => {
    const repository = await mkdtemp(join(tmpdir(), "hraness-kb-evaluation-confinement-"));
    const outside = await mkdtemp(join(tmpdir(), "hraness-kb-evaluation-outside-"));
    temporaryRoots.push(repository, outside);
    const root = join(repository, "kb");
    const other = join(repository, "other");
    await mkdir(root);
    await mkdir(other);
    const git = gitFixture();

    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root: outside,
      runGit: git.provider,
    })).rejects.toThrow("inside the repository");
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root: other,
      runGit: git.provider,
    })).rejects.toThrow("resolve to frozen.vaultRoot");

    const linked = join(repository, "linked");
    await symlink(outside, linked);
    expect(verifyFrozenEvaluationSnapshot({
      corpus: {
        frozen: { repositoryCommit: HEAD, vaultTree: TREE, vaultRoot: "linked" },
      },
      repository,
      root: linked,
      runGit: git.provider,
    })).rejects.toThrow("inside the repository");
    expect(git.requests).toEqual([]);
  });

  test("rejects a repository argument below the Git working-tree root", async () => {
    const { repository, root } = await emptyRepositoryFixture();
    const git = gitFixture({ prefix: "nested/" });
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root,
      runGit: git.provider,
    })).rejects.toThrow("must be the Git working-tree root");
    expect(git.requests.map((request) => request.arguments)).toEqual([
      ["rev-parse", "--show-prefix"],
    ]);
  });

  test("surfaces bounded Git provider failures as snapshot errors", async () => {
    const { repository, root } = await emptyRepositoryFixture();
    expect(verifyFrozenEvaluationSnapshot({
      corpus: corpus(),
      repository,
      root,
      runGit: () => Promise.resolve({ status: "unavailable", message: "git absent" }),
    })).rejects.toBeInstanceOf(FrozenEvaluationSnapshotError);
  });
});

const semanticUpdate = {
  collections: 1,
  indexed: 0,
  updated: 0,
  unchanged: 10,
  removed: 0,
  needsEmbedding: 0,
} as const;

function semanticHit(path: string, source: SemanticSearchHit["source"]): SemanticSearchHit {
  return {
    path,
    title: path,
    score: 0.8,
    source,
    docid: path,
    line: 4,
    snippet: `Semantic evidence for ${path}`,
    signals: { keyword: source !== "vec", semantic: source !== "fts" },
    tags: [],
    metadata: {},
    inboundContextualCount: 0,
    outboundContextualCount: 0,
    backlinks: [],
  };
}

async function adapterRepositoryFixture(): Promise<{
  readonly repository: string;
  readonly root: string;
  readonly contextId: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "hraness-kb-evaluation-adapters-"));
  temporaryRoots.push(repository);
  const root = join(repository, "kb");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, "scopes"), { recursive: true });
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src", "file.ts"), "export const value = 1;\n", "utf8");
  await writeFile(
    join(repository, "src", "AGENTS.md"),
    `${agentContextMarkerForScope("src")}\n# Contents\n\n# Guidelines\n`,
    "utf8",
  );
  await writeFile(join(root, "index.md"), "# Evaluation vault\n", "utf8");

  const notes: Readonly<Record<string, string>> = {
    "exact.md": "# Exact\n\nSTRUCTURED_EXACT_TOKEN belongs to this note.\n",
    "keyword.md": "# Keyword\n\nKeyword fixture.\n",
    "semantic.md": "# Semantic\n\nSemantic fixture.\n",
    "hybrid.md": "# Hybrid\n\nSTRUCTURED_HYBRID_TOKEN belongs here.\n",
    "selected.md": [
      "---",
      "type: note",
      "status: selected",
      "---",
      "# Selected metadata",
      "",
    ].join("\n"),
    "graph-a.md": "# Graph A\n\n[[notes/graph-b]]\n",
    "graph-b.md": "# Graph B\n\n[[notes/graph-a]]\n",
    "direct-history.md": "# Direct history\n",
    "searched-history.md": "# Searched history\n",
    "file-memory.md": [
      "---",
      "type: note",
      "repository_scopes: [src/file.ts]",
      "---",
      "# File memory",
      "",
      "Exact file-owned memory.",
      "",
    ].join("\n"),
    "parent-memory.md": [
      "---",
      "type: note",
      "repository_scopes: [src]",
      "---",
      "# Parent memory",
      "",
      "Directory-owned memory.",
      "",
    ].join("\n"),
  };
  await Promise.all(Object.entries(notes).map(([name, source]) =>
    writeFile(join(root, "notes", name), source, "utf8")));

  const contextId = agentContextNoteId("src");
  await writeFile(
    join(root, agentContextNotePath("src")),
    [
      "---",
      "type: agent-context",
      "scope: src",
      "---",
      "# Source context",
      "",
    ].join("\n"),
    "utf8",
  );
  return { repository, root, contextId };
}

function query(inputs: EvaluationRetrievalInputs): EvaluationQuery {
  return {
    id: "adapter-query",
    get text(): string {
      throw new Error("The adapter parsed human query prose.");
    },
    class: "conceptual-recall",
    split: "test",
    answer: "answerable",
    inputs,
    qrels: [],
    assessorIds: ["assessor"],
    adjudication: { status: "not-required" },
  };
}

async function retrieve(
  evaluation: KnowledgeBaseEvaluation,
  frozen: RetrievalEvaluationCorpus["frozen"],
  id: string,
  inputs: EvaluationRetrievalInputs,
  limit = 20,
): Promise<EvaluationRetrieverResult> {
  const retriever = evaluation.retrievers.find((candidate) => candidate.id === id);
  if (retriever === undefined) throw new Error(`Missing retriever ${id}.`);
  return await retriever.retrieve({
    corpus: frozen,
    query: query(inputs),
    limit,
    signal: new AbortController().signal,
  }) as EvaluationRetrieverResult;
}

describe("built-in knowledge-base evaluation retrievers", () => {
  test("opens one scan and session, runs every fixed lane, preserves evidence, and closes lazily opened state", async () => {
    const fixture = await adapterRepositoryFixture();
    const manifest = corpus();
    const git = gitFixture();
    const embeddingModelFile = join(fixture.repository, "verified-model.gguf");
    const structuredTextQueries: string[] = [];
    let scans = 0;
    let semanticOpens = 0;
    let semanticCloses = 0;
    let gitIndexes = 0;
    const semanticSession: SemanticSearchSession = {
      root: fixture.root,
      database: join(fixture.root, "semantic.sqlite"),
      model: "fixture-model",
      update: semanticUpdate,
      search: (options: SemanticSessionSearchOptions): Promise<SemanticSearchResult> => {
        structuredTextQueries.push(options.query);
        if (options.query === "STRUCTURED_UNAVAILABLE_TOKEN") {
          return Promise.reject(new Error("fixture semantic lane unavailable"));
        }
        const mode = options.mode ?? "semantic";
        const selected = mode === "keyword"
          ? semanticHit("notes/keyword.md", "fts")
          : mode === "semantic"
            ? semanticHit("notes/semantic.md", "vec")
            : semanticHit("notes/hybrid.md", "hybrid");
        return Promise.resolve({
          root: fixture.root,
          database: join(fixture.root, "semantic.sqlite"),
          model: "fixture-model",
          mode,
          query: options.query,
          update: semanticUpdate,
          embedding: null,
          results: [selected],
        });
      },
      close: () => {
        semanticCloses += 1;
        return Promise.resolve();
      },
    };
    const evaluation = await openKnowledgeBaseEvaluation({
      corpus: manifest,
      repository: fixture.repository,
      root: fixture.root,
      embeddingModelFile,
      runGit: git.provider,
      scanVault: async (root, options) => {
        scans += 1;
        return await scanVault(root, options);
      },
      openSemanticSearchSession: (options) => {
        semanticOpens += 1;
        expect(options.embeddingModelFile).toBe(embeddingModelFile);
        return Promise.resolve(semanticSession);
      },
      indexGitHistory: (options): Promise<GitHistoryIndex> => {
        gitIndexes += 1;
        const commits = new Map([
          ["notes/direct-history", {
            subject: "historical-target direct rationale",
            changedPaths: ["kb/notes/direct-history.md", "src/file.ts"],
          }],
          ["notes/searched-history", {
            subject: "historical-target searched rationale",
            changedPaths: ["kb/notes/searched-history.md", "src/file.ts"],
          }],
        ]);
        return Promise.resolve({
          status: "ready",
          repository: fixture.repository,
          root: fixture.root,
          vaultPrefix: "kb",
          head: HEAD,
          scannedCommits: 2,
          notes: options.notes.flatMap((note) => {
            const commit = commits.get(note.id);
            return commit === undefined ? [] : [{
              id: note.id,
              path: note.path,
              repositoryPath: `kb/${note.path}`,
              commits: [{
                hash: note.id === "notes/direct-history" ? "c".repeat(40) : "d".repeat(40),
                committedAt: "2026-08-01T12:00:00.000Z",
                subject: commit.subject,
                changedPaths: commit.changedPaths,
              }],
            }];
          }),
        });
      },
    });

    expect(knowledgeBaseEvaluationRetrieverIds).toEqual([
      "exact",
      "keyword",
      "semantic",
      "hybrid",
      "metadata",
      "graph",
      "path-context",
      "git",
    ]);
    expect(evaluation.retrievers.map(({ id }) => id)).toEqual([
      ...knowledgeBaseEvaluationRetrieverIds,
    ]);
    expect(scans).toBe(1);

    const exact = await retrieve(evaluation, manifest.frozen, "exact", {
      text: "STRUCTURED_EXACT_TOKEN",
    });
    expect(exact).toMatchObject({
      status: "ready",
      hits: [{ documentId: "notes/exact", rank: 1, evidence: { mode: "exact" } }],
      diagnostics: [{ lane: "exact", status: "ready" }],
      resources: { resultCount: 1 },
    });
    expect(typeof exact.timings?.searchMs).toBe("number");
    expect(typeof exact.resources?.noteCount).toBe("number");

    const keyword = await retrieve(evaluation, manifest.frozen, "keyword", {
      text: "STRUCTURED_KEYWORD_TOKEN",
    });
    expect(keyword).toMatchObject({
      status: "ready",
      hits: [{ documentId: "notes/keyword", rank: 1 }],
      diagnostics: [{ lane: "qmd", status: "ready" }],
    });

    const semantic = await retrieve(evaluation, manifest.frozen, "semantic", {
      text: "STRUCTURED_SEMANTIC_TOKEN",
    });
    expect(semantic).toMatchObject({
      status: "ready",
      hits: [{ documentId: "notes/semantic", rank: 1 }],
    });

    const hybrid = await retrieve(evaluation, manifest.frozen, "hybrid", {
      text: "STRUCTURED_HYBRID_TOKEN",
    });
    expect(hybrid).toMatchObject({
      status: "ready",
      hits: [{
        documentId: "notes/hybrid",
        rank: 1,
        evidence: {
          evidence: [{ kind: "exact" }, { kind: "qmd" }],
        },
      }],
    });

    const metadata = await retrieve(evaluation, manifest.frozen, "metadata", {
      metadata: {
        filters: [{ kind: "equals", path: "status", value: "selected" }],
        tags: [],
      },
    });
    expect(metadata).toMatchObject({
      status: "ready",
      hits: [{
        documentId: "notes/selected",
        rank: 1,
        evidence: { metadata: { status: "selected" } },
      }],
    });
    expect(typeof metadata.timings?.listMs).toBe("number");

    const graph = await retrieve(evaluation, manifest.frozen, "graph", {
      graph: { seeds: ["notes/graph-b", "notes/graph-a"], depth: 1 },
    });
    expect(graph.hits.map(({ documentId, rank }) => ({ documentId, rank }))).toEqual([
      { documentId: "notes/graph-b", rank: 1 },
      { documentId: "notes/graph-a", rank: 2 },
    ]);
    expect(graph.hits[0]?.evidence).toHaveProperty("neighborhoods");

    const pathContext = await retrieve(evaluation, manifest.frozen, "path-context", {
      context: { repositoryPath: "src/file.ts" },
    });
    expect(pathContext.status).toBe("ready");
    expect(pathContext.hits.map(({ documentId }) => documentId)).toEqual([
      fixture.contextId,
      "notes/file-memory",
      "notes/parent-memory",
    ]);
    expect(pathContext.hits.every(({ documentId }) => !documentId.endsWith("AGENTS.md"))).toBe(true);
    expect(pathContext.hits[0]?.evidence).toMatchObject({
      kind: "agent-context",
      scope: "src",
    });
    expect(pathContext.hits[1]?.evidence).toMatchObject({
      kind: "repository-memory",
      record: { matchedScope: "src/file.ts", match: "exact" },
    });
    expect(pathContext.hits[2]?.evidence).toMatchObject({
      kind: "repository-memory",
      record: { matchedScope: "src", match: "ancestor" },
    });

    const history = await retrieve(evaluation, manifest.frozen, "git", {
      history: {
        query: "historical-target",
        noteIds: ["notes/direct-history"],
      },
    });
    expect(history.hits.map(({ documentId, rank }) => ({ documentId, rank }))).toEqual([
      { documentId: "notes/direct-history", rank: 1 },
      { documentId: "notes/searched-history", rank: 2 },
    ]);
    expect(history.hits[0]?.evidence).toMatchObject({
      history: { id: "notes/direct-history" },
      search: { id: "notes/direct-history" },
    });
    expect(typeof history.timings?.searchHistoryMs).toBe("number");
    expect(typeof history.timings?.historyMs).toBe("number");

    expect(structuredTextQueries).toEqual([
      "STRUCTURED_KEYWORD_TOKEN",
      "STRUCTURED_SEMANTIC_TOKEN",
      "STRUCTURED_HYBRID_TOKEN",
    ]);
    expect(semanticOpens).toBe(1);
    expect(gitIndexes).toBe(1);
    await evaluation.close();
    await evaluation.close();
    expect(semanticCloses).toBe(1);
  });

  test("returns unavailable without touching a backend when a lane's structured input is missing", async () => {
    const fixture = await adapterRepositoryFixture();
    const manifest = corpus();
    let semanticOpens = 0;
    let gitIndexes = 0;
    let contextInspections = 0;
    let memoryBuilds = 0;
    const evaluation = await openKnowledgeBaseEvaluation({
      corpus: manifest,
      repository: fixture.repository,
      root: fixture.root,
      runGit: gitFixture().provider,
      openSemanticSearchSession: () => {
        semanticOpens += 1;
        return Promise.reject(new Error("must not open semantic state"));
      },
      indexGitHistory: () => {
        gitIndexes += 1;
        return Promise.reject(new Error("must not index Git"));
      },
      inspectAgentContextRepository: (...args) => {
        contextInspections += 1;
        throw new Error(`must not inspect context: ${args.length}`);
      },
      buildRepositoryMemoryContext: (...args) => {
        memoryBuilds += 1;
        throw new Error(`must not build memory: ${args.length}`);
      },
    });
    for (const id of knowledgeBaseEvaluationRetrieverIds) {
      const result = await retrieve(evaluation, manifest.frozen, id, {
        noteId: "notes/exact",
      });
      expect(result).toMatchObject({
        status: "unavailable",
        hits: [],
        diagnostics: [{ lane: id, status: "unavailable" }],
      });
    }
    expect({ semanticOpens, gitIndexes, contextInspections, memoryBuilds }).toEqual({
      semanticOpens: 0,
      gitIndexes: 0,
      contextInspections: 0,
      memoryBuilds: 0,
    });
    await evaluation.close();
  });

  test("preserves unavailable semantic diagnostics and distinguishes a degraded hybrid lane", async () => {
    const fixture = await adapterRepositoryFixture();
    const manifest = corpus();
    const session: SemanticSearchSession = {
      root: fixture.root,
      database: join(fixture.root, "semantic.sqlite"),
      model: "fixture-model",
      update: semanticUpdate,
      search: () => Promise.reject(new Error("fixture model unavailable")),
      close: () => Promise.resolve(),
    };
    const evaluation = await openKnowledgeBaseEvaluation({
      corpus: manifest,
      repository: fixture.repository,
      root: fixture.root,
      runGit: gitFixture().provider,
      openSemanticSearchSession: () => Promise.resolve(session),
    });

    const semantic = await retrieve(evaluation, manifest.frozen, "semantic", {
      text: "STRUCTURED_UNAVAILABLE_TOKEN",
    });
    expect(semantic).toMatchObject({
      status: "unavailable",
      hits: [],
      diagnostics: [{
        lane: "qmd",
        status: "unavailable",
        message: "fixture model unavailable",
      }],
      resources: { partial: 1 },
    });

    const hybrid = await retrieve(evaluation, manifest.frozen, "hybrid", {
      text: "STRUCTURED_UNAVAILABLE_TOKEN",
    });
    expect(hybrid).toMatchObject({
      status: "degraded",
      diagnostics: [
        { lane: "exact", status: "ready" },
        { lane: "qmd", status: "unavailable" },
      ],
    });
    await evaluation.close();
  });

  test("rejects Git evidence from a later HEAD", async () => {
    const fixture = await adapterRepositoryFixture();
    const manifest = corpus();
    const evaluation = await openKnowledgeBaseEvaluation({
      corpus: manifest,
      repository: fixture.repository,
      root: fixture.root,
      runGit: gitFixture().provider,
      indexGitHistory: (options): Promise<GitHistoryIndex> => Promise.resolve({
        status: "ready",
        repository: fixture.repository,
        root: fixture.root,
        vaultPrefix: "kb",
        head: "f".repeat(40),
        scannedCommits: 1,
        notes: options.notes.map((note) => ({
          id: note.id,
          path: note.path,
          repositoryPath: `kb/${note.path}`,
          commits: [],
        })),
      }),
    });
    expect(retrieve(evaluation, manifest.frozen, "git", {
      history: { query: "later", noteIds: [] },
    })).rejects.toThrow("expected frozen commit");
    await evaluation.close();
  });
});
