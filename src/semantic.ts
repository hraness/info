import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Backlink, MetadataObject, Note, NoteConnections } from "./graph.js";
import {
  describeSemanticProjection,
  prepareSemanticProjection,
  resolveSemanticDatabase,
  withSemanticGenerationWriterLease,
  type SemanticIndexIdentity,
  type SemanticProjection,
  type SemanticWriterLeaseOptions,
} from "./semantic-runtime.js";
import { fuseRankedCandidates, validateSearchQuery } from "./search.js";
import { scanVault, type VaultSnapshot } from "./vault.js";

/** QMD's small local default at an immutable Hugging Face repository revision. */
export const recommendedEmbeddingModel =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf#0f741b5a6585bd53aeb15cd1372c56f2a0f65e12";

const semanticIndexSchema = 1;
const qmdVersion = "2.5.3";
const collectionName = "kb";
const markdownPattern = "**/*.md";
const ignoredPatterns = ["index.md", "**/AGENTS.md"] as const;
const embeddingChunkStrategy = "regex";
const globalContext =
  "A Markdown knowledge base. Source records preserve evidence; maintained notes contain current synthesis; explicit wikilinks define structural relationships.";
const collectionContext = {
  "/": "Knowledge-base notes, clipped sources, plans, reports, and explicit contextual links.",
  "/articles": "Captured source records and their acquisition provenance.",
  "/notes": "Maintained concepts, comparisons, and current synthesis.",
  "/plans": "Decisions, constraints, execution state, and verification evidence.",
  "/riffs": "Voice-preserving first-person source thought.",
} as const;
const semanticIndexIdentity: SemanticIndexIdentity = {
  producer: { package: "@hraness/kb", schema: semanticIndexSchema },
  indexer: { package: "@tobilu/qmd", version: qmdVersion },
  collection: {
    name: collectionName,
    pattern: markdownPattern,
    ignore: ignoredPatterns,
    globalContext,
    pathContexts: Object.entries(collectionContext).map(([path, context]) => ({ path, context })),
  },
  embedding: {
    model: recommendedEmbeddingModel,
    chunkStrategy: embeddingChunkStrategy,
  },
};
// Keep this widened: a literal dynamic import makes TypeScript load QMD's public declarations.
const qmdModuleSpecifier: string = "@tobilu/qmd";

export type SemanticSearchMode = "hybrid" | "keyword" | "semantic";

export type SemanticIndexOptions = {
  readonly root: string;
  readonly database?: string;
  readonly force?: boolean;
};

export type SemanticSearchOptions = {
  readonly root: string;
  readonly query: string;
  readonly database?: string;
  readonly mode?: SemanticSearchMode;
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly minScore?: number;
};

export type SemanticCollectionConfig = {
  readonly global_context?: string;
  readonly collections: Readonly<Record<string, {
    readonly path: string;
    readonly pattern: string;
    readonly ignore?: readonly string[];
    readonly context?: Readonly<Record<string, string>>;
  }>>;
  readonly models?: {
    readonly embed?: string;
  };
};

export type SemanticStoreOptions = {
  readonly dbPath: string;
  readonly config: SemanticCollectionConfig;
};

export type SemanticUpdateResult = {
  readonly collections: number;
  readonly indexed: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly needsEmbedding: number;
};

export type SemanticEmbeddingFailure = {
  readonly path: string;
  readonly hash: string;
  readonly seq: number;
  readonly attempts: number;
  readonly reason: string;
};

export type SemanticEmbeddingResult = {
  readonly docsProcessed: number;
  readonly chunksEmbedded: number;
  readonly errors: number;
  readonly failures?: readonly SemanticEmbeddingFailure[];
  readonly durationMs: number;
};

export type SemanticIndexResult = {
  readonly root: string;
  readonly database: string;
  readonly model: string;
  readonly update: SemanticUpdateResult;
  readonly embedding: SemanticEmbeddingResult | null;
};

export type SemanticSearchHit = {
  readonly path: string;
  readonly title: string;
  readonly score: number;
  readonly source: "fts" | "hybrid" | "vec";
  readonly docid: string;
  readonly modifiedAt?: string;
  readonly line?: number;
  readonly snippet: string;
  readonly signals?: {
    readonly keyword: boolean;
    readonly semantic: boolean;
  };
  readonly tags: readonly string[];
  readonly metadata: MetadataObject;
  readonly inboundContextualCount: number;
  readonly outboundContextualCount: number;
  readonly backlinks: readonly Backlink[];
};

