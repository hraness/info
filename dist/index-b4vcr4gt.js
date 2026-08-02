// @bun
import {
  fuseRankedCandidates,
  validateSearchQuery
} from "./index-4cknf4jw.js";
import {
  MAX_ANALYZED_NOTES,
  analyzeVault,
  isCanonicalNoteId,
  lookupNote,
  normalizeVaultPath,
  parseNote,
  renderCatalog,
  replaceCatalog
} from "./index-4962kvds.js";

// src/semantic.ts
import { createHash as createHash2 } from "crypto";
import { constants as constants3 } from "fs";
import { mkdir as mkdir2, open as open3, realpath as realpath3, stat } from "fs/promises";
import { homedir } from "os";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join3, relative as relative3, resolve as resolve3, sep as sep3 } from "path";

// src/semantic-runtime.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import {
  constants as constants2
} from "fs";
import {
  lstat as lstat2,
  mkdir,
  open as open2,
  opendir,
  realpath as realpath2,
  rename as rename2,
  rm as rm2,
  writeFile
} from "fs/promises";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "path";

// src/vault.ts
import { randomUUID } from "crypto";
import { constants } from "fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm
} from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
var MAX_SCANNED_NOTES = MAX_ANALYZED_NOTES;
var MAX_NOTE_UTF8_BYTES = 16 * 1024 * 1024;
var MAX_VAULT_UTF8_BYTES = 256 * 1024 * 1024;

