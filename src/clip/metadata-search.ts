import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
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
  writeSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  resolveSafeNetworkTarget,
  type ResolvedNetworkAddress,
  type SafeNetworkTargetOptions,
} from "./network.js";
import {
  normalizeSourceUrlIdentity,
  parseMetadataSearchResponse,
  type MetadataSearchResponse,
} from "./url-intelligence.js";
import { sanitizeArtifactUrl } from "./persist.js";

const REQUEST_SCHEMA_VERSION = 1;
const MIN_RESULTS = 1;
const MAX_RESULTS = 20;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 15_000;
const MAX_QUERY_BYTES = 4 * 1024;
const DEFAULT_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_GRACE_MS = 500;
const MAX_PROCESS_GRACE_MS = 2_000;
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_BINARY_BYTES = 256 * 1024 * 1024;
const KILL_GRACE_MS = 100;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_ENGINE_ADDRESSES = 8;
const METADATA_SEARCH_ENGINE_HOSTS = Object.freeze([
  "html.duckduckgo.com",
  "search.brave.com",
  "www.startpage.com",
  "search.yahoo.com",
] as const);

export type MetadataSearchNetworkResolver = (
  url: URL,
  options: SafeNetworkTargetOptions,
) => Promise<readonly ResolvedNetworkAddress[]>;

