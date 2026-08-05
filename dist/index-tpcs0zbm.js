// @bun
import {
  discoverArchiveTodaySnapshot,
  normalizeSourceUrlIdentity,
  parseArchiveTodayMementoUrl,
  parseMetadataSearchResponse,
  rankMetadataSearchResults
} from "./index-tp2p17gt.js";
import {
  sanitizeArtifactUrl
} from "./index-ey9rycsn.js";
import {
  assertSafeNetworkUrl,
  isPrivateHostname,
  resolveSafeNetworkTarget
} from "./index-e5fbsywq.js";

// src/clip/metadata-search.ts
import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync
} from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
var REQUEST_SCHEMA_VERSION = 1;
var MIN_RESULTS = 1;
var MAX_RESULTS = 20;
var MIN_TIMEOUT_MS = 500;
var MAX_TIMEOUT_MS = 15000;
var MAX_QUERY_BYTES = 4 * 1024;
var DEFAULT_RESULTS = 10;
var DEFAULT_TIMEOUT_MS = 15000;
var DEFAULT_PROCESS_GRACE_MS = 500;
var MAX_PROCESS_GRACE_MS = 2000;
var DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
var DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
var DEFAULT_MAX_BINARY_BYTES = 64 * 1024 * 1024;
var MAX_CONFIGURED_BINARY_BYTES = 256 * 1024 * 1024;
var KILL_GRACE_MS = 100;
var HASH_BUFFER_BYTES = 64 * 1024;
var MAX_ENGINE_ADDRESSES = 8;
var METADATA_SEARCH_ENGINE_HOSTS = Object.freeze([
  "html.duckduckgo.com",
  "search.brave.com",
  "www.startpage.com",
  "search.yahoo.com"
]);
function failure(category, message) {
  return Object.freeze({ status: "failure", category, message });
}
function signalAborted(signal) {
  return signal?.aborted === true;
}
function checkedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return resolved;
}
function utf8Length(value) {
  return Buffer.byteLength(value, "utf8");
}
function hasUnsafeQueryCodeUnits(value) {
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0)
      return true;
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343)
        return true;
      index += 1;
    } else if (code >= 56320 && code <= 57343) {
      return true;
    }
  }
  return false;
}
function validateRequest(request, defaults) {
  if (typeof request.query !== "string" || request.query.trim() === "" || utf8Length(request.query.trim()) > MAX_QUERY_BYTES || hasUnsafeQueryCodeUnits(request.query))
    return null;
  const maxResults = request.maxResults ?? defaults.maxResults;
  const timeoutMs = request.timeoutMs ?? defaults.timeoutMs;
  if (!Number.isSafeInteger(maxResults) || maxResults < MIN_RESULTS || maxResults > MAX_RESULTS || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS)
    return null;
  return Object.freeze({
    query: request.query.trim(),
    maxResults,
    timeoutMs,
    ...request.signal === undefined ? {} : { signal: request.signal }
  });
}
function sameOpenedIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function inspectBinary(binaryPath, maxBytes) {
  const pathMetadata = lstatSync(binaryPath, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1n) {
    throw new Error("The metadata search binary does not have a trusted file identity.");
  }
  const ownerExecutable = (pathMetadata.mode & 0o100n) !== 0n;
  const writableByAnotherUser = (pathMetadata.mode & 0o022n) !== 0n;
  const privilegedExecutable = (pathMetadata.mode & 0o6000n) !== 0n;
  const processOwner = typeof process.getuid === "function" ? BigInt(process.getuid()) : pathMetadata.uid;
  if (!ownerExecutable || writableByAnotherUser || privilegedExecutable || pathMetadata.uid !== processOwner || pathMetadata.size <= 0n || pathMetadata.size > BigInt(maxBytes))
    throw new Error("The metadata search binary does not satisfy the executable policy.");
  const descriptor = openSync(binaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameOpenedIdentity(pathMetadata, opened) || opened.nlink !== 1n || !opened.isFile()) {
      throw new Error("The metadata search binary identity changed while it was inspected.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset <= maxBytes) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, maxBytes + 1 - offset), offset);
      if (bytesRead === 0)
        break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > maxBytes)
      throw new Error("The metadata search binary exceeds its byte limit.");
    const finished = fstatSync(descriptor, { bigint: true });
    if (!sameOpenedIdentity(opened, finished) || BigInt(offset) !== finished.size) {
      throw new Error("The metadata search binary identity changed while it was read.");
    }
    return Object.freeze({
      realPath: realpathSync(binaryPath),
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      mode: opened.mode,
      owner: opened.uid,
      modifiedNanoseconds: opened.mtimeNs,
      changedNanoseconds: opened.ctimeNs,
      sha256: hash.digest("hex")
    });
  } finally {
    closeSync(descriptor);
  }
}
function identitiesEqual(left, right) {
  return left.realPath === right.realPath && left.device === right.device && left.inode === right.inode && left.size === right.size && left.mode === right.mode && left.owner === right.owner && left.modifiedNanoseconds === right.modifiedNanoseconds && left.changedNanoseconds === right.changedNanoseconds && left.sha256 === right.sha256;
}
function openedIdentityMatches(opened, expected) {
  return opened.dev === expected.device && opened.ino === expected.inode && opened.size === expected.size && opened.mode === expected.mode && opened.uid === expected.owner && opened.mtimeNs === expected.modifiedNanoseconds && opened.ctimeNs === expected.changedNanoseconds && opened.nlink === 1n && opened.isFile();
}
function materializePinnedBinary(expected, runDirectory) {
  const source = openSync(expected.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destinationPath = join(runDirectory, "metadata-search");
  let destination = null;
  try {
    if (!openedIdentityMatches(fstatSync(source, { bigint: true }), expected)) {
      throw new Error("metadata search binary identity changed");
    }
    destination = openSync(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 320);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    const expectedBytes = Number(expected.size);
    while (offset < expectedBytes) {
      const bytesRead = readSync(source, buffer, 0, Math.min(buffer.byteLength, expectedBytes - offset), offset);
      if (bytesRead === 0)
        throw new Error("metadata search binary ended early");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(destination, buffer, written, bytesRead - written, offset + written);
      }
      offset += bytesRead;
    }
    if (hash.digest("hex") !== expected.sha256 || !openedIdentityMatches(fstatSync(source, { bigint: true }), expected))
      throw new Error("metadata search binary identity changed");
    fsyncSync(destination);
    return destinationPath;
  } finally {
    if (destination !== null)
      closeSync(destination);
    closeSync(source);
  }
}
function createPrivateRunDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hraness-kb-metadata-search-"));
  chmodSync(directory, 448);
  for (const name of ["home", "config", "cache", "data", "tmp"]) {
    mkdirSync(join(directory, name), { mode: 448 });
  }
  return directory;
}
function isolatedMetadataSearchEnvironment(source, runDirectory) {
  const environment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = source[key];
    if (value !== undefined)
      environment[key] = value;
  }
  environment.HOME = join(runDirectory, "home");
  environment.XDG_CONFIG_HOME = join(runDirectory, "config");
  environment.XDG_CACHE_HOME = join(runDirectory, "cache");
  environment.XDG_DATA_HOME = join(runDirectory, "data");
  environment.TMPDIR = join(runDirectory, "tmp");
  environment.TMP = join(runDirectory, "tmp");
  environment.TEMP = join(runDirectory, "tmp");
  return Object.freeze(environment);
}
function appendBounded(capture, chunk, maximumBytes, onExceeded, retain) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (capture.bytes > maximumBytes)
    return;
  capture.bytes += bytes.byteLength;
  if (capture.bytes > maximumBytes) {
    capture.chunks.length = 0;
    onExceeded();
    return;
  }
  if (retain)
    capture.chunks.push(bytes);
}
async function runProcess(options) {
  let child = null;
  let closed = null;
  let timeout = null;
  let forceKill = null;
  let termination;
  let onAbort = null;
  try {
    child = spawn(options.binaryPath, [], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const runningChild = child;
    const stdout = { chunks: [], bytes: 0 };
    const stderr = { chunks: [], bytes: 0 };
    let spawnFailed = false;
    const terminate = (reason) => {
      if (termination !== undefined)
        return;
      termination = reason;
      runningChild.kill("SIGTERM");
      forceKill = setTimeout(() => runningChild.kill("SIGKILL"), KILL_GRACE_MS);
    };
    runningChild.stdout.on("data", (chunk) => {
      appendBounded(stdout, chunk, options.maxStdoutBytes, () => terminate("output-limit"), true);
    });
    runningChild.stderr.on("data", (chunk) => {
      appendBounded(stderr, chunk, options.maxStderrBytes, () => terminate("output-limit"), false);
    });
    runningChild.stdin.on("error", () => {});
    closed = new Promise((resolve) => {
      runningChild.once("error", () => {
        spawnFailed = true;
      });
      runningChild.once("close", (exitCode, processSignal) => {
        resolve(Object.freeze({
          stdout: Buffer.concat(stdout.chunks),
          exitCode,
          signal: processSignal,
          spawnFailed,
          ...termination === undefined ? {} : { termination }
        }));
      });
    });
    timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    if (options.signal !== undefined) {
      onAbort = () => terminate("aborted");
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted)
        terminate("aborted");
    }
    runningChild.stdin.end(options.stdin, "utf8");
    return await closed;
  } finally {
    if (timeout !== null)
      clearTimeout(timeout);
    if (forceKill !== null)
      clearTimeout(forceKill);
    if (onAbort !== null && options.signal !== undefined) {
      options.signal.removeEventListener("abort", onAbort);
    }
    if (child !== null && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    if (closed !== null)
      await closed;
  }
}
function deterministicResponse(response, maximumResults) {
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const enginesQueried = Object.freeze([...response.enginesQueried].sort());
  const results = response.results.map((result) => Object.freeze({ ...result, engines: Object.freeze([...result.engines].sort()) })).sort((left, right) => right.score - left.score || compareText(left.title, right.title) || compareText(left.url, right.url)).slice(0, maximumResults);
  return Object.freeze({
    ...response,
    results: Object.freeze(results),
    enginesQueried,
    enginesFailed: Object.freeze([...response.enginesFailed].sort()),
    engineStatus: response.engineStatus
  });
}
async function resolveEngineHosts(resolver, timeoutMs) {
  const resolved = await Promise.all(METADATA_SEARCH_ENGINE_HOSTS.map(async (hostname) => {
    const addresses = await resolver(new URL(`https://${hostname}/`), {
      allowPrivateNetwork: false,
      timeoutMs
    });
    if (addresses.length === 0 || addresses.length > MAX_ENGINE_ADDRESSES) {
      throw new Error("metadata search engine DNS answer count is invalid");
    }
    const unique = new Map;
    for (const address of addresses) {
      if (address.family !== 4 && address.family !== 6 || typeof address.address !== "string" || address.address.trim() !== address.address || address.address === "")
        throw new Error("metadata search engine DNS answer is invalid");
      unique.set(`${address.family}:${address.address}`, Object.freeze({ ...address }));
    }
    if (unique.size !== addresses.length)
      throw new Error("metadata search engine DNS answer is duplicated");
    return Object.freeze({
      hostname,
      addresses: Object.freeze([...unique.values()].sort((left, right) => left.family - right.family || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0)))
    });
  }));
  return Object.freeze(resolved);
}
function createExactUrlSearchQuery(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" || normalizeSourceUrlIdentity(url) === null) {
    return null;
  }
  url.hash = "";
  const exactUrl = url.href;
  let sanitized;
  try {
    sanitized = sanitizeArtifactUrl(exactUrl);
  } catch {
    return null;
  }
  if (sanitized !== exactUrl || utf8Length(exactUrl) > MAX_QUERY_BYTES - 2)
    return null;
  return `"${exactUrl}"`;
}
function createRustMetadataSearchProvider(options) {
  if (!isAbsolute(options.binaryPath)) {
    throw new TypeError("The metadata search binary path must be absolute.");
  }
  const defaultMaxResults = checkedInteger(options.defaultMaxResults, DEFAULT_RESULTS, MIN_RESULTS, MAX_RESULTS, "defaultMaxResults");
  const defaultTimeoutMs = checkedInteger(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "defaultTimeoutMs");
  const processGraceMs = checkedInteger(options.processGraceMs, DEFAULT_PROCESS_GRACE_MS, 0, MAX_PROCESS_GRACE_MS, "processGraceMs");
  const maxStdoutBytes = checkedInteger(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES, 1, 16 * 1024 * 1024, "maxStdoutBytes");
  const maxStderrBytes = checkedInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 1, 2 * 1024 * 1024, "maxStderrBytes");
  const maxBinaryBytes = checkedInteger(options.maxBinaryBytes, DEFAULT_MAX_BINARY_BYTES, 1, MAX_CONFIGURED_BINARY_BYTES, "maxBinaryBytes");
  let pinnedIdentity;
  try {
    pinnedIdentity = inspectBinary(options.binaryPath, maxBinaryBytes);
  } catch {
    throw new Error("The metadata search binary is unavailable or untrusted.");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const resolveNetworkTarget = options.resolveNetworkTarget ?? resolveSafeNetworkTarget;
  return async (request) => {
    const validated = validateRequest(request, { maxResults: defaultMaxResults, timeoutMs: defaultTimeoutMs });
    if (validated === null)
      return failure("invalid-request", "The metadata search request is invalid.");
    if (signalAborted(validated.signal))
      return failure("aborted", "Metadata search was aborted.");
    let engineHosts;
    try {
      engineHosts = await resolveEngineHosts(resolveNetworkTarget, validated.timeoutMs);
    } catch {
      return failure("unavailable", "Metadata search network targets are unavailable.");
    }
    if (signalAborted(validated.signal))
      return failure("aborted", "Metadata search was aborted.");
    let currentIdentity;
    try {
      currentIdentity = inspectBinary(options.binaryPath, maxBinaryBytes);
    } catch {
      return failure("unavailable", "Metadata search is unavailable.");
    }
    if (!identitiesEqual(pinnedIdentity, currentIdentity)) {
      return failure("unavailable", "Metadata search is unavailable.");
    }
    let runDirectory;
    try {
      runDirectory = createPrivateRunDirectory();
    } catch {
      return failure("unavailable", "Metadata search is unavailable.");
    }
    try {
      const input = JSON.stringify({
        schema_version: REQUEST_SCHEMA_VERSION,
        query: validated.query,
        max_results: validated.maxResults,
        timeout_ms: validated.timeoutMs,
        engine_hosts: engineHosts
      });
      let result;
      try {
        const executablePath = materializePinnedBinary(currentIdentity, runDirectory);
        result = await runProcess({
          binaryPath: executablePath,
          cwd: runDirectory,
          environment: isolatedMetadataSearchEnvironment(sourceEnvironment, runDirectory),
          stdin: input,
          timeoutMs: validated.timeoutMs + processGraceMs,
          maxStdoutBytes,
          maxStderrBytes,
          ...validated.signal === undefined ? {} : { signal: validated.signal }
        });
      } catch {
        return failure("process", "Metadata search process failed.");
      }
      if (result.termination === "aborted")
        return failure("aborted", "Metadata search was aborted.");
      if (result.termination === "timeout")
        return failure("timeout", "Metadata search timed out.");
      if (result.termination === "output-limit") {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
      if (result.spawnFailed)
        return failure("unavailable", "Metadata search is unavailable.");
      if (result.exitCode !== 0 || result.signal !== null) {
        return failure("process", "Metadata search process failed.");
      }
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      } catch {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
      try {
        const parsed = parseMetadataSearchResponse(JSON.parse(decoded));
        if (parsed.query !== validated.query) {
          return failure("protocol", "Metadata search returned an invalid response.");
        }
        return Object.freeze({
          status: "success",
          response: deterministicResponse(parsed, validated.maxResults)
        });
      } catch {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
    } finally {
      rmSync(runDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  };
}

// src/clip/url-metadata.ts
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import {
  closeSync as closeSync2,
  constants as constants2,
  fchmodSync,
  fstatSync as fstatSync2,
  ftruncateSync,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync2,
  openSync as openSync2,
  readFileSync,
  readSync as readSync2,
  readdirSync,
  realpathSync as realpathSync2,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync as writeSync2
} from "fs";
import { hostname } from "os";
import { basename, dirname, join as join2, relative, resolve, sep } from "path";
import { parseDocument } from "yaml";
var URL_METADATA_FILENAME = "url-metadata.json";
var URL_METADATA_SCHEMA_VERSION = 1;
var METADATA_SEARCH_ENGINE_ID = "metadata-search-engine-rs";
var METADATA_SEARCH_ENGINE_VERSION = "0.1.3";
var METADATA_SEARCH_ENGINE_REVISION = "f40a00ea67a857ee996e1caba1ebab3ee7a14a47";
var MAX_ARTICLE_DIRECTORIES = 4096;
var MAX_DIRECTORY_ENTRIES = 256;
var MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
var MAX_SIDECAR_BYTES = 1024 * 1024;
var MAX_CANDIDATES = 20;
var MAX_ARCHIVES = 32;
var MAX_ATTEMPTS = 16;
var MAX_WARNINGS = 32;
var MAX_URL_BYTES = 16 * 1024;
var MAX_TITLE_BYTES = 2 * 1024;
var MAX_SNIPPET_BYTES = 8 * 1024;
var MAX_MESSAGE_BYTES = 2 * 1024;
var MAX_ENGINE_COUNT = 8;
var MAX_LOCK_BYTES = 4 * 1024;
var MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS = 30000;
var LOCK_EXCLUSIVE = 2;
var LOCK_NONBLOCKING = 4;
var F_SET_FILE_DESCRIPTOR = 2;
var FILE_DESCRIPTOR_CLOSE_ON_EXEC = 1;
var INTERRUPTED_SYSTEM_CALL = 4;
var engineNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
var lockTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var nativeFlock;
var nativeFcntl;
var nativeErrnoLocation;
var nativeFfiRead;
var nativeLockLibraries = [];
var savedUrlRecordIdentities = new WeakMap;
function requiredNativeSymbol(symbols, name) {
  const symbol = symbols[name];
  if (symbol === undefined)
    throw new Error(`URL metadata locking could not bind ${name}.`);
  return symbol;
}
function linuxLibcCandidates(processMaps, architecture = process.arch) {
  const candidates = [];
  const append = (candidate) => {
    if (!candidates.includes(candidate))
      candidates.push(candidate);
  };
  for (const line of processMaps.split(`
`)) {
    const pathStart = line.indexOf("/");
    if (pathStart < 0 || line.endsWith(" (deleted)"))
      continue;
    const path = line.slice(pathStart).replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCodePoint(Number.parseInt(octal, 8)));
    if (/\/(?:libc(?:-[^/]+)?\.so(?:\.[0-9]+)*|libc\.musl-[^/]+\.so(?:\.[0-9]+)*|ld-musl-[^/]+\.so(?:\.[0-9]+)*)$/u.test(path))
      append(path);
  }
  append("libc.so.6");
  if (architecture === "x64")
    append("/lib/ld-musl-x86_64.so.1");
  if (architecture === "arm64")
    append("/lib/ld-musl-aarch64.so.1");
  return candidates;
}
function initializeNativeLocking() {
  if (nativeFlock !== undefined && nativeFcntl !== undefined && nativeErrnoLocation !== undefined)
    return;
  const ffi = globalThis.Bun?.FFI;
  if (ffi === undefined) {
    throw new Error("URL metadata writes require Bun's native file-locking runtime.");
  }
  nativeFfiRead = ffi.read;
  if (process.platform === "darwin") {
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: "ptr" },
      fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
      flock: { args: ["i32", "i32"], returns: "i32" }
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
    } catch {}
    const failures = [];
    for (const candidate of linuxLibcCandidates(processMaps)) {
      try {
        const library = ffi.dlopen(candidate, {
          __errno_location: { args: [], returns: "ptr" },
          fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
          flock: { args: ["i32", "i32"], returns: "i32" }
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
function currentNativeErrno() {
  initializeNativeLocking();
  const pointer = nativeErrnoLocation?.();
  if (pointer === undefined || pointer === null)
    throw new Error("URL metadata locking could not read errno.");
  if (nativeFfiRead === undefined)
    throw new Error("URL metadata locking lost its native read binding.");
  return nativeFfiRead.i32(pointer);
}
function tryExclusiveFileLock(descriptor) {
  initializeNativeLocking();
  for (;; ) {
    if (nativeFlock?.(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) === 0)
      return true;
    const errno = currentNativeErrno();
    if (errno === INTERRUPTED_SYSTEM_CALL)
      continue;
    if (process.platform === "darwin" && errno === 35 || process.platform === "linux" && errno === 11) {
      return false;
    }
    throw new Error(`URL metadata flock failed with errno ${errno}.`);
  }
}
function setDescriptorCloseOnExec(descriptor) {
  initializeNativeLocking();
  if (nativeFcntl?.(descriptor, F_SET_FILE_DESCRIPTOR, FILE_DESCRIPTOR_CLOSE_ON_EXEC) !== 0) {
    throw new Error(`URL metadata fcntl failed with errno ${currentNativeErrno()}.`);
  }
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function errorFromUnknown(value, message) {
  return value instanceof Error ? value : new Error(message, { cause: value });
}
function throwCleanupErrorWithoutOperationError(operationError, cleanupError) {
  if (operationError === undefined && cleanupError !== undefined) {
    throw errorFromUnknown(cleanupError, "URL metadata write cleanup failed.");
  }
}
function utf8Length2(value) {
  return new TextEncoder().encode(value).byteLength;
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}
function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      throw new TypeError(`${label} contains unknown key ${JSON.stringify(key)}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new TypeError(`${label} is missing ${JSON.stringify(key)}.`);
  }
}
function boundedText(value, label, maximumBytes) {
  if (typeof value !== "string" || value === "" || utf8Length2(value) > maximumBytes) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximumBytes} UTF-8 bytes.`);
  }
  if (/\p{Cc}|\p{Cs}/u.test(value))
    throw new TypeError(`${label} contains unsafe control characters.`);
  return value;
}
function boundedTextList(value, label, maximumCount, maximumBytes) {
  if (!Array.isArray(value) || value.length > maximumCount) {
    throw new TypeError(`${label} must be an array with at most ${maximumCount} entries.`);
  }
  const parsed = value.map((item, index) => boundedText(item, `${label}[${index}]`, maximumBytes));
  if (new Set(parsed).size !== parsed.length)
    throw new TypeError(`${label} contains duplicate entries.`);
  return Object.freeze(parsed);
}
function engineList(value, label) {
  const engines = boundedTextList(value, label, MAX_ENGINE_COUNT, 64);
  for (const engine of engines) {
    if (!engineNamePattern.test(engine)) {
      throw new TypeError(`${label} contains an invalid engine identifier.`);
    }
  }
  return engines;
}
function normalizedPublicUrl(value, label) {
  const text = boundedText(value, label, MAX_URL_BYTES);
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL.`, { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username !== "" || url.password !== "") {
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
function isoTimestamp(value, label) {
  const text = boundedText(value, label, 128);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}
function parseUrlMetadataWriteLockOwner(value) {
  const input = record(value, "URL metadata write lock owner");
  exactKeys(input, [
    "schemaVersion",
    "kind",
    "host",
    "pid",
    "processIdentity",
    "token",
    "acquiredAt"
  ], "URL metadata write lock owner");
  if (input.schemaVersion !== 1 || input.kind !== "url-metadata-write-lock") {
    throw new TypeError("URL metadata write lock owner has an unsupported identity.");
  }
  if (typeof input.pid !== "number" || !Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new TypeError("URL metadata write lock owner.pid must be a positive safe integer.");
  }
  const token = boundedText(input.token, "URL metadata write lock owner.token", 64);
  if (!lockTokenPattern.test(token))
    throw new TypeError("URL metadata write lock owner.token is invalid.");
  return Object.freeze({
    schemaVersion: 1,
    kind: "url-metadata-write-lock",
    host: boundedText(input.host, "URL metadata write lock owner.host", 255),
    pid: input.pid,
    processIdentity: boundedText(input.processIdentity, "URL metadata write lock owner.processIdentity", 512),
    token,
    acquiredAt: isoTimestamp(input.acquiredAt, "URL metadata write lock owner.acquiredAt")
  });
}
function operatingSystemProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0)
        return null;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
      const state = fields[0];
      const startTicks = fields[19];
      if (state === "Z" || startTicks === undefined || !/^\d+$/u.test(startTicks))
        return null;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[0-9a-f-]{36}$/u.test(bootId))
        return null;
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000
      }).trim();
      return started === "" ? null : `darwin:${started.replace(/\s+/gu, " ")}`;
    } catch {
      return null;
    }
  }
  return null;
}
function currentWriteLockOwner() {
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
    acquiredAt: new Date().toISOString()
  });
}
function parseCandidate(value, label) {
  const input = record(value, label);
  exactKeys(input, ["title", "url", "snippet", "engines", "score"], label);
  const score = input.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    throw new TypeError(`${label}.score must be a finite non-negative number.`);
  }
  const snippet = input.snippet === null ? null : boundedText(input.snippet, `${label}.snippet`, MAX_SNIPPET_BYTES);
  return Object.freeze({
    title: boundedText(input.title, `${label}.title`, MAX_TITLE_BYTES),
    url: normalizedPublicUrl(input.url, `${label}.url`),
    snippet,
    engines: boundedTextList(input.engines, `${label}.engines`, MAX_ENGINE_COUNT, 64),
    score
  });
}
function parseAttempt(value, label) {
  const input = record(value, label);
  exactKeys(input, ["provider", "outcome", "message"], label);
  if (input.provider !== "metadata-search-engine-rs" && input.provider !== "archive-today") {
    throw new TypeError(`${label}.provider is unsupported.`);
  }
  if (input.outcome !== "succeeded" && input.outcome !== "partial" && input.outcome !== "not-found" && input.outcome !== "failed" && input.outcome !== "skipped")
    throw new TypeError(`${label}.outcome is unsupported.`);
  return Object.freeze({
    provider: input.provider,
    outcome: input.outcome,
    message: boundedText(input.message, `${label}.message`, MAX_MESSAGE_BYTES)
  });
}
function parseArchive(value, label, subjectUrl, generatedAt) {
  const input = record(value, label);
  exactKeys(input, ["url", "capturedAt", "discovery"], label);
  if (input.discovery !== "newest" && input.discovery !== "timemap" && input.discovery !== "metadata-search")
    throw new TypeError(`${label}.discovery is unsupported.`);
  const url = normalizedPublicUrl(input.url, `${label}.url`);
  const capturedAt = isoTimestamp(input.capturedAt, `${label}.capturedAt`);
  let memento;
  try {
    memento = parseArchiveTodayMementoUrl(url, {
      originalUrl: subjectUrl,
      now: new Date(generatedAt)
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
    discovery: input.discovery
  });
}
function parseSelectedField(value, label, maximumBytes) {
  if (value === null)
    return null;
  const input = record(value, label);
  exactKeys(input, ["value", "sourceUrl", "provider"], label);
  if (input.provider !== METADATA_SEARCH_ENGINE_ID)
    throw new TypeError(`${label}.provider is unsupported.`);
  return Object.freeze({
    value: boundedText(input.value, `${label}.value`, maximumBytes),
    sourceUrl: normalizedPublicUrl(input.sourceUrl, `${label}.sourceUrl`),
    provider: METADATA_SEARCH_ENGINE_ID
  });
}
function metadataStatus(options) {
  if (options.hasCandidate)
    return options.partial ? "partial" : "matched";
  if (options.hasArchive)
    return "partial";
  if (options.queriedEngines === 0 || options.failedEngines === options.queriedEngines)
    return "unavailable";
  return options.partial ? "partial" : "not-found";
}
function parseUrlMetadataDocument(value) {
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
    "warnings"
  ], "URL metadata document");
  if (input.schemaVersion !== URL_METADATA_SCHEMA_VERSION || input.kind !== "url-metadata") {
    throw new TypeError("URL metadata document has an unsupported identity.");
  }
  if (input.status !== "matched" && input.status !== "not-found" && input.status !== "partial" && input.status !== "unavailable")
    throw new TypeError("URL metadata document has an unsupported status.");
  const provider = record(input.provider, "URL metadata document.provider");
  exactKeys(provider, ["id", "version", "revision", "enginesQueried", "enginesFailed"], "URL metadata document.provider");
  if (provider.id !== METADATA_SEARCH_ENGINE_ID || provider.version !== METADATA_SEARCH_ENGINE_VERSION || provider.revision !== METADATA_SEARCH_ENGINE_REVISION)
    throw new TypeError("URL metadata document has an unsupported provider identity.");
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
  const attempts = Object.freeze(input.attempts.map((item, index) => parseAttempt(item, `URL metadata document.attempts[${index}]`)));
  const candidates = Object.freeze(input.candidates.map((item, index) => parseCandidate(item, `URL metadata document.candidates[${index}]`)));
  const candidateUrls = new Set;
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
  if (best === null && (title !== null || description !== null) || best !== null && (title?.value !== best.title || title.sourceUrl !== subjectUrl) || best?.snippet === null && description !== null || best?.snippet !== null && best !== null && (description?.value !== best.snippet || description.sourceUrl !== subjectUrl)) {
    throw new TypeError("URL metadata document selected fields do not match the best exact candidate.");
  }
  const archives = Object.freeze(input.archives.map((item, index) => parseArchive(item, `URL metadata document.archives[${index}]`, subjectUrl, generatedAt)));
  const archiveCaptures = new Set;
  for (const archive of archives) {
    if (archiveCaptures.has(archive.capturedAt)) {
      throw new TypeError("URL metadata document archives contain a duplicate capture timestamp.");
    }
    archiveCaptures.add(archive.capturedAt);
  }
  const partial = enginesFailed.length > 0 || attempts.some(({ outcome }) => outcome === "failed" || outcome === "partial");
  const expectedStatus = metadataStatus({
    hasCandidate: best !== null,
    hasArchive: archives.length > 0,
    queriedEngines: enginesQueried.length,
    failedEngines: enginesFailed.length,
    partial
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
      enginesFailed
    }),
    attempts,
    candidates,
    selected: Object.freeze({
      title,
      description
    }),
    archives,
    warnings: boundedTextList(input.warnings, "URL metadata document.warnings", MAX_WARNINGS, MAX_MESSAGE_BYTES)
  });
}
function stableCandidateOrder(left, right) {
  return right.score - left.score || right.engines.length - left.engines.length || compareText(left.title, right.title) || compareText(left.url, right.url);
}
function createUrlMetadataDocument(input) {
  const candidates = [...input.candidates].sort(stableCandidateOrder).slice(0, MAX_CANDIDATES);
  const best = candidates[0] ?? null;
  const archives = [...input.archives ?? []].sort((left, right) => compareText(right.capturedAt, left.capturedAt) || compareText(left.url, right.url)).slice(0, MAX_ARCHIVES);
  const partial = input.enginesFailed.length > 0 || input.attempts.some(({ outcome }) => outcome === "failed" || outcome === "partial");
  const status = metadataStatus({
    hasCandidate: best !== null,
    hasArchive: archives.length > 0,
    queriedEngines: input.enginesQueried.length,
    failedEngines: input.enginesFailed.length,
    partial
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
      enginesFailed: [...input.enginesFailed]
    },
    attempts: [...input.attempts],
    candidates,
    selected: {
      title: best === null ? null : {
        value: best.title,
        sourceUrl: best.url,
        provider: METADATA_SEARCH_ENGINE_ID
      },
      description: best?.snippet === null || best?.snippet === undefined ? null : {
        value: best.snippet,
        sourceUrl: best.url,
        provider: METADATA_SEARCH_ENGINE_ID
      }
    },
    archives,
    warnings: [...input.warnings ?? []]
  });
}
function renderUrlMetadataDocument(document) {
  return `${JSON.stringify(parseUrlMetadataDocument(document), null, 2)}
`;
}
function frontmatterObject(markdown, path) {
  const match = /^---(?:\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/u.exec(markdown);
  if (match === null)
    return {};
  const parsed = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (parsed.errors.length > 0)
    throw new Error(`Invalid YAML frontmatter in ${path}: ${parsed.errors[0]?.message ?? "unknown error"}`);
  const value = parsed.toJS({ maxAliasCount: 32 });
  if (value === null)
    return {};
  return record(value, `Frontmatter in ${path}`);
}
function absoluteSource(value, label, allowLocalPdf) {
  if (value === undefined)
    return null;
  if (allowLocalPdf && value === "source.pdf")
    return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL${allowLocalPdf ? " or source.pdf" : ""}.`);
  }
  let parsed;
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
function confined(root, path, label) {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.includes(`\x00`)) {
    throw new Error(`${label} escapes the articles root.`);
  }
}
function identity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    links: metadata.nlink,
    modifiedNanoseconds: metadata.mtimeNs,
    changedNanoseconds: metadata.ctimeNs
  });
}
function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.mode === right.mode && left.links === right.links && left.modifiedNanoseconds === right.modifiedNanoseconds && left.changedNanoseconds === right.changedNanoseconds;
}
function sameInode(left, right) {
  return left.device === right.device && left.inode === right.inode;
}
function validateOwnedLockFile(metadata, path) {
  const effectiveUserId = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || effectiveUserId !== undefined && metadata.uid !== BigInt(effectiveUserId)) {
    throw new Error(`URL metadata write lock must be an owned regular single-link file: ${path}`);
  }
  return identity(metadata);
}
function readDescriptorText(descriptor, maximumBytes, label) {
  const metadata = fstatSync2(descriptor, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} descriptor must be a regular single-link file.`);
  }
  if (metadata.size > BigInt(maximumBytes))
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  const bytes = Buffer.alloc(Number(metadata.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync2(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0)
      throw new Error(`${label} ended before its validated size.`);
    offset += count;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8.`, { cause: error });
  }
}
function lockOwnerFromDescriptor(descriptor) {
  let value;
  try {
    value = JSON.parse(readDescriptorText(descriptor, MAX_LOCK_BYTES, "URL metadata write lock"));
  } catch (error) {
    throw new Error("URL metadata write lock owner metadata is malformed.", { cause: error });
  }
  return parseUrlMetadataWriteLockOwner(value);
}
function writeLockOwner(descriptor, owner) {
  const bytes = Buffer.from(`${JSON.stringify(owner)}
`, "utf8");
  if (bytes.byteLength > MAX_LOCK_BYTES)
    throw new Error("URL metadata write lock owner metadata is oversized.");
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync2(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written === 0)
      throw new Error("URL metadata write lock owner metadata could not be fully written.");
    offset += written;
  }
  ftruncateSync(descriptor, bytes.byteLength);
  fchmodSync(descriptor, 384);
  fsyncSync2(descriptor);
  const parsed = lockOwnerFromDescriptor(descriptor);
  if (parsed.host !== owner.host || parsed.pid !== owner.pid || parsed.processIdentity !== owner.processIdentity || parsed.token !== owner.token || parsed.acquiredAt !== owner.acquiredAt)
    throw new Error("URL metadata write lock owner metadata failed verification.");
  return validateOwnedLockFile(fstatSync2(descriptor, { bigint: true }), "opened lock descriptor");
}
function assertMalformedLockIsOldEnoughToRecover(descriptor, identity2, path) {
  try {
    lockOwnerFromDescriptor(descriptor);
    return;
  } catch (error) {
    const ageNanoseconds = BigInt(Date.now()) * 1000000n - identity2.modifiedNanoseconds;
    const recoveryAgeNanoseconds = BigInt(MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS) * 1000000n;
    if (ageNanoseconds < recoveryAgeNanoseconds) {
      throw new Error(`Refusing to reclaim a fresh malformed URL metadata write lock: ${path}`, { cause: error });
    }
  }
}
function activeLockOwnerDescription(path, openedIdentity) {
  try {
    const publishedIdentity = validateOwnedLockFile(lstatSync2(path, { bigint: true }), path);
    if (!sameInode(openedIdentity, publishedIdentity))
      return "an active writer after concurrent lock replacement";
    const owner = parseUrlMetadataWriteLockOwner(JSON.parse(readBoundedSingleLinkFile(path, MAX_LOCK_BYTES, "URL metadata write lock").text));
    if (owner.host === hostname() && operatingSystemProcessIdentity(owner.pid) === owner.processIdentity)
      return `active writer pid ${owner.pid} (${owner.token})`;
  } catch {}
  return "an active writer with unverified owner metadata";
}
function acquireUrlMetadataWriteLock(path) {
  const owner = currentWriteLockOwner();
  let descriptor = null;
  let existedBeforeOpen = true;
  try {
    try {
      validateOwnedLockFile(lstatSync2(path, { bigint: true }), path);
    } catch (error) {
      const cause = error;
      if (cause.code !== "ENOENT")
        throw error;
      existedBeforeOpen = false;
    }
    descriptor = openSync2(path, constants2.O_RDWR | constants2.O_CREAT | constants2.O_NOFOLLOW, 384);
    setDescriptorCloseOnExec(descriptor);
    const openedIdentity = validateOwnedLockFile(fstatSync2(descriptor, { bigint: true }), path);
    const publishedIdentity = validateOwnedLockFile(lstatSync2(path, { bigint: true }), path);
    if (!sameInode(openedIdentity, publishedIdentity)) {
      throw new Error(`URL metadata write lock identity changed while opening: ${path}`);
    }
    if (!tryExclusiveFileLock(descriptor)) {
      throw new Error(`URL metadata sidecar is locked by ${activeLockOwnerDescription(path, openedIdentity)}.`);
    }
    if (existedBeforeOpen)
      assertMalformedLockIsOldEnoughToRecover(descriptor, openedIdentity, path);
    const identity2 = writeLockOwner(descriptor, owner);
    const ownedPathIdentity = validateOwnedLockFile(lstatSync2(path, { bigint: true }), path);
    if (!sameIdentity(identity2, ownedPathIdentity)) {
      throw new Error(`URL metadata write lock changed while publishing its owner: ${path}`);
    }
    const held = Object.freeze({ descriptor, identity: identity2, owner, path });
    descriptor = null;
    return held;
  } finally {
    if (descriptor !== null)
      closeSync2(descriptor);
  }
}
function releaseUrlMetadataWriteLock(held) {
  let releaseError;
  try {
    assertHeldUrlMetadataWriteLockCurrent(held);
    unlinkSync(held.path);
  } catch (error) {
    releaseError = errorFromUnknown(error, "URL metadata write lock release failed.");
  }
  try {
    closeSync2(held.descriptor);
  } catch (error) {
    releaseError ??= errorFromUnknown(error, "URL metadata write lock descriptor close failed.");
  }
  if (releaseError !== undefined)
    throw releaseError;
}
function assertHeldUrlMetadataWriteLockCurrent(held) {
  const openedIdentity = validateOwnedLockFile(fstatSync2(held.descriptor, { bigint: true }), held.path);
  const publishedIdentity = validateOwnedLockFile(lstatSync2(held.path, { bigint: true }), held.path);
  const owner = lockOwnerFromDescriptor(held.descriptor);
  if (!sameIdentity(held.identity, openedIdentity) || !sameIdentity(held.identity, publishedIdentity) || owner.token !== held.owner.token || owner.pid !== held.owner.pid || owner.processIdentity !== held.owner.processIdentity)
    throw new Error(`URL metadata write lock was replaced while held: ${held.path}`);
}
function removeOwnedTemporaryFile(path, expected) {
  let published;
  try {
    published = validateRegularSingleLink(lstatSync2(path, { bigint: true }), path, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar");
  } catch (error) {
    const cause = error;
    if (cause.code === "ENOENT")
      return;
    throw error;
  }
  if (!sameIdentity(expected, published)) {
    throw new Error(`Refusing to remove a replaced URL metadata temporary sidecar: ${path}`);
  }
  unlinkSync(path);
}
function directoryIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode
  });
}
function sameDirectoryIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}
function validateArticleDirectory(path) {
  const metadata = lstatSync2(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync2(path) !== path) {
    throw new Error(`Article directory must be a real directory: ${path}`);
  }
  return directoryIdentity(metadata);
}
function validateOpenedArticleDirectory(descriptor, path) {
  const metadata = fstatSync2(descriptor, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Article directory descriptor is no longer a directory: ${path}`);
  }
  return directoryIdentity(metadata);
}
function validateRegularSingleLink(metadata, path, maximumBytes, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} must be a regular single-link file: ${path}`);
  }
  if (metadata.size > BigInt(maximumBytes))
    throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  return identity(metadata);
}
function readBoundedSingleLinkFile(path, maximumBytes, label) {
  const pathIdentity = validateRegularSingleLink(lstatSync2(path, { bigint: true }), path, maximumBytes, label);
  const descriptor = openSync2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW);
  try {
    const openedIdentity = validateRegularSingleLink(fstatSync2(descriptor, { bigint: true }), path, maximumBytes, label);
    if (!sameIdentity(pathIdentity, openedIdentity))
      throw new Error(`${label} identity changed before read: ${path}`);
    const bytes = Buffer.alloc(Number(openedIdentity.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync2(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0)
        throw new Error(`${label} ended before its validated size: ${path}`);
      offset += count;
    }
    const finishedIdentity = validateRegularSingleLink(fstatSync2(descriptor, { bigint: true }), path, maximumBytes, label);
    const finalPathIdentity = validateRegularSingleLink(lstatSync2(path, { bigint: true }), path, maximumBytes, label);
    if (!sameIdentity(openedIdentity, finishedIdentity) || !sameIdentity(openedIdentity, finalPathIdentity)) {
      throw new Error(`${label} identity changed during read: ${path}`);
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} must be valid UTF-8: ${path}`, { cause: error });
    }
    return Object.freeze({ text, identity: openedIdentity });
  } finally {
    closeSync2(descriptor);
  }
}
function discoverSavedUrlRecords(vaultRoot) {
  const resolvedVault = realpathSync2(resolve(vaultRoot));
  const vaultMetadata = lstatSync2(resolvedVault);
  if (!vaultMetadata.isDirectory() || vaultMetadata.isSymbolicLink())
    throw new Error("The vault root must be a real directory.");
  const articlesRoot = join2(resolvedVault, "articles");
  const articlesMetadata = lstatSync2(articlesRoot);
  if (!articlesMetadata.isDirectory() || articlesMetadata.isSymbolicLink())
    throw new Error("The articles root must be a real directory.");
  if (realpathSync2(articlesRoot) !== articlesRoot)
    throw new Error("The articles root must resolve to itself.");
  const entries = readdirSync(articlesRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length > MAX_ARTICLE_DIRECTORIES) {
    throw new Error(`The articles root exceeds ${MAX_ARTICLE_DIRECTORIES} directories.`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`The articles root contains a symbolic link: ${entry.name}`);
  }
  const records = [];
  for (const entry of directories.sort((left, right) => compareText(left.name, right.name))) {
    const directory = join2(articlesRoot, entry.name);
    confined(articlesRoot, directory, "Article directory");
    const capturedDirectoryIdentity = validateArticleDirectory(directory);
    const children = readdirSync(directory, { withFileTypes: true });
    if (children.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`Article directory exceeds ${MAX_DIRECTORY_ENTRIES} entries: ${directory}`);
    }
    if (children.some((child) => child.isSymbolicLink())) {
      throw new Error(`Article directory contains a symbolic link: ${directory}`);
    }
    const urlMarkdown = [];
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".md") || child.name === "AGENTS.md")
        continue;
      const markdownPath = join2(directory, child.name);
      const markdown = readBoundedSingleLinkFile(markdownPath, MAX_MARKDOWN_BYTES, "Article Markdown");
      const metadata = frontmatterObject(markdown.text, markdownPath);
      const source = absoluteSource(metadata.source, `${markdownPath} source`, true);
      const sourceUrl = absoluteSource(metadata.source_url, `${markdownPath} source_url`, false);
      if (source !== null && sourceUrl !== null && source !== sourceUrl) {
        throw new Error(`Article Markdown has conflicting source and source_url values: ${markdownPath}`);
      }
      const url = source ?? sourceUrl;
      if (url !== null)
        urlMarkdown.push({ path: markdownPath, identity: markdown.identity, url });
    }
    if (urlMarkdown.length > 1)
      throw new Error(`Article directory contains multiple URL-bearing Markdown files: ${directory}`);
    const selected = urlMarkdown[0];
    if (selected === undefined)
      continue;
    if (!sameDirectoryIdentity(capturedDirectoryIdentity, validateArticleDirectory(directory))) {
      throw new Error(`Article directory identity changed during inventory: ${directory}`);
    }
    const saved = {
      articleId: entry.name,
      directory,
      markdownPath: selected.path,
      sidecarPath: join2(directory, URL_METADATA_FILENAME),
      subjectUrl: selected.url
    };
    savedUrlRecordIdentities.set(saved, Object.freeze({
      directory: capturedDirectoryIdentity,
      markdown: selected.identity
    }));
    records.push(Object.freeze(saved));
  }
  return Object.freeze(records);
}
function fileIdentity(path) {
  return identity(lstatSync2(path, { bigint: true }));
}
function savedUrlRecordIdentity(saved) {
  const owned = savedUrlRecordIdentities.get(saved);
  if (owned === undefined)
    throw new Error("Saved URL record was not produced by the validated inventory.");
  return owned;
}
function assertSavedUrlRecordCurrent(saved) {
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
function readOwnedSidecar(path, subjectUrl) {
  const read = readBoundedSingleLinkFile(path, MAX_SIDECAR_BYTES, "URL metadata sidecar");
  let value;
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
function readUrlMetadataDocument(saved) {
  if (dirname(saved.sidecarPath) !== saved.directory || basename(saved.sidecarPath) !== URL_METADATA_FILENAME) {
    throw new Error("URL metadata sidecar path is not owned by its article directory.");
  }
  assertSavedUrlRecordCurrent(saved);
  const document = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl).document;
  assertSavedUrlRecordCurrent(saved);
  return document;
}
function writeUrlMetadataDocument(saved, document) {
  const parsed = parseUrlMetadataDocument(document);
  if (parsed.subjectUrl !== saved.subjectUrl)
    throw new Error("URL metadata document does not match its saved URL record.");
  if (dirname(saved.sidecarPath) !== saved.directory || basename(saved.sidecarPath) !== URL_METADATA_FILENAME) {
    throw new Error("URL metadata sidecar path is not owned by its article directory.");
  }
  assertSavedUrlRecordCurrent(saved);
  const rendered = renderUrlMetadataDocument(parsed);
  if (utf8Length2(rendered) > MAX_SIDECAR_BYTES)
    throw new Error("URL metadata sidecar exceeds its byte limit.");
  const lockPath = join2(saved.directory, `.${URL_METADATA_FILENAME}.lock`);
  let heldLock = null;
  let temporaryPath = null;
  let temporaryDescriptor = null;
  let temporaryIdentity = null;
  let directoryDescriptor = null;
  let operationError;
  try {
    heldLock = acquireUrlMetadataWriteLock(lockPath);
    temporaryPath = join2(saved.directory, `.${URL_METADATA_FILENAME}.${process.pid}.${heldLock.owner.token}.tmp`);
    assertSavedUrlRecordCurrent(saved);
    let existing = null;
    try {
      existing = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl);
    } catch (error) {
      const cause = error;
      if (cause.code !== "ENOENT")
        throw error;
    }
    if (existing !== null && renderUrlMetadataDocument(existing.document) === rendered) {
      assertSavedUrlRecordCurrent(saved);
      return { changed: false, path: saved.sidecarPath };
    }
    temporaryDescriptor = openSync2(temporaryPath, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW, 384);
    setDescriptorCloseOnExec(temporaryDescriptor);
    temporaryIdentity = validateRegularSingleLink(fstatSync2(temporaryDescriptor, { bigint: true }), temporaryPath, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar");
    const publishedTemporaryIdentity = validateRegularSingleLink(lstatSync2(temporaryPath, { bigint: true }), temporaryPath, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar");
    if (!sameIdentity(temporaryIdentity, publishedTemporaryIdentity)) {
      throw new Error(`URL metadata temporary sidecar identity changed while opening: ${temporaryPath}`);
    }
    writeFileSync(temporaryDescriptor, rendered, "utf8");
    fchmodSync(temporaryDescriptor, 420);
    fsyncSync2(temporaryDescriptor);
    temporaryIdentity = validateRegularSingleLink(fstatSync2(temporaryDescriptor, { bigint: true }), temporaryPath, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar");
    if (!sameIdentity(temporaryIdentity, validateRegularSingleLink(lstatSync2(temporaryPath, { bigint: true }), temporaryPath, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar")))
      throw new Error(`URL metadata temporary sidecar changed while writing: ${temporaryPath}`);
    closeSync2(temporaryDescriptor);
    temporaryDescriptor = null;
    if (existing === null) {
      try {
        lstatSync2(saved.sidecarPath);
        throw new Error(`URL metadata sidecar appeared concurrently: ${saved.sidecarPath}`);
      } catch (error) {
        const cause = error;
        if (cause.code !== "ENOENT")
          throw error;
      }
    } else if (!sameIdentity(existing.identity, fileIdentity(saved.sidecarPath))) {
      throw new Error(`URL metadata sidecar changed concurrently: ${saved.sidecarPath}`);
    }
    directoryDescriptor = openSync2(saved.directory, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    if (!sameDirectoryIdentity(savedUrlRecordIdentity(saved).directory, validateOpenedArticleDirectory(directoryDescriptor, saved.directory))) {
      throw new Error(`Article directory identity changed before metadata install: ${saved.directory}`);
    }
    assertSavedUrlRecordCurrent(saved);
    assertHeldUrlMetadataWriteLockCurrent(heldLock);
    if (!sameIdentity(temporaryIdentity, validateRegularSingleLink(lstatSync2(temporaryPath, { bigint: true }), temporaryPath, MAX_SIDECAR_BYTES, "URL metadata temporary sidecar")))
      throw new Error(`URL metadata temporary sidecar changed before install: ${temporaryPath}`);
    renameSync(temporaryPath, saved.sidecarPath);
    temporaryPath = null;
    temporaryIdentity = null;
    const installed = readOwnedSidecar(saved.sidecarPath, saved.subjectUrl);
    if (renderUrlMetadataDocument(installed.document) !== rendered) {
      throw new Error(`URL metadata sidecar failed post-install verification: ${saved.sidecarPath}`);
    }
    assertHeldUrlMetadataWriteLockCurrent(heldLock);
    fsyncSync2(directoryDescriptor);
    return { changed: true, path: saved.sidecarPath };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    if (directoryDescriptor !== null) {
      try {
        closeSync2(directoryDescriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (temporaryDescriptor !== null) {
      try {
        closeSync2(temporaryDescriptor);
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

// src/clip/url-metadata-backfill.ts
var DEFAULT_MAX_RESULTS = 20;
var DEFAULT_SEARCH_TIMEOUT_MS = 15000;
var DEFAULT_NETWORK_VALIDATION_TIMEOUT_MS = 5000;
var MAX_INTER_REQUEST_DELAY_MS = 60000;
function compareText2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function boundedInteger(value, fallback, minimum, maximum, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}
function resolveOptions(options) {
  if (typeof options.vaultRoot !== "string" || options.vaultRoot.trim() === "") {
    throw new TypeError("The URL metadata backfill vault root must be a non-empty path.");
  }
  return Object.freeze({
    vaultRoot: options.vaultRoot,
    refresh: options.refresh ?? false,
    discoverArchives: options.discoverArchives ?? false,
    interRequestDelayMs: boundedInteger(options.interRequestDelayMs, 0, 0, MAX_INTER_REQUEST_DELAY_MS, "URL metadata backfill inter-request delay"),
    maxResults: boundedInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, 20, "URL metadata backfill result limit"),
    searchTimeoutMs: boundedInteger(options.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 500, 15000, "URL metadata backfill search timeout"),
    networkValidationTimeoutMs: boundedInteger(options.networkValidationTimeoutMs, DEFAULT_NETWORK_VALIDATION_TIMEOUT_MS, 250, 60000, "URL metadata backfill network validation timeout"),
    ...options.signal === undefined ? {} : { signal: options.signal }
  });
}
function abortAwareSleep(milliseconds, signal) {
  if (milliseconds === 0)
    return Promise.resolve();
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new Error("URL metadata backfill aborted.");
  if (signal?.aborted === true)
    return Promise.reject(abortError());
  return new Promise((resolve2, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => finish(abortError());
    function finish(error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error === undefined)
        resolve2();
      else
        reject(error);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function resolveDependencies(dependencies) {
  if (typeof dependencies.searchProvider !== "function") {
    throw new TypeError("URL metadata backfill requires a search provider.");
  }
  return Object.freeze({
    searchProvider: dependencies.searchProvider,
    discoverRecords: dependencies.discoverRecords ?? discoverSavedUrlRecords,
    readMetadata: dependencies.readMetadata ?? readUrlMetadataDocument,
    writeMetadata: dependencies.writeMetadata ?? writeUrlMetadataDocument,
    assertNetworkUrl: dependencies.assertNetworkUrl ?? assertSafeNetworkUrl,
    discoverArchive: dependencies.discoverArchive ?? discoverArchiveTodaySnapshot,
    now: dependencies.now ?? (() => new Date),
    sleep: dependencies.sleep ?? abortAwareSleep
  });
}
function canonicalNow(now) {
  let value;
  try {
    value = now();
  } catch (error) {
    throw new Error("URL metadata backfill could not read its clock.", { cause: error });
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("URL metadata backfill now must return a valid Date.");
  }
  return new Date(value.getTime());
}
function sortedInventory(records) {
  const sorted = [...records].sort((left, right) => compareText2(left.articleId, right.articleId) || compareText2(left.subjectUrl, right.subjectUrl) || compareText2(left.markdownPath, right.markdownPath));
  const sidecars = new Set;
  for (const record2 of sorted) {
    if (sidecars.has(record2.sidecarPath)) {
      throw new Error(`URL metadata inventory repeats a sidecar path: ${record2.sidecarPath}`);
    }
    sidecars.add(record2.sidecarPath);
  }
  return Object.freeze(sorted);
}
function isMissingFile(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isAborted(signal) {
  return signal?.aborted === true;
}
function readExisting(saved, readMetadata) {
  try {
    return readMetadata(saved);
  } catch (error) {
    if (isMissingFile(error))
      return null;
    throw error;
  }
}
function sortedStrings(values) {
  return Object.freeze([...values].sort(compareText2));
}
function addArchive(archives, memento, discovery) {
  const candidate = Object.freeze({
    url: memento.url,
    capturedAt: memento.capturedAt,
    discovery
  });
  const previous = archives.get(memento.timestamp);
  if (previous === undefined || previous.discovery === "metadata-search" && discovery === "newest" || previous.discovery === discovery && compareText2(candidate.url, previous.url) < 0)
    archives.set(memento.timestamp, candidate);
}
function collectSuccessfulSearch(subjectUrl, query, response, now, metadata, resultLimit) {
  if (response.query !== query) {
    metadata.attempts.push(Object.freeze({
      provider: "metadata-search-engine-rs",
      outcome: "failed",
      message: "Metadata search returned a response for a different query."
    }));
    return;
  }
  metadata.enginesQueried = sortedStrings(response.enginesQueried);
  metadata.enginesFailed = sortedStrings(response.enginesFailed);
  const ranked = rankMetadataSearchResults(response.results, { targetUrl: subjectUrl, limit: resultLimit });
  let archiveMatches = 0;
  let discarded = 0;
  for (const result of ranked) {
    if (result.exactTarget) {
      metadata.candidates.push(Object.freeze({
        title: result.title,
        url: result.sourceIdentity,
        snippet: result.snippet,
        engines: sortedStrings(result.engines),
        score: result.score
      }));
      continue;
    }
    try {
      const memento = parseArchiveTodayMementoUrl(result.url, { originalUrl: subjectUrl, now });
      addArchive(metadata.archives, memento, "metadata-search");
      archiveMatches += 1;
    } catch {
      discarded += 1;
    }
  }
  if (discarded > 0) {
    metadata.warnings.push(`Discarded ${discarded} search result${discarded === 1 ? "" : "s"} without an exact source binding.`);
  }
  const unavailable = response.engineStatus === "unavailable" || response.enginesFailed.length === response.enginesQueried.length;
  const partial = !unavailable && (response.engineStatus === "partial" || response.enginesFailed.length > 0);
  const usefulMatches = metadata.candidates.length + archiveMatches;
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: unavailable ? "failed" : partial ? "partial" : usefulMatches > 0 ? "succeeded" : "not-found",
    message: unavailable ? "Metadata search failed because all queried engines were unavailable." : partial ? `Metadata search completed with ${response.enginesFailed.length} failed engine${response.enginesFailed.length === 1 ? "" : "s"}.` : usefulMatches > 0 ? `Metadata search returned ${metadata.candidates.length} exact source match${metadata.candidates.length === 1 ? "" : "es"} and ${archiveMatches} bound archive match${archiveMatches === 1 ? "" : "es"}.` : "Metadata search returned no exact source or bound archive matches."
  }));
}
function addSearchFailure(metadata, category) {
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: "failed",
    message: `Metadata search failed (${category}).`
  }));
}
async function runArchiveDiscovery(saved, now, discoverArchive, metadata) {
  let outcome;
  try {
    outcome = await discoverArchive(saved.subjectUrl, { now: () => new Date(now.getTime()) });
  } catch {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "failed",
      message: "Archive.today discovery failed."
    }));
    return;
  }
  if (outcome.status === "found") {
    try {
      const memento = parseArchiveTodayMementoUrl(outcome.snapshot.url, {
        originalUrl: saved.subjectUrl,
        now
      });
      addArchive(metadata.archives, memento, "newest");
      metadata.attempts.push(Object.freeze({
        provider: "archive-today",
        outcome: "succeeded",
        message: "Archive.today returned a validated newest snapshot."
      }));
    } catch {
      metadata.attempts.push(Object.freeze({
        provider: "archive-today",
        outcome: "failed",
        message: "Archive.today returned an invalid newest snapshot."
      }));
    }
    return;
  }
  if (outcome.status === "not-found") {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "not-found",
      message: "Archive.today has no discoverable snapshot for this source."
    }));
    return;
  }
  if (outcome.status === "throttled") {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "failed",
      message: "Archive.today throttled snapshot discovery."
    }));
    return;
  }
  metadata.attempts.push(Object.freeze({
    provider: "archive-today",
    outcome: "failed",
    message: `Archive.today snapshot discovery was unavailable (${outcome.reason}).`
  }));
}
function newRecordMetadata() {
  return {
    attempts: [],
    candidates: [],
    archives: new Map,
    warnings: [],
    enginesQueried: Object.freeze([]),
    enginesFailed: Object.freeze([])
  };
}
function skipUnsafeProviders(metadata, includeArchive, reason) {
  const explanation = reason === "network" ? "the source failed network-safety validation" : "the source could not form a disclosure-safe exact query";
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: "skipped",
    message: `Metadata search was skipped because ${explanation}.`
  }));
  if (includeArchive) {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "skipped",
      message: `Archive.today discovery was skipped because ${explanation}.`
    }));
  }
  metadata.warnings.push(`No URL was disclosed because ${explanation}.`);
}
function item(saved, action, document) {
  return Object.freeze({
    articleId: saved.articleId,
    subjectUrl: saved.subjectUrl,
    sidecarPath: saved.sidecarPath,
    action,
    status: document.status
  });
}
function report(generatedAt, totalRecords, items, interrupted) {
  const skippedRecords = items.filter(({ action }) => action === "skipped").length;
  const writtenRecords = items.filter(({ action }) => action === "written").length;
  const unchangedRecords = items.filter(({ action }) => action === "unchanged").length;
  const counts = Object.freeze({
    matched: items.filter(({ status }) => status === "matched").length,
    notFound: items.filter(({ status }) => status === "not-found").length,
    partial: items.filter(({ status }) => status === "partial").length,
    unavailable: items.filter(({ status }) => status === "unavailable").length
  });
  return Object.freeze({
    generatedAt,
    totalRecords,
    processedRecords: writtenRecords + unchangedRecords,
    skippedRecords,
    writtenRecords,
    unchangedRecords,
    remainingRecords: totalRecords - items.length,
    aborted: interrupted,
    statusCounts: counts,
    items: Object.freeze([...items])
  });
}
async function backfillSavedUrlMetadata(options, dependencies) {
  const resolvedOptions = resolveOptions(options);
  const resolved = resolveDependencies(dependencies);
  const now = canonicalNow(resolved.now);
  const generatedAt = now.toISOString();
  const records = sortedInventory(resolved.discoverRecords(resolvedOptions.vaultRoot));
  const items = [];
  let interrupted = isAborted(resolvedOptions.signal);
  let outboundRequestStarted = false;
  const waitForRequestSlot = async () => {
    if (isAborted(resolvedOptions.signal))
      return false;
    if (outboundRequestStarted && resolvedOptions.interRequestDelayMs > 0) {
      try {
        await resolved.sleep(resolvedOptions.interRequestDelayMs, resolvedOptions.signal);
      } catch (error) {
        if (isAborted(resolvedOptions.signal))
          return false;
        throw error;
      }
      if (isAborted(resolvedOptions.signal))
        return false;
    }
    outboundRequestStarted = true;
    return true;
  };
  for (const saved of records) {
    if (interrupted || isAborted(resolvedOptions.signal)) {
      interrupted = true;
      break;
    }
    const existing = readExisting(saved, resolved.readMetadata);
    if (existing !== null && !resolvedOptions.refresh) {
      items.push(item(saved, "skipped", existing));
      continue;
    }
    const metadata = newRecordMetadata();
    let safeForDisclosure = true;
    try {
      await resolved.assertNetworkUrl(new URL(saved.subjectUrl), false, resolvedOptions.networkValidationTimeoutMs);
    } catch {
      safeForDisclosure = false;
      skipUnsafeProviders(metadata, resolvedOptions.discoverArchives, "network");
    }
    const query = safeForDisclosure ? createExactUrlSearchQuery(saved.subjectUrl) : null;
    if (safeForDisclosure && query === null) {
      safeForDisclosure = false;
      skipUnsafeProviders(metadata, resolvedOptions.discoverArchives, "query");
    }
    if (safeForDisclosure && query !== null) {
      if (!await waitForRequestSlot()) {
        interrupted = true;
        break;
      }
      try {
        const outcome = await resolved.searchProvider({
          query,
          maxResults: resolvedOptions.maxResults,
          timeoutMs: resolvedOptions.searchTimeoutMs,
          ...resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }
        });
        if (isAborted(resolvedOptions.signal)) {
          interrupted = true;
          break;
        }
        if (outcome.status === "failure")
          addSearchFailure(metadata, outcome.category);
        else
          collectSuccessfulSearch(saved.subjectUrl, query, outcome.response, now, metadata, resolvedOptions.maxResults);
      } catch {
        if (isAborted(resolvedOptions.signal)) {
          interrupted = true;
          break;
        }
        addSearchFailure(metadata, "provider-threw");
      }
      if (resolvedOptions.discoverArchives) {
        if (!await waitForRequestSlot()) {
          interrupted = true;
          break;
        }
        await runArchiveDiscovery(saved, now, resolved.discoverArchive, metadata);
        if (isAborted(resolvedOptions.signal)) {
          interrupted = true;
          break;
        }
      }
    }
    const document = createUrlMetadataDocument({
      subjectUrl: saved.subjectUrl,
      generatedAt,
      enginesQueried: metadata.enginesQueried,
      enginesFailed: metadata.enginesFailed,
      attempts: metadata.attempts,
      candidates: metadata.candidates,
      archives: [...metadata.archives.values()],
      warnings: metadata.warnings
    });
    const write = resolved.writeMetadata(saved, document);
    items.push(item(saved, write.changed ? "written" : "unchanged", document));
  }
  return report(generatedAt, records.length, items, interrupted);
}

export { isolatedMetadataSearchEnvironment, createExactUrlSearchQuery, createRustMetadataSearchProvider, parseUrlMetadataDocument, createUrlMetadataDocument, renderUrlMetadataDocument, discoverSavedUrlRecords, readUrlMetadataDocument, writeUrlMetadataDocument, backfillSavedUrlMetadata };
