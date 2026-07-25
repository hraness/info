// @bun
import {
  analyzeVault,
  parseNote,
  renderCatalog,
  replaceCatalog
} from "./index-rbfx133v.js";

// src/semantic.ts
import { createHash } from "crypto";
import { mkdir, realpath as realpath2, stat } from "fs/promises";
import { homedir } from "os";
import { dirname as dirname2, isAbsolute, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "path";

// src/vault.ts
import { randomUUID } from "crypto";
import { constants } from "fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
var defaultIgnoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules"
]);
async function markdownFiles(directory, ignoredDirectories = defaultIgnoredDirectories) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith("."))
      continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name))
        continue;
      files.push(...await markdownFiles(entryPath, ignoredDirectories));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
      files.push(entryPath);
    }
  }
  return files;
}
async function readVaultNotes(root, ignoredDirectories = defaultIgnoredDirectories) {
  const notes = [];
  for (const path of await markdownFiles(root, ignoredDirectories)) {
    const vaultPath = relative(root, path).split(sep).join("/");
    notes.push(parseNote(vaultPath, await readFile(path, "utf8")));
  }
  return notes;
}
function confined(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}
async function assertConfinedIndexParents(root, path) {
  if (!confined(root, path))
    throw new Error("The managed index must be a file inside the vault root.");
  const parent = dirname(path);
  const segments = relative(root, parent).split(sep).filter((segment) => segment !== "");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("The managed index path must not traverse a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Every managed index parent must be a directory.");
    }
  }
  const canonicalParent = await realpath(parent);
  if (!confined(root, join(canonicalParent, basename(path)))) {
    throw new Error("The managed index parent resolves outside the vault root.");
  }
}
async function readIndexRevision(root, path) {
  await assertConfinedIndexParents(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile())
      throw new Error("The managed index must be a regular file.");
    if (metadata.nlink !== 1n)
      throw new Error("The managed index must not be hard-linked.");
    const canonicalPath = await realpath(path);
    if (!confined(root, canonicalPath)) {
      throw new Error("The managed index resolves outside the vault root.");
    }
    return {
      content: await handle.readFile({ encoding: "utf8" }),
      device: metadata.dev,
      inode: metadata.ino,
      mode: Number(metadata.mode & 0o777n)
    };
  } finally {
    await handle.close();
  }
}
function sameRevision(left, right) {
  return left.device === right.device && left.inode === right.inode && left.content === right.content;
}
async function atomicReplace(root, path, content, expected) {
  const beforeWrite = await readIndexRevision(root, path);
  if (!sameRevision(beforeWrite, expected)) {
    throw new Error("The managed index changed during refresh; retry without overwriting the editor's changes.");
  }
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await assertConfinedIndexParents(root, path);
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, expected.mode);
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    const beforeRename = await readIndexRevision(root, path);
    if (!sameRevision(beforeRename, expected)) {
      throw new Error("The managed index changed during refresh; retry without overwriting the editor's changes.");
    }
    await assertConfinedIndexParents(root, path);
    await rename(temporaryPath, path);
  } catch (error) {
    if (!closed)
      await handle.close().catch(() => {
        return;
      });
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
    throw error;
  }
}
async function snapshot(rootInput, options, writeIndex) {
  const requestedRoot = resolve(rootInput);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory())
    throw new Error("The vault root must be a directory.");
  const indexPath = resolve(root, options.index ?? "index.md");
  const relativeIndex = relative(root, indexPath);
  if (!confined(root, indexPath)) {
    throw new Error("The managed index must be a file inside the vault root.");
  }
  if (!indexPath.toLowerCase().endsWith(".md")) {
    throw new Error("The managed index must be a Markdown file.");
  }
  const vaultIndexPath = relativeIndex.split(sep).join("/");
  const catalogNoteId = vaultIndexPath.toLowerCase().endsWith(".md") ? vaultIndexPath.slice(0, -3) : vaultIndexPath;
  const indexRevision = await readIndexRevision(root, indexPath);
  const currentIndex = indexRevision.content;
  const notes = await readVaultNotes(root, options.ignoredDirectories);
  const expectedIndex = replaceCatalog(currentIndex, renderCatalog(notes, catalogNoteId));
  const stale = currentIndex !== expectedIndex;
  let index = stale ? "stale" : "current";
  if (writeIndex && stale) {
    await atomicReplace(root, indexPath, expectedIndex, indexRevision);
    index = "updated";
    const parsed = parseNote(vaultIndexPath, expectedIndex);
    const noteIndex = notes.findIndex((note) => note.path === vaultIndexPath);
    if (noteIndex === -1)
      notes.push(parsed);
    else
      notes[noteIndex] = parsed;
  }
  return {
    root,
    indexPath,
    index,
    notes,
    analysis: analyzeVault(notes, {
      catalogNoteId,
      ...options.includeInSuggestions === undefined ? {} : { includeInSuggestions: options.includeInSuggestions }
    })
  };
}
async function scanVault(root = ".", options = {}) {
  return snapshot(root, options, false);
}
async function refreshVault(root = ".", options = {}) {
  return snapshot(root, options, true);
}