export type SearchProviderRequest = {
  readonly query: string;
  readonly maxResults?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type SearchProviderErrorCategory =
  | "invalid-request"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "protocol"
  | "process";

export type SearchProviderOutcome =
  | {
      readonly status: "success";
      readonly response: MetadataSearchResponse;
    }
  | {
      readonly status: "failure";
      readonly category: SearchProviderErrorCategory;
      readonly message: string;
    };

/** Provider-neutral search boundary. Expected runtime failures are returned, not thrown. */
export type SearchProvider = (request: SearchProviderRequest) => Promise<SearchProviderOutcome>;

export type RustMetadataSearchProviderOptions = {
  /** Absolute path to the reviewed binary. The file identity is pinned when the provider is created. */
  readonly binaryPath: string;
  readonly defaultMaxResults?: number;
  readonly defaultTimeoutMs?: number;
  readonly processGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxBinaryBytes?: number;
  /** Source environment to sanitize. Defaults to the current process environment. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test and composition seam. Production uses the pinned public-network resolver. */
  readonly resolveNetworkTarget?: MetadataSearchNetworkResolver;
};

type BinaryIdentity = {
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly owner: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
  readonly sha256: string;
};

type ValidatedRequest = {
  readonly query: string;
  readonly maxResults: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

type TerminationReason = "timeout" | "aborted" | "output-limit";

type ProcessResult = {
  readonly stdout: Buffer;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
  readonly termination?: TerminationReason;
};

type OutputCapture = {
  readonly chunks: Buffer[];
  bytes: number;
};

type ResolvedEngineHost = {
  readonly hostname: string;
  readonly addresses: readonly ResolvedNetworkAddress[];
};

function failure(category: SearchProviderErrorCategory, message: string): SearchProviderOutcome {
  return Object.freeze({ status: "failure", category, message });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function checkedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return resolved;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasUnsafeQueryCodeUnits(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateRequest(
  request: SearchProviderRequest,
  defaults: { readonly maxResults: number; readonly timeoutMs: number },
): ValidatedRequest | null {
  if (
    typeof request.query !== "string"
    || request.query.trim() === ""
    || utf8Length(request.query.trim()) > MAX_QUERY_BYTES
    || hasUnsafeQueryCodeUnits(request.query)
  ) return null;
  const maxResults = request.maxResults ?? defaults.maxResults;
  const timeoutMs = request.timeoutMs ?? defaults.timeoutMs;
  if (
    !Number.isSafeInteger(maxResults)
    || maxResults < MIN_RESULTS
    || maxResults > MAX_RESULTS
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS
  ) return null;
  return Object.freeze({
    query: request.query.trim(),
    maxResults,
    timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function sameOpenedIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function inspectBinary(binaryPath: string, maxBytes: number): BinaryIdentity {
  const pathMetadata = lstatSync(binaryPath, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1n) {
    throw new Error("The metadata search binary does not have a trusted file identity.");
  }
  const ownerExecutable = (pathMetadata.mode & 0o100n) !== 0n;
  const writableByAnotherUser = (pathMetadata.mode & 0o022n) !== 0n;
  const privilegedExecutable = (pathMetadata.mode & 0o6000n) !== 0n;
  const processOwner = typeof process.getuid === "function" ? BigInt(process.getuid()) : pathMetadata.uid;
  if (
    !ownerExecutable
    || writableByAnotherUser
    || privilegedExecutable
    || pathMetadata.uid !== processOwner
    || pathMetadata.size <= 0n
    || pathMetadata.size > BigInt(maxBytes)
  ) throw new Error("The metadata search binary does not satisfy the executable policy.");

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
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("The metadata search binary exceeds its byte limit.");
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
      sha256: hash.digest("hex"),
    });
  } finally {
    closeSync(descriptor);
  }
}

function identitiesEqual(left: BinaryIdentity, right: BinaryIdentity): boolean {
  return left.realPath === right.realPath
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.owner === right.owner
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds
    && left.sha256 === right.sha256;
}

function openedIdentityMatches(opened: BigIntStats, expected: BinaryIdentity): boolean {
  return opened.dev === expected.device
    && opened.ino === expected.inode
    && opened.size === expected.size
    && opened.mode === expected.mode
    && opened.uid === expected.owner
    && opened.mtimeNs === expected.modifiedNanoseconds
    && opened.ctimeNs === expected.changedNanoseconds
    && opened.nlink === 1n
    && opened.isFile();
}

/**
 * Copy reviewed bytes through an already-open descriptor into the private run
 * directory. The task executes this copy, closing the path-replacement window
 * between the final identity check and `spawn`.
 */
function materializePinnedBinary(expected: BinaryIdentity, runDirectory: string): string {
  const source = openSync(expected.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destinationPath = join(runDirectory, "metadata-search");
  let destination: number | null = null;
  try {
    if (!openedIdentityMatches(fstatSync(source, { bigint: true }), expected)) {
      throw new Error("metadata search binary identity changed");
    }
    destination = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    const expectedBytes = Number(expected.size);
    while (offset < expectedBytes) {
      const bytesRead = readSync(source, buffer, 0, Math.min(buffer.byteLength, expectedBytes - offset), offset);
      if (bytesRead === 0) throw new Error("metadata search binary ended early");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(destination, buffer, written, bytesRead - written, offset + written);
      }
      offset += bytesRead;
    }
    if (
      hash.digest("hex") !== expected.sha256
      || !openedIdentityMatches(fstatSync(source, { bigint: true }), expected)
    ) throw new Error("metadata search binary identity changed");
    fsyncSync(destination);
    return destinationPath;
  } finally {
    if (destination !== null) closeSync(destination);
    closeSync(source);
  }
}

function createPrivateRunDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hraness-kb-metadata-search-"));
  chmodSync(directory, 0o700);
  for (const name of ["home", "config", "cache", "data", "tmp"]) {
    mkdirSync(join(directory, name), { mode: 0o700 });
  }
  return directory;
}

/** Construct a minimal subprocess environment without ambient proxy, auth, provider, or startup state. */
export function isolatedMetadataSearchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  runDirectory: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
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

function appendBounded(
  capture: OutputCapture,
  chunk: Buffer | string,
  maximumBytes: number,
  onExceeded: () => void,
  retain: boolean,
): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (capture.bytes > maximumBytes) return;
  capture.bytes += bytes.byteLength;
  if (capture.bytes > maximumBytes) {
    capture.chunks.length = 0;
    onExceeded();
    return;
  }
  if (retain) capture.chunks.push(bytes);
}

async function runProcess(options: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}): Promise<ProcessResult> {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed: Promise<ProcessResult> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  let termination: TerminationReason | undefined;
  let onAbort: (() => void) | null = null;
  try {
    child = spawn(options.binaryPath, [], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const runningChild = child;
    const stdout: OutputCapture = { chunks: [], bytes: 0 };
    const stderr: OutputCapture = { chunks: [], bytes: 0 };
    let spawnFailed = false;
    const terminate = (reason: TerminationReason): void => {
      if (termination !== undefined) return;
      termination = reason;
      runningChild.kill("SIGTERM");
      forceKill = setTimeout(() => runningChild.kill("SIGKILL"), KILL_GRACE_MS);
    };
    runningChild.stdout.on("data", (chunk: Buffer) => {
      appendBounded(stdout, chunk, options.maxStdoutBytes, () => terminate("output-limit"), true);
    });
    runningChild.stderr.on("data", (chunk: Buffer) => {
      appendBounded(stderr, chunk, options.maxStderrBytes, () => terminate("output-limit"), false);
    });
    runningChild.stdin.on("error", () => {
      // The close event supplies the categorical process outcome.
    });
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
          ...(termination === undefined ? {} : { termination }),
        }));
      });
    });
    timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    if (options.signal !== undefined) {
      onAbort = () => terminate("aborted");
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) terminate("aborted");
    }
    runningChild.stdin.end(options.stdin, "utf8");
    return await closed;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    if (forceKill !== null) clearTimeout(forceKill);
    if (onAbort !== null && options.signal !== undefined) {
      options.signal.removeEventListener("abort", onAbort);
    }
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (closed !== null) await closed;
  }
}