class VaultScanBudgetError extends RangeError {
  kind;
  limit;
  constructor(kind, limit, message) {
    super(message);
    this.name = "VaultScanBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}
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
function checkedScanLimit(value, hardMaximum, option) {
  const limit = value ?? hardMaximum;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > hardMaximum) {
    throw new RangeError(`${option} must be a safe integer from 0 through ${hardMaximum}.`);
  }
  return limit;
}
function normalizedRawNoteId(rawId) {
  return normalizeVaultPath(rawId).normalize("NFC");
}
function validateScannedNotePaths(root, paths) {
  const files = paths.map((absolutePath) => {
    const vaultPath = relative(root, absolutePath).split(sep).join("/");
    return {
      absolutePath,
      vaultPath,
      rawId: vaultPath.slice(0, -3)
    };
  });
  const pathByNormalizedId = new Map;
  for (const file of files) {
    const normalizedId = normalizedRawNoteId(file.rawId);
    const collision = pathByNormalizedId.get(normalizedId);
    if (collision !== undefined && collision !== file.vaultPath) {
      throw new Error(`Vault note paths ${JSON.stringify(collision)} and ` + `${JSON.stringify(file.vaultPath)} normalize to the same note ID ` + `${JSON.stringify(normalizedId)}.`);
    }
    pathByNormalizedId.set(normalizedId, file.vaultPath);
  }
  for (const file of files) {
    if (isCanonicalNoteId(file.rawId))
      continue;
    if (file.rawId !== file.rawId.normalize("NFC")) {
      throw new Error(`Vault note path ${JSON.stringify(file.vaultPath)} is not NFC; ` + `its extensionless note ID must be exactly ` + `${JSON.stringify(file.rawId.normalize("NFC"))}.`);
    }
    if (file.rawId.includes("\\")) {
      throw new Error(`Vault note path ${JSON.stringify(file.vaultPath)} contains a backslash; ` + "note IDs must use exact vault-root directory separators.");
    }
    throw new Error(`Vault note path ${JSON.stringify(file.vaultPath)} must have an exact ` + "canonical extensionless vault-root note ID.");
  }
  return files;
}
function assertScannableNoteFile(vaultPath, metadata) {
  if (metadata.isSymbolicLink()) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must not be a symbolic link.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must be a regular file.`);
  }
  if (metadata.nlink !== 1n) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must not be hard-linked.`);
  }
}
function noteBytesError(vaultPath, limit) {
  return new VaultScanBudgetError("note-bytes", limit, `Vault note ${JSON.stringify(vaultPath)} exceeds the ${limit}-byte UTF-8 limit.`);
}
function totalBytesError(limit) {
  return new VaultScanBudgetError("total-bytes", limit, `Vault scan exceeds the ${limit}-byte cumulative UTF-8 limit.`);
}
async function readBoundedNote(handle, vaultPath, maxNoteBytes, remainingTotalBytes, maxTotalBytes) {
  const chunks = [];
  let bytes = 0;
  for (;; ) {
    const remaining = Math.min(maxNoteBytes - bytes, remainingTotalBytes - bytes);
    const buffer = new Uint8Array(Math.min(64 * 1024, Math.max(1, remaining + 1)));
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0)
      break;
    bytes += result.bytesRead;
    if (bytes > maxNoteBytes)
      throw noteBytesError(vaultPath, maxNoteBytes);
    if (bytes > remainingTotalBytes) {
      throw totalBytesError(maxTotalBytes);
    }
    chunks.push(buffer.slice(0, result.bytesRead));
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(joined),
      bytes
    };
  } catch (error) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} is not valid UTF-8.`, { cause: error });
  }
}
async function readVaultNotes(root, ignoredDirectories = defaultIgnoredDirectories, limits = {}) {
  const maxNotes = checkedScanLimit(limits.maxNotes, MAX_SCANNED_NOTES, "maxNotes");
  const maxNoteBytes = checkedScanLimit(limits.maxNoteBytes, MAX_NOTE_UTF8_BYTES, "maxNoteBytes");
  const maxTotalBytes = checkedScanLimit(limits.maxTotalBytes, MAX_VAULT_UTF8_BYTES, "maxTotalBytes");
  const paths = await markdownFiles(root, ignoredDirectories);
  if (paths.length > maxNotes) {
    throw new VaultScanBudgetError("notes", maxNotes, `Vault scan exceeds the ${maxNotes} Markdown note limit.`);
  }
  const files = validateScannedNotePaths(root, paths);
  let declaredTotal = 0n;
  const preflight = [];
  for (const file of files) {
    const metadata = await lstat(file.absolutePath, { bigint: true });
    assertScannableNoteFile(file.vaultPath, metadata);
    if (metadata.size > BigInt(maxNoteBytes)) {
      throw noteBytesError(file.vaultPath, maxNoteBytes);
    }
    declaredTotal += metadata.size;
    if (declaredTotal > BigInt(maxTotalBytes)) {
      throw totalBytesError(maxTotalBytes);
    }
    preflight.push({
      ...file,
      device: metadata.dev,
      inode: metadata.ino
    });
  }
  const notes = [];
  let observedTotal = 0;
  for (const file of preflight) {
    const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const beforeRead = await handle.stat({ bigint: true });
      assertScannableNoteFile(file.vaultPath, beforeRead);
      if (beforeRead.dev !== file.device || beforeRead.ino !== file.inode) {
        throw new Error(`Vault note ${JSON.stringify(file.vaultPath)} changed during scan; retry.`);
      }
      if (beforeRead.size > BigInt(maxNoteBytes)) {
        throw noteBytesError(file.vaultPath, maxNoteBytes);
      }
      if (BigInt(observedTotal) + beforeRead.size > BigInt(maxTotalBytes)) {
        throw totalBytesError(maxTotalBytes);
      }
      const read = await readBoundedNote(handle, file.vaultPath, maxNoteBytes, maxTotalBytes - observedTotal, maxTotalBytes);
      const afterRead = await handle.stat({ bigint: true });
      if (afterRead.dev !== file.device || afterRead.ino !== file.inode || afterRead.size !== beforeRead.size || afterRead.size !== BigInt(read.bytes)) {
        throw new Error(`Vault note ${JSON.stringify(file.vaultPath)} changed during scan; retry.`);
      }
      observedTotal += read.bytes;
      notes.push(parseNote(file.vaultPath, read.content));
    } finally {
      await handle.close();
    }
  }
  return notes;
}
function confined(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}
async function assertConfinedIndexParents(root, path) {
  if (!confined(root, path))
    throw new Error("The configured index must be a file inside the vault root.");
  const parent = dirname(path);
  const segments = relative(root, parent).split(sep).filter((segment) => segment !== "");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("The configured index path must not traverse a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Every configured index parent must be a directory.");
    }
  }
  const canonicalParent = await realpath(parent);
  if (!confined(root, join(canonicalParent, basename(path)))) {
    throw new Error("The configured index parent resolves outside the vault root.");
  }
}
async function readIndexRevision(root, path, maxNoteBytes = MAX_NOTE_UTF8_BYTES) {
  await assertConfinedIndexParents(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile())
      throw new Error("The configured index must be a regular file.");
    if (metadata.nlink !== 1n)
      throw new Error("The configured index must not be hard-linked.");
    const canonicalPath = await realpath(path);
    if (!confined(root, canonicalPath)) {
      throw new Error("The configured index resolves outside the vault root.");
    }
    const vaultPath = relative(root, path).split(sep).join("/");
    if (metadata.size > BigInt(maxNoteBytes)) {
      throw noteBytesError(vaultPath, maxNoteBytes);
    }
    const read = await readBoundedNote(handle, vaultPath, maxNoteBytes, maxNoteBytes, maxNoteBytes);
    const afterRead = await handle.stat({ bigint: true });
    if (afterRead.dev !== metadata.dev || afterRead.ino !== metadata.ino || afterRead.size !== metadata.size || afterRead.size !== BigInt(read.bytes)) {
      throw new Error("The configured index changed during scan; retry.");
    }
    return {
      content: read.content,
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
function parsedCatalogMode(value, source) {
  if (value === undefined)
    return;
  if (value === "managed" || value === "authored")
    return value;
  throw new Error(`${source} must be exactly "managed" or "authored".`);
}
function declaredCatalogMode(indexNote) {
  const declaration = Object.entries(indexNote.metadata).find(([name]) => name.toLocaleLowerCase("en-US") === "kb_catalog");
  return parsedCatalogMode(declaration?.[1], `The configured index frontmatter property "kb_catalog"`);
}
async function atomicReplace(root, path, content, expected) {
  const beforeWrite = await readIndexRevision(root, path);
  if (!sameRevision(beforeWrite, expected)) {
    throw new Error("The configured index changed during refresh; retry without overwriting the editor's changes.");
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
      throw new Error("The configured index changed during refresh; retry without overwriting the editor's changes.");
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
    throw new Error("The configured index must be a file inside the vault root.");
  }
  if (!indexPath.toLowerCase().endsWith(".md")) {
    throw new Error("The configured index must be a Markdown file.");
  }
  const vaultIndexPath = relativeIndex.split(sep).join("/");
  const catalogNoteId = vaultIndexPath.toLowerCase().endsWith(".md") ? vaultIndexPath.slice(0, -3) : vaultIndexPath;
  const notes = await readVaultNotes(root, options.ignoredDirectories, {
    ...options.maxNotes === undefined ? {} : { maxNotes: options.maxNotes },
    ...options.maxNoteBytes === undefined ? {} : { maxNoteBytes: options.maxNoteBytes },
    ...options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }
  });
  const indexRevision = await readIndexRevision(root, indexPath, options.maxNoteBytes ?? MAX_NOTE_UTF8_BYTES);
  const currentIndex = indexRevision.content;
  const indexNote = parseNote(vaultIndexPath, currentIndex);
  const catalogMode = parsedCatalogMode(options.catalogMode, "ScanVaultOptions.catalogMode") ?? declaredCatalogMode(indexNote) ?? "managed";
  let index = "authored";
  if (catalogMode === "managed") {
    const expectedIndex = replaceCatalog(currentIndex, renderCatalog(notes, catalogNoteId));
    const stale = currentIndex !== expectedIndex;
    index = stale ? "stale" : "current";
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
  }
  const mentionScope = options.mentionScope;
  const mentionIds = new Set;
  if (typeof mentionScope === "string") {
    const lookup = lookupNote(notes, mentionScope);
    if (lookup.kind === "found")
      mentionIds.add(lookup.note.id);
    else if (lookup.kind === "ambiguous") {
      for (const note of lookup.candidates)
        mentionIds.add(note.id);
    }
  }
  const mentionScopePredicate = mentionScope === undefined ? undefined : (note) => mentionScope !== false && mentionIds.has(note.id);
  return {
    root,
    indexPath,
    catalogMode,
    index,
    notes,
    analysis: analyzeVault(notes, {
      catalogNoteId,
      ...options.includeInSuggestions === undefined ? {} : { includeInSuggestions: options.includeInSuggestions },
      ...mentionScopePredicate === undefined ? {} : { mentionScope: mentionScopePredicate },
      ...options.maxNotes === undefined ? {} : { maxNotes: options.maxNotes },
      ...options.maxConnectionObservations === undefined ? {} : { maxConnectionObservations: options.maxConnectionObservations },
      ...options.maxMentionPairs === undefined ? {} : { maxMentionPairs: options.maxMentionPairs },
      ...options.maxMentions === undefined ? {} : { maxMentions: options.maxMentions }
    })
  };
}
async function scanVault(root = ".", options = {}) {
  return snapshot(root, options, false);
}
async function refreshVault(root = ".", options = {}) {
  return snapshot(root, options, true);
}

// src/semantic-runtime.ts
var LEASE_VERSION = 1;
var PROJECTION_VERSION = 2;
var DEFAULT_LEASE_WAIT_MS = 30000;
var DEFAULT_LEASE_POLL_MS = 25;
var MAX_LEASE_WAIT_MS = 10 * 60000;
var MAX_LEASE_POLL_MS = 1000;
var GENERATION_PREFIX = "generation-";
var READER_PREFIX = ".reader-";
var MANIFEST_NAME = "manifest.json";
var OWNER_NAME = "owner.json";
var SNAPSHOT_OWNER_NAME = ".hraness-kb-semantic-cache.json";
var SNAPSHOT_OWNER_VERSION = 1;
var SNAPSHOT_OWNER_KIND = "@hraness/kb/semantic-projection-cache";
var MAX_OWNER_BYTES = 4 * 1024;
var MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
var MAX_CACHE_DIRECTORY_ENTRIES = 1024;
var MAX_INDEX_IDENTITY_BYTES = 16 * 1024;
var MAX_INDEX_IDENTITY_STRING_BYTES = 4 * 1024;
var MAX_INDEX_IDENTITY_ENTRIES = 64;
function errorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error))
    return;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
function checkedLeaseBound(value, fallback, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return result;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkedIdentityString(value, label) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value === "" || bytes > MAX_INDEX_IDENTITY_STRING_BYTES) {
    throw new RangeError(`${label} must contain from 1 through ${MAX_INDEX_IDENTITY_STRING_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
  }
  return value;
}
function validatedIndexIdentity(identity) {
  if (!Number.isSafeInteger(identity.producer.schema) || identity.producer.schema < 1) {
    throw new RangeError("Semantic index producer schema must be a positive safe integer.");
  }
  if (identity.collection.ignore.length > MAX_INDEX_IDENTITY_ENTRIES || identity.collection.pathContexts.length > MAX_INDEX_IDENTITY_ENTRIES) {
    throw new RangeError(`Semantic index identity collections are limited to ${MAX_INDEX_IDENTITY_ENTRIES} entries.`);
  }
  const validated = {
    producer: {
      package: checkedIdentityString(identity.producer.package, "Semantic index producer package"),
      schema: identity.producer.schema
    },
    indexer: {
      package: checkedIdentityString(identity.indexer.package, "Semantic indexer package"),
      version: checkedIdentityString(identity.indexer.version, "Semantic indexer version")
    },
    collection: {
      name: checkedIdentityString(identity.collection.name, "Semantic collection name"),
      pattern: checkedIdentityString(identity.collection.pattern, "Semantic collection pattern"),
      ignore: identity.collection.ignore.map((pattern) => checkedIdentityString(pattern, "Semantic collection ignore pattern")),
      globalContext: checkedIdentityString(identity.collection.globalContext, "Semantic collection global context"),
      pathContexts: identity.collection.pathContexts.map((entry) => ({
        path: checkedIdentityString(entry.path, "Semantic collection context path"),
        context: checkedIdentityString(entry.context, "Semantic collection path context")
      }))
    },
    embedding: {
      model: checkedIdentityString(identity.embedding.model, "Semantic embedding model"),
      chunkStrategy: checkedIdentityString(identity.embedding.chunkStrategy, "Semantic embedding chunk strategy")
    }
  };
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_INDEX_IDENTITY_BYTES) {
    throw new RangeError(`Semantic index identity exceeds the ${MAX_INDEX_IDENTITY_BYTES.toLocaleString("en-US")}-byte limit.`);
  }
  return validated;
}
async function boundedMetadataText(path, maximum, label) {
  const pathBefore = await lstat2(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1n) {
    throw new Error(`${label} must be a regular, singly linked file.`);
  }
  const handle = await open2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new Error(`${label} must be a regular, singly linked file.`);
    }
    if (before.size > BigInt(maximum)) {
      throw new RangeError(`${label} exceeds the ${maximum.toLocaleString("en-US")}-byte metadata limit.`);
    }
    const chunks = [];
    let bytes = 0;
    for (;; ) {
      const remaining = maximum - bytes;
      const buffer = new Uint8Array(Math.min(64 * 1024, remaining + 1));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0)
        break;
      bytes += result.bytesRead;
      if (bytes > maximum) {
        throw new RangeError(`${label} exceeds the ${maximum.toLocaleString("en-US")}-byte metadata limit.`);
      }
      chunks.push(buffer.slice(0, result.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat2(path, { bigint: true });
    } catch {
      throw new Error(`${label} changed while it was being read; retry.`);
    }
    if (!after.isFile() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(bytes) || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error(`${label} changed while it was being read; retry.`);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } finally {
    await handle.close();
  }
}
async function safeDirectory(path, label) {
  try {
    const metadata = await lstat2(path);
    if (metadata.isSymbolicLink())
      throw new Error(`${label} must not be a symbolic link.`);
    if (!metadata.isDirectory())
      throw new Error(`${label} must be a directory.`);
    return "directory";
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return "absent";
    throw error;
  }
}
async function canonicalProspectiveDirectory(path) {
  const missing = [];
  let candidate = resolve2(path);
  for (;; ) {
    try {
      return resolve2(await realpath2(candidate), ...missing.toReversed());
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        throw error;
      const parent = dirname2(candidate);
      if (parent === candidate)
        throw error;
      missing.push(basename2(candidate));
      candidate = parent;
    }
  }
}
async function validateSemanticDatabaseFile(path) {
  let metadata;
  try {
    metadata = await lstat2(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("Semantic database must not be a symbolic link.");
  }
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    throw new Error("Semantic database must be a regular, singly linked file.");
  }
  const handle = await open2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.dev !== metadata.dev || current.ino !== metadata.ino) {
      throw new Error("Semantic database must be a regular, singly linked file.");
    }
  } finally {
    await handle.close();
  }
}
async function canonicalSemanticDatabasePath(database) {
  const requested = resolve2(database);
  const canonicalParent = await canonicalProspectiveDirectory(dirname2(requested));
  const canonical = join2(canonicalParent, basename2(requested));
  await validateSemanticDatabaseFile(canonical);
  try {
    return await realpath2(canonical);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return canonical;
    throw error;
  }
}
async function settledSemanticDatabasePath(database) {
  const canonical = await canonicalSemanticDatabasePath(database);
  await mkdir(dirname2(canonical), { recursive: true, mode: 448 });
  const settledParent = await realpath2(dirname2(canonical));
  if (settledParent !== dirname2(canonical)) {
    throw new Error("Semantic database parent changed while settling its identity; retry.");
  }
  let created;
  try {
    created = await open2(canonical, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW | constants2.O_NONBLOCK, 384);
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw error;
  } finally {
    await created?.close();
  }
  await validateSemanticDatabaseFile(canonical);
  return await realpath2(canonical);
}
function pathIsWithin(root, candidate) {
  return candidate === root || confinedPath(root, candidate);
}
function assertSemanticCacheOutsideVault(root, database) {
  const ownedPaths = [
    database,
    `${database}.writer-lease`,
    `${database}.snapshot`
  ];
  if (ownedPaths.some((path) => pathIsWithin(root, path) || pathIsWithin(path, root))) {
    throw new Error("Semantic database, lease, and snapshot paths must not overlap the vault root.");
  }
}
async function resolveSemanticDatabase(database, root) {
  const [canonicalDatabase, canonicalRoot] = await Promise.all([
    canonicalSemanticDatabasePath(database),
    realpath2(root)
  ]);
  assertSemanticCacheOutsideVault(canonicalRoot, canonicalDatabase);
  return canonicalDatabase;
}
function parsedOwner(value) {
  if (!isRecord(value) || value.version !== LEASE_VERSION || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== "string" || value.token.length < 16 || value.token.length > 128 || typeof value.acquiredAt !== "string") {
    return null;
  }
  return {
    version: LEASE_VERSION,
    pid: value.pid,
    token: value.token,
    acquiredAt: value.acquiredAt
  };
}
async function readOwner(path) {
  try {
    return parsedOwner(JSON.parse(await boundedMetadataText(join2(path, OWNER_NAME), MAX_OWNER_BYTES, "Semantic lease owner")));
  } catch (error) {
    if (error instanceof RangeError)
      throw error;
    return null;
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}
async function recoverDeadLease(path) {
  if (await safeDirectory(path, "Semantic writer lease") === "absent")
    return false;
  const owner = await readOwner(path);
  if (owner === null || processIsAlive(owner.pid))
    return false;
  const confirmed = await readOwner(path);
  if (confirmed?.pid !== owner.pid || confirmed.token !== owner.token)
    return false;
  const tombstone = `${path}.dead-${owner.token}-${randomUUID2()}`;
  try {
    await rename2(path, tombstone);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? ""))
      return false;
    throw error;
  }
  await rm2(tombstone, { recursive: true, force: true });
  return true;
}
async function acquireWriterLeaseState(database, options) {
  const waitMs = checkedLeaseBound(options.waitMs, DEFAULT_LEASE_WAIT_MS, MAX_LEASE_WAIT_MS, "Semantic writer lease wait");
  const pollMs = checkedLeaseBound(options.pollMs, DEFAULT_LEASE_POLL_MS, MAX_LEASE_POLL_MS, "Semantic writer lease poll interval");
  const canonicalDatabase = await settledSemanticDatabasePath(database);
  const path = `${canonicalDatabase}.writer-lease`;
  const owner = {
    version: LEASE_VERSION,
    pid: process.pid,
    token: randomUUID2(),
    acquiredAt: new Date().toISOString()
  };
  const startedAt = Date.now();
  for (;; ) {
    await safeDirectory(path, "Semantic writer lease");
    const claim = `${path}.claim-${process.pid}-${owner.token}`;
    await mkdir(claim, { mode: 448 });
    try {
      await writeFile(join2(claim, OWNER_NAME), `${JSON.stringify(owner)}
`, {
        encoding: "utf8",
        flag: "wx",
        mode: 384
      });
      try {
        await rename2(claim, path);
        const lease = { path, owner, database: canonicalDatabase };
        try {
          await validateSemanticDatabaseFile(canonicalDatabase);
          return lease;
        } catch (error) {
          await releaseWriterLease(lease);
          throw error;
        }
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? ""))
          throw error;
      }
    } finally {
      await rm2(claim, { recursive: true, force: true });
    }
    if (await recoverDeadLease(path))
      continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= waitMs) {
      throw new Error(`Timed out after ${waitMs}ms waiting for the semantic writer lease for ${JSON.stringify(resolve2(database))}.`);
    }
    await Bun.sleep(Math.min(pollMs, waitMs - elapsed));
  }
}
async function releaseWriterLease(lease) {
  if (await safeDirectory(lease.path, "Semantic writer lease") === "absent")
    return;
  const current = await readOwner(lease.path);
  if (current?.pid !== lease.owner.pid || current.token !== lease.owner.token)
    return;
  const tombstone = `${lease.path}.release-${lease.owner.token}`;
  try {
    await rename2(lease.path, tombstone);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return;
    throw error;
  }
  await rm2(tombstone, { recursive: true, force: true });
}
async function acquireSemanticWriterLease(database, options = {}) {
  const lease = await acquireWriterLeaseState(database, options);
  let released = false;
  return {
    release: async () => {
      if (released)
        return;
      released = true;
      await releaseWriterLease(lease);
    }
  };
}
function confinedPath(root, path) {
  const candidate = relative2(root, path);
  return candidate !== "" && candidate !== ".." && !candidate.startsWith(`..${sep2}`) && !isAbsolute(candidate);
}
function validatedProjectionNotes(notes) {
  if (notes.length > MAX_SCANNED_NOTES) {
    throw new VaultScanBudgetError("notes", MAX_SCANNED_NOTES, `Vault scan exceeds the ${MAX_SCANNED_NOTES} Markdown note limit.`);
  }
  const paths = new Set;
  const validated = [];
  let totalBytes = 0;
  for (const note of notes) {
    const path = note.path;
    const segments = path.split("/");
    if (path === "" || isAbsolute(path) || path.includes("\\") || !path.endsWith(".md") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Semantic projection note path ${JSON.stringify(path)} is invalid.`);
    }
    if (paths.has(path)) {
      throw new Error(`Semantic projection note path ${JSON.stringify(path)} is duplicated.`);
    }
    paths.add(path);
    const bytes = Buffer.byteLength(note.content, "utf8");
    if (bytes > MAX_NOTE_UTF8_BYTES) {
      throw new VaultScanBudgetError("note-bytes", MAX_NOTE_UTF8_BYTES, `Vault note ${JSON.stringify(path)} exceeds the ${MAX_NOTE_UTF8_BYTES}-byte UTF-8 limit.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_VAULT_UTF8_BYTES) {
      throw new VaultScanBudgetError("total-bytes", MAX_VAULT_UTF8_BYTES, `Vault scan exceeds the ${MAX_VAULT_UTF8_BYTES}-byte cumulative UTF-8 limit.`);
    }
    validated.push({
      path,
      sha256: createHash("sha256").update(note.content).digest("hex"),
      bytes
    });
  }
  return { notes: validated, totalBytes };
}
async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  let handle;
  try {
    handle = await open2(temporary, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW, 384);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename2(temporary, path);
  } finally {
    await handle?.close().catch(() => {
      return;
    });
    await rm2(temporary, { force: true }).catch(() => {
      return;
    });
  }
}
function snapshotCacheOwner(database) {
  return {
    version: SNAPSHOT_OWNER_VERSION,
    kind: SNAPSHOT_OWNER_KIND,
    databaseIdentity: resolve2(database)
  };
}
async function assertOwnedSnapshotCache(database, snapshotDirectory) {
  if (await safeDirectory(snapshotDirectory, "Semantic snapshot cache") === "absent") {
    return "absent";
  }
  const expected = snapshotCacheOwner(database);
  let actual;
  try {
    actual = JSON.parse(await boundedMetadataText(join2(snapshotDirectory, SNAPSHOT_OWNER_NAME), MAX_OWNER_BYTES, "Semantic snapshot cache owner"));
  } catch {
    throw new Error(`Semantic snapshot cache ${JSON.stringify(snapshotDirectory)} is unowned or has an incompatible ownership marker; remove this disposable directory explicitly before retrying.`);
  }
  if (!isRecord(actual) || actual.version !== expected.version || actual.kind !== expected.kind || actual.databaseIdentity !== expected.databaseIdentity) {
    throw new Error(`Semantic snapshot cache ${JSON.stringify(snapshotDirectory)} is unowned or has an incompatible ownership marker; remove this disposable directory explicitly before retrying.`);
  }
  return "owned";
}
async function ensureOwnedSnapshotCache(database, snapshotDirectory) {
  if (await assertOwnedSnapshotCache(database, snapshotDirectory) === "owned")
    return;
  const temporary = `${snapshotDirectory}.initialize-${process.pid}-${randomUUID2()}`;
  await mkdir(temporary, { mode: 448 });
  try {
    await writeFile(join2(temporary, SNAPSHOT_OWNER_NAME), `${JSON.stringify(snapshotCacheOwner(database))}
`, { encoding: "utf8", flag: "wx", mode: 384 });
    try {
      await rename2(temporary, snapshotDirectory);
      return;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? ""))
        throw error;
    }
  } finally {
    await rm2(temporary, { recursive: true, force: true });
  }
  await assertOwnedSnapshotCache(database, snapshotDirectory);
}
async function existingGenerationMatches(generationPath, manifest, manifestText) {
  try {
    if (await safeDirectory(generationPath, "Semantic projection generation") === "absent") {
      return false;
    }
    if (await boundedMetadataText(join2(generationPath, MANIFEST_NAME), MAX_MANIFEST_BYTES, "Semantic projection manifest") !== manifestText) {
      return false;
    }
    for (const entry of manifest.notes) {
      const path = resolve2(generationPath, ...entry.path.split("/"));
      if (!confinedPath(generationPath, path))
        return false;
      const content = await boundedMetadataText(path, MAX_NOTE_UTF8_BYTES, `Semantic projection note ${JSON.stringify(entry.path)}`);
      if (Buffer.byteLength(content, "utf8") !== entry.bytes || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
        return false;
      }
    }
    const expectedNotes = new Set(manifest.notes.map(({ path }) => join2(...path.split("/"))));
    const expectedDirectories = new Set;
    for (const path of expectedNotes) {
      let parent = dirname2(path);
      while (parent !== ".") {
        expectedDirectories.add(parent);
        parent = dirname2(parent);
      }
    }
    const pending = [generationPath];
    let entries = 0;
    const maximumEntries = manifest.notes.length + expectedDirectories.size + MAX_CACHE_DIRECTORY_ENTRIES + 1;
    while (pending.length > 0) {
      const directoryPath = pending.pop();
      if (directoryPath === undefined)
        break;
      const directory = await opendir(directoryPath);
      try {
        for await (const entry of directory) {
          entries += 1;
          if (entries > maximumEntries || entry.isSymbolicLink())
            return false;
          const absolute = join2(directoryPath, entry.name);
          const path = relative2(generationPath, absolute);
          if (entry.isDirectory()) {
            if (!expectedDirectories.has(path))
              return false;
            pending.push(absolute);
            continue;
          }
          if (!entry.isFile())
            return false;
          if (path === MANIFEST_NAME || expectedNotes.has(path))
            continue;
          if (dirname2(path) === "." && entry.name.startsWith(READER_PREFIX) && entry.name.endsWith(".json")) {
            continue;
          }
          return false;
        }
      } finally {
        try {
          await directory.close();
        } catch {}
      }
    }
    return true;
  } catch (error) {
    if (error instanceof RangeError || error instanceof Error && error.message.includes("symbolic link")) {
      throw error;
    }
    return false;
  }
}
async function materializeGeneration(snapshotDirectory, generationPath, manifest, manifestText, notesByPath) {
  if (await existingGenerationMatches(generationPath, manifest, manifestText))
    return;
  if (await safeDirectory(generationPath, "Semantic projection generation") === "directory") {
    if (await activeGenerationReaders(generationPath) > 0) {
      throw new Error("Semantic projection cache verification failed while this generation still has active readers; close those sessions and retry the repair.");
    }
    await rm2(generationPath, { recursive: true, force: true });
  }
  const temporary = join2(snapshotDirectory, `.temporary-${process.pid}-${randomUUID2()}`);
  await mkdir(temporary, { recursive: true, mode: 448 });
  try {
    for (const entry of manifest.notes) {
      const note = notesByPath.get(entry.path);
      if (note === undefined) {
        throw new Error(`Semantic projection lost note ${JSON.stringify(entry.path)}.`);
      }
      const bytes = Buffer.byteLength(note.content, "utf8");
      const sha256 = createHash("sha256").update(note.content).digest("hex");
      if (bytes !== entry.bytes || sha256 !== entry.sha256) {
        throw new Error(`Semantic projection note ${JSON.stringify(entry.path)} changed after validation.`);
      }
      const destination = resolve2(temporary, ...entry.path.split("/"));
      if (!confinedPath(temporary, destination)) {
        throw new Error(`Semantic projection path ${JSON.stringify(entry.path)} escapes its generation.`);
      }
      await mkdir(dirname2(destination), { recursive: true, mode: 448 });
      await writeFile(destination, note.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 384
      });
    }
    await atomicWrite(join2(temporary, MANIFEST_NAME), manifestText);
    await rename2(temporary, generationPath);
  } catch (error) {
    await rm2(temporary, { recursive: true, force: true });
    throw error;
  }
}
function readerOwnerName(owner) {
  return `${READER_PREFIX}${owner.pid}-${owner.token}.json`;
}
async function activeGenerationReaders(generation) {
  let directory;
  try {
    directory = await opendir(generation);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return 0;
    throw error;
  }
  let active = 0;
  let readerEntries = 0;
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.startsWith(READER_PREFIX) || !entry.name.endsWith(".json")) {
        continue;
      }
      readerEntries += 1;
      if (readerEntries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic projection generation has too many reader entries.");
      }
      const path = join2(generation, entry.name);
      let owner;
      try {
        owner = parsedOwner(JSON.parse(await boundedMetadataText(path, MAX_OWNER_BYTES, "Semantic projection reader")));
      } catch (error) {
        if (error instanceof RangeError)
          throw error;
        owner = null;
      }
      if (owner !== null && processIsAlive(owner.pid)) {
        active += 1;
      } else {
        await rm2(path, { force: true });
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {}
  }
  return active;
}
async function activeReaderGenerations(database) {
  const canonicalDatabase = await canonicalSemanticDatabasePath(database);
  const snapshotDirectory = `${canonicalDatabase}.snapshot`;
  if (await assertOwnedSnapshotCache(canonicalDatabase, snapshotDirectory) === "absent") {
    return new Set;
  }
  const active = new Set;
  const directory = await opendir(snapshotDirectory);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic snapshot cache has too many metadata entries.");
      }
      if (!entry.isDirectory() || !entry.name.startsWith(GENERATION_PREFIX))
        continue;
      if (await activeGenerationReaders(join2(snapshotDirectory, entry.name)) > 0) {
        active.add(entry.name);
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {}
  }
  return active;
}
async function withSemanticGenerationWriterLease(database, generation, operation, options = {}) {
  if (!generation.startsWith(GENERATION_PREFIX)) {
    throw new Error("Semantic projection generation is invalid.");
  }
  if (options.excludeReaders !== undefined && typeof options.excludeReaders !== "boolean") {
    throw new TypeError("Semantic writer excludeReaders must be a boolean.");
  }
  const waitMs = checkedLeaseBound(options.waitMs, DEFAULT_LEASE_WAIT_MS, MAX_LEASE_WAIT_MS, "Semantic writer lease wait");
  const pollMs = checkedLeaseBound(options.pollMs, DEFAULT_LEASE_POLL_MS, MAX_LEASE_POLL_MS, "Semantic writer lease poll interval");
  const readerDescription = options.excludeReaders === true ? "semantic projection readers" : "readers of an older semantic projection";
  const startedAt = Date.now();
  for (;; ) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= waitMs) {
      throw new Error(`Timed out after ${waitMs}ms waiting for ${readerDescription} to close.`);
    }
    const lease = await acquireSemanticWriterLease(database, {
      waitMs: Math.max(1, waitMs - elapsed),
      pollMs
    });
    let compatible = false;
    try {
      const active = await activeReaderGenerations(database);
      compatible = options.excludeReaders === true ? active.size === 0 : [...active].every((candidate) => candidate === generation);
      if (compatible)
        return await operation();
    } finally {
      await lease.release();
    }
    const waited = Date.now() - startedAt;
    if (waited >= waitMs) {
      throw new Error(`Timed out after ${waitMs}ms waiting for ${readerDescription} to close.`);
    }
    await Bun.sleep(Math.min(pollMs, waitMs - waited));
  }
}
async function cleanUnusedGenerations(snapshotDirectory, currentGeneration) {
  const directory = await opendir(snapshotDirectory);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic snapshot cache has too many metadata entries.");
      }
      if (!entry.isDirectory())
        continue;
      const path = join2(snapshotDirectory, entry.name);
      if (entry.name.startsWith(".temporary-")) {
        await rm2(path, { recursive: true, force: true });
        continue;
      }
      if (!entry.name.startsWith(GENERATION_PREFIX) || entry.name === currentGeneration)
        continue;
      if (await activeGenerationReaders(path) === 0) {
        await rm2(path, { recursive: true, force: true });
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {}
  }
}
async function describeSemanticProjection(database, root, notes, indexIdentity) {
  const [canonicalRoot, prospectiveDatabase] = await Promise.all([
    realpath2(root),
    canonicalSemanticDatabasePath(database)
  ]);
  assertSemanticCacheOutsideVault(canonicalRoot, prospectiveDatabase);
  const validated = validatedProjectionNotes(notes);
  const validatedIdentity = validatedIndexIdentity(indexIdentity);
  const canonicalDatabase = await settledSemanticDatabasePath(prospectiveDatabase);
  assertSemanticCacheOutsideVault(canonicalRoot, canonicalDatabase);
  const identity = createHash("sha256").update(JSON.stringify({
    version: PROJECTION_VERSION,
    indexIdentity: validatedIdentity,
    root: canonicalRoot,
    notes: validated.notes,
    totalBytes: validated.totalBytes
  })).digest("hex");
  const generation = `${GENERATION_PREFIX}${identity.slice(0, 32)}`;
  const snapshotDirectory = `${canonicalDatabase}.snapshot`;
  const generationPath = join2(snapshotDirectory, generation);
  const manifest = {
    version: PROJECTION_VERSION,
    indexIdentity: validatedIdentity,
    root: canonicalRoot,
    generation,
    notes: validated.notes,
    totalBytes: validated.totalBytes
  };
  const manifestText = `${JSON.stringify(manifest)}
`;
  if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
    throw new RangeError(`Semantic projection manifest exceeds the ${MAX_MANIFEST_BYTES}-byte metadata limit.`);
  }
  return {
    database: canonicalDatabase,
    snapshotDirectory,
    generationPath,
    manifest,
    manifestText
  };
}
async function prepareSemanticProjection(description, notes) {
  const { database, snapshotDirectory, generationPath, manifest, manifestText } = description;
  const validated = validatedProjectionNotes(notes);
  if (validated.totalBytes !== manifest.totalBytes || JSON.stringify(validated.notes) !== JSON.stringify(manifest.notes)) {
    throw new Error("Semantic projection notes changed after validation.");
  }
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  await ensureOwnedSnapshotCache(database, snapshotDirectory);
  await materializeGeneration(snapshotDirectory, generationPath, manifest, manifestText, notesByPath);
  const reader = {
    version: LEASE_VERSION,
    pid: process.pid,
    token: randomUUID2(),
    acquiredAt: new Date().toISOString()
  };
  const readerPath = join2(generationPath, readerOwnerName(reader));
  await writeFile(readerPath, `${JSON.stringify(reader)}
`, {
    encoding: "utf8",
    flag: "wx",
    mode: 384
  });
  try {
    await atomicWrite(join2(snapshotDirectory, MANIFEST_NAME), manifestText);
    await cleanUnusedGenerations(snapshotDirectory, manifest.generation);
  } catch (error) {
    await rm2(readerPath, { force: true });
    throw error;
  }
  let released = false;
  return {
    root: generationPath,
    manifest,
    release: async () => {
      if (released)
        return;
      released = true;
      await rm2(readerPath, { force: true });
    }
  };
}

