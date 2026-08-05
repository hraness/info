import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import { isPrivateHostname } from "./network.js";
import { sanitizeArtifactUrl } from "./persist.js";
import { parseArchiveTodayMementoUrl } from "./url-intelligence.js";

export const URL_METADATA_FILENAME = "url-metadata.json";
export const URL_METADATA_SCHEMA_VERSION = 1 as const;
export const METADATA_SEARCH_ENGINE_ID = "metadata-search-engine-rs" as const;
export const METADATA_SEARCH_ENGINE_VERSION = "0.1.3" as const;
export const METADATA_SEARCH_ENGINE_REVISION = "f40a00ea67a857ee996e1caba1ebab3ee7a14a47" as const;

const MAX_ARTICLE_DIRECTORIES = 4_096;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 20;
const MAX_ARCHIVES = 32;
const MAX_ATTEMPTS = 16;
const MAX_WARNINGS = 32;
const MAX_URL_BYTES = 16 * 1024;
const MAX_TITLE_BYTES = 2 * 1024;
const MAX_SNIPPET_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024;
const MAX_ENGINE_COUNT = 8;
const MAX_LOCK_BYTES = 4 * 1024;
const MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS = 30_000;
const LOCK_EXCLUSIVE = 0x02;
const LOCK_NONBLOCKING = 0x04;
const F_SET_FILE_DESCRIPTOR = 2;
const FILE_DESCRIPTOR_CLOSE_ON_EXEC = 1;
const INTERRUPTED_SYSTEM_CALL = 4;
const engineNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const lockTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type NativeFlockFunction = (descriptor: number, operation: number) => number;
type NativeFcntlFunction = (descriptor: number, command: number, argument: number) => number;
type NativePointer = number;
type BunFfiRuntime = {
  readonly dlopen: (
    path: string,
    symbols: Readonly<Record<string, {
      readonly args: readonly string[];
      readonly returns: string;
    }>>,
  ) => {
    readonly symbols: Readonly<Record<string, (...arguments_: readonly number[]) => number>>;
  };
  readonly read: {
    readonly i32: (pointer: NativePointer) => number;
  };
};

let nativeFlock: NativeFlockFunction | undefined;
let nativeFcntl: NativeFcntlFunction | undefined;
let nativeErrnoLocation: (() => NativePointer) | undefined;
let nativeFfiRead: BunFfiRuntime["read"] | undefined;
const nativeLockLibraries: unknown[] = [];

export type SavedUrlRecord = {
  readonly articleId: string;
  readonly directory: string;
  readonly markdownPath: string;
  readonly sidecarPath: string;
  readonly subjectUrl: string;
};

export type UrlMetadataCandidate = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string | null;
  readonly engines: readonly string[];
  readonly score: number;
};

export type UrlMetadataArchive = {
  readonly url: string;
  readonly capturedAt: string;
  readonly discovery: "newest" | "timemap" | "metadata-search";
};

export type UrlMetadataAttempt = {
  readonly provider: "metadata-search-engine-rs" | "archive-today";
  readonly outcome: "succeeded" | "partial" | "not-found" | "failed" | "skipped";
  readonly message: string;
};

export type UrlMetadataSelectedField = {
  readonly value: string;
  readonly sourceUrl: string;
  readonly provider: typeof METADATA_SEARCH_ENGINE_ID;
};

export type UrlMetadataDocument = {
  readonly schemaVersion: typeof URL_METADATA_SCHEMA_VERSION;
  readonly kind: "url-metadata";
  readonly subjectUrl: string;
  readonly generatedAt: string;
  readonly status: "matched" | "not-found" | "partial" | "unavailable";
  readonly provider: {
    readonly id: typeof METADATA_SEARCH_ENGINE_ID;
    readonly version: typeof METADATA_SEARCH_ENGINE_VERSION;
    readonly revision: typeof METADATA_SEARCH_ENGINE_REVISION;
    readonly enginesQueried: readonly string[];
    readonly enginesFailed: readonly string[];
  };
  readonly attempts: readonly UrlMetadataAttempt[];
  readonly candidates: readonly UrlMetadataCandidate[];
  readonly selected: {
    readonly title: UrlMetadataSelectedField | null;
    readonly description: UrlMetadataSelectedField | null;
  };
  readonly archives: readonly UrlMetadataArchive[];
  readonly warnings: readonly string[];
};

export type CreateUrlMetadataDocumentInput = {
  readonly subjectUrl: string;
  readonly generatedAt: string;
  readonly enginesQueried: readonly string[];
  readonly enginesFailed: readonly string[];
  readonly attempts: readonly UrlMetadataAttempt[];
  readonly candidates: readonly UrlMetadataCandidate[];
  readonly archives?: readonly UrlMetadataArchive[];
  readonly warnings?: readonly string[];
};

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
};

type DirectoryIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
};

type SavedUrlRecordIdentity = {
  readonly directory: DirectoryIdentity;
  readonly markdown: FileIdentity;
};

type UrlMetadataWriteLockOwner = {
  readonly schemaVersion: 1;
  readonly kind: "url-metadata-write-lock";
  readonly host: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly token: string;
  readonly acquiredAt: string;
};

type HeldUrlMetadataWriteLock = {
  readonly descriptor: number;
  readonly identity: FileIdentity;
  readonly owner: UrlMetadataWriteLockOwner;
  readonly path: string;
};

const savedUrlRecordIdentities = new WeakMap<SavedUrlRecord, SavedUrlRecordIdentity>();

function requiredNativeSymbol(
  symbols: Readonly<Record<string, (...arguments_: readonly number[]) => number>>,
  name: string,
): (...arguments_: readonly number[]) => number {
  const symbol = symbols[name];
  if (symbol === undefined) throw new Error(`URL metadata locking could not bind ${name}.`);
  return symbol;
}