function deterministicResponse(response: MetadataSearchResponse, maximumResults: number): MetadataSearchResponse {
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const enginesQueried = Object.freeze([...response.enginesQueried].sort());
  const results = response.results
    .map((result) => Object.freeze({ ...result, engines: Object.freeze([...result.engines].sort()) }))
    .sort((left, right) => right.score - left.score || compareText(left.title, right.title) || compareText(left.url, right.url))
    .slice(0, maximumResults);
  return Object.freeze({
    ...response,
    results: Object.freeze(results),
    enginesQueried,
    enginesFailed: Object.freeze([...response.enginesFailed].sort()),
    engineStatus: response.engineStatus,
  });
}

async function resolveEngineHosts(
  resolver: MetadataSearchNetworkResolver,
  timeoutMs: number,
): Promise<readonly ResolvedEngineHost[]> {
  const resolved = await Promise.all(METADATA_SEARCH_ENGINE_HOSTS.map(async (hostname) => {
    const addresses = await resolver(new URL(`https://${hostname}/`), {
      allowPrivateNetwork: false,
      timeoutMs,
    });
    if (addresses.length === 0 || addresses.length > MAX_ENGINE_ADDRESSES) {
      throw new Error("metadata search engine DNS answer count is invalid");
    }
    const unique = new Map<string, ResolvedNetworkAddress>();
    for (const address of addresses) {
      if (
        (address.family !== 4 && address.family !== 6)
        || typeof address.address !== "string"
        || address.address.trim() !== address.address
        || address.address === ""
      ) throw new Error("metadata search engine DNS answer is invalid");
      unique.set(`${address.family}:${address.address}`, Object.freeze({ ...address }));
    }
    if (unique.size !== addresses.length) throw new Error("metadata search engine DNS answer is duplicated");
    return Object.freeze({
      hostname,
      addresses: Object.freeze([...unique.values()].sort((left, right) =>
        left.family - right.family || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0))),
    });
  }));
  return Object.freeze(resolved);
}

/**
 * Form an exact-match query after dropping the non-request fragment. Safe identity-bearing
 * query parameters are preserved; credential-shaped URL data causes a closed rejection.
 */
export function createExactUrlSearchQuery(value: string | URL): string | null {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || normalizeSourceUrlIdentity(url) === null) {
    return null;
  }
  url.hash = "";
  const exactUrl = url.href;
  let sanitized: string;
  try {
    sanitized = sanitizeArtifactUrl(exactUrl);
  } catch {
    return null;
  }
  if (sanitized !== exactUrl || utf8Length(exactUrl) > MAX_QUERY_BYTES - 2) return null;
  return `"${exactUrl}"`;
}

