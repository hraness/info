// @bun
import {
  isCanonicalNoteId
} from "./index-q2ks380z.js";

// src/authoring.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "crypto";
import { constants as constants2 } from "fs";
import {
  link as link2,
  lstat as lstat2,
  mkdir as mkdir2,
  open as open2,
  readdir,
  realpath as realpath2,
  rename as rename2,
  rmdir,
  unlink as unlink2
} from "fs/promises";
import {
  basename,
  dirname,
  join as join2,
  posix,
  relative as relative2,
  resolve as resolve2,
  sep as sep2
} from "path";
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument
} from "yaml";

// src/note-lock.ts
import { createHash, randomUUID } from "crypto";
import { constants } from "fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
var LOCK_SCHEMA_VERSION = 1;
var MAX_LOCK_BYTES = 4 * 1024;
var DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
var DEFAULT_HEARTBEAT_MS = 5000;
var DEFAULT_POLL_INTERVAL_MS = 20;
var DEFAULT_WAIT_TIMEOUT_MS = 30000;
var MAX_RECLAIM_ATTEMPTS = 8;

class NoteLockBusyError extends Error {
  lockPath;
  constructor(lockPath) {
    super("this note is already being edited");
    this.name = "NoteLockBusyError";
    this.lockPath = lockPath;
  }
}

class NoteLockLostError extends Error {
  lockPath;
  constructor(lockPath) {
    super("the note lock is no longer owned by this process");
    this.name = "NoteLockLostError";
    this.lockPath = lockPath;
  }
}
function isErrno(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function within(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}
function defaultCacheHome() {
  const configured = process.env.XDG_CACHE_HOME;
  return configured !== undefined && isAbsolute(configured) ? configured : join(homedir(), ".cache");
}
function defaultDependencies() {
  return {
    pid: process.pid,
    now: () => new Date,
    monotonicNow: () => performance.now(),
    token: () => randomUUID(),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !isErrno(error, "ESRCH");
      }
    },
    sleep: async (milliseconds) => {
      await new Promise((resolveSleep) => {
        setTimeout(resolveSleep, milliseconds);
      });
    },
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS
  };
}
function resolvedDependencies(overrides) {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0) {
    throw new TypeError("a note lock requires a positive process ID");
  }
  for (const [label, value] of [
    ["staleAfterMs", dependencies.staleAfterMs],
    ["heartbeatMs", dependencies.heartbeatMs],
    ["pollIntervalMs", dependencies.pollIntervalMs]
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive finite duration`);
    }
  }
  return dependencies;
}
async function lockPathFor(vaultRootInput, canonicalNoteId, cacheHomeInput) {
  if (canonicalNoteId === "" || canonicalNoteId.includes("\x00") || canonicalNoteId.includes(`
`) || canonicalNoteId.includes("\r")) {
    throw new TypeError("a note lock requires a non-empty single-line note ID");
  }
  const vaultRoot = await realpath(resolve(vaultRootInput));
  const cacheHome = resolve(cacheHomeInput ?? defaultCacheHome());
  const requestedDirectory = join(cacheHome, "hraness-oh", "note-locks", sha256(vaultRoot));
  await mkdir(requestedDirectory, { recursive: true, mode: 448 });
  const requestedMetadata = await lstat(requestedDirectory);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("the note lock root must be a real directory");
  }
  const lockDirectory = await realpath(requestedDirectory);
  if (within(vaultRoot, lockDirectory)) {
    throw new Error("the note lock root must remain outside the vault");
  }
  return join(lockDirectory, `${sha256(canonicalNoteId)}.lock`);
}
function parseOwner(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value;
  const version = record["version"];
  const pid = record["pid"];
  const token = record["token"];
  const acquiredAt = record["acquiredAt"];
  if (version !== LOCK_SCHEMA_VERSION || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof token !== "string" || !/^[0-9a-z-]{16,128}$/iu.test(token) || typeof acquiredAt !== "string" || Number.isNaN(Date.parse(acquiredAt))) {
    return null;
  }
  return { version, pid, token, acquiredAt };
}
async function observeLock(path) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size > BigInt(MAX_LOCK_BYTES)) {
    return { kind: "unsafe" };
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return isErrno(error, "ENOENT") ? null : { kind: "unsafe" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size || opened.size > BigInt(MAX_LOCK_BYTES)) {
      return { kind: "unsafe" };
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0)
        return { kind: "unsafe" };
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, Number(opened.size))).bytesRead !== 0) {
      return { kind: "unsafe" };
    }
    const finished = await handle.stat({ bigint: true });
    let finalPath;
    try {
      finalPath = await lstat(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        return null;
      throw error;
    }
    if (!finalPath.isFile() || finalPath.isSymbolicLink() || finalPath.nlink !== 1n || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size || finished.size !== opened.size || finished.mtimeNs !== opened.mtimeNs || finished.ctimeNs !== opened.ctimeNs) {
      return { kind: "unsafe" };
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      value = null;
    }
    return {
      kind: "regular",
      device: opened.dev,
      inode: opened.ino,
      modifiedAtMs: Number(opened.mtimeMs),
      owner: parseOwner(value)
    };
  } finally {
    await handle.close();
  }
}
function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}
async function restoreUnexpectedLock(tombstone, lockPath) {
  try {
    await link(tombstone, lockPath);
  } catch {
    return;
  }
  try {
    await unlink(tombstone);
  } catch {}
}
async function reclaimObservedLock(lockPath, observed, token, dependencies) {
  const tombstone = `${lockPath}.stale-${token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST"))
      return false;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved === null || moved.kind !== "regular" || !sameIdentity(observed, moved)) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return false;
  }
  await unlink(tombstone);
  return true;
}
async function releaseOwnedLock(lockPath, owner, dependencies) {
  const tombstone = `${lockPath}.release-${owner.token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      return;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved?.kind !== "regular" || moved.owner?.token !== owner.token) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return;
  }
  await unlink(tombstone);
}
async function tryAcquire(lockPath, dependencies) {
  for (let attempt = 0;attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const owner = {
      version: LOCK_SCHEMA_VERSION,
      pid: dependencies.pid,
      token: dependencies.token(),
      acquiredAt: dependencies.now().toISOString()
    };
    let handle;
    try {
      handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 384);
    } catch (error) {
      if (!isErrno(error, "EEXIST"))
        throw error;
      const observed = await observeLock(lockPath);
      if (observed === null)
        continue;
      if (observed.kind === "unsafe")
        throw new NoteLockBusyError(lockPath);
      const ageMs = Math.max(0, dependencies.now().getTime() - observed.modifiedAtMs);
      const ownerAlive = observed.owner !== null && dependencies.isProcessAlive(observed.owner.pid);
      if (ownerAlive || observed.owner === null && ageMs <= dependencies.staleAfterMs) {
        throw new NoteLockBusyError(lockPath);
      }
      if (await reclaimObservedLock(lockPath, observed, owner.token, dependencies)) {
        continue;
      }
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify(owner)}
`, { encoding: "utf8" });
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {
        return;
      });
      const created = await observeLock(lockPath);
      if (created?.kind === "regular") {
        await reclaimObservedLock(lockPath, created, owner.token, dependencies).catch(() => {
          return;
        });
      }
      throw error;
    }
    const timer = setInterval(() => {
      const now = dependencies.now();
      handle.utimes(now, now).catch(() => {
        return;
      });
    }, dependencies.heartbeatMs);
    timer.unref();
    let released = false;
    return {
      path: lockPath,
      assertOwned: async () => {
        const observed = await observeLock(lockPath);
        if (observed?.kind !== "regular" || observed.owner?.token !== owner.token) {
          throw new NoteLockLostError(lockPath);
        }
      },
      release: async () => {
        if (released)
          return;
        released = true;
        clearInterval(timer);
        await handle.close();
        await releaseOwnedLock(lockPath, owner, dependencies);
      }
    };
  }
  throw new NoteLockBusyError(lockPath);
}
async function acquireNoteLock(vaultRoot, canonicalNoteId, options = {}) {
  const lockPath = await lockPathFor(vaultRoot, canonicalNoteId, options.cacheHome);
  const dependencies = resolvedDependencies(options.dependencies);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new TypeError("waitTimeoutMs must be a non-negative finite duration");
  }
  const deadline = dependencies.monotonicNow() + waitTimeoutMs;
  for (;; ) {
    try {
      return await tryAcquire(lockPath, dependencies);
    } catch (error) {
      if (!(error instanceof NoteLockBusyError))
        throw error;
      const remaining = deadline - dependencies.monotonicNow();
      if (remaining <= 0)
        throw error;
      await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remaining));
    }
  }
}