function linuxLibcCandidates(processMaps: string, architecture = process.arch): readonly string[] {
  const candidates: string[] = [];
  const append = (candidate: string): void => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  for (const line of processMaps.split("\n")) {
    const pathStart = line.indexOf("/");
    if (pathStart < 0 || line.endsWith(" (deleted)")) continue;
    const path = line.slice(pathStart).replace(
      /\\([0-7]{3})/gu,
      (_, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)),
    );
    if (
      /\/(?:libc(?:-[^/]+)?\.so(?:\.[0-9]+)*|libc\.musl-[^/]+\.so(?:\.[0-9]+)*|ld-musl-[^/]+\.so(?:\.[0-9]+)*)$/u
        .test(path)
    ) append(path);
  }
  append("libc.so.6");
  if (architecture === "x64") append("/lib/ld-musl-x86_64.so.1");
  if (architecture === "arm64") append("/lib/ld-musl-aarch64.so.1");
  return candidates;
}

function initializeNativeLocking(): void {
  if (nativeFlock !== undefined && nativeFcntl !== undefined && nativeErrnoLocation !== undefined) return;
  const ffi = (globalThis as typeof globalThis & {
    readonly Bun?: { readonly FFI?: BunFfiRuntime };
  }).Bun?.FFI;
  if (ffi === undefined) {
    throw new Error("URL metadata writes require Bun's native file-locking runtime.");
  }
  nativeFfiRead = ffi.read;
  if (process.platform === "darwin") {
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: "ptr" },
      fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
      flock: { args: ["i32", "i32"], returns: "i32" },
    });
    nativeLockLibraries.push(library);
    const errnoLocation = requiredNativeSymbol(library.symbols, "__error");
    const fcntl = requiredNativeSymbol(library.symbols, "fcntl");
    const flock = requiredNativeSymbol(library.symbols, "flock");
    nativeErrnoLocation = () => errnoLocation();
    nativeFcntl = (descriptor, command, argument) => fcntl(descriptor, command, argument);
    nativeFlock = (descriptor, operation) => flock(descriptor, operation);
    return;
  }
  if (process.platform === "linux") {
    let processMaps = "";
    try {
      processMaps = readFileSync("/proc/self/maps", "utf8");
    } catch {
      // The fallback library names below still cover glibc and common musl layouts.
    }
    const failures: string[] = [];
    for (const candidate of linuxLibcCandidates(processMaps)) {
      try {
        const library = ffi.dlopen(candidate, {
          __errno_location: { args: [], returns: "ptr" },
          fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
          flock: { args: ["i32", "i32"], returns: "i32" },
        });
        nativeLockLibraries.push(library);
        const errnoLocation = requiredNativeSymbol(library.symbols, "__errno_location");
        const fcntl = requiredNativeSymbol(library.symbols, "fcntl");
        const flock = requiredNativeSymbol(library.symbols, "flock");
        nativeErrnoLocation = () => errnoLocation();
        nativeFcntl = (descriptor, command, argument) => fcntl(descriptor, command, argument);
        nativeFlock = (descriptor, operation) => flock(descriptor, operation);
        return;
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`URL metadata locking could not load the host libc (${failures.join("; ")}).`);
  }
  throw new Error(`URL metadata locking is unsupported on ${process.platform}.`);
}

function currentNativeErrno(): number {
  initializeNativeLocking();
  const pointer = nativeErrnoLocation?.();
  if (pointer === undefined || pointer === null) throw new Error("URL metadata locking could not read errno.");
  if (nativeFfiRead === undefined) throw new Error("URL metadata locking lost its native read binding.");
  return nativeFfiRead.i32(pointer);
}

function tryExclusiveFileLock(descriptor: number): boolean {
  initializeNativeLocking();
  for (;;) {
    if (nativeFlock?.(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) === 0) return true;
    const errno = currentNativeErrno();
    if (errno === INTERRUPTED_SYSTEM_CALL) continue;
    if ((process.platform === "darwin" && errno === 35) || (process.platform === "linux" && errno === 11)) {
      return false;
    }
    throw new Error(`URL metadata flock failed with errno ${errno}.`);
  }
}

function setDescriptorCloseOnExec(descriptor: number): void {
  initializeNativeLocking();
  if (nativeFcntl?.(descriptor, F_SET_FILE_DESCRIPTOR, FILE_DESCRIPTOR_CLOSE_ON_EXEC) !== 0) {
    throw new Error(`URL metadata fcntl failed with errno ${currentNativeErrno()}.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorFromUnknown(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function throwCleanupErrorWithoutOperationError(operationError: unknown, cleanupError: unknown): void {
  if (operationError === undefined && cleanupError !== undefined) {
    throw errorFromUnknown(cleanupError, "URL metadata write cleanup failed.");
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${label} contains unknown key ${JSON.stringify(key)}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${JSON.stringify(key)}.`);
  }
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value === "" || utf8Length(value) > maximumBytes) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximumBytes} UTF-8 bytes.`);
  }
  if (/\p{Cc}|\p{Cs}/u.test(value)) throw new TypeError(`${label} contains unsafe control characters.`);
  return value;
}

function boundedTextList(
  value: unknown,
  label: string,
  maximumCount: number,
  maximumBytes: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumCount) {
    throw new TypeError(`${label} must be an array with at most ${maximumCount} entries.`);
  }
  const parsed = value.map((item, index) => boundedText(item, `${label}[${index}]`, maximumBytes));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${label} contains duplicate entries.`);
  return Object.freeze(parsed);
}

function engineList(value: unknown, label: string): readonly string[] {
  const engines = boundedTextList(value, label, MAX_ENGINE_COUNT, 64);
  for (const engine of engines) {
    if (!engineNamePattern.test(engine)) {
      throw new TypeError(`${label} contains an invalid engine identifier.`);
    }
  }
  return engines;
}