// src/semantic.ts
var recommendedEmbeddingModel = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
var collectionName = "oh";
var markdownPattern = "**/*.md";
var qmdModuleSpecifier = "@tobilu/qmd";
function cacheHome(dependencies) {
  const configured = dependencies.cacheHome ?? process.env.XDG_CACHE_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    return isAbsolute(configured) ? configured : resolve2(configured);
  }
  return join2(homedir(), ".cache");
}
function semanticDatabasePath(root, dependencies = {}) {
  const identity = createHash("sha256").update(resolve2(root)).digest("hex").slice(0, 20);
  return join2(cacheHome(dependencies), "hraness-oh", "indexes", `${identity}.sqlite`);
}
async function resolvedDirectory(path) {
  const root = await realpath2(resolve2(path));
  if (!(await stat(root)).isDirectory())
    throw new Error("Knowledge-base root must be a directory.");
  return root;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundaryRecord(value, label) {
  if (!isRecord(value))
    throw new Error(`${label} must be an object.`);
  return value;
}
function boundaryString(value, label) {
  if (typeof value !== "string")
    throw new Error(`${label} must be a string.`);
  return value;
}
function boundaryNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}
function boundaryCount(value, label) {
  const number = boundaryNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}
function boundaryArray(value, label) {
  if (!Array.isArray(value))
    throw new Error(`${label} must be an array.`);
  return value;
}
function parseUpdateResult(value) {
  const result = boundaryRecord(value, "QMD update result");
  return {
    collections: boundaryCount(result.collections, "QMD update result.collections"),
    indexed: boundaryCount(result.indexed, "QMD update result.indexed"),
    updated: boundaryCount(result.updated, "QMD update result.updated"),
    unchanged: boundaryCount(result.unchanged, "QMD update result.unchanged"),
    removed: boundaryCount(result.removed, "QMD update result.removed"),
    needsEmbedding: boundaryCount(result.needsEmbedding, "QMD update result.needsEmbedding")
  };
}
function parseEmbeddingFailure(value, index) {
  const label = `QMD embedding result.failures[${index}]`;
  const failure = boundaryRecord(value, label);
  return {
    path: boundaryString(failure.path, `${label}.path`),
    hash: boundaryString(failure.hash, `${label}.hash`),
    seq: boundaryCount(failure.seq, `${label}.seq`),
    attempts: boundaryCount(failure.attempts, `${label}.attempts`),
    reason: boundaryString(failure.reason, `${label}.reason`)
  };
}
function parseEmbeddingResult(value) {
  const result = boundaryRecord(value, "QMD embedding result");
  const failures = result.failures === undefined ? undefined : boundaryArray(result.failures, "QMD embedding result.failures").map((failure, index) => parseEmbeddingFailure(failure, index));
  return {
    docsProcessed: boundaryCount(result.docsProcessed, "QMD embedding result.docsProcessed"),
    chunksEmbedded: boundaryCount(result.chunksEmbedded, "QMD embedding result.chunksEmbedded"),
    errors: boundaryCount(result.errors, "QMD embedding result.errors"),
    ...failures === undefined ? {} : { failures },
    durationMs: boundaryNumber(result.durationMs, "QMD embedding result.durationMs")
  };
}
function parseSearchDocument(value, index) {
  const label = `QMD search result[${index}]`;
  const result = boundaryRecord(value, label);
  const source = result.source;
  if (source !== "fts" && source !== "vec") {
    throw new Error(`${label}.source must be "fts" or "vec".`);
  }
  const chunkPos = result.chunkPos === undefined ? undefined : boundaryCount(result.chunkPos, `${label}.chunkPos`);
  return {
    filepath: boundaryString(result.filepath, `${label}.filepath`),
    title: boundaryString(result.title, `${label}.title`),
    hash: boundaryString(result.hash, `${label}.hash`),
    docid: boundaryString(result.docid, `${label}.docid`),
    modifiedAt: boundaryString(result.modifiedAt, `${label}.modifiedAt`),
    score: boundaryNumber(result.score, `${label}.score`),
    source,
    ...chunkPos === undefined ? {} : { chunkPos }
  };
}
function parseSearchResults(value) {
  return boundaryArray(value, "QMD search results").map((result, index) => parseSearchDocument(result, index));
}
function boundUnknownMethod(owner, name, label) {
  const method = owner[name];
  if (typeof method !== "function")
    throw new Error(`${label}.${name} must be a function.`);
  return async (...arguments_) => {
    const returned = Reflect.apply(method, owner, arguments_);
    return await returned;
  };
}
function parseSearchStore(value) {
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
    update: async (options) => parseUpdateResult(await update(options))
  };
}
async function closeMalformedStore(value) {
  if (!isRecord(value))
    return;
  const close = value.close;
  if (typeof close !== "function")
    return;
  try {
    const returned = Reflect.apply(close, value, []);
    await returned;
  } catch {}
}
async function openedSearchStore(value) {
  try {
    return parseSearchStore(value);
  } catch (error) {
    await closeMalformedStore(value);
    throw error;
  }
}
function storeConfig(root) {
  return {
    global_context: "A Markdown knowledge base. Source records preserve evidence; maintained notes contain current synthesis; explicit wikilinks define structural relationships.",
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
          "/riffs": "Voice-preserving first-person source thought."
        }
      }
    },
    models: { embed: recommendedEmbeddingModel }
  };
}
async function defaultCreateStore(options) {
  const loaded = await import(qmdModuleSpecifier);
  const module = boundaryRecord(loaded, "QMD module");
  const createStore = boundUnknownMethod(module, "createStore", "QMD module");
  return await createStore(options);
}
async function openStore(root, database, dependencies) {
  await mkdir(dirname2(database), { recursive: true });
  const created = await (dependencies.createStore ?? defaultCreateStore)({
    dbPath: database,
    config: storeConfig(root)
  });
  return await openedSearchStore(created);
}
function databaseFor(root, requested, dependencies) {
  if (requested === undefined)
    return semanticDatabasePath(root, dependencies);
  return resolve2(requested);
}
async function embedChanged(store, update, force) {
  if (!force && update.needsEmbedding === 0)
    return null;
  return await store.embed({
    collection: collectionName,
    force,
    model: recommendedEmbeddingModel,
    chunkStrategy: "regex"
  });
}
async function indexSemanticVault(options, dependencies = {}) {
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
function qmdEmojiToHex(value) {
  return value.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => [...run].filter((character) => /\p{So}|\p{Sk}/u.test(character)).map((character) => character.codePointAt(0)?.toString(16) ?? "").join("-"));
}
function qmdHandelize(path) {
  if (path.trim() === "")
    return null;
  const segments = path.split("/").filter((segment) => segment !== "");
  const lastSegment = segments.at(-1) ?? "";
  const filenameWithoutExtension = lastSegment.replace(/\.[^.]+$/u, "");
  if (!/[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExtension))
    return null;
  const result = path.replaceAll("___", "/").split("/").map((rawSegment, index, allSegments) => {
    const segment = qmdEmojiToHex(rawSegment);
    if (index === allSegments.length - 1) {
      const extension = segment.match(/(\.[a-z0-9]+)$/iu)?.[1] ?? "";
      const name = extension === "" ? segment : segment.slice(0, -extension.length);
      return name.replace(/[^\p{L}\p{N}$]+/gu, "-").replace(/^-+|-+$/gu, "") + extension;
    }
    return segment.replace(/[^\p{L}\p{N}$]+/gu, "-").replace(/^-+|-+$/gu, "");
  }).filter((segment) => segment !== "").join("/");
  return result === "" ? null : result;
}
function qmdNoteLookup(notes) {
  const lookup = new Map;
  for (const note of notes) {
    const qmdPath = qmdHandelize(note.path);
    if (qmdPath === null)
      continue;
    const contentHash = createHash("sha256").update(note.content).digest("hex");
    const byHash = lookup.get(qmdPath) ?? new Map;
    const candidates = byHash.get(contentHash) ?? [];
    candidates.push(note);
    byHash.set(contentHash, candidates);
    lookup.set(qmdPath, byHash);
  }
  return lookup;
}
function qmdVirtualNotePath(filepath) {
  if (!filepath.startsWith("qmd://"))
    return;
  const prefix = `qmd://${collectionName}/`;
  if (!filepath.startsWith(prefix))
    return null;
  const path = filepath.slice(prefix.length);
  const segments = path.split("/");
  const hasControlCharacter = [...path].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (path === "" || path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("%") || hasControlCharacter || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path;
}
async function resolvedSearchNote(root, result, notesByPath, notesByQmdPath) {
  const virtualPath = qmdVirtualNotePath(result.filepath);
  if (virtualPath !== undefined) {
    if (virtualPath === null)
      return null;
    const candidates = notesByQmdPath.get(virtualPath)?.get(result.hash) ?? [];
    const candidate2 = candidates[0];
    return candidates.length === 1 && candidate2 !== undefined ? candidate2 : null;
  }
  if (!isAbsolute(result.filepath))
    return null;
  let filepath;
  try {
    filepath = await realpath2(resolve2(result.filepath));
  } catch {
    return null;
  }
  const candidate = relative2(root, filepath);
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep2}`) || isAbsolute(candidate)) {
    return null;
  }
  const note = notesByPath.get(candidate.split(sep2).join("/"));
  return note ?? null;
}
function queryOffset(body, query, suggested) {
  if (suggested !== undefined && Number.isSafeInteger(suggested) && suggested >= 0 && suggested <= body.length) {
    return suggested;
  }
  const terms = query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const lowerBody = body.toLocaleLowerCase("en-US");
  for (const term of terms.toSorted((left, right) => right.length - left.length)) {
    const offset = lowerBody.indexOf(term);
    if (offset !== -1)
      return offset;
  }
  return 0;
}
function boundedSnippet(body, offset) {
  const normalized = body.replaceAll(`\r
`, `
`).replaceAll("\r", `
`);
  const maximum = 600;
  const start = Math.max(0, Math.min(normalized.length, offset) - 180);
  const end = Math.min(normalized.length, start + maximum);
  const value = normalized.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "\u2026" : ""}${value}${end < normalized.length ? "\u2026" : ""}`;
}
async function searchHit(store, root, query, result, notesByPath, notesByQmdPath, connectionsById) {
  const note = await resolvedSearchNote(root, result, notesByPath, notesByQmdPath);
  if (note === null)
    return null;
  const currentHash = createHash("sha256").update(note.content).digest("hex");
  if (result.hash !== currentHash)
    return null;
  const connection = connectionsById.get(note.id);
  const body = await store.getDocumentBody(result.filepath) ?? "";
  if (body !== note.content)
    return null;
  const offset = queryOffset(body, query, result.chunkPos);
  return {
    path: note.path,
    title: note.title,
    score: result.score,
    source: result.source,
    docid: result.docid,
    modifiedAt: result.modifiedAt,
    ...body === "" ? {} : { line: body.slice(0, offset).split(`
`).length },
    snippet: boundedSnippet(body, offset),
    tags: note.tags,
    metadata: note.metadata,
    inboundContextualCount: connection?.inboundContextualCount ?? 0,
    outboundContextualCount: connection?.outboundContextualCount ?? 0,
    backlinks: connection?.backlinks ?? []
  };
}
function boundedLimit(value) {
  if (value === undefined)
    return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Search limit must be an integer from 1 through 100.");
  }
  return value;
}
function boundedScore(value) {
  if (value === undefined)
    return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Minimum score must be a number from 0 through 1.");
  }
  return value;
}
async function searchSemanticVault(options, dependencies = {}) {
  const query = options.query.trim();
  if (query === "")
    throw new Error("Search query must not be empty.");
  const root = await resolvedDirectory(options.root);
  const database = databaseFor(root, options.database, dependencies);
  const mode = options.mode ?? "semantic";
  const limit = boundedLimit(options.limit);
  const minScore = boundedScore(options.minScore);
  const store = await openStore(root, database, dependencies);
  try {
    const update = await store.update({ collections: [collectionName] });
    const embedding = mode === "semantic" ? await embedChanged(store, update, false) : null;
    const matches = mode === "semantic" ? await store.searchVector(query, { collection: collectionName, limit }) : await store.searchLex(query, { collection: collectionName, limit });
    const snapshot2 = await (dependencies.scanVault ?? scanVault)(root);
    const notesByPath = new Map(snapshot2.notes.map((note) => [note.path, note]));
    const notesByQmdPath = qmdNoteLookup(snapshot2.notes);
    const connectionsById = new Map(snapshot2.analysis.noteConnections.map((connection) => [connection.id, connection]));
    const hits = await Promise.all(matches.filter(({ score }) => score >= minScore).map((result) => searchHit(store, root, query, result, notesByPath, notesByQmdPath, connectionsById)));
    return {
      root,
      database,
      model: recommendedEmbeddingModel,
      mode,
      query,
      update,
      embedding,
      results: hits.filter((hit) => hit !== null)
    };
  } finally {
    await store.close();
  }
}

export { defaultIgnoredDirectories, markdownFiles, readVaultNotes, scanVault, refreshVault, recommendedEmbeddingModel, semanticDatabasePath, indexSemanticVault, searchSemanticVault };