// src/authoring.ts
var MAX_NOTE_BYTES = 16 * 1024 * 1024;
var NOTE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
var PREDICATE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var MAX_PARENT_DIRECTORY_ENTRIES = 1e5;
var MAX_RECOVERY_LOCATIONS_PER_NOTE = 8;

class InvalidCanonicalNoteIdError extends TypeError {
  noteId;
  constructor(noteId) {
    super(`not an exact canonical note ID: ${JSON.stringify(noteId)}`);
    this.name = "InvalidCanonicalNoteIdError";
    this.noteId = noteId;
  }
}

class NoteRevisionConflictError extends Error {
  path;
  expected;
  actual;
  recoveryPath;
  constructor(path, expected, actual, recoveryPath = null) {
    super(recoveryPath === null ? "the note changed during authoring; retry from its current revision" : `the note changed during authoring; displaced bytes remain at ${recoveryPath}`);
    this.name = "NoteRevisionConflictError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.recoveryPath = recoveryPath;
  }
}

class NoteAlreadyExistsError extends Error {
  path;
  constructor(path, reason) {
    super(`the existing note is incompatible with this create request: ${reason}`);
    this.name = "NoteAlreadyExistsError";
    this.path = path;
  }
}

class NoteRecoveryRequiredError extends Error {
  path;
  recoveryPath;
  constructor(path, recoveryPath, cause) {
    super(`authoring stopped; displaced bytes remain at ${recoveryPath}`, { cause });
    this.name = "NoteRecoveryRequiredError";
    this.path = path;
    this.recoveryPath = recoveryPath;
  }
}
function isErrno2(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sha2562(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function revisionFor(bytes) {
  return `sha256:${sha2562(bytes)}`;
}
function inside(root, candidate) {
  const fromRoot = relative2(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep2}`);
}
function canonicalNoteId(value) {
  if (!isCanonicalNoteId(value)) {
    throw new InvalidCanonicalNoteIdError(value);
  }
  return value;
}
function normalizeRelationPredicate(value) {
  const normalized = value.trim().normalize("NFC").toLocaleLowerCase("en-US").replaceAll("_", "-").replace(/\s+/gu, "-").replace(/-{2,}/gu, "-");
  if (!PREDICATE_PATTERN.test(normalized)) {
    throw new TypeError(`not a valid relation predicate: ${JSON.stringify(value)}`);
  }
  return normalized;
}
function exactPredicate(value) {
  const normalized = normalizeRelationPredicate(value);
  if (value !== normalized) {
    throw new Error(`authored relation predicate is not canonical kebab-case: ${value}`);
  }
  return value;
}
function requireRevision(value) {
  if (!NOTE_REVISION_PATTERN.test(value)) {
    throw new TypeError("expectedRevision is not an Oh note revision");
  }
  return value;
}
async function resolveVault(rootInput) {
  const root = await realpath2(resolve2(rootInput));
  const metadata = await lstat2(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the vault root must be a real directory");
  }
  if (dirname(root) === root) {
    throw new Error("refusing to author notes in a filesystem root");
  }
  return { root };
}
function pathFor(vault, id) {
  const canonicalId = canonicalNoteId(id);
  const relativePath = `${canonicalId}.md`;
  const path = resolve2(vault.root, ...relativePath.split("/"));
  if (!inside(vault.root, path)) {
    throw new InvalidCanonicalNoteIdError(id);
  }
  return { path, relativePath };
}
async function assertExactDirectoryEntry(directory, name) {
  const entries = await readdir(directory);
  if (!entries.includes(name)) {
    const error = new Error(`vault path component is not exact: ${name}`);
    error.code = "ENOENT";
    throw error;
  }
}
async function assertSafeParent(vault, path) {
  if (!inside(vault.root, path)) {
    throw new Error("the note path must remain inside the vault");
  }
  const parent = dirname(path);
  const segments = relative2(vault.root, parent).split(sep2).filter(Boolean);
  let current = vault.root;
  for (const segment of segments) {
    await assertExactDirectoryEntry(current, segment);
    current = join2(current, segment);
    const metadata = await lstat2(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("the note path must not traverse a symbolic link");
    }
    if (!metadata.isDirectory()) {
      throw new Error("every note parent must be a directory");
    }
  }
  const canonicalParent = await realpath2(parent);
  if (canonicalParent !== parent || !inside(vault.root, join2(canonicalParent, basename(path)))) {
    throw new Error("the note parent resolves outside the vault");
  }
}
async function readSnapshotAtPath(vault, path, relativePath) {
  await assertSafeParent(vault, path);
  await assertExactDirectoryEntry(dirname(path), basename(path));
  const beforeOpen = await lstat2(path, { bigint: true });
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw new Error("the note target must be a regular file");
  }
  if (beforeOpen.nlink !== 1n) {
    throw new Error("the note target must not be hard-linked");
  }
  if (beforeOpen.size > BigInt(MAX_NOTE_BYTES)) {
    throw new Error("the note is too large for bounded authoring");
  }
  const handle = await open2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino || opened.size !== beforeOpen.size || opened.size > BigInt(MAX_NOTE_BYTES)) {
      throw new Error("the note target changed while it was opened");
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error("the note target changed while it was read");
      }
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, Number(opened.size))).bytesRead !== 0) {
      throw new Error("the note target grew while it was read");
    }
    const finished = await handle.stat({ bigint: true });
    const finalPath = await lstat2(path, { bigint: true });
    if (!finalPath.isFile() || finalPath.isSymbolicLink() || finalPath.nlink !== 1n || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size || finished.size !== opened.size || finished.mtimeNs !== opened.mtimeNs || finished.ctimeNs !== opened.ctimeNs) {
      throw new Error("the note target changed while it was read");
    }
    const canonicalPath = await realpath2(path);
    if (canonicalPath !== path || !inside(vault.root, canonicalPath)) {
      throw new Error("the note target resolves outside the vault");
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error("the note target is not valid UTF-8", { cause: error });
    }
    return {
      path,
      relativePath,
      content,
      revision: revisionFor(bytes),
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      modifiedAtNs: opened.mtimeNs,
      changedAtNs: opened.ctimeNs,
      mode: Number(opened.mode & 0o777n)
    };
  } finally {
    await handle.close();
  }
}
async function readSnapshot(vault, id) {
  const { path, relativePath } = pathFor(vault, id);
  return readSnapshotAtPath(vault, path, relativePath);
}
async function readOptionalSnapshot(vault, id) {
  try {
    return await readSnapshot(vault, id);
  } catch (error) {
    if (isErrno2(error, "ENOENT"))
      return null;
    throw error;
  }
}
function sameSnapshot(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.modifiedAtNs === right.modifiedAtNs && left.changedAtNs === right.changedAtNs && left.mode === right.mode && left.revision === right.revision;
}
function frontmatter(content, relativePath) {
  const firstLineEnd = content.indexOf(`
`);
  const openingEnd = firstLineEnd === -1 ? content.length : firstLineEnd;
  const openingContentEnd = content[openingEnd - 1] === "\r" ? openingEnd - 1 : openingEnd;
  const opening = content.slice(0, openingContentEnd);
  if (opening.trim() !== "---") {
    return {
      document: parseFrontmatterDocument("", relativePath),
      hadFrontmatter: false,
      openingDelimiter: "---",
      closingDelimiter: "---",
      newline: content.includes(`\r
`) ? `\r
` : `
`,
      bodySuffix: content
    };
  }
  if (firstLineEnd === -1) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: missing closing delimiter`);
  }
  const newline = content[firstLineEnd - 1] === "\r" ? `\r
` : `
`;
  let cursor = firstLineEnd + 1;
  for (;; ) {
    const nextNewline = content.indexOf(`
`, cursor);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const lineContentEnd = content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = content.slice(cursor, lineContentEnd);
    if (line.trim() === "---") {
      const yamlSource = content.slice(firstLineEnd + 1, cursor);
      return {
        document: parseFrontmatterDocument(yamlSource, relativePath),
        hadFrontmatter: true,
        openingDelimiter: content.slice(0, openingContentEnd),
        closingDelimiter: content.slice(cursor, lineContentEnd),
        newline,
        bodySuffix: content.slice(lineContentEnd)
      };
    }
    if (nextNewline === -1)
      break;
    cursor = nextNewline + 1;
  }
  throw new Error(`invalid YAML frontmatter in ${relativePath}: missing closing delimiter`);
}
function parseFrontmatterDocument(source, relativePath) {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    schema: "core",
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: expected a mapping`);
  }
  if (isMap(document.contents)) {
    const seen = new Set;
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error(`invalid YAML frontmatter in ${relativePath}: keys must be strings`);
      }
      const folded = pair.key.value.toLocaleLowerCase("en-US");
      if (seen.has(folded)) {
        throw new Error(`invalid YAML frontmatter in ${relativePath}: keys must not differ only by case`);
      }
      seen.add(folded);
    }
  }
  return document;
}
function relationNodes(parts, relativePath, create) {
  const { document } = parts;
  if (document.contents === null) {
    if (!create) {
      const detached = document.createNode({});
      if (!isMap(detached))
        throw new Error("YAML did not create a mapping");
      return { root: detached, relations: null };
    }
    document.contents = document.createNode({});
  }
  if (!isMap(document.contents)) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: expected a mapping`);
  }
  const root = document.contents;
  const relationPair = root.items.find((pair) => isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value.toLocaleLowerCase("en-US") === "relations");
  const existing = relationPair?.value;
  if (existing === undefined) {
    if (!create)
      return { root, relations: null };
    const created = document.createNode({});
    if (!isMap(created))
      throw new Error("YAML did not create a relation mapping");
    root.set("relations", created);
    return { root, relations: created };
  }
  if (!isMap(existing)) {
    throw new Error(`invalid relations in ${relativePath}: expected a mapping`);
  }
  return { root, relations: existing };
}
function scalarString(value) {
  return isScalar(value) && typeof value.value === "string" ? value.value : null;
}
function relationsFromParts(parts, relativePath) {
  const { relations } = relationNodes(parts, relativePath, false);
  if (relations === null)
    return [];
  const output = [];
  const seen = new Set;
  for (const pair of relations.items) {
    const predicateValue = scalarString(pair.key);
    if (predicateValue === null) {
      throw new Error(`invalid relations in ${relativePath}: predicates must be strings`);
    }
    const predicate = exactPredicate(predicateValue);
    const scalarTarget = scalarString(pair.value);
    if (scalarTarget !== null) {
      const target = canonicalNoteId(scalarTarget);
      const key = `${predicate}\x00${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ predicate, target });
      }
      continue;
    }
    if (!isSeq(pair.value)) {
      throw new Error(`invalid relations in ${relativePath}: ${predicate} targets must be a string or array`);
    }
    for (const item of pair.value.items) {
      const targetValue = scalarString(item);
      if (targetValue === null) {
        throw new Error(`invalid relations in ${relativePath}: ${predicate} targets must be strings`);
      }
      const target = canonicalNoteId(targetValue);
      const key = `${predicate}\x00${target}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      output.push({ predicate, target });
    }
  }
  return output.toSorted((left, right) => left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target));
}
function relationValue(relations, predicate, relativePath) {
  const value = relations.get(predicate, true);
  if (value === undefined)
    return null;
  const scalarTarget = scalarString(value);
  if (scalarTarget !== null) {
    return { kind: "scalar", target: canonicalNoteId(scalarTarget) };
  }
  if (!isSeq(value)) {
    throw new Error(`invalid relations in ${relativePath}: ${predicate} targets must be a string or array`);
  }
  for (const item of value.items) {
    if (scalarString(item) === null) {
      throw new Error(`invalid relations in ${relativePath}: ${predicate} targets must be strings`);
    }
  }
  return { kind: "sequence", sequence: value };
}
function renderFrontmatter(parts) {
  let yaml = parts.document.toString({ lineWidth: 0 });
  if (parts.newline === `\r
`)
    yaml = yaml.replaceAll(`
`, `\r
`);
  if (!yaml.endsWith(parts.newline))
    yaml += parts.newline;
  if (parts.hadFrontmatter) {
    return parts.openingDelimiter + parts.newline + yaml + parts.closingDelimiter + parts.bodySuffix;
  }
  return parts.openingDelimiter + parts.newline + yaml + parts.closingDelimiter + parts.newline + parts.bodySuffix;
}
function compareScalarNodes(left, right) {
  return (scalarString(left) ?? "").localeCompare(scalarString(right) ?? "");
}
function addRelationToParts(parts, relativePath, predicate, target) {
  const { relations } = relationNodes(parts, relativePath, true);
  if (relations === null)
    throw new Error("YAML did not create relations");
  const existing = relationValue(relations, predicate, relativePath);
  if (existing === null) {
    const created = parts.document.createNode([target], { flow: true });
    if (!isSeq(created))
      throw new Error("YAML did not create a relation sequence");
    relations.set(predicate, created);
    return true;
  }
  if (existing.kind === "scalar") {
    if (existing.target === target)
      return false;
    const created = parts.document.createNode([existing.target, target].toSorted((left, right) => left.localeCompare(right)), { flow: true });
    if (!isSeq(created))
      throw new Error("YAML did not create a relation sequence");
    relations.set(predicate, created);
    return true;
  }
  const sequence = existing.sequence;
  if (sequence.items.some((item) => scalarString(item) === target))
    return false;
  sequence.add(parts.document.createNode(target));
  sequence.items.sort(compareScalarNodes);
  return true;
}
function removeRelationFromParts(parts, relativePath, predicate, target, sourceId) {
  const { root, relations } = relationNodes(parts, relativePath, false);
  if (relations === null)
    return false;
  const value = relations.get(predicate, true);
  if (value === undefined)
    return false;
  const repairableTarget = (raw) => {
    let candidate = raw;
    if (candidate.toLocaleLowerCase("en-US").endsWith(".md")) {
      candidate = candidate.slice(0, -3);
    }
    if (candidate.startsWith(".")) {
      candidate = posix.normalize(posix.join(posix.dirname(sourceId), candidate));
    }
    return isCanonicalNoteId(candidate) ? candidate : null;
  };
  const matches = (node) => {
    const raw = scalarString(node);
    return raw !== null && repairableTarget(raw) === target;
  };
  if (!isSeq(value)) {
    if (!matches(value))
      return false;
    relations.delete(predicate);
    if (relations.items.length === 0)
      root.delete("relations");
    return true;
  }
  const sequence = value;
  const retained = sequence.items.filter((item) => !matches(item));
  if (retained.length === sequence.items.length)
    return false;
  if (retained.length === 0) {
    relations.delete(predicate);
    if (relations.items.length === 0)
      root.delete("relations");
  } else {
    sequence.items = retained;
  }
  return true;
}
function dependenciesFor(overrides) {
  return {
    token: overrides?.token ?? randomUUID2,
    ...overrides?.beforeInstall === undefined ? {} : { beforeInstall: overrides.beforeInstall },
    ...overrides?.beforeCommit === undefined ? {} : { beforeCommit: overrides.beforeCommit },
    ...overrides?.afterSourceQuarantined === undefined ? {} : { afterSourceQuarantined: overrides.afterSourceQuarantined }
  };
}
async function cleanupTemporary(temporaryPath, identity) {
  if (identity === null)
    return;
  try {
    const current = await lstat2(temporaryPath, { bigint: true });
    if (current.dev === identity.device && current.ino === identity.inode) {
      await unlink2(temporaryPath);
    }
  } catch (error) {
    if (!isErrno2(error, "ENOENT"))
      throw error;
  }
}
async function fsyncDirectory(path) {
  const handle = await open2(path, constants2.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function recoveryRelativePath(vault, path) {
  return relative2(vault.root, path).split(sep2).join("/");
}
async function discoveredRecoveryLocations(vault, notePath) {
  const directory = dirname(notePath);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_PARENT_DIRECTORY_ENTRIES) {
    throw new Error("the note parent has too many entries for bounded recovery");
  }
  const prefix = `.${basename(notePath)}.`;
  const suffix = ".recovery";
  const matching = entries.filter(({ name }) => name.startsWith(prefix) && name.endsWith(suffix)).toSorted((left, right) => left.name.localeCompare(right.name));
  if (matching.length > MAX_RECOVERY_LOCATIONS_PER_NOTE) {
    const firstPath = join2(directory, matching[0]?.name ?? "");
    throw new NoteRecoveryRequiredError(recoveryRelativePath(vault, notePath), recoveryRelativePath(vault, firstPath), new Error("too many interrupted authoring transactions require manual recovery"));
  }
  const recoverable = [];
  const empty = [];
  for (const entry of matching) {
    const nonce = entry.name.slice(prefix.length, -suffix.length);
    const recoveryDirectory = join2(directory, entry.name);
    const recoveryDirectoryRelative = recoveryRelativePath(vault, recoveryDirectory);
    if (!/^\d+\.[0-9a-f]{32}$/u.test(nonce) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new NoteRecoveryRequiredError(recoveryRelativePath(vault, notePath), recoveryDirectoryRelative, new Error("an unrecognized authoring recovery artifact is present"));
    }
    const metadata = await lstat2(recoveryDirectory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath2(recoveryDirectory) !== recoveryDirectory) {
      throw new NoteRecoveryRequiredError(recoveryRelativePath(vault, notePath), recoveryDirectoryRelative, new Error("an authoring recovery directory changed identity"));
    }
    const children = await readdir(recoveryDirectory);
    if (children.length === 0) {
      empty.push({
        directory: recoveryDirectory,
        path: join2(recoveryDirectory, basename(notePath)),
        relativePath: recoveryRelativePath(vault, join2(recoveryDirectory, basename(notePath))),
        device: metadata.dev,
        inode: metadata.ino
      });
      continue;
    }
    if (children.length !== 1 || children[0] !== basename(notePath)) {
      throw new NoteRecoveryRequiredError(recoveryRelativePath(vault, notePath), recoveryDirectoryRelative, new Error("an authoring recovery directory has unexpected contents"));
    }
    const recoveryPath = join2(recoveryDirectory, basename(notePath));
    try {
      await readSnapshotAtPath(vault, recoveryPath, recoveryRelativePath(vault, recoveryPath));
    } catch (error) {
      throw new NoteRecoveryRequiredError(recoveryRelativePath(vault, notePath), recoveryRelativePath(vault, recoveryPath), error);
    }
    recoverable.push({
      directory: recoveryDirectory,
      path: recoveryPath,
      relativePath: recoveryRelativePath(vault, recoveryPath),
      device: metadata.dev,
      inode: metadata.ino
    });
  }
  return { recoverable, empty };
}
async function directoryIdentity(vault, notePath) {
  await assertSafeParent(vault, notePath);
  const metadata = await lstat2(dirname(notePath), { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the note parent must remain a real directory");
  }
  return { device: metadata.dev, inode: metadata.ino };
}
async function assertSameDirectory(vault, notePath, expected) {
  const current = await directoryIdentity(vault, notePath);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("the note parent changed during authoring");
  }
}
async function createRecoveryLocation(vault, path, dependencies) {
  const directory = dirname(path);
  const recoveryDirectory = join2(directory, `.${basename(path)}.${process.pid}.${sha2562(dependencies.token()).slice(0, 32)}.recovery`);
  await mkdir2(recoveryDirectory, { mode: 448 });
  const metadata = await lstat2(recoveryDirectory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the recovery location is not a private directory");
  }
  await fsyncDirectory(directory);
  const recoveryPath = join2(recoveryDirectory, basename(path));
  return {
    directory: recoveryDirectory,
    path: recoveryPath,
    relativePath: relative2(vault.root, recoveryPath).split(sep2).join("/"),
    device: metadata.dev,
    inode: metadata.ino
  };
}
async function assertRecoveryLocation(recovery) {
  const metadata = await lstat2(recovery.directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== recovery.device || metadata.ino !== recovery.inode || await realpath2(recovery.directory) !== recovery.directory) {
    throw new Error("the recovery location changed during authoring");
  }
}
async function removeRecoveryDirectory(recovery, parentDirectory) {
  await rmdir(recovery.directory);
  await fsyncDirectory(parentDirectory);
}
function sameQuarantinedSnapshot(quarantined, expected) {
  return quarantined.device === expected.device && quarantined.inode === expected.inode && quarantined.size === expected.size && quarantined.modifiedAtNs === expected.modifiedAtNs && quarantined.mode === expected.mode && quarantined.revision === expected.revision;
}
async function restoreQuarantinedSource(vault, recovery, path, expectedDirectory) {
  await assertSameDirectory(vault, path, expectedDirectory);
  await assertRecoveryLocation(recovery);
  try {
    await link2(recovery.path, path);
  } catch (error) {
    if (isErrno2(error, "EEXIST"))
      return false;
    throw error;
  }
  await unlink2(recovery.path);
  await fsyncDirectory(recovery.directory);
  await removeRecoveryDirectory(recovery, dirname(path));
  return true;
}
async function assertNoInterruptedRecovery(vault, id) {
  const { path, relativePath } = pathFor(vault, id);
  await assertSafeParent(vault, path);
  const artifacts = await discoveredRecoveryLocations(vault, path);
  const first = artifacts.recoverable[0] ?? artifacts.empty[0];
  if (first !== undefined) {
    throw new NoteRecoveryRequiredError(relativePath, first.relativePath, new Error("an interrupted authoring transaction requires a writer to recover it"));
  }
}
async function recoverInterruptedAuthoring(vault, id, lock) {
  const { path, relativePath } = pathFor(vault, id);
  await lock.assertOwned();
  await assertSafeParent(vault, path);
  const artifacts = await discoveredRecoveryLocations(vault, path);
  for (const emptyRecovery of artifacts.empty) {
    await assertRecoveryLocation(emptyRecovery);
    await removeRecoveryDirectory(emptyRecovery, dirname(path));
  }
  const first = artifacts.recoverable[0];
  if (first === undefined)
    return;
  if (artifacts.recoverable.length !== 1) {
    throw new NoteRecoveryRequiredError(relativePath, first.relativePath, new Error("multiple interrupted authoring transactions require manual recovery"));
  }
  const current = await readOptionalSnapshot(vault, id);
  if (current !== null) {
    throw new NoteRecoveryRequiredError(relativePath, first.relativePath, new Error("both the canonical note and displaced bytes exist"));
  }
  const expectedDirectory = await directoryIdentity(vault, path);
  if (!await restoreQuarantinedSource(vault, first, path, expectedDirectory)) {
    throw new NoteRecoveryRequiredError(relativePath, first.relativePath, new Error("the canonical note was recreated during interrupted recovery"));
  }
  await lock.assertOwned();
}
async function installTemporaryWithoutClobber(temporaryPath, path) {
  try {
    await link2(temporaryPath, path);
  } catch (error) {
    if (isErrno2(error, "EEXIST"))
      return false;
    throw error;
  }
  await unlink2(temporaryPath);
  return true;
}
async function currentRevisionOrNull(vault, id) {
  try {
    return (await readOptionalSnapshot(vault, id))?.revision ?? null;
  } catch {
    return null;
  }
}
function withRecoveryPath(error, relativePath, recoveryPath) {
  if (error instanceof NoteRevisionConflictError) {
    return new NoteRevisionConflictError(error.path, error.expected, error.actual, recoveryPath);
  }
  return new NoteRecoveryRequiredError(relativePath, recoveryPath, error);
}
async function atomicInstall(vault, id, content, expected, lock, dependencies) {
  const { path, relativePath } = pathFor(vault, id);
  await assertSafeParent(vault, path);
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_NOTE_BYTES) {
    throw new Error("the rendered note is too large for bounded authoring");
  }
  const directory = dirname(path);
  const expectedDirectory = await directoryIdentity(vault, path);
  const temporaryPath = join2(directory, `.${basename(path)}.${process.pid}.${sha2562(dependencies.token()).slice(0, 32)}.tmp`);
  const mode = expected?.mode ?? 420;
  const handle = await open2(temporaryPath, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW, mode);
  let closed = false;
  let identity = null;
  let recovery = null;
  let sourceQuarantined = false;
  let destinationInstalled = false;
  try {
    const created = await handle.stat({ bigint: true });
    if (!created.isFile() || created.nlink !== 1n) {
      throw new Error("the temporary note target is not a private regular file");
    }
    identity = { device: created.dev, inode: created.ino };
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    const complete = await handle.stat({ bigint: true });
    if (!complete.isFile() || complete.nlink !== 1n || complete.dev !== identity.device || complete.ino !== identity.inode) {
      throw new Error("the temporary note target changed before installation");
    }
    await handle.close();
    closed = true;
    await dependencies.beforeInstall?.({
      operation: expected === null ? "create" : "replace",
      path,
      temporaryPath
    });
    await lock.assertOwned();
    const current = await readOptionalSnapshot(vault, id);
    if (expected === null && current !== null || expected !== null && (current === null || !sameSnapshot(current, expected))) {
      throw new NoteRevisionConflictError(relativePath, expected?.revision ?? null, current?.revision ?? null);
    }
    await assertSafeParent(vault, path);
    const temporary = await lstat2(temporaryPath, { bigint: true });
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1n || temporary.dev !== identity.device || temporary.ino !== identity.inode) {
      throw new Error("the temporary note target changed before installation");
    }
    if (expected === null) {
      const context2 = {
        operation: "create",
        path,
        temporaryPath
      };
      await dependencies.beforeCommit?.(context2);
      await lock.assertOwned();
      await assertSameDirectory(vault, path, expectedDirectory);
      if (!await installTemporaryWithoutClobber(temporaryPath, path)) {
        throw new NoteRevisionConflictError(relativePath, null, await currentRevisionOrNull(vault, id));
      }
      destinationInstalled = true;
      await fsyncDirectory(directory);
      return revisionFor(bytes);
    }
    recovery = await createRecoveryLocation(vault, path, dependencies);
    const context = {
      operation: "replace",
      path,
      temporaryPath,
      recoveryPath: recovery.path
    };
    await dependencies.beforeCommit?.(context);
    await lock.assertOwned();
    await assertSameDirectory(vault, path, expectedDirectory);
    await assertRecoveryLocation(recovery);
    try {
      await rename2(path, recovery.path);
    } catch (error) {
      if (isErrno2(error, "ENOENT")) {
        throw new NoteRevisionConflictError(relativePath, expected.revision, null);
      }
      throw error;
    }
    sourceQuarantined = true;
    await Promise.all([
      fsyncDirectory(directory),
      fsyncDirectory(recovery.directory)
    ]);
    const quarantined = await readSnapshotAtPath(vault, recovery.path, recovery.relativePath);
    if (!sameQuarantinedSnapshot(quarantined, expected)) {
      throw new NoteRevisionConflictError(relativePath, expected.revision, quarantined.revision);
    }
    await dependencies.afterSourceQuarantined?.(context);
    await lock.assertOwned();
    await assertSameDirectory(vault, path, expectedDirectory);
    await assertRecoveryLocation(recovery);
    const stillQuarantined = await readSnapshotAtPath(vault, recovery.path, recovery.relativePath);
    if (!sameQuarantinedSnapshot(stillQuarantined, expected)) {
      throw new NoteRevisionConflictError(relativePath, expected.revision, stillQuarantined.revision);
    }
    if (!await installTemporaryWithoutClobber(temporaryPath, path)) {
      throw new NoteRevisionConflictError(relativePath, expected.revision, await currentRevisionOrNull(vault, id));
    }
    destinationInstalled = true;
    await fsyncDirectory(directory);
    await unlink2(recovery.path);
    sourceQuarantined = false;
    await fsyncDirectory(recovery.directory);
    await removeRecoveryDirectory(recovery, directory);
    recovery = null;
    await fsyncDirectory(directory);
    return revisionFor(bytes);
  } catch (error) {
    if (recovery !== null && sourceQuarantined && !destinationInstalled) {
      let restored = false;
      try {
        restored = await restoreQuarantinedSource(vault, recovery, path, expectedDirectory);
      } catch (restoreError) {
        throw withRecoveryPath(new AggregateError([error, restoreError], "authoring failed and the prior source could not be restored"), relativePath, recovery.relativePath);
      }
      if (restored) {
        sourceQuarantined = false;
        recovery = null;
      }
    }
    if (recovery !== null && sourceQuarantined) {
      throw withRecoveryPath(error, relativePath, recovery.relativePath);
    }
    if (recovery !== null) {
      try {
        await removeRecoveryDirectory(recovery, directory);
        recovery = null;
      } catch (cleanupError) {
        if (!isErrno2(cleanupError, "ENOENT")) {
          throw new AggregateError([error, cleanupError], "authoring failed and its empty recovery directory could not be removed");
        }
      }
    }
    throw error;
  } finally {
    if (!closed)
      await handle.close().catch(() => {
        return;
      });
    await cleanupTemporary(temporaryPath, identity);
  }
}
function checkedExpectedRevision(options) {
  return options.expectedRevision === undefined ? undefined : requireRevision(options.expectedRevision);
}
function assertExpected(snapshot, expected) {
  if (expected !== undefined && snapshot.revision !== expected) {
    throw new NoteRevisionConflictError(snapshot.relativePath, expected, snapshot.revision);
  }
}
function noteResult(snapshot, relations, changed) {
  return {
    changed,
    path: snapshot.relativePath,
    revision: snapshot.revision,
    relations
  };
}
function validateTitle(title) {
  if (title === "" || title !== title.trim() || title.includes(`
`) || title.includes("\r") || title.length > 512) {
    throw new TypeError("a note title must be a non-empty single line");
  }
  return title;
}
function validateType(type) {
  const canonical = normalizeRelationPredicate(type);
  if (canonical !== type)
    throw new TypeError("a note type must be canonical kebab-case");
  return type;
}
function validateTags(tags) {
  const result = [];
  const seen = new Set;
  for (const candidate of tags ?? []) {
    const tag = candidate.trim().replace(/^#+/u, "").normalize("NFC");
    if (tag === "" || tag.includes(`
`) || tag.includes("\r") || tag.length > 128) {
      throw new TypeError(`not a valid note tag: ${JSON.stringify(candidate)}`);
    }
    const folded = tag.toLocaleLowerCase("en-US");
    if (seen.has(folded))
      continue;
    seen.add(folded);
    result.push(tag);
  }
  return result;
}
function normalizedRequestedBody(body) {
  return body.endsWith(`
`) ? body : `${body}
`;
}
function renderCreatedNote(input) {
  const title = validateTitle(input.title);
  const type = validateType(input.type);
  const tags = validateTags(input.tags);
  const metadata = { type, title };
  if (tags.length > 0)
    metadata["tags"] = tags;
  const document = new Document(metadata, { schema: "core" });
  const body = normalizedRequestedBody(input.body ?? `# ${title}
`);
  return `---
${document.toString({ lineWidth: 0 })}---

${body}`;
}
function topLevelScalar(parts, key) {
  if (!isMap(parts.document.contents))
    return null;
  return scalarString(parts.document.contents.get(key, true));
}
function topLevelStrings(parts, key) {
  if (!isMap(parts.document.contents))
    return [];
  const value = parts.document.contents.get(key, true);
  if (value === undefined)
    return [];
  if (isScalar(value) && typeof value.value === "string")
    return [value.value];
  if (!isSeq(value))
    return [];
  return value.items.flatMap((item) => {
    const candidate = scalarString(item);
    return candidate === null ? [] : [candidate];
  });
}
function assertCompatibleCreate(snapshot, input) {
  const parts = frontmatter(snapshot.content, snapshot.relativePath);
  const requestedType = validateType(input.type);
  const requestedTitle = validateTitle(input.title);
  if (topLevelScalar(parts, "type") !== requestedType) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "type differs");
  }
  if (topLevelScalar(parts, "title") !== requestedTitle) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "title differs");
  }
  const presentTags = new Set(topLevelStrings(parts, "tags").map((tag) => tag.toLocaleLowerCase("en-US")));
  const missingTag = validateTags(input.tags).find((tag) => !presentTags.has(tag.toLocaleLowerCase("en-US")));
  if (missingTag !== undefined) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, `tag is missing: ${missingTag}`);
  }
  if (input.body !== undefined && parts.bodySuffix !== `${parts.newline}${parts.newline}${normalizedRequestedBody(input.body)}`) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "body differs");
  }
  return relationsFromParts(parts, snapshot.relativePath);
}
async function noteRevision(root, id) {
  const vault = await resolveVault(root);
  const canonicalId = canonicalNoteId(id);
  await assertNoInterruptedRecovery(vault, canonicalId);
  return (await readSnapshot(vault, canonicalId)).revision;
}
async function listNoteRelations(root, sourceId) {
  const vault = await resolveVault(root);
  const canonicalId = canonicalNoteId(sourceId);
  await assertNoInterruptedRecovery(vault, canonicalId);
  const source = await readSnapshot(vault, canonicalId);
  return relationsFromParts(frontmatter(source.content, source.relativePath), source.relativePath);
}
async function createNote(root, input, options = {}) {
  const vault = await resolveVault(root);
  const id = canonicalNoteId(input.id);
  const expected = checkedExpectedRevision(options);
  const dependencies = dependenciesFor(options.dependencies);
  const lock = await acquireNoteLock(vault.root, id, options.lock);
  try {
    await recoverInterruptedAuthoring(vault, id, lock);
    const existing = await readOptionalSnapshot(vault, id);
    if (existing !== null) {
      assertExpected(existing, expected);
      const relations = assertCompatibleCreate(existing, input);
      return noteResult(existing, relations, false);
    }
    if (expected !== undefined) {
      throw new NoteRevisionConflictError(`${id}.md`, expected, null);
    }
    const content = renderCreatedNote(input);
    const revision = await atomicInstall(vault, id, content, null, lock, dependencies);
    return {
      changed: true,
      path: `${id}.md`,
      revision,
      relations: []
    };
  } finally {
    await lock.release();
  }
}
async function createConceptNote(root, input, options = {}) {
  return createNote(root, { ...input, type: "concept" }, options);
}
async function editNoteRelation(operation, root, sourceIdInput, predicateInput, targetIdInput, options) {
  const vault = await resolveVault(root);
  const sourceId = canonicalNoteId(sourceIdInput);
  const targetId = canonicalNoteId(targetIdInput);
  const predicate = normalizeRelationPredicate(predicateInput);
  const expected = checkedExpectedRevision(options);
  const dependencies = dependenciesFor(options.dependencies);
  const lock = await acquireNoteLock(vault.root, sourceId, options.lock);
  try {
    await recoverInterruptedAuthoring(vault, sourceId, lock);
    const source = await readSnapshot(vault, sourceId);
    assertExpected(source, expected);
    if (operation === "add" && targetId !== sourceId) {
      await readSnapshot(vault, targetId);
    }
    const parts = frontmatter(source.content, source.relativePath);
    if (operation === "add")
      relationsFromParts(parts, source.relativePath);
    const changed = operation === "add" ? addRelationToParts(parts, source.relativePath, predicate, targetId) : removeRelationFromParts(parts, source.relativePath, predicate, targetId, sourceId);
    if (!changed) {
      return noteResult(source, relationsFromParts(parts, source.relativePath), false);
    }
    const content = renderFrontmatter(parts);
    const relations = relationsFromParts(frontmatter(content, source.relativePath), source.relativePath);
    const revision = await atomicInstall(vault, sourceId, content, source, lock, dependencies);
    return {
      changed: true,
      path: source.relativePath,
      revision,
      relations
    };
  } finally {
    await lock.release();
  }
}
async function addNoteRelation(root, sourceId, predicate, targetId, options = {}) {
  return editNoteRelation("add", root, sourceId, predicate, targetId, options);
}
async function removeNoteRelation(root, sourceId, predicate, targetId, options = {}) {
  return editNoteRelation("remove", root, sourceId, predicate, targetId, options);
}

export { InvalidCanonicalNoteIdError, NoteRevisionConflictError, NoteAlreadyExistsError, NoteRecoveryRequiredError, canonicalNoteId, normalizeRelationPredicate, noteRevision, listNoteRelations, createNote, createConceptNote, addNoteRelation, removeNoteRelation };