function normalizedPublicUrl(value: unknown, label: string): string {
  const text = boundedText(value, label, MAX_URL_BYTES);
  let url: URL;
  try {
    url = new URL(text);
  } catch (error) {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL.`, { cause: error });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new TypeError(`${label} must be a credential-free HTTP(S) URL.`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new TypeError(`${label} must not target a private network.`);
  }
  url.hash = "";
  const normalized = url.href;
  if (sanitizeArtifactUrl(normalized) !== normalized) {
    throw new TypeError(`${label} must not contain credential-shaped path or query data.`);
  }
  return normalized;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function parseUrlMetadataWriteLockOwner(value: unknown): UrlMetadataWriteLockOwner {
  const input = record(value, "URL metadata write lock owner");
  exactKeys(input, [
    "schemaVersion",
    "kind",
    "host",
    "pid",
    "processIdentity",
    "token",
    "acquiredAt",
  ], "URL metadata write lock owner");
  if (input.schemaVersion !== 1 || input.kind !== "url-metadata-write-lock") {
    throw new TypeError("URL metadata write lock owner has an unsupported identity.");
  }
  if (typeof input.pid !== "number" || !Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new TypeError("URL metadata write lock owner.pid must be a positive safe integer.");
  }
  const token = boundedText(input.token, "URL metadata write lock owner.token", 64);
  if (!lockTokenPattern.test(token)) throw new TypeError("URL metadata write lock owner.token is invalid.");
  return Object.freeze({
    schemaVersion: 1,
    kind: "url-metadata-write-lock",
    host: boundedText(input.host, "URL metadata write lock owner.host", 255),
    pid: input.pid,
    processIdentity: boundedText(input.processIdentity, "URL metadata write lock owner.processIdentity", 512),
    token,
    acquiredAt: isoTimestamp(input.acquiredAt, "URL metadata write lock owner.acquiredAt"),
  });
}

function operatingSystemProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
      const state = fields[0];
      const startTicks = fields[19];
      if (state === "Z" || startTicks === undefined || !/^\d+$/u.test(startTicks)) return null;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[0-9a-f-]{36}$/u.test(bootId)) return null;
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      return started === "" ? null : `darwin:${started.replace(/\s+/gu, " ")}`;
    } catch {
      return null;
    }
  }
  return null;
}

function currentWriteLockOwner(): UrlMetadataWriteLockOwner {
  const processIdentity = operatingSystemProcessIdentity(process.pid);
  if (processIdentity === null) {
    throw new Error("URL metadata locking could not verify the current process identity.");
  }
  return parseUrlMetadataWriteLockOwner({
    schemaVersion: 1,
    kind: "url-metadata-write-lock",
    host: hostname(),
    pid: process.pid,
    processIdentity,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  });
}

function parseCandidate(value: unknown, label: string): UrlMetadataCandidate {
  const input = record(value, label);
  exactKeys(input, ["title", "url", "snippet", "engines", "score"], label);
  const score = input.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    throw new TypeError(`${label}.score must be a finite non-negative number.`);
  }
  const snippet = input.snippet === null
    ? null
    : boundedText(input.snippet, `${label}.snippet`, MAX_SNIPPET_BYTES);
  return Object.freeze({
    title: boundedText(input.title, `${label}.title`, MAX_TITLE_BYTES),
    url: normalizedPublicUrl(input.url, `${label}.url`),
    snippet,
    engines: boundedTextList(input.engines, `${label}.engines`, MAX_ENGINE_COUNT, 64),
    score,
  });
}

function parseAttempt(value: unknown, label: string): UrlMetadataAttempt {
  const input = record(value, label);
  exactKeys(input, ["provider", "outcome", "message"], label);
  if (input.provider !== "metadata-search-engine-rs" && input.provider !== "archive-today") {
    throw new TypeError(`${label}.provider is unsupported.`);
  }
  if (
    input.outcome !== "succeeded"
    && input.outcome !== "partial"
    && input.outcome !== "not-found"
    && input.outcome !== "failed"
    && input.outcome !== "skipped"
  ) throw new TypeError(`${label}.outcome is unsupported.`);
  return Object.freeze({
    provider: input.provider,
    outcome: input.outcome,
    message: boundedText(input.message, `${label}.message`, MAX_MESSAGE_BYTES),
  });
}

function parseArchive(
  value: unknown,
  label: string,
  subjectUrl: string,
  generatedAt: string,
): UrlMetadataArchive {
  const input = record(value, label);
  exactKeys(input, ["url", "capturedAt", "discovery"], label);
  if (
    input.discovery !== "newest"
    && input.discovery !== "timemap"
    && input.discovery !== "metadata-search"
  ) throw new TypeError(`${label}.discovery is unsupported.`);
  const url = normalizedPublicUrl(input.url, `${label}.url`);
  const capturedAt = isoTimestamp(input.capturedAt, `${label}.capturedAt`);
  let memento;
  try {
    memento = parseArchiveTodayMementoUrl(url, {
      originalUrl: subjectUrl,
      now: new Date(generatedAt),
    });
  } catch (error) {
    throw new TypeError(`${label} must be an exact timestamped Archive.today-family snapshot.`, { cause: error });
  }
  if (memento.capturedAt !== capturedAt) {
    throw new TypeError(`${label}.capturedAt must match its snapshot timestamp.`);
  }
  return Object.freeze({
    url: memento.url,
    capturedAt,
    discovery: input.discovery,
  });
}

function parseSelectedField(
  value: unknown,
  label: string,
  maximumBytes: number,
): UrlMetadataSelectedField | null {
  if (value === null) return null;
  const input = record(value, label);
  exactKeys(input, ["value", "sourceUrl", "provider"], label);
  if (input.provider !== METADATA_SEARCH_ENGINE_ID) throw new TypeError(`${label}.provider is unsupported.`);
  return Object.freeze({
    value: boundedText(input.value, `${label}.value`, maximumBytes),
    sourceUrl: normalizedPublicUrl(input.sourceUrl, `${label}.sourceUrl`),
    provider: METADATA_SEARCH_ENGINE_ID,
  });
}

function metadataStatus(options: {
  readonly hasCandidate: boolean;
  readonly hasArchive: boolean;
  readonly queriedEngines: number;
  readonly failedEngines: number;
  readonly partial: boolean;
}): UrlMetadataDocument["status"] {
  if (options.hasCandidate) return options.partial ? "partial" : "matched";
  if (options.hasArchive) return "partial";
  if (options.queriedEngines === 0 || options.failedEngines === options.queriedEngines) return "unavailable";
  return options.partial ? "partial" : "not-found";
}

export function parseUrlMetadataDocument(value: unknown): UrlMetadataDocument {
  const input = record(value, "URL metadata document");
  exactKeys(input, [
    "schemaVersion",
    "kind",
    "subjectUrl",
    "generatedAt",
    "status",
    "provider",
    "attempts",
    "candidates",
    "selected",
    "archives",
    "warnings",
  ], "URL metadata document");
  if (input.schemaVersion !== URL_METADATA_SCHEMA_VERSION || input.kind !== "url-metadata") {
    throw new TypeError("URL metadata document has an unsupported identity.");
  }
  if (
    input.status !== "matched"
    && input.status !== "not-found"
    && input.status !== "partial"
    && input.status !== "unavailable"
  ) throw new TypeError("URL metadata document has an unsupported status.");

  const provider = record(input.provider, "URL metadata document.provider");
  exactKeys(provider, ["id", "version", "revision", "enginesQueried", "enginesFailed"], "URL metadata document.provider");
  if (
    provider.id !== METADATA_SEARCH_ENGINE_ID
    || provider.version !== METADATA_SEARCH_ENGINE_VERSION
    || provider.revision !== METADATA_SEARCH_ENGINE_REVISION
  ) throw new TypeError("URL metadata document has an unsupported provider identity.");

  if (!Array.isArray(input.attempts) || input.attempts.length > MAX_ATTEMPTS) {
    throw new TypeError(`URL metadata document.attempts must have at most ${MAX_ATTEMPTS} entries.`);
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    throw new TypeError(`URL metadata document.candidates must have at most ${MAX_CANDIDATES} entries.`);
  }
  if (!Array.isArray(input.archives) || input.archives.length > MAX_ARCHIVES) {
    throw new TypeError(`URL metadata document.archives must have at most ${MAX_ARCHIVES} entries.`);
  }
  const selected = record(input.selected, "URL metadata document.selected");
  exactKeys(selected, ["title", "description"], "URL metadata document.selected");

  const subjectUrl = normalizedPublicUrl(input.subjectUrl, "URL metadata document.subjectUrl");
  const generatedAt = isoTimestamp(input.generatedAt, "URL metadata document.generatedAt");
  const enginesQueried = engineList(provider.enginesQueried, "URL metadata document.provider.enginesQueried");
  const enginesFailed = engineList(provider.enginesFailed, "URL metadata document.provider.enginesFailed");
  const queried = new Set(enginesQueried);
  for (const engine of enginesFailed) {
    if (!queried.has(engine)) {
      throw new TypeError("URL metadata document.provider.enginesFailed contains an unqueried engine.");
    }
  }
  const failed = new Set(enginesFailed);
  const attempts = Object.freeze(input.attempts.map((item, index) =>
    parseAttempt(item, `URL metadata document.attempts[${index}]`)));
  const candidates = Object.freeze(input.candidates.map((item, index) =>
    parseCandidate(item, `URL metadata document.candidates[${index}]`)));
  const candidateUrls = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.url !== subjectUrl) {
      throw new TypeError("URL metadata document candidate must exactly match subjectUrl.");
    }
    if (candidateUrls.has(candidate.url)) {
      throw new TypeError("URL metadata document candidates contain a duplicate source URL.");
    }
    candidateUrls.add(candidate.url);
    for (const engine of candidate.engines) {
      if (!queried.has(engine) || failed.has(engine)) {
        throw new TypeError("URL metadata document candidate references an unavailable or unqueried engine.");
      }
    }
  }
  const title = parseSelectedField(selected.title, "URL metadata document.selected.title", MAX_TITLE_BYTES);
  const description = parseSelectedField(selected.description, "URL metadata document.selected.description", MAX_SNIPPET_BYTES);
  const best = candidates[0] ?? null;
  if (
    (best === null && (title !== null || description !== null))
    || (best !== null && (title?.value !== best.title || title.sourceUrl !== subjectUrl))
    || (best?.snippet === null && description !== null)
    || (best?.snippet !== null && best !== null
      && (description?.value !== best.snippet || description.sourceUrl !== subjectUrl))
  ) {
    throw new TypeError("URL metadata document selected fields do not match the best exact candidate.");
  }
  const archives = Object.freeze(input.archives.map((item, index) =>
    parseArchive(item, `URL metadata document.archives[${index}]`, subjectUrl, generatedAt)));
  const archiveCaptures = new Set<string>();
  for (const archive of archives) {
    if (archiveCaptures.has(archive.capturedAt)) {
      throw new TypeError("URL metadata document archives contain a duplicate capture timestamp.");
    }
    archiveCaptures.add(archive.capturedAt);
  }
  const partial = enginesFailed.length > 0
    || attempts.some(({ outcome }) => outcome === "failed" || outcome === "partial");
  const expectedStatus = metadataStatus({
    hasCandidate: best !== null,
    hasArchive: archives.length > 0,
    queriedEngines: enginesQueried.length,
    failedEngines: enginesFailed.length,
    partial,
  });
  if (input.status !== expectedStatus) {
    throw new TypeError(`URL metadata document status must be ${expectedStatus}.`);
  }

  return Object.freeze({
    schemaVersion: URL_METADATA_SCHEMA_VERSION,
    kind: "url-metadata",
    subjectUrl,
    generatedAt,
    status: expectedStatus,
    provider: Object.freeze({
      id: METADATA_SEARCH_ENGINE_ID,
      version: METADATA_SEARCH_ENGINE_VERSION,
      revision: METADATA_SEARCH_ENGINE_REVISION,
      enginesQueried,
      enginesFailed,
    }),
    attempts,
    candidates,
    selected: Object.freeze({
      title,
      description,
    }),
    archives,
    warnings: boundedTextList(input.warnings, "URL metadata document.warnings", MAX_WARNINGS, MAX_MESSAGE_BYTES),
  });
}

function stableCandidateOrder(left: UrlMetadataCandidate, right: UrlMetadataCandidate): number {
  return right.score - left.score
    || right.engines.length - left.engines.length
    || compareText(left.title, right.title)
    || compareText(left.url, right.url);
}

export function createUrlMetadataDocument(input: CreateUrlMetadataDocumentInput): UrlMetadataDocument {
  const candidates = [...input.candidates].sort(stableCandidateOrder).slice(0, MAX_CANDIDATES);
  const best = candidates[0] ?? null;
  const archives = [...(input.archives ?? [])]
    .sort((left, right) => compareText(right.capturedAt, left.capturedAt) || compareText(left.url, right.url))
    .slice(0, MAX_ARCHIVES);
  const partial = input.enginesFailed.length > 0
    || input.attempts.some(({ outcome }) => outcome === "failed" || outcome === "partial");
  const status = metadataStatus({
    hasCandidate: best !== null,
    hasArchive: archives.length > 0,
    queriedEngines: input.enginesQueried.length,
    failedEngines: input.enginesFailed.length,
    partial,
  });
  return parseUrlMetadataDocument({
    schemaVersion: URL_METADATA_SCHEMA_VERSION,
    kind: "url-metadata",
    subjectUrl: input.subjectUrl,
    generatedAt: input.generatedAt,
    status,
    provider: {
      id: METADATA_SEARCH_ENGINE_ID,
      version: METADATA_SEARCH_ENGINE_VERSION,
      revision: METADATA_SEARCH_ENGINE_REVISION,
      enginesQueried: [...input.enginesQueried],
      enginesFailed: [...input.enginesFailed],
    },
    attempts: [...input.attempts],
    candidates,
    selected: {
      title: best === null ? null : {
        value: best.title,
        sourceUrl: best.url,
        provider: METADATA_SEARCH_ENGINE_ID,
      },
      description: best?.snippet === null || best?.snippet === undefined ? null : {
        value: best.snippet,
        sourceUrl: best.url,
        provider: METADATA_SEARCH_ENGINE_ID,
      },
    },
    archives,
    warnings: [...(input.warnings ?? [])],
  });
}

export function renderUrlMetadataDocument(document: UrlMetadataDocument): string {
  return `${JSON.stringify(parseUrlMetadataDocument(document), null, 2)}\n`;
}

function frontmatterObject(markdown: string, path: string): Readonly<Record<string, unknown>> {
  const match = /^---(?:\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/u.exec(markdown);
  if (match === null) return {};
  const parsed = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (parsed.errors.length > 0) throw new Error(`Invalid YAML frontmatter in ${path}: ${parsed.errors[0]?.message ?? "unknown error"}`);
  const value: unknown = parsed.toJS({ maxAliasCount: 32 });
  if (value === null) return {};
  return record(value, `Frontmatter in ${path}`);
}

function absoluteSource(value: unknown, label: string, allowLocalPdf: boolean): string | null {
  if (value === undefined) return null;
  if (allowLocalPdf && value === "source.pdf") return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL${allowLocalPdf ? " or source.pdf" : ""}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL${allowLocalPdf ? " or source.pdf" : ""}.`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  return normalizedPublicUrl(value, label);
}

function confined(root: string, path: string, label: string): void {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.includes(`\0`)) {
    throw new Error(`${label} escapes the articles root.`);
  }
}