/** Create the isolated adapter for the reviewed Rust metadata-search helper. */
export function createRustMetadataSearchProvider(options: RustMetadataSearchProviderOptions): SearchProvider {
  if (!isAbsolute(options.binaryPath)) {
    throw new TypeError("The metadata search binary path must be absolute.");
  }
  const defaultMaxResults = checkedInteger(
    options.defaultMaxResults,
    DEFAULT_RESULTS,
    MIN_RESULTS,
    MAX_RESULTS,
    "defaultMaxResults",
  );
  const defaultTimeoutMs = checkedInteger(
    options.defaultTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  const processGraceMs = checkedInteger(
    options.processGraceMs,
    DEFAULT_PROCESS_GRACE_MS,
    0,
    MAX_PROCESS_GRACE_MS,
    "processGraceMs",
  );
  const maxStdoutBytes = checkedInteger(
    options.maxStdoutBytes,
    DEFAULT_MAX_STDOUT_BYTES,
    1,
    16 * 1024 * 1024,
    "maxStdoutBytes",
  );
  const maxStderrBytes = checkedInteger(
    options.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
    1,
    2 * 1024 * 1024,
    "maxStderrBytes",
  );
  const maxBinaryBytes = checkedInteger(
    options.maxBinaryBytes,
    DEFAULT_MAX_BINARY_BYTES,
    1,
    MAX_CONFIGURED_BINARY_BYTES,
    "maxBinaryBytes",
  );
  let pinnedIdentity: BinaryIdentity;
  try {
    pinnedIdentity = inspectBinary(options.binaryPath, maxBinaryBytes);
  } catch {
    throw new Error("The metadata search binary is unavailable or untrusted.");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const resolveNetworkTarget = options.resolveNetworkTarget ?? resolveSafeNetworkTarget;

  return async (request) => {
    const validated = validateRequest(request, { maxResults: defaultMaxResults, timeoutMs: defaultTimeoutMs });
    if (validated === null) return failure("invalid-request", "The metadata search request is invalid.");
    if (signalAborted(validated.signal)) return failure("aborted", "Metadata search was aborted.");

    let engineHosts: readonly ResolvedEngineHost[];
    try {
      engineHosts = await resolveEngineHosts(resolveNetworkTarget, validated.timeoutMs);
    } catch {
      return failure("unavailable", "Metadata search network targets are unavailable.");
    }
    if (signalAborted(validated.signal)) return failure("aborted", "Metadata search was aborted.");

    let currentIdentity: BinaryIdentity;
    try {
      currentIdentity = inspectBinary(options.binaryPath, maxBinaryBytes);
    } catch {
      return failure("unavailable", "Metadata search is unavailable.");
    }
    if (!identitiesEqual(pinnedIdentity, currentIdentity)) {
      return failure("unavailable", "Metadata search is unavailable.");
    }

    let runDirectory: string;
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
        engine_hosts: engineHosts,
      });
      let result: ProcessResult;
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
          ...(validated.signal === undefined ? {} : { signal: validated.signal }),
        });
      } catch {
        return failure("process", "Metadata search process failed.");
      }
      if (result.termination === "aborted") return failure("aborted", "Metadata search was aborted.");
      if (result.termination === "timeout") return failure("timeout", "Metadata search timed out.");
      if (result.termination === "output-limit") {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
      if (result.spawnFailed) return failure("unavailable", "Metadata search is unavailable.");
      if (result.exitCode !== 0 || result.signal !== null) {
        return failure("process", "Metadata search process failed.");
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      } catch {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
      try {
        const parsed = parseMetadataSearchResponse(JSON.parse(decoded) as unknown);
        if (parsed.query !== validated.query) {
          return failure("protocol", "Metadata search returned an invalid response.");
        }
        return Object.freeze({
          status: "success",
          response: deterministicResponse(parsed, validated.maxResults),
        });
      } catch {
        return failure("protocol", "Metadata search returned an invalid response.");
      }
    } finally {
      rmSync(runDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  };
}