export type SemanticSearchResult = {
  readonly root: string;
  readonly database: string;
  readonly model: string;
  readonly mode: SemanticSearchMode;
  readonly query: string;
  readonly update: SemanticUpdateResult;
  readonly embedding: SemanticEmbeddingResult | null;
  /** Raw backend-window evidence for post-filter completeness diagnostics. */
  readonly rawWindow?: {
    readonly requested: number;
    readonly returned: number;
    /** Rows rejected because they could not reconcile to this live snapshot. */
    readonly discarded: number;
    /** Rows intentionally excluded by the caller's minimum score. */
    readonly thresholdRejected: number;
    /** True when QMD returned fewer raw rows than the requested backend window. */
    readonly exhausted: boolean;
  };
  readonly results: readonly SemanticSearchHit[];
};

export type SemanticSessionOptions = {
  readonly root: string;
  readonly database?: string;
};

export type SemanticSessionSearchOptions = Omit<
  SemanticSearchOptions,
  "root" | "database"
>;

export type SemanticSearchSession = {
  readonly root: string;
  readonly database: string;
  readonly model: string;
  readonly update: SemanticUpdateResult;
  /** Searches share one live vault snapshot and one serialized QMD store. */
  readonly search: (
    options: SemanticSessionSearchOptions,
  ) => Promise<SemanticSearchResult>;
  /** Idempotently close the owned QMD store after queued searches settle. */
  readonly close: () => Promise<void>;
};

type SemanticSearchDocument = {
  readonly filepath: string;
  readonly title: string;
  readonly hash: string;
  readonly docid: string;
  readonly modifiedAt: string;
  readonly score: number;
  readonly source: "fts" | "vec";
  readonly chunkPos?: number;
};

type SearchStore = {
  readonly close: () => Promise<void>;
  readonly update: (options: { readonly collections: readonly string[] }) => Promise<SemanticUpdateResult>;
  readonly embed: (options: {
    readonly collection: string;
    readonly force: boolean;
    readonly model: string;
    readonly chunkStrategy: "regex";
  }) => Promise<SemanticEmbeddingResult>;
  readonly searchLex: (
    query: string,
    options: { readonly collection: string; readonly limit: number },
  ) => Promise<readonly SemanticSearchDocument[]>;
  readonly searchVector: (
    query: string,
    options: { readonly collection: string; readonly limit: number },
  ) => Promise<readonly SemanticSearchDocument[]>;
};

export type SemanticDependencies = {
  readonly createStore?: (options: SemanticStoreOptions) => Promise<unknown>;
  readonly cacheHome?: string;
  readonly scanVault?: (root: string) => Promise<VaultSnapshot>;
  readonly writerLease?: SemanticWriterLeaseOptions;
};

function cacheHome(dependencies: SemanticDependencies): string {
  const configured = dependencies.cacheHome ?? process.env.XDG_CACHE_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    return isAbsolute(configured) ? configured : resolve(configured);
  }
  return join(homedir(), ".cache");
}

export function semanticDatabasePath(root: string, dependencies: SemanticDependencies = {}): string {
  const identity = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 20);
  return join(cacheHome(dependencies), "hraness-kb", "indexes", `${identity}.sqlite`);
}