function identity(metadata: BigIntStats): FileIdentity {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    links: metadata.nlink,
    modifiedNanoseconds: metadata.mtimeNs,
    changedNanoseconds: metadata.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function sameInode(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function validateOwnedLockFile(metadata: BigIntStats, path: string): FileIdentity {
  const effectiveUserId = process.geteuid?.();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || (effectiveUserId !== undefined && metadata.uid !== BigInt(effectiveUserId))
  ) {
    throw new Error(`URL metadata write lock must be an owned regular single-link file: ${path}`);
  }
  return identity(metadata);
}

function readDescriptorText(descriptor: number, maximumBytes: number, label: string): string {
  const metadata = fstatSync(descriptor, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} descriptor must be a regular single-link file.`);
  }
  if (metadata.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  const bytes = Buffer.alloc(Number(metadata.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new Error(`${label} ended before its validated size.`);
    offset += count;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8.`, { cause: error });
  }
}

function lockOwnerFromDescriptor(descriptor: number): UrlMetadataWriteLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(readDescriptorText(descriptor, MAX_LOCK_BYTES, "URL metadata write lock"));
  } catch (error) {
    throw new Error("URL metadata write lock owner metadata is malformed.", { cause: error });
  }
  return parseUrlMetadataWriteLockOwner(value);
}