// src/semantic.ts
var recommendedEmbeddingModel = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf#0f741b5a6585bd53aeb15cd1372c56f2a0f65e12";
var recommendedEmbeddingModelSha256 = "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63";
var MAX_EMBEDDING_MODEL_BYTES = 2 * 1024 * 1024 * 1024;
var semanticIndexSchema = 1;
var qmdIndexerVersion = "2.5.3+hraness.aa993dceb3ef8cfb71d470554ca437570f5a2b3c";
var collectionName = "kb";
var markdownPattern = "**/*.md";
var ignoredPatterns = ["index.md", "**/AGENTS.md"];
var embeddingChunkStrategy = "regex";
var globalContext = "A Markdown knowledge base. Source records preserve evidence; maintained notes contain current synthesis; explicit wikilinks define structural relationships.";
var collectionContext = {
  "/": "Knowledge-base notes, clipped sources, plans, reports, and explicit contextual links.",
  "/articles": "Captured source records and their acquisition provenance.",
  "/notes": "Maintained concepts, comparisons, and current synthesis.",
  "/plans": "Decisions, constraints, execution state, and verification evidence.",
  "/riffs": "Voice-preserving first-person source thought."
};
var recommendedEmbeddingModelIdentity = `${recommendedEmbeddingModel}@sha256:${recommendedEmbeddingModelSha256}`;
var semanticIndexIdentity = {
  producer: { package: "@hraness/kb", schema: semanticIndexSchema },
  indexer: { package: "@tobilu/qmd", version: qmdIndexerVersion },
  collection: {
    name: collectionName,
    pattern: markdownPattern,
    ignore: ignoredPatterns,
    globalContext,
    pathContexts: Object.entries(collectionContext).map(([path, context]) => ({ path, context }))
  },
  embedding: {
    model: recommendedEmbeddingModelIdentity,
    chunkStrategy: embeddingChunkStrategy
  }
};
var qmdModuleSpecifier = "@tobilu/qmd";
async function sha256EmbeddingModelFile(path) {
  const handle = await open3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new TypeError("The embedding model must be a regular file.");
    if (metadata.size > MAX_EMBEDDING_MODEL_BYTES) {
      throw new RangeError(`The embedding model exceeds ${MAX_EMBEDDING_MODEL_BYTES.toLocaleString("en-US")} bytes.`);
    }
    const hash = createHash2("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let observed = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0)
        break;
      observed += bytesRead;
      if (observed > MAX_EMBEDDING_MODEL_BYTES) {
        throw new RangeError(`The embedding model exceeds ${MAX_EMBEDDING_MODEL_BYTES.toLocaleString("en-US")} bytes.`);
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.size !== metadata.size || observed !== metadata.size) {
      throw new Error("The embedding model changed while its digest was computed; retry.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function verifiedEmbeddingModelSource(path, dependencies) {
  if (path === undefined)
    return recommendedEmbeddingModel;
  const absolutePath = resolve3(path);
  const digest = await (dependencies.digestEmbeddingModelFile ?? sha256EmbeddingModelFile)(absolutePath);
  if (digest !== recommendedEmbeddingModelSha256) {
    throw new Error("The local embedding model does not match the pinned recommended model SHA-256.");
  }
  return absolutePath;
}
function cacheHome(dependencies) {
  const configured = dependencies.cacheHome ?? process.env.XDG_CACHE_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    return isAbsolute2(configured) ? configured : resolve3(configured);
  }
  return join3(homedir(), ".cache");
}
function semanticDatabasePath(root, dependencies = {}) {
  const identity = createHash2("sha256").update(resolve3(root)).digest("hex").slice(0, 20);
  return join3(cacheHome(dependencies), "hraness-kb", "indexes", `${identity}.sqlite`);
}
async function resolvedDirectory(path) {
  const root = await realpath3(resolve3(path));
  if (!(await stat(root)).isDirectory())
    throw new Error("Knowledge-base root must be a directory.");
  return root;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundaryRecord(value, label) {
  if (!isRecord2(value))
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
function boundedResultArray(value, label, maximum) {
  const results = boundaryArray(value, label);
  if (results.length > maximum) {
    throw new Error(`${label} returned more than the requested ${maximum} results.`);
  }
  return results;
}
function parseSearchResults(value, maximum) {
  return boundedResultArray(value, "QMD search results", maximum).map((result, index) => parseSearchDocument(result, index));
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
function internalVectorBoundary(store, modelIdentity) {
  if (store.internal === undefined)
    return null;
  const internal = boundaryRecord(store.internal, "QMD store.internal");
  const llm = boundaryRecord(internal.llm, "QMD store.internal.llm");
  const getHashesNeedingEmbedding = boundUnknownMethod(internal, "getHashesNeedingEmbedding", "QMD store.internal");
  const searchVec = boundUnknownMethod(internal, "searchVec", "QMD store.internal");
  const embed = boundUnknownMethod(llm, "embed", "QMD store.internal.llm");
  const session = Object.freeze({ embed });
  return {
    pendingEmbeddingCount: async () => boundaryCount(await getHashesNeedingEmbedding(modelIdentity), "QMD store.internal.getHashesNeedingEmbedding result"),
    searchVector: async (query, options) => parseSearchResults(await searchVec(query, modelIdentity, options.limit, options.collection, session), options.limit)
  };
}
function parseSearchStore(value, modelIdentity) {
  const store = boundaryRecord(value, "QMD store");
  const close = boundUnknownMethod(store, "close", "QMD store");
  const embed = boundUnknownMethod(store, "embed", "QMD store");
  const searchLex = boundUnknownMethod(store, "searchLex", "QMD store");
  const searchVector = boundUnknownMethod(store, "searchVector", "QMD store");
  const update = boundUnknownMethod(store, "update", "QMD store");
  const internalVector = internalVectorBoundary(store, modelIdentity);
  return {
    close: async () => {
      await close();
    },
    embed: async (options) => parseEmbeddingResult(await embed(options)),
    searchLex: async (query, options) => parseSearchResults(await searchLex(query, options), options.limit),
    searchVector: internalVector?.searchVector ?? (async (query, options) => parseSearchResults(await searchVector(query, options), options.limit)),
    update: async (options) => {
      const result = parseUpdateResult(await update(options));
      if (internalVector === null)
        return result;
      return {
        ...result,
        needsEmbedding: await internalVector.pendingEmbeddingCount()
      };
    }
  };
}
async function closeMalformedStore(value) {
  if (!isRecord2(value))
    return;
  const close = value.close;
  if (typeof close !== "function")
    return;
  try {
    const returned = Reflect.apply(close, value, []);
    await returned;
  } catch {}
}
async function openedSearchStore(value, modelIdentity) {
  try {
    return parseSearchStore(value, modelIdentity);
  } catch (error) {
    await closeMalformedStore(value);
    throw error;
  }
}
function storeConfig(root, embeddingModelSource) {
  return {
    global_context: globalContext,
    collections: {
      [collectionName]: {
        path: root,
        pattern: markdownPattern,
        ignore: ignoredPatterns,
        context: collectionContext
      }
    },
    models: { embed: embeddingModelSource }
  };
}
async function defaultCreateStore(options) {
  const loaded = await import(qmdModuleSpecifier);
  const module = boundaryRecord(loaded, "QMD module");
  const createStore = boundUnknownMethod(module, "createStore", "QMD module");
  return await createStore(options);
}
async function openStore(root, database, embeddingModelSource, dependencies) {
  await mkdir2(dirname3(database), { recursive: true });
  const created = await (dependencies.createStore ?? defaultCreateStore)({
    dbPath: database,
    config: storeConfig(root, embeddingModelSource)
  });
  return await openedSearchStore(created, recommendedEmbeddingModel);
}
function databaseFor(root, requested, dependencies) {
  if (requested === undefined)
    return semanticDatabasePath(root, dependencies);
  return resolve3(requested);
}
async function embedChanged(store, update, force) {
  if (!force && update.needsEmbedding === 0)
    return null;
  return await store.embed({
    collection: collectionName,
    force,
    model: recommendedEmbeddingModel,
    chunkStrategy: embeddingChunkStrategy
  });
}
async function semanticSnapshot(root, dependencies) {
  return await (dependencies.scanVault ?? ((vaultRoot) => scanVault(vaultRoot, { mentionScope: false })))(root);
}
async function indexSemanticVault(options, dependencies = {}) {
  const root = await resolvedDirectory(options.root);
  const databaseCandidate = await resolveSemanticDatabase(databaseFor(root, options.database, dependencies), root);
  const snapshot2 = await semanticSnapshot(root, dependencies);
  const description = await describeSemanticProjection(databaseCandidate, root, snapshot2.notes, semanticIndexIdentity);
  const database = description.database;
  return await withSemanticGenerationWriterLease(database, description.manifest.generation, async () => {
    const projection = await prepareSemanticProjection(description, snapshot2.notes);
    let store;
    try {
      store = await openStore(projection.root, database, recommendedEmbeddingModel, dependencies);
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
  }, {
    ...dependencies.writerLease,
    excludeReaders: options.force === true
  });
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
function qmdNoteLookup(notes, contentHashesByPath) {
  const lookup = new Map;
  for (const note of notes) {
    const qmdPath = qmdHandelize(note.path);
    if (qmdPath === null)
      continue;
    const contentHash = contentHashesByPath.get(note.path);
    if (contentHash === undefined) {
      throw new Error(`Semantic projection lost the hash for ${JSON.stringify(note.path)}.`);
    }
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
async function resolvedSearchNote(projectionRoot, result, notesByPath, notesByQmdPath, contentHashesByPath) {
  const virtualPath = qmdVirtualNotePath(result.filepath);
  if (virtualPath !== undefined) {
    if (virtualPath === null)
      return null;
    const candidates = notesByQmdPath.get(virtualPath)?.get(result.hash) ?? [];
    const candidate2 = candidates[0];
    return candidates.length === 1 && candidate2 !== undefined && contentHashesByPath.get(candidate2.path) === result.hash ? candidate2 : null;
  }
  if (!isAbsolute2(result.filepath))
    return null;
  let filepath;
  try {
    filepath = await realpath3(resolve3(result.filepath));
  } catch {
    return null;
  }
  const candidate = relative3(projectionRoot, filepath);
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep3}`) || isAbsolute2(candidate)) {
    return null;
  }
  const note = notesByPath.get(candidate.split(sep3).join("/"));
  return note !== undefined && contentHashesByPath.get(note.path) === result.hash ? note : null;
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
async function searchHit(projectionRoot, query, result, notesByPath, notesByQmdPath, contentHashesByPath, connectionsById) {
  const note = await resolvedSearchNote(projectionRoot, result, notesByPath, notesByQmdPath, contentHashesByPath);
  if (note === null)
    return null;
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
function semanticDocumentKey(document) {
  return JSON.stringify([document.filepath, document.hash]);
}
function firstDocumentsByKey(documents) {
  const byKey = new Map;
  for (const document of documents) {
    const key = semanticDocumentKey(document);
    if (!byKey.has(key))
      byKey.set(key, document);
  }
  return byKey;
}
function fusedHybridDocuments(lexical, vector, candidateLimit) {
  const lexicalByKey = firstDocumentsByKey(lexical);
  const vectorByKey = firstDocumentsByKey(vector);
  return fuseRankedCandidates([
    { name: "keyword", weight: 1, ids: lexical.map(semanticDocumentKey) },
    { name: "semantic", weight: 1, ids: vector.map(semanticDocumentKey) }
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
        semantic: candidate.contributions.some(({ lane }) => lane === "semantic")
      }
    };
  });
}
async function hybridSearchHit(projectionRoot, query, result, notesByPath, notesByQmdPath, contentHashesByPath, connectionsById) {
  const hit = await searchHit(projectionRoot, query, result.document, notesByPath, notesByQmdPath, contentHashesByPath, connectionsById);
  if (hit === null)
    return null;
  return {
    ...hit,
    score: result.score,
    source: "hybrid",
    signals: result.signals
  };
}
function boundedLimit(value, maximum) {
  if (value === undefined)
    return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Search limit must be an integer from 1 through ${maximum}.`);
  }
  return value;
}
function boundedCandidateLimit(value, resultLimit) {
  if (value === undefined)
    return Math.max(40, resultLimit * 4);
  if (!Number.isSafeInteger(value) || value < resultLimit || value > 500) {
    throw new Error(`Search candidate limit must be an integer from ${resultLimit} through 500.`);
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
function boundedMode(value) {
  const mode = value ?? "semantic";
  if (mode !== "hybrid" && mode !== "keyword" && mode !== "semantic") {
    throw new Error('Search mode must be "hybrid", "keyword", or "semantic".');
  }
  return mode;
}
async function executeSemanticSearch(context, options) {
  const query = validateSearchQuery(options.query).query;
  const mode = boundedMode(options.mode);
  const limit = boundedLimit(options.limit, 500);
  const candidateLimit = boundedCandidateLimit(options.candidateLimit, limit);
  const minScore = boundedScore(options.minScore);
  const embedding = mode === "keyword" ? null : await context.ensureEmbedding();
  let hits;
  let rawRequested;
  let rawReturned;
  let rawDiscarded;
  let rawThresholdRejected;
  let rawExhausted;
  if (mode === "hybrid") {
    const lexical = await context.store.searchLex(query, {
      collection: collectionName,
      limit: candidateLimit
    });
    const vector = await context.store.searchVector(query, {
      collection: collectionName,
      limit: candidateLimit
    });
    const fused = fusedHybridDocuments(lexical, vector, candidateLimit);
    const considered = fused.filter(({ score }) => score >= minScore);
    rawRequested = candidateLimit;
    rawReturned = fused.length;
    rawThresholdRejected = fused.length - considered.length;
    rawExhausted = fused.length < candidateLimit && lexical.length < candidateLimit && vector.length < candidateLimit;
    hits = await Promise.all(considered.map((result) => hybridSearchHit(context.projectionRoot, query, result, context.notesByPath, context.notesByQmdPath, context.contentHashesByPath, context.connectionsById)));
    rawDiscarded = considered.length - hits.filter((hit) => hit !== null).length;
  } else {
    const matches = mode === "semantic" ? await context.store.searchVector(query, {
      collection: collectionName,
      limit: candidateLimit
    }) : await context.store.searchLex(query, {
      collection: collectionName,
      limit: candidateLimit
    });
    rawRequested = candidateLimit;
    rawReturned = matches.length;
    const considered = matches.filter(({ score }) => score >= minScore);
    rawThresholdRejected = matches.length - considered.length;
    rawExhausted = matches.length < candidateLimit;
    hits = await Promise.all(considered.map((result) => searchHit(context.projectionRoot, query, result, context.notesByPath, context.notesByQmdPath, context.contentHashesByPath, context.connectionsById)));
    rawDiscarded = considered.length - hits.filter((hit) => hit !== null).length;
  }
  const verified = hits.filter((hit) => hit !== null);
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
      exhausted: rawExhausted
    },
    results: verified.slice(0, limit)
  };
}
async function openSemanticSearchSession(options, dependencies = {}) {
  const embeddingModelSource = await verifiedEmbeddingModelSource(options.embeddingModelFile, dependencies);
  const root = await resolvedDirectory(options.root);
  const databaseCandidate = await resolveSemanticDatabase(databaseFor(root, options.database, dependencies), root);
  const snapshot2 = await semanticSnapshot(root, dependencies);
  const description = await describeSemanticProjection(databaseCandidate, root, snapshot2.notes, semanticIndexIdentity);
  const database = description.database;
  let retained;
  let initialized;
  try {
    initialized = await withSemanticGenerationWriterLease(database, description.manifest.generation, async () => {
      const projection2 = await prepareSemanticProjection(description, snapshot2.notes);
      let store2;
      try {
        store2 = await openStore(projection2.root, database, embeddingModelSource, dependencies);
        retained = { store: store2, projection: projection2 };
        const update2 = await store2.update({ collections: [collectionName] });
        return { store: store2, projection: projection2, update: update2 };
      } catch (error) {
        try {
          await store2?.close();
        } finally {
          await projection2.release();
          retained = undefined;
        }
        throw error;
      }
    }, dependencies.writerLease);
  } catch (error) {
    await retained?.store.close().catch(() => {
      return;
    });
    await retained?.projection.release().catch(() => {
      return;
    });
    throw error;
  }
  const { store, projection, update } = initialized;
  const notesByPath = new Map(snapshot2.notes.map((note) => [note.path, note]));
  const contentHashesByPath = new Map(description.manifest.notes.map(({ path, sha256 }) => [path, sha256]));
  const notesByQmdPath = qmdNoteLookup(snapshot2.notes, contentHashesByPath);
  const connectionsById = new Map(snapshot2.analysis.noteConnections.map((connection) => [connection.id, connection]));
  let embeddingPromise;
  const ensureEmbedding = () => {
    embeddingPromise ??= update.needsEmbedding === 0 ? Promise.resolve(null) : withSemanticGenerationWriterLease(database, projection.manifest.generation, async () => {
      const refreshed = await store.update({ collections: [collectionName] });
      return await embedChanged(store, refreshed, false);
    }, dependencies.writerLease);
    return embeddingPromise;
  };
  let tail = Promise.resolve();
  let closeRequested = false;
  let closePromise;
  const serialize = (operation) => {
    const result = tail.then(operation);
    tail = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  };
  const context = {
    root,
    projectionRoot: projection.root,
    database,
    store,
    update,
    ensureEmbedding,
    notesByPath,
    notesByQmdPath,
    contentHashesByPath,
    connectionsById
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
      if (closePromise !== undefined)
        return closePromise;
      closeRequested = true;
      closePromise = serialize(async () => {
        try {
          await store.close();
        } finally {
          await projection.release();
        }
      });
      return closePromise;
    }
  };
}
async function searchSemanticVault(options, dependencies = {}) {
  const query = validateSearchQuery(options.query).query;
  const mode = boundedMode(options.mode);
  const limit = boundedLimit(options.limit, 100);
  const candidateLimit = boundedCandidateLimit(options.candidateLimit, limit);
  const minScore = boundedScore(options.minScore);
  const session = await openSemanticSearchSession({
    root: options.root,
    ...options.database === undefined ? {} : { database: options.database }
  }, dependencies);
  try {
    return await session.search({
      query,
      mode,
      limit,
      candidateLimit,
      minScore
    });
  } finally {
    await session.close();
  }
}

export { MAX_SCANNED_NOTES, MAX_NOTE_UTF8_BYTES, MAX_VAULT_UTF8_BYTES, VaultScanBudgetError, defaultIgnoredDirectories, markdownFiles, readVaultNotes, scanVault, refreshVault, recommendedEmbeddingModel, recommendedEmbeddingModelSha256, MAX_EMBEDDING_MODEL_BYTES, qmdIndexerVersion, sha256EmbeddingModelFile, semanticDatabasePath, indexSemanticVault, openSemanticSearchSession, searchSemanticVault };