async function resolvedDirectory(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory()) throw new Error("Knowledge-base root must be a directory.");
  return root;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundaryRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function boundaryString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function boundaryNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function boundaryCount(value: unknown, label: string): number {
  const number = boundaryNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function boundaryArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function parseUpdateResult(value: unknown): SemanticUpdateResult {
  const result = boundaryRecord(value, "QMD update result");
  return {
    collections: boundaryCount(result.collections, "QMD update result.collections"),
    indexed: boundaryCount(result.indexed, "QMD update result.indexed"),
    updated: boundaryCount(result.updated, "QMD update result.updated"),
    unchanged: boundaryCount(result.unchanged, "QMD update result.unchanged"),
    removed: boundaryCount(result.removed, "QMD update result.removed"),
    needsEmbedding: boundaryCount(
      result.needsEmbedding,
      "QMD update result.needsEmbedding",
    ),
  };
}

function parseEmbeddingFailure(value: unknown, index: number): SemanticEmbeddingFailure {
  const label = `QMD embedding result.failures[${index}]`;
  const failure = boundaryRecord(value, label);
  return {
    path: boundaryString(failure.path, `${label}.path`),
    hash: boundaryString(failure.hash, `${label}.hash`),
    seq: boundaryCount(failure.seq, `${label}.seq`),
    attempts: boundaryCount(failure.attempts, `${label}.attempts`),
    reason: boundaryString(failure.reason, `${label}.reason`),
  };
}

function parseEmbeddingResult(value: unknown): SemanticEmbeddingResult {
  const result = boundaryRecord(value, "QMD embedding result");
  const failures = result.failures === undefined
    ? undefined
    : boundaryArray(result.failures, "QMD embedding result.failures")
        .map((failure, index) => parseEmbeddingFailure(failure, index));
  return {
    docsProcessed: boundaryCount(result.docsProcessed, "QMD embedding result.docsProcessed"),
    chunksEmbedded: boundaryCount(result.chunksEmbedded, "QMD embedding result.chunksEmbedded"),
    errors: boundaryCount(result.errors, "QMD embedding result.errors"),
    ...(failures === undefined ? {} : { failures }),
    durationMs: boundaryNumber(result.durationMs, "QMD embedding result.durationMs"),
  };
}

function parseSearchDocument(value: unknown, index: number): SemanticSearchDocument {
  const label = `QMD search result[${index}]`;
  const result = boundaryRecord(value, label);
  const source = result.source;
  if (source !== "fts" && source !== "vec") {
    throw new Error(`${label}.source must be "fts" or "vec".`);
  }
  const chunkPos = result.chunkPos === undefined
    ? undefined
    : boundaryCount(result.chunkPos, `${label}.chunkPos`);
  return {
    filepath: boundaryString(result.filepath, `${label}.filepath`),
    title: boundaryString(result.title, `${label}.title`),
    hash: boundaryString(result.hash, `${label}.hash`),
    docid: boundaryString(result.docid, `${label}.docid`),
    modifiedAt: boundaryString(result.modifiedAt, `${label}.modifiedAt`),
    score: boundaryNumber(result.score, `${label}.score`),
    source,
    ...(chunkPos === undefined ? {} : { chunkPos }),
  };
}

function boundedResultArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  const results = boundaryArray(value, label);
  if (results.length > maximum) {
    throw new Error(`${label} returned more than the requested ${maximum} results.`);
  }
  return results;
}

function parseSearchResults(
  value: unknown,
  maximum: number,
): readonly SemanticSearchDocument[] {
  return boundedResultArray(value, "QMD search results", maximum)
    .map((result, index) => parseSearchDocument(result, index));
}

type UnknownMethod = (...arguments_: unknown[]) => Promise<unknown>;

function boundUnknownMethod(
  owner: Readonly<Record<string, unknown>>,
  name: string,
  label: string,
): UnknownMethod {
  const method = owner[name];
  if (typeof method !== "function") throw new Error(`${label}.${name} must be a function.`);
  return async (...arguments_) => {
    const returned: unknown = Reflect.apply(method, owner, arguments_);
    return await returned;
  };
}

function parseSearchStore(value: unknown): SearchStore {
  const store = boundaryRecord(value, "QMD store");
  const close = boundUnknownMethod(store, "close", "QMD store");
  const embed = boundUnknownMethod(store, "embed", "QMD store");
  const searchLex = boundUnknownMethod(store, "searchLex", "QMD store");
  const searchVector = boundUnknownMethod(store, "searchVector", "QMD store");
  const update = boundUnknownMethod(store, "update", "QMD store");
  return {
    close: async () => {
      await close();
    },
    embed: async (options) => parseEmbeddingResult(await embed(options)),
    searchLex: async (query, options) =>
      parseSearchResults(await searchLex(query, options), options.limit),
    searchVector: async (query, options) =>
      parseSearchResults(await searchVector(query, options), options.limit),
    update: async (options) => parseUpdateResult(await update(options)),
  };
}