function writeLockOwner(descriptor: number, owner: UrlMetadataWriteLockOwner): FileIdentity {
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  if (bytes.byteLength > MAX_LOCK_BYTES) throw new Error("URL metadata write lock owner metadata is oversized.");
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written === 0) throw new Error("URL metadata write lock owner metadata could not be fully written.");
    offset += written;
  }
  ftruncateSync(descriptor, bytes.byteLength);
  fchmodSync(descriptor, 0o600);
  fsyncSync(descriptor);
  const parsed = lockOwnerFromDescriptor(descriptor);
  if (
    parsed.host !== owner.host
    || parsed.pid !== owner.pid
    || parsed.processIdentity !== owner.processIdentity
    || parsed.token !== owner.token
    || parsed.acquiredAt !== owner.acquiredAt
  ) throw new Error("URL metadata write lock owner metadata failed verification.");
  return validateOwnedLockFile(fstatSync(descriptor, { bigint: true }), "opened lock descriptor");
}

function assertMalformedLockIsOldEnoughToRecover(
  descriptor: number,
  identity: FileIdentity,
  path: string,
): void {
  try {
    lockOwnerFromDescriptor(descriptor);
    return;
  } catch (error) {
    const ageNanoseconds = BigInt(Date.now()) * 1_000_000n - identity.modifiedNanoseconds;
    const recoveryAgeNanoseconds = BigInt(MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS) * 1_000_000n;
    if (ageNanoseconds < recoveryAgeNanoseconds) {
      throw new Error(
        `Refusing to reclaim a fresh malformed URL metadata write lock: ${path}`,
        { cause: error },
      );
    }
  }
}

