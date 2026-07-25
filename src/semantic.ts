import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Backlink, MetadataObject, Note, NoteConnections } from "./graph.js";
import { scanVault, type VaultSnapshot } from "./vault.js";

/** QMD 2.5.3's small English-optimized default. The package version pins the contract. */
export const recommendedEmbeddingModel =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

const collectionName = "oh";
const markdownPattern = "**/*.md";
// Keep this widened: a literal dynamic import makes TypeScript load QMD's public declarations.
const qmdModuleSpecifier: string = "@tobilu/qmd";

export type SemanticSearchMode = "keyword" | "semantic";

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
  readonly source: "fts" | "vec";
  readonly docid: string;
  readonly modifiedAt: string;
  readonly line?: number;
  readonly snippet: string;
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
  readonly results: readonly SemanticSearchHit[];
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
  readonly getDocumentBody: (path: string) => Promise<string | null>;
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
  return join(cacheHome(dependencies), "hraness-oh", "indexes", `${identity}.sqlite`);
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

function parseSearchResults(value: unknown): readonly SemanticSearchDocument[] {
  return boundaryArray(value, "QMD search results")
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
  const getDocumentBody = boundUnknownMethod(store, "getDocumentBody", "QMD store");
  const searchLex = boundUnknownMethod(store, "searchLex", "QMD store");
  const searchVector = boundUnknownMethod(store, "searchVector", "QMD store");
  const update = boundUnknownMethod(store, "update", "QMD store");
  return {
    close: async () => {
      await close();
    },
    embed: async (options) => parseEmbeddingResult(await embed(options)),
    getDocumentBody: async (path) => {
      const body = await getDocumentBody(path);
      if (body !== null && typeof body !== "string") {
        throw new Error("QMD document body must be a string or null.");
      }
      return body;
    },
    searchLex: async (query, options) => parseSearchResults(await searchLex(query, options)),
    searchVector: async (query, options) => parseSearchResults(await searchVector(query, options)),
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
    global_context:
      "A Markdown knowledge base. Source records preserve evidence; maintained notes contain current synthesis; explicit wikilinks define structural relationships.",
    collections: {
      [collectionName]: {
        path: root,
        pattern: markdownPattern,
        ignore: ["index.md", "**/AGENTS.md"],
        context: {
          "/": "Knowledge-base notes, clipped sources, plans, reports, and explicit contextual links.",
          "/articles": "Captured source records and their acquisition provenance.",
          "/notes": "Maintained concepts, comparisons, and current synthesis.",
          "/plans": "Decisions, constraints, execution state, and verification evidence.",
          "/riffs": "Voice-preserving first-person source thought.",
        },
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
    chunkStrategy: "regex",
  });
}

/** Build or incrementally refresh the local QMD vector index for one vault. */
export async function indexSemanticVault(
  options: SemanticIndexOptions,
  dependencies: SemanticDependencies = {},
): Promise<SemanticIndexResult> {
  const root = await resolvedDirectory(options.root);
  const database = databaseFor(root, options.database, dependencies);
  const store = await openStore(root, database, dependencies);
  try {
    const update = await store.update({ collections: [collectionName] });
    const embedding = await embedChanged(store, update, options.force ?? false);
    return { root, database, model: recommendedEmbeddingModel, update, embedding };
  } finally {
    await store.close();
  }
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

function qmdNoteLookup(notes: readonly Note[]): QmdNoteLookup {
  const lookup = new Map<string, Map<string, Note[]>>();
  for (const note of notes) {
    const qmdPath = qmdHandelize(note.path);
    if (qmdPath === null) continue;
    const contentHash = createHash("sha256").update(note.content).digest("hex");
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
  root: string,
  result: SemanticSearchDocument,
  notesByPath: ReadonlyMap<string, Note>,
  notesByQmdPath: QmdNoteLookup,
): Promise<Note | null> {
  const virtualPath = qmdVirtualNotePath(result.filepath);
  if (virtualPath !== undefined) {
    if (virtualPath === null) return null;
    const candidates = notesByQmdPath.get(virtualPath)?.get(result.hash) ?? [];
    const candidate = candidates[0];
    return candidates.length === 1 && candidate !== undefined ? candidate : null;
  }
  if (!isAbsolute(result.filepath)) return null;
  let filepath: string;
  try {
    filepath = await realpath(resolve(result.filepath));
  } catch {
    return null;
  }
  const candidate = relative(root, filepath);
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    return null;
  }
  const note = notesByPath.get(candidate.split(sep).join("/"));
  return note ?? null;
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
  store: SearchStore,
  root: string,
  query: string,
  result: SemanticSearchDocument,
  notesByPath: ReadonlyMap<string, Note>,
  notesByQmdPath: QmdNoteLookup,
  connectionsById: ReadonlyMap<string, NoteConnections>,
): Promise<SemanticSearchHit | null> {
  const note = await resolvedSearchNote(root, result, notesByPath, notesByQmdPath);
  if (note === null) return null;
  const currentHash = createHash("sha256").update(note.content).digest("hex");
  if (result.hash !== currentHash) return null;
  const connection = connectionsById.get(note.id);
  const body = await store.getDocumentBody(result.filepath) ?? "";
  if (body !== note.content) return null;
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

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Search limit must be an integer from 1 through 100.");
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

/** Incrementally synchronize the vault, then run local BM25 or embedding search. */
export async function searchSemanticVault(
  options: SemanticSearchOptions,
  dependencies: SemanticDependencies = {},
): Promise<SemanticSearchResult> {
  const query = options.query.trim();
  if (query === "") throw new Error("Search query must not be empty.");
  const root = await resolvedDirectory(options.root);
  const database = databaseFor(root, options.database, dependencies);
  const mode = options.mode ?? "semantic";
  const limit = boundedLimit(options.limit);
  const minScore = boundedScore(options.minScore);
  const store = await openStore(root, database, dependencies);
  try {
    const update = await store.update({ collections: [collectionName] });
    const embedding = mode === "semantic" ? await embedChanged(store, update, false) : null;
    const matches = mode === "semantic"
      ? await store.searchVector(query, { collection: collectionName, limit })
      : await store.searchLex(query, { collection: collectionName, limit });
    const snapshot = await (dependencies.scanVault ?? scanVault)(root);
    const notesByPath = new Map(snapshot.notes.map((note) => [note.path, note]));
    const notesByQmdPath = qmdNoteLookup(snapshot.notes);
    const connectionsById = new Map(
      snapshot.analysis.noteConnections.map((connection) => [connection.id, connection]),
    );
    const hits = await Promise.all(
      matches
        .filter(({ score }) => score >= minScore)
        .map((result) =>
          searchHit(store, root, query, result, notesByPath, notesByQmdPath, connectionsById)),
    );
    return {
      root,
      database,
      model: recommendedEmbeddingModel,
      mode,
      query,
      update,
      embedding,
      results: hits.filter((hit): hit is SemanticSearchHit => hit !== null),
    };
  } finally {
    await store.close();
  }
}