async function closeMalformedStore(value: unknown): Promise<void> {
  if (!isRecord(value)) return;
  const close = value.close;
  if (typeof close !== "function") return;
  try {
    const returned: unknown = Reflect.apply(close, value, []);
    await returned;
  } catch {
    // Preserve the boundary error that explains why the store was rejected.
  }
}

async function openedSearchStore(value: unknown): Promise<SearchStore> {
  try {
    return parseSearchStore(value);
  } catch (error: unknown) {
    await closeMalformedStore(value);
    throw error;
  }
}

function storeConfig(root: string): SemanticCollectionConfig {
  return {
    global_context: globalContext,
    collections: {
      [collectionName]: {
        path: root,
        pattern: markdownPattern,
        ignore: ignoredPatterns,
        context: collectionContext,
      },
    },
    models: { embed: recommendedEmbeddingModel },
  };
}

async function defaultCreateStore(options: SemanticStoreOptions): Promise<unknown> {
  const loaded: unknown = await import(qmdModuleSpecifier);
  const module = boundaryRecord(loaded, "QMD module");
  const createStore = boundUnknownMethod(module, "createStore", "QMD module");
  return await createStore(options);
}

async function openStore(
  root: string,
  database: string,
  dependencies: SemanticDependencies,
): Promise<SearchStore> {
  await mkdir(dirname(database), { recursive: true });
  const created = await (dependencies.createStore ?? defaultCreateStore)({
    dbPath: database,
    config: storeConfig(root),
  });
  return await openedSearchStore(created);
}

function databaseFor(
  root: string,
  requested: string | undefined,
  dependencies: SemanticDependencies,
): string {
  if (requested === undefined) return semanticDatabasePath(root, dependencies);
  return resolve(requested);
}

async function embedChanged(
  store: SearchStore,
  update: SemanticUpdateResult,
  force: boolean,
): Promise<SemanticEmbeddingResult | null> {
  if (!force && update.needsEmbedding === 0) return null;
  return await store.embed({
    collection: collectionName,
    force,
    model: recommendedEmbeddingModel,
    chunkStrategy: embeddingChunkStrategy,
  });
}

async function semanticSnapshot(
  root: string,
  dependencies: SemanticDependencies,
): Promise<VaultSnapshot> {
  return await (dependencies.scanVault
    ?? ((vaultRoot: string) => scanVault(vaultRoot, { mentionScope: false })))(root);
}

/** Build or incrementally refresh the local QMD vector index for one vault. */
export async function indexSemanticVault(
  options: SemanticIndexOptions,
  dependencies: SemanticDependencies = {},
): Promise<SemanticIndexResult> {
  const root = await resolvedDirectory(options.root);
  const databaseCandidate = await resolveSemanticDatabase(
    databaseFor(root, options.database, dependencies),
    root,
  );
  const snapshot = await semanticSnapshot(root, dependencies);
  const description = await describeSemanticProjection(
    databaseCandidate,
    root,
    snapshot.notes,
    semanticIndexIdentity,
  );
  const database = description.database;
  return await withSemanticGenerationWriterLease(
    database,
    description.manifest.generation,
    async () => {
      const projection = await prepareSemanticProjection(description, snapshot.notes);
      let store: SearchStore | undefined;
      try {
        store = await openStore(projection.root, database, dependencies);
        const update = await store.update({ collections: [collectionName] });
        const embedding = await embedChanged(store, update, options.force ?? false);
        return { root, database, model: recommendedEmbeddingModel, update, embedding };
      } finally {
        try {
          await store?.close();
        } finally {
          await projection.release();
        }
      }
    },
    {
      ...dependencies.writerLease,
      excludeReaders: options.force === true,
    },
  );
}

function qmdEmojiToHex(value: string): string {
  return value.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) =>
    [...run]
      .filter((character) => /\p{So}|\p{Sk}/u.test(character))
      .map((character) => character.codePointAt(0)?.toString(16) ?? "")
      .join("-"));
}