function activeLockOwnerDescription(path: string, openedIdentity: FileIdentity): string {
  try {
    const publishedIdentity = validateOwnedLockFile(lstatSync(path, { bigint: true }), path);
    if (!sameInode(openedIdentity, publishedIdentity)) return "an active writer after concurrent lock replacement";
    const owner = parseUrlMetadataWriteLockOwner(JSON.parse(
      readBoundedSingleLinkFile(path, MAX_LOCK_BYTES, "URL metadata write lock").text,
    ));
    if (
      owner.host === hostname()
      && operatingSystemProcessIdentity(owner.pid) === owner.processIdentity
    ) return `active writer pid ${owner.pid} (${owner.token})`;
  } catch {
    // The kernel lock remains authoritative while owner metadata is initializing or malformed.
  }
  return "an active writer with unverified owner metadata";
}

function acquireUrlMetadataWriteLock(path: string): HeldUrlMetadataWriteLock {
  const owner = currentWriteLockOwner();
  let descriptor: number | null = null;
  let existedBeforeOpen = true;
  try {
    try {
      validateOwnedLockFile(lstatSync(path, { bigint: true }), path);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      if (cause.code !== "ENOENT") throw error;
      existedBeforeOpen = false;
    }
    descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    setDescriptorCloseOnExec(descriptor);
    const openedIdentity = validateOwnedLockFile(fstatSync(descriptor, { bigint: true }), path);
    const publishedIdentity = validateOwnedLockFile(lstatSync(path, { bigint: true }), path);
    if (!sameInode(openedIdentity, publishedIdentity)) {
      throw new Error(`URL metadata write lock identity changed while opening: ${path}`);
    }
    if (!tryExclusiveFileLock(descriptor)) {
      throw new Error(`URL metadata sidecar is locked by ${activeLockOwnerDescription(path, openedIdentity)}.`);
    }
    if (existedBeforeOpen) assertMalformedLockIsOldEnoughToRecover(descriptor, openedIdentity, path);
    const identity = writeLockOwner(descriptor, owner);
    const ownedPathIdentity = validateOwnedLockFile(lstatSync(path, { bigint: true }), path);
    if (!sameIdentity(identity, ownedPathIdentity)) {
      throw new Error(`URL metadata write lock changed while publishing its owner: ${path}`);
    }
    const held = Object.freeze({ descriptor, identity, owner, path });
    descriptor = null;
    return held;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function releaseUrlMetadataWriteLock(held: HeldUrlMetadataWriteLock): void {
  let releaseError: Error | undefined;
  try {
    assertHeldUrlMetadataWriteLockCurrent(held);
    unlinkSync(held.path);
  } catch (error) {
    releaseError = errorFromUnknown(error, "URL metadata write lock release failed.");
  }
  try {
    closeSync(held.descriptor);
  } catch (error) {
    releaseError ??= errorFromUnknown(error, "URL metadata write lock descriptor close failed.");
  }
  if (releaseError !== undefined) throw releaseError;
}

function assertHeldUrlMetadataWriteLockCurrent(held: HeldUrlMetadataWriteLock): void {
  const openedIdentity = validateOwnedLockFile(
    fstatSync(held.descriptor, { bigint: true }),
    held.path,
  );
  const publishedIdentity = validateOwnedLockFile(lstatSync(held.path, { bigint: true }), held.path);
  const owner = lockOwnerFromDescriptor(held.descriptor);
  if (
    !sameIdentity(held.identity, openedIdentity)
    || !sameIdentity(held.identity, publishedIdentity)
    || owner.token !== held.owner.token
    || owner.pid !== held.owner.pid
    || owner.processIdentity !== held.owner.processIdentity
  ) throw new Error(`URL metadata write lock was replaced while held: ${held.path}`);
}

function removeOwnedTemporaryFile(path: string, expected: FileIdentity): void {
  let published: FileIdentity;
  try {
    published = validateRegularSingleLink(
      lstatSync(path, { bigint: true }),
      path,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    );
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "ENOENT") return;
    throw error;
  }
  if (!sameIdentity(expected, published)) {
    throw new Error(`Refusing to remove a replaced URL metadata temporary sidecar: ${path}`);
  }
  unlinkSync(path);
}

function directoryIdentity(metadata: BigIntStats): DirectoryIdentity {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
  });
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode;
}

function validateArticleDirectory(path: string): DirectoryIdentity {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Article directory must be a real directory: ${path}`);
  }
  return directoryIdentity(metadata);
}

function validateOpenedArticleDirectory(descriptor: number, path: string): DirectoryIdentity {
  const metadata = fstatSync(descriptor, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Article directory descriptor is no longer a directory: ${path}`);
  }
  return directoryIdentity(metadata);
}

function validateRegularSingleLink(
  metadata: BigIntStats,
  path: string,
  maximumBytes: number,
  label: string,
): FileIdentity {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} must be a regular single-link file: ${path}`);
  }
  if (metadata.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  return identity(metadata);
}

function readBoundedSingleLinkFile(
  path: string,
  maximumBytes: number,
  label: string,
): { readonly text: string; readonly identity: FileIdentity } {
  const pathIdentity = validateRegularSingleLink(lstatSync(path, { bigint: true }), path, maximumBytes, label);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedIdentity = validateRegularSingleLink(fstatSync(descriptor, { bigint: true }), path, maximumBytes, label);
    if (!sameIdentity(pathIdentity, openedIdentity)) throw new Error(`${label} identity changed before read: ${path}`);
    const bytes = Buffer.alloc(Number(openedIdentity.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error(`${label} ended before its validated size: ${path}`);
      offset += count;
    }
    const finishedIdentity = validateRegularSingleLink(fstatSync(descriptor, { bigint: true }), path, maximumBytes, label);
    const finalPathIdentity = validateRegularSingleLink(lstatSync(path, { bigint: true }), path, maximumBytes, label);
    if (!sameIdentity(openedIdentity, finishedIdentity) || !sameIdentity(openedIdentity, finalPathIdentity)) {
      throw new Error(`${label} identity changed during read: ${path}`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} must be valid UTF-8: ${path}`, { cause: error });
    }
    return Object.freeze({ text, identity: openedIdentity });
  } finally {
    closeSync(descriptor);
  }
}

export function discoverSavedUrlRecords(vaultRoot: string): readonly SavedUrlRecord[] {
  const resolvedVault = realpathSync(resolve(vaultRoot));
  const vaultMetadata = lstatSync(resolvedVault);
  if (!vaultMetadata.isDirectory() || vaultMetadata.isSymbolicLink()) throw new Error("The vault root must be a real directory.");
  const articlesRoot = join(resolvedVault, "articles");
  const articlesMetadata = lstatSync(articlesRoot);
  if (!articlesMetadata.isDirectory() || articlesMetadata.isSymbolicLink()) throw new Error("The articles root must be a real directory.");
  if (realpathSync(articlesRoot) !== articlesRoot) throw new Error("The articles root must resolve to itself.");

  const entries = readdirSync(articlesRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length > MAX_ARTICLE_DIRECTORIES) {
    throw new Error(`The articles root exceeds ${MAX_ARTICLE_DIRECTORIES} directories.`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`The articles root contains a symbolic link: ${entry.name}`);
  }

  const records: SavedUrlRecord[] = [];
  for (const entry of directories.sort((left, right) => compareText(left.name, right.name))) {
    const directory = join(articlesRoot, entry.name);
    confined(articlesRoot, directory, "Article directory");
    const capturedDirectoryIdentity = validateArticleDirectory(directory);
    const children = readdirSync(directory, { withFileTypes: true });
    if (children.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`Article directory exceeds ${MAX_DIRECTORY_ENTRIES} entries: ${directory}`);
    }
    if (children.some((child) => child.isSymbolicLink())) {
      throw new Error(`Article directory contains a symbolic link: ${directory}`);
    }
    const urlMarkdown: Array<{
      readonly path: string;
      readonly identity: FileIdentity;
      readonly url: string;
    }> = [];
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".md") || child.name === "AGENTS.md") continue;
      const markdownPath = join(directory, child.name);
      const markdown = readBoundedSingleLinkFile(markdownPath, MAX_MARKDOWN_BYTES, "Article Markdown");
      const metadata = frontmatterObject(markdown.text, markdownPath);
      const source = absoluteSource(metadata.source, `${markdownPath} source`, true);
      const sourceUrl = absoluteSource(metadata.source_url, `${markdownPath} source_url`, false);
      if (source !== null && sourceUrl !== null && source !== sourceUrl) {
        throw new Error(`Article Markdown has conflicting source and source_url values: ${markdownPath}`);
      }
      const url = source ?? sourceUrl;
      if (url !== null) urlMarkdown.push({ path: markdownPath, identity: markdown.identity, url });
    }
    if (urlMarkdown.length > 1) throw new Error(`Article directory contains multiple URL-bearing Markdown files: ${directory}`);
    const selected = urlMarkdown[0];
    if (selected === undefined) continue;
    if (!sameDirectoryIdentity(capturedDirectoryIdentity, validateArticleDirectory(directory))) {
      throw new Error(`Article directory identity changed during inventory: ${directory}`);
    }
    const saved: SavedUrlRecord = {
      articleId: entry.name,
      directory,
      markdownPath: selected.path,
      sidecarPath: join(directory, URL_METADATA_FILENAME),
      subjectUrl: selected.url,
    };
    savedUrlRecordIdentities.set(saved, Object.freeze({
      directory: capturedDirectoryIdentity,
      markdown: selected.identity,
    }));
    records.push(Object.freeze(saved));
  }
  return Object.freeze(records);
}

function fileIdentity(path: string): FileIdentity {
  return identity(lstatSync(path, { bigint: true }));
}

function savedUrlRecordIdentity(saved: SavedUrlRecord): SavedUrlRecordIdentity {
  const owned = savedUrlRecordIdentities.get(saved);
  if (owned === undefined) throw new Error("Saved URL record was not produced by the validated inventory.");
  return owned;
}

function assertSavedUrlRecordCurrent(saved: SavedUrlRecord): void {
  const expected = savedUrlRecordIdentity(saved);
  if (dirname(saved.markdownPath) !== saved.directory || !basename(saved.markdownPath).endsWith(".md")) {
    throw new Error("Saved URL Markdown path is not owned by its article directory.");
  }
  const currentDirectoryIdentity = validateArticleDirectory(saved.directory);
  if (!sameDirectoryIdentity(expected.directory, currentDirectoryIdentity)) {
    throw new Error(`Article directory identity changed before metadata write: ${saved.directory}`);
  }
  const markdown = readBoundedSingleLinkFile(saved.markdownPath, MAX_MARKDOWN_BYTES, "Article Markdown");
  if (!sameIdentity(expected.markdown, markdown.identity)) {
    throw new Error(`Article Markdown identity changed before metadata write: ${saved.markdownPath}`);
  }
  const metadata = frontmatterObject(markdown.text, saved.markdownPath);
  const source = absoluteSource(metadata.source, `${saved.markdownPath} source`, true);
  const sourceUrl = absoluteSource(metadata.source_url, `${saved.markdownPath} source_url`, false);
  if (source !== null && sourceUrl !== null && source !== sourceUrl) {
    throw new Error(`Article Markdown has conflicting source and source_url values: ${saved.markdownPath}`);
  }
  if ((source ?? sourceUrl) !== saved.subjectUrl) {
    throw new Error(`Article Markdown source changed before metadata write: ${saved.markdownPath}`);
  }
}

function readOwnedSidecar(path: string, subjectUrl: string): { readonly document: UrlMetadataDocument; readonly identity: FileIdentity } {
  const read = readBoundedSingleLinkFile(path, MAX_SIDECAR_BYTES, "URL metadata sidecar");
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch (error) {
    throw new Error(`Refusing to replace malformed URL metadata sidecar: ${path}`, { cause: error });
  }
  const document = parseUrlMetadataDocument(value);
  if (document.subjectUrl !== subjectUrl) {
    throw new Error(`Refusing to replace URL metadata sidecar for a different subject: ${path}`);
  }
  return { document, identity: read.identity };
}