/** Owned equivalent of QMD 2.5.3's pinned handelize path transform. */
function qmdHandelize(path: string): string | null {
  if (path.trim() === "") return null;
  const segments = path.split("/").filter((segment) => segment !== "");
  const lastSegment = segments.at(-1) ?? "";
  const filenameWithoutExtension = lastSegment.replace(/\.[^.]+$/u, "");
  if (!/[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExtension)) return null;
  const result = path
    .replaceAll("___", "/")
    .split("/")
    .map((rawSegment, index, allSegments) => {
      const segment = qmdEmojiToHex(rawSegment);
      if (index === allSegments.length - 1) {
        const extension = segment.match(/(\.[a-z0-9]+)$/iu)?.[1] ?? "";
        const name = extension === "" ? segment : segment.slice(0, -extension.length);
        return name
          .replace(/[^\p{L}\p{N}$]+/gu, "-")
          .replace(/^-+|-+$/gu, "") + extension;
      }
      return segment
        .replace(/[^\p{L}\p{N}$]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    })
    .filter((segment) => segment !== "")
    .join("/");
  return result === "" ? null : result;
}

type QmdNoteLookup = ReadonlyMap<string, ReadonlyMap<string, readonly Note[]>>;

function qmdNoteLookup(
  notes: readonly Note[],
  contentHashesByPath: ReadonlyMap<string, string>,
): QmdNoteLookup {
  const lookup = new Map<string, Map<string, Note[]>>();
  for (const note of notes) {
    const qmdPath = qmdHandelize(note.path);
    if (qmdPath === null) continue;
    const contentHash = contentHashesByPath.get(note.path);
    if (contentHash === undefined) {
      throw new Error(`Semantic projection lost the hash for ${JSON.stringify(note.path)}.`);
    }
    const byHash = lookup.get(qmdPath) ?? new Map<string, Note[]>();
    const candidates = byHash.get(contentHash) ?? [];
    candidates.push(note);
    byHash.set(contentHash, candidates);
    lookup.set(qmdPath, byHash);
  }
  return lookup;
}

/** Undefined means a filesystem result; null means a rejected virtual result. */
function qmdVirtualNotePath(filepath: string): string | null | undefined {
  if (!filepath.startsWith("qmd://")) return undefined;
  const prefix = `qmd://${collectionName}/`;
  if (!filepath.startsWith(prefix)) return null;
  const path = filepath.slice(prefix.length);
  const segments = path.split("/");
  const hasControlCharacter = [...path].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (path === ""
    || path.includes("\\")
    || path.includes("?")
    || path.includes("#")
    || path.includes("%")
    || hasControlCharacter
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

async function resolvedSearchNote(
  projectionRoot: string,
  result: SemanticSearchDocument,
  notesByPath: ReadonlyMap<string, Note>,
  notesByQmdPath: QmdNoteLookup,
  contentHashesByPath: ReadonlyMap<string, string>,
): Promise<Note | null> {
  const virtualPath = qmdVirtualNotePath(result.filepath);
  if (virtualPath !== undefined) {
    if (virtualPath === null) return null;
    const candidates = notesByQmdPath.get(virtualPath)?.get(result.hash) ?? [];
    const candidate = candidates[0];
    return candidates.length === 1
      && candidate !== undefined
      && contentHashesByPath.get(candidate.path) === result.hash
      ? candidate
      : null;
  }
  if (!isAbsolute(result.filepath)) return null;
  let filepath: string;
  try {
    filepath = await realpath(resolve(result.filepath));
  } catch {
    return null;
  }
  const candidate = relative(projectionRoot, filepath);
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    return null;
  }
  const note = notesByPath.get(candidate.split(sep).join("/"));
  return note !== undefined && contentHashesByPath.get(note.path) === result.hash ? note : null;
}

function queryOffset(body: string, query: string, suggested: number | undefined): number {
  if (suggested !== undefined && Number.isSafeInteger(suggested) && suggested >= 0 && suggested <= body.length) {
    return suggested;
  }
  const terms = query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const lowerBody = body.toLocaleLowerCase("en-US");
  for (const term of terms.toSorted((left, right) => right.length - left.length)) {
    const offset = lowerBody.indexOf(term);
    if (offset !== -1) return offset;
  }
  return 0;
}

function boundedSnippet(body: string, offset: number): string {
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const maximum = 600;
  const start = Math.max(0, Math.min(normalized.length, offset) - 180);
  const end = Math.min(normalized.length, start + maximum);
  const value = normalized.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${value}${end < normalized.length ? "…" : ""}`;
}

async function searchHit(
  projectionRoot: string,
  query: string,
  result: SemanticSearchDocument,
  notesByPath: ReadonlyMap<string, Note>,
  notesByQmdPath: QmdNoteLookup,
  contentHashesByPath: ReadonlyMap<string, string>,
  connectionsById: ReadonlyMap<string, NoteConnections>,
): Promise<SemanticSearchHit | null> {
  const note = await resolvedSearchNote(
    projectionRoot,
    result,
    notesByPath,
    notesByQmdPath,
    contentHashesByPath,
  );
  if (note === null) return null;
  const connection = connectionsById.get(note.id);
  const body = note.content;
  const offset = queryOffset(body, query, result.chunkPos);
  return {
    path: note.path,
    title: note.title,
    score: result.score,
    source: result.source,
    docid: result.docid,
    modifiedAt: result.modifiedAt,
    ...(body === "" ? {} : { line: body.slice(0, offset).split("\n").length }),
    snippet: boundedSnippet(body, offset),
    tags: note.tags,
    metadata: note.metadata,
    inboundContextualCount: connection?.inboundContextualCount ?? 0,
    outboundContextualCount: connection?.outboundContextualCount ?? 0,
    backlinks: connection?.backlinks ?? [],
  };
}

type FusedSemanticDocument = {
  readonly document: SemanticSearchDocument;
  readonly score: number;
  readonly signals: {
    readonly keyword: boolean;
    readonly semantic: boolean;
  };
};

function semanticDocumentKey(document: SemanticSearchDocument): string {
  return JSON.stringify([document.filepath, document.hash]);
}

function firstDocumentsByKey(
  documents: readonly SemanticSearchDocument[],
): ReadonlyMap<string, SemanticSearchDocument> {
  const byKey = new Map<string, SemanticSearchDocument>();
  for (const document of documents) {
    const key = semanticDocumentKey(document);
    if (!byKey.has(key)) byKey.set(key, document);
  }
  return byKey;
}

function fusedHybridDocuments(
  lexical: readonly SemanticSearchDocument[],
  vector: readonly SemanticSearchDocument[],
  candidateLimit: number,
): readonly FusedSemanticDocument[] {
  const lexicalByKey = firstDocumentsByKey(lexical);
  const vectorByKey = firstDocumentsByKey(vector);
  return fuseRankedCandidates([
    { name: "keyword", weight: 1, ids: lexical.map(semanticDocumentKey) },
    { name: "semantic", weight: 1, ids: vector.map(semanticDocumentKey) },
  ]).slice(0, candidateLimit).map((candidate) => {
    const lexicalDocument = lexicalByKey.get(candidate.id);
    const vectorDocument = vectorByKey.get(candidate.id);
    const document = vectorDocument ?? lexicalDocument;
    if (document === undefined) {
      throw new Error("Fused QMD candidate lost its source document.");
    }
    return {
      document,
      score: candidate.score,
      signals: {
        keyword: candidate.contributions.some(({ lane }) => lane === "keyword"),
        semantic: candidate.contributions.some(({ lane }) => lane === "semantic"),
      },
    };
  });
}

async function hybridSearchHit(
  projectionRoot: string,
  query: string,
  result: FusedSemanticDocument,
  notesByPath: ReadonlyMap<string, Note>,
  notesByQmdPath: QmdNoteLookup,
  contentHashesByPath: ReadonlyMap<string, string>,
  connectionsById: ReadonlyMap<string, NoteConnections>,
): Promise<SemanticSearchHit | null> {
  const hit = await searchHit(
    projectionRoot,
    query,
    result.document,
    notesByPath,
    notesByQmdPath,
    contentHashesByPath,
    connectionsById,
  );
  if (hit === null) return null;
  return {
    ...hit,
    score: result.score,
    source: "hybrid",
    signals: result.signals,
  };
}

function boundedLimit(value: number | undefined, maximum: 100 | 500): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Search limit must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function boundedCandidateLimit(
  value: number | undefined,
  resultLimit: number,
): number {
  if (value === undefined) return Math.max(40, resultLimit * 4);
  if (!Number.isSafeInteger(value) || value < resultLimit || value > 500) {
    throw new Error(
      `Search candidate limit must be an integer from ${resultLimit} through 500.`,
    );
  }
  return value;
}

function boundedScore(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Minimum score must be a number from 0 through 1.");
  }
  return value;
}

function boundedMode(value: unknown): SemanticSearchMode {
  const mode = value ?? "semantic";
  if (mode !== "hybrid" && mode !== "keyword" && mode !== "semantic") {
    throw new Error('Search mode must be "hybrid", "keyword", or "semantic".');
  }
  return mode;
}

type SemanticSearchContext = {
  readonly root: string;
  readonly projectionRoot: string;
  readonly database: string;
  readonly store: SearchStore;
  readonly update: SemanticUpdateResult;
  readonly ensureEmbedding: () => Promise<SemanticEmbeddingResult | null>;
  readonly notesByPath: ReadonlyMap<string, Note>;
  readonly notesByQmdPath: QmdNoteLookup;
  readonly contentHashesByPath: ReadonlyMap<string, string>;
  readonly connectionsById: ReadonlyMap<string, NoteConnections>;
};

async function executeSemanticSearch(
  context: SemanticSearchContext,
  options: SemanticSessionSearchOptions,
): Promise<SemanticSearchResult> {
  const query = validateSearchQuery(options.query).query;
  const mode = boundedMode(options.mode);
  const limit = boundedLimit(options.limit, 500);
  const candidateLimit = boundedCandidateLimit(options.candidateLimit, limit);
  const minScore = boundedScore(options.minScore);
  const embedding = mode === "keyword"
    ? null
    : await context.ensureEmbedding();
  let hits: readonly (SemanticSearchHit | null)[];
  let rawRequested: number;
  let rawReturned: number;
  let rawDiscarded: number;
  let rawThresholdRejected: number;
  let rawExhausted: boolean;
  if (mode === "hybrid") {
    const lexical = await context.store.searchLex(query, {
      collection: collectionName,
      limit: candidateLimit,
    });
    const vector = await context.store.searchVector(query, {
      collection: collectionName,
      limit: candidateLimit,
    });
    const fused = fusedHybridDocuments(lexical, vector, candidateLimit);
    const considered = fused.filter(({ score }) => score >= minScore);
    rawRequested = candidateLimit;
    rawReturned = fused.length;
    rawThresholdRejected = fused.length - considered.length;
    rawExhausted = fused.length < candidateLimit
      && lexical.length < candidateLimit
      && vector.length < candidateLimit;
    hits = await Promise.all(considered.map((result) =>
      hybridSearchHit(
        context.projectionRoot,
        query,
        result,
        context.notesByPath,
        context.notesByQmdPath,
        context.contentHashesByPath,
        context.connectionsById,
      )));
    rawDiscarded = considered.length - hits.filter((hit) => hit !== null).length;
  } else {
    const matches = mode === "semantic"
      ? await context.store.searchVector(query, {
          collection: collectionName,
          limit: candidateLimit,
        })
      : await context.store.searchLex(query, {
          collection: collectionName,
          limit: candidateLimit,
        });
    rawRequested = candidateLimit;
    rawReturned = matches.length;
    const considered = matches.filter(({ score }) => score >= minScore);
    rawThresholdRejected = matches.length - considered.length;
    rawExhausted = matches.length < candidateLimit;
    hits = await Promise.all(considered
      .map((result) =>
        searchHit(
          context.projectionRoot,
          query,
          result,
          context.notesByPath,
          context.notesByQmdPath,
          context.contentHashesByPath,
          context.connectionsById,
        )));
    rawDiscarded = considered.length - hits.filter((hit) => hit !== null).length;
  }
  const verified = hits.filter((hit): hit is SemanticSearchHit => hit !== null);
  return {
    root: context.root,
    database: context.database,
    model: recommendedEmbeddingModel,
    mode,
    query,
    update: context.update,
    embedding,
    rawWindow: {
      requested: rawRequested,
      returned: rawReturned,
      discarded: rawDiscarded,
      thresholdRejected: rawThresholdRejected,
      exhausted: rawExhausted,
    },
    results: verified.slice(0, limit),
  };
}

/** Open one serialized QMD search session over one immutable live vault snapshot. */
export async function openSemanticSearchSession(
  options: SemanticSessionOptions,
  dependencies: SemanticDependencies = {},
): Promise<SemanticSearchSession> {
  const root = await resolvedDirectory(options.root);
  const databaseCandidate = await resolveSemanticDatabase(
    databaseFor(root, options.database, dependencies),
    root,
  );
  const snapshot = await semanticSnapshot(root, dependencies);
  const description = await describeSemanticProjection(
    databaseCandidate,
    root,
    snapshot.notes,
    semanticIndexIdentity,
  );
  const database = description.database;
  let retained: {
    readonly store: SearchStore;
    readonly projection: SemanticProjection;
  } | undefined;
  let initialized: {
    readonly store: SearchStore;
    readonly projection: SemanticProjection;
    readonly update: SemanticUpdateResult;
  };
  try {
    initialized = await withSemanticGenerationWriterLease(
      database,
      description.manifest.generation,
      async () => {
        const projection = await prepareSemanticProjection(description, snapshot.notes);
        let store: SearchStore | undefined;
        try {
          store = await openStore(projection.root, database, dependencies);
          retained = { store, projection };
          const update = await store.update({ collections: [collectionName] });
          return { store, projection, update };
        } catch (error: unknown) {
          try {
            await store?.close();
          } finally {
            await projection.release();
            retained = undefined;
          }
          throw error;
        }
      },
      dependencies.writerLease,
    );
  } catch (error: unknown) {
    await retained?.store.close().catch(() => undefined);
    await retained?.projection.release().catch(() => undefined);
    throw error;
  }
  const { store, projection, update } = initialized;
  const notesByPath = new Map(snapshot.notes.map((note) => [note.path, note]));
  const contentHashesByPath = new Map(
    description.manifest.notes.map(({ path, sha256 }) => [path, sha256]),
  );
  const notesByQmdPath = qmdNoteLookup(snapshot.notes, contentHashesByPath);
  const connectionsById = new Map(
    snapshot.analysis.noteConnections.map((connection) => [connection.id, connection]),
  );
  let embeddingPromise: Promise<SemanticEmbeddingResult | null> | undefined;
  const ensureEmbedding = (): Promise<SemanticEmbeddingResult | null> => {
    embeddingPromise ??= update.needsEmbedding === 0
      ? Promise.resolve(null)
      : withSemanticGenerationWriterLease(
          database,
          projection.manifest.generation,
          async () => {
            // Another process may have completed this generation's vectors while
            // the session waited. Refresh under the lease before writing.
            const refreshed = await store.update({ collections: [collectionName] });
            return await embedChanged(store, refreshed, false);
          },
          dependencies.writerLease,
        );
    return embeddingPromise;
  };
  let tail: Promise<void> = Promise.resolve();
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;
  const serialize = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const context: SemanticSearchContext = {
    root,
    projectionRoot: projection.root,
    database,
    store,
    update,
    ensureEmbedding,
    notesByPath,
    notesByQmdPath,
    contentHashesByPath,
    connectionsById,
  };
  return {
    root,
    database,
    model: recommendedEmbeddingModel,
    update,
    search: (searchOptions) => {
      if (closeRequested) {
        return Promise.reject(new Error("Semantic search session is closed."));
      }
      return serialize(() => executeSemanticSearch(context, searchOptions));
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closeRequested = true;
      closePromise = serialize(async () => {
        try {
          await store.close();
        } finally {
          await projection.release();
        }
      });
      return closePromise;
    },
  };
}

/** Incrementally synchronize the vault, then run local hybrid, BM25, or embedding search. */
export async function searchSemanticVault(
  options: SemanticSearchOptions,
  dependencies: SemanticDependencies = {},
): Promise<SemanticSearchResult> {
  const query = validateSearchQuery(options.query).query;
  const mode = boundedMode(options.mode);
  const limit = boundedLimit(options.limit, 100);
  const candidateLimit = boundedCandidateLimit(options.candidateLimit, limit);
  const minScore = boundedScore(options.minScore);
  const session = await openSemanticSearchSession(
    {
      root: options.root,
      ...(options.database === undefined ? {} : { database: options.database }),
    },
    dependencies,
  );
  try {
    return await session.search({
      query,
      mode,
      limit,
      candidateLimit,
      minScore,
    });
  } finally {
    await session.close();
  }
}