/** Read one tool-owned sidecar without following links or accepting a subject mismatch. */
export function readUrlMetadataDocument(saved: SavedUrlRecord): UrlMetadataDocument {
  if (dirname(saved.sidecarPath) !== saved.directory || basename(saved.sidecarPath) !== URL_METADATA_FILENAME) {
    throw new Error("URL metadata sidecar path is not owned by its article directory.");
  }
  assertSavedUrlRecordCurrent(saved);
  const document = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl).document;
  assertSavedUrlRecordCurrent(saved);
  return document;
}

export function writeUrlMetadataDocument(
  saved: SavedUrlRecord,
  document: UrlMetadataDocument,
): { readonly changed: boolean; readonly path: string } {
  const parsed = parseUrlMetadataDocument(document);
  if (parsed.subjectUrl !== saved.subjectUrl) throw new Error("URL metadata document does not match its saved URL record.");
  if (dirname(saved.sidecarPath) !== saved.directory || basename(saved.sidecarPath) !== URL_METADATA_FILENAME) {
    throw new Error("URL metadata sidecar path is not owned by its article directory.");
  }
  assertSavedUrlRecordCurrent(saved);
  const rendered = renderUrlMetadataDocument(parsed);
  if (utf8Length(rendered) > MAX_SIDECAR_BYTES) throw new Error("URL metadata sidecar exceeds its byte limit.");

  const lockPath = join(saved.directory, `.${URL_METADATA_FILENAME}.lock`);
  let heldLock: HeldUrlMetadataWriteLock | null = null;
  let temporaryPath: string | null = null;
  let temporaryDescriptor: number | null = null;
  let temporaryIdentity: FileIdentity | null = null;
  let directoryDescriptor: number | null = null;
  let operationError: unknown;
  try {
    heldLock = acquireUrlMetadataWriteLock(lockPath);
    temporaryPath = join(
      saved.directory,
      `.${URL_METADATA_FILENAME}.${process.pid}.${heldLock.owner.token}.tmp`,
    );
    assertSavedUrlRecordCurrent(saved);
    let existing: ReturnType<typeof readOwnedSidecar> | null = null;
    try {
      existing = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      if (cause.code !== "ENOENT") throw error;
    }
    if (existing !== null && renderUrlMetadataDocument(existing.document) === rendered) {
      assertSavedUrlRecordCurrent(saved);
      return { changed: false, path: saved.sidecarPath };
    }

    temporaryDescriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    setDescriptorCloseOnExec(temporaryDescriptor);
    temporaryIdentity = validateRegularSingleLink(
      fstatSync(temporaryDescriptor, { bigint: true }),
      temporaryPath,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    );
    const publishedTemporaryIdentity = validateRegularSingleLink(
      lstatSync(temporaryPath, { bigint: true }),
      temporaryPath,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    );
    if (!sameIdentity(temporaryIdentity, publishedTemporaryIdentity)) {
      throw new Error(`URL metadata temporary sidecar identity changed while opening: ${temporaryPath}`);
    }
    writeFileSync(temporaryDescriptor, rendered, "utf8");
    fchmodSync(temporaryDescriptor, 0o644);
    fsyncSync(temporaryDescriptor);
    temporaryIdentity = validateRegularSingleLink(
      fstatSync(temporaryDescriptor, { bigint: true }),
      temporaryPath,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    );
    if (!sameIdentity(temporaryIdentity, validateRegularSingleLink(
      lstatSync(temporaryPath, { bigint: true }),
      temporaryPath,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    ))) throw new Error(`URL metadata temporary sidecar changed while writing: ${temporaryPath}`);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    if (existing === null) {
      try {
        lstatSync(saved.sidecarPath);
        throw new Error(`URL metadata sidecar appeared concurrently: ${saved.sidecarPath}`);
      } catch (error) {
        const cause = error as NodeJS.ErrnoException;
        if (cause.code !== "ENOENT") throw error;
      }
    } else if (!sameIdentity(existing.identity, fileIdentity(saved.sidecarPath))) {
      throw new Error(`URL metadata sidecar changed concurrently: ${saved.sidecarPath}`);
    }

    directoryDescriptor = openSync(saved.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameDirectoryIdentity(
      savedUrlRecordIdentity(saved).directory,
      validateOpenedArticleDirectory(directoryDescriptor, saved.directory),
    )) {
      throw new Error(`Article directory identity changed before metadata install: ${saved.directory}`);
    }
    assertSavedUrlRecordCurrent(saved);
    assertHeldUrlMetadataWriteLockCurrent(heldLock);
    if (!sameIdentity(temporaryIdentity, validateRegularSingleLink(
      lstatSync(temporaryPath, { bigint: true }),
      temporaryPath,
      MAX_SIDECAR_BYTES,
      "URL metadata temporary sidecar",
    ))) throw new Error(`URL metadata temporary sidecar changed before install: ${temporaryPath}`);
    renameSync(temporaryPath, saved.sidecarPath);
    temporaryPath = null;
    temporaryIdentity = null;
    const installed = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl);
    if (renderUrlMetadataDocument(installed.document) !== rendered) {
      throw new Error(`URL metadata sidecar failed post-install verification: ${saved.sidecarPath}`);
    }
    assertHeldUrlMetadataWriteLockCurrent(heldLock);
    fsyncSync(directoryDescriptor);
    return { changed: true, path: saved.sidecarPath };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (directoryDescriptor !== null) {
      try {
        closeSync(directoryDescriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (temporaryDescriptor !== null) {
      try {
        closeSync(temporaryDescriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (temporaryPath !== null && temporaryIdentity !== null) {
      try {
        removeOwnedTemporaryFile(temporaryPath, temporaryIdentity);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (heldLock !== null) {
      try {
        releaseUrlMetadataWriteLock(heldLock);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    throwCleanupErrorWithoutOperationError(operationError, cleanupError);
  }
}
