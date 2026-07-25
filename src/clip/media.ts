import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import { getCookies, type GetCookiesOptions } from "@steipete/sweet-cookie";

import { BoundedByteBuffer } from "./bounded-byte-buffer.js";
import { sniffImage } from "./assets.js";
import {
  filterCookieProviderResult,
  MAX_COOKIE_BYTES,
  readCookieFile,
  renderNetscapeCookieJar,
} from "./cookies.js";
import { startNetworkProxy, type LocalNetworkProxy } from "./network-proxy.js";

export type MediaCookieBrowser = "chrome" | "arc" | "brave" | "chromium" | "edge" | "firefox" | "safari";

export type MediaCaptureStatus = "captured" | "unavailable" | "unsupported" | "failed";

export type MediaMetadata = {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly uploader?: string;
  readonly uploaderId?: string;
  readonly channel?: string;
  readonly channelId?: string;
  readonly webpageUrl?: string;
  readonly extractor?: string;
  readonly durationSeconds?: number;
  readonly timestamp?: number;
};

export type MediaRecord = {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type MediaCaptureResult = {
  readonly status: MediaCaptureStatus;
  readonly records: readonly MediaRecord[];
  readonly metadata: MediaMetadata | null;
  readonly warnings: readonly string[];
};

export type VideoContextCaptureStatus = MediaCaptureStatus | "partial";

export type VideoTranscript = {
  readonly language: string;
  readonly markdown: string;
  readonly cueCount: number;
  readonly truncated: boolean;
};

export type VideoContextCaptureResult = {
  readonly status: VideoContextCaptureStatus;
  readonly thumbnail: MediaRecord | null;
  readonly transcript: VideoTranscript | null;
  readonly metadata: MediaMetadata | null;
  readonly warnings: readonly string[];
};

export type MediaCommand = {
  readonly command: readonly string[];
  /** Private process input; secret-bearing media URLs must never be placed in argv. */
  readonly stdin?: string;
  /** Dedicated working directory that confines relative yt-dlp outputs. */
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly monitoredDirectory: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
};

export type MediaCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type MediaCommandRunner = (specification: MediaCommand) => Promise<MediaCommandResult>;

export type BrowserMediaCookieRequest = {
  readonly url: URL;
  readonly source: MediaCookieBrowser;
  readonly profile?: string;
  readonly timeoutMs: number;
};

export type FileMediaCookieRequest = {
  readonly url: URL;
  readonly source: "file";
  readonly file: string;
  readonly timeoutMs: number;
};

export type MediaCookieRequest = BrowserMediaCookieRequest | FileMediaCookieRequest;

/** Foreign cookie-provider results are deliberately parsed from unknown. */
export type MediaCookieProvider = (request: MediaCookieRequest) => Promise<unknown>;
export type SweetCookieReader = (options: GetCookiesOptions) => Promise<unknown>;

export type CaptureMediaOptions = {
  readonly url: URL;
  /** Dedicated media destination. The command itself writes into a private child staging directory. */
  readonly outputDirectory: string;
  /** Prefix stored in manifest paths, for example `assets/media`. */
  readonly relativePrefix?: string;
  readonly timeoutMs: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly allowPrivateNetwork?: boolean;
  readonly maxFiles?: number;
  readonly maxOutputBytes?: number;
  readonly executable?: string;
  readonly userAgent?: string;
  /** Set only in response to an explicit user cookie-source choice. */
  readonly cookieBrowser?: {
    readonly source: MediaCookieBrowser;
    readonly profile?: string;
  };
  /** Set only in response to an explicit user cookie-file choice. */
  readonly cookiesFile?: string;
  readonly exists?: (path: string) => boolean;
  readonly which?: (executable: string) => string | null;
  readonly homeDirectory?: string;
  readonly run?: MediaCommandRunner;
  readonly cookieProvider?: MediaCookieProvider;
  /** Test seam. Production callers leave this unset. */
  readonly startProxy?: typeof startNetworkProxy;
};

export type CaptureVideoContextOptions = CaptureMediaOptions & {
  /** One exact yt-dlp subtitle language identifier, such as `en` or `en-US`. */
  readonly transcriptLanguage?: string;
  /** Explicit Node.js runtime for yt-dlp's JavaScript challenge support; null disables discovery. */
  readonly nodeExecutable?: string | null;
  /** Test seam used to validate a discovered Node.js runtime. */
  readonly readNodeVersion?: (path: string) => string | null;
};

export type ParsedWebVtt = {
  readonly markdown: string;
  readonly cueCount: number;
  readonly truncated: boolean;
};

export type ParseWebVttOptions = {
  readonly maxInputBytes?: number;
  readonly maxCues?: number;
  readonly maxOutputBytes?: number;
};

type JsonRecord = Readonly<Record<string, unknown>>;

const metadataPrefix = "CLIP_MEDIA_JSON\t";
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let result = "";
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

/** Validate common audio/video containers by signature before promoting them into the clip. */
export function sniffMediaMimeType(bytes: Uint8Array, extension: string): string | null {
  const normalized = extension.toLowerCase();
  if (ascii(bytes, 4, 4) === "ftyp") {
    if (normalized === ".mov") return "video/quicktime";
    if (normalized === ".m4a") return "audio/mp4";
    if (normalized === ".mp4") return "video/mp4";
    if (normalized === ".m4v") return "video/x-m4v";
    return null;
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (normalized === ".webm") return "video/webm";
    if (normalized === ".mkv") return "video/x-matroska";
    return null;
  }
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return normalized === ".mp3" ? "audio/mpeg" : null;
  }
  if (ascii(bytes, 0, 4) === "OggS") {
    if (normalized === ".opus") return "audio/opus";
    if (normalized === ".ogg") return "audio/ogg";
    return null;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return normalized === ".wav" ? "audio/wav" : null;
  }
  if (ascii(bytes, 0, 4) === "fLaC") return normalized === ".flac" ? "audio/flac" : null;
  if (bytes[0] === 0xff && (((bytes[1] ?? 0) & 0xf6) === 0xf0)) {
    return normalized === ".aac" ? "audio/aac" : null;
  }
  return null;
}

async function readBoundedStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const iterable: AsyncIterable<unknown> = stream;
  const bytes = new BoundedByteBuffer(maxBytes);
  for await (const value of iterable) {
    let chunk: Buffer;
    if (Buffer.isBuffer(value)) chunk = value;
    else if (typeof value === "string") chunk = Buffer.from(value);
    else if (value instanceof Uint8Array) chunk = Buffer.from(value);
    else throw new Error("media command returned an unsupported output chunk");
    if (!bytes.append(chunk)) throw new Error(`media command output exceeded ${maxBytes} bytes`);
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}

function inspectMonitoredDirectory(
  directory: string,
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
): string | null {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return `could not inspect media staging directory: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (entries.length > maxFiles) return `media capture created more than ${maxFiles} files`;
  let totalBytes = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      // yt-dlp and ffmpeg atomically rename temporary fragments while this monitor runs.
      continue;
    }
    if (!entry.isFile() || stats.isSymbolicLink()) return "media capture created an unexpected non-file output";
    if (stats.size > maxFileBytes) return `media capture created a file larger than ${maxFileBytes} bytes`;
    totalBytes += stats.size;
    if (totalBytes > maxTotalBytes) return `media capture exceeded the ${maxTotalBytes}-byte total limit`;
  }
  return null;
}

/** Run yt-dlp with wall-clock, process-output, file-count, per-file, and total-byte limits. */
export const runMediaCommand: MediaCommandRunner = async (specification) => {
  const executable = specification.command[0];
  if (executable === undefined) throw new Error("media command is empty");
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(executable, specification.command.slice(1), {
    ...(specification.cwd === undefined ? {} : { cwd: specification.cwd }),
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.once("error", () => {
    // A child that exits before reading its private input is handled by its exit status.
  });
  child.stdin.end(specification.stdin ?? "");
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  const signalProcessTree = (signal: NodeJS.Signals): void => {
    if (useProcessGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may have exited before group signaling; fall back to the direct child handle.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Killing an already-exited fallback process is harmless.
    }
  };
  let failure: string | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const requestStop = (reason: string): void => {
    if (failure === null) failure = reason;
    if (forceKillTimer !== null) return;
    signalProcessTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree("SIGKILL"), 1_000);
  };
  const timeout = setTimeout(() => {
    requestStop(`media command timed out after ${specification.timeoutMs}ms`);
  }, specification.timeoutMs);
  const monitor = setInterval(() => {
    const violation = inspectMonitoredDirectory(
      specification.monitoredDirectory,
      specification.maxFiles,
      specification.maxFileBytes,
      specification.maxTotalBytes,
    );
    if (violation !== null) requestStop(violation);
  }, 100);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, specification.maxOutputBytes),
      readBoundedStream(child.stderr, specification.maxOutputBytes),
      exited,
    ]);
    const finalViolation = inspectMonitoredDirectory(
      specification.monitoredDirectory,
      specification.maxFiles,
      specification.maxFileBytes,
      specification.maxTotalBytes,
    );
    if (failure !== null) throw new Error(failure);
    if (finalViolation !== null) throw new Error(finalViolation);
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (failure === null) requestStop(error instanceof Error ? error.message : "media command failed");
    await exited.catch(() => 1);
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  }
};

export function discoverYtDlp(options: {
  readonly homeDirectory?: string;
  readonly exists?: (path: string) => boolean;
  readonly which?: (executable: string) => string | null;
} = {}): string | null {
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const fromPath = which("yt-dlp");
  if (fromPath !== null && exists(fromPath)) return fromPath;
  const homeDirectory = options.homeDirectory ?? homedir();
  return [
    join(homeDirectory, ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
  ].find((path) => exists(path)) ?? null;
}

function readInstalledNodeVersion(executable: string): string | null {
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 4_096,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function supportsYtDlpNodeRuntime(version: string | null): boolean {
  if (version === null) return false;
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  if (match?.[1] === undefined) return false;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 22;
}

/** Discover a Node.js >=22 runtime that yt-dlp can use for supported JavaScript challenges. */
export function discoverNodeRuntime(options: {
  readonly homeDirectory?: string;
  readonly exists?: (path: string) => boolean;
  readonly which?: (executable: string) => string | null;
  readonly readVersion?: (path: string) => string | null;
} = {}): string | null {
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const readVersion = options.readVersion ?? readInstalledNodeVersion;
  const homeDirectory = options.homeDirectory ?? homedir();
  const candidates = [
    which("node"),
    join(homeDirectory, ".local", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    if (exists(candidate) && supportsYtDlpNodeRuntime(readVersion(candidate))) return candidate;
  }
  return null;
}

function cleanString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\0/g, "").trim();
  if (cleaned === "" || cleaned.length > maximumLength) return undefined;
  return cleaned;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeWebUrl(value: unknown): string | undefined {
  const candidate = cleanString(value, 8_192);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/** Parse only the explicitly printed metadata allowlist; format URLs and cookie material are never accepted. */
export function parseMediaMetadata(stdout: string): MediaMetadata | null {
  const scanStart = Math.max(0, stdout.length - 2 * 1024 * 1024);
  let lineEnd = stdout.length;
  while (lineEnd >= scanStart) {
    const newline = stdout.lastIndexOf("\n", lineEnd - 1);
    const lineStart = Math.max(scanStart, newline + 1);
    const rawLine = stdout.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    lineEnd = newline < scanStart ? scanStart - 1 : newline;
    if (!line.startsWith(metadataPrefix)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(metadataPrefix.length));
      if (!isRecord(parsed)) continue;
      const id = cleanString(parsed.id, 512);
      const title = cleanString(parsed.title, 8_192);
      const description = cleanString(parsed.description, 500_000);
      const uploader = cleanString(parsed.uploader, 8_192);
      const uploaderId = cleanString(parsed.uploader_id, 8_192);
      const channel = cleanString(parsed.channel, 8_192);
      const channelId = cleanString(parsed.channel_id, 8_192);
      const webpageUrl = safeWebUrl(parsed.webpage_url);
      const extractor = cleanString(parsed.extractor, 1_024);
      const durationSeconds = finiteNonNegative(parsed.duration);
      const timestamp = finiteNonNegative(parsed.timestamp);
      return {
        ...(id === undefined ? {} : { id }),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(uploader === undefined ? {} : { uploader }),
        ...(uploaderId === undefined ? {} : { uploaderId }),
        ...(channel === undefined ? {} : { channel }),
        ...(channelId === undefined ? {} : { channelId }),
        ...(webpageUrl === undefined ? {} : { webpageUrl }),
        ...(extractor === undefined ? {} : { extractor }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    } catch {
      // Ignore malformed or truncated diagnostic lines.
    }
  }
  return null;
}

function validProfile(profile: string | undefined): boolean {
  return profile === undefined || (profile.trim() !== "" && profile.length <= 4_096 && !/\p{Cc}/u.test(profile));
}

export function buildMediaCookieOptions(request: BrowserMediaCookieRequest): GetCookiesOptions {
  const common = {
    url: request.url.href,
    timeoutMs: request.timeoutMs,
    mode: "first",
    debug: false,
  } as const;
  const profile = request.profile?.trim();
  if (request.source === "edge") {
    return {
      ...common,
      browsers: ["edge"],
      edgeProfile: profile ?? "",
    };
  }
  if (request.source === "firefox") {
    return {
      ...common,
      browsers: ["firefox"],
      firefoxProfile: profile ?? "",
    };
  }
  if (request.source === "safari") {
    return {
      ...common,
      browsers: ["safari"],
      ...(profile === undefined ? {} : { safariCookiesFile: profile }),
    };
  }
  return {
    ...common,
    browsers: ["chrome"],
    chromiumBrowser: request.source,
    chromeProfile: profile ?? "",
  };
}

type CookieJarResult =
  | { readonly ok: true; readonly path: string; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly warning: string };

/** Build an injectable provider. Explicit files bypass Sweet Cookie and can never probe browser stores. */
export function createMediaCookieProvider(reader: SweetCookieReader): MediaCookieProvider {
  return (request) => {
    if (request.source !== "file") return reader(buildMediaCookieOptions(request));
    const parsed = readCookieFile(request.file, request.url);
    return Promise.resolve(parsed.ok
      ? {
          cookies: parsed.cookies,
          warnings: parsed.rejected === 0
            ? []
            : [`Ignored ${parsed.rejected} malformed, expired, or out-of-scope cookie record(s).`],
        }
      : { cookies: [], warnings: [] });
  };
}

/** Resolve only cookies matching the requested URL through Sweet Cookie's selected local source. */
export const readMediaCookies = createMediaCookieProvider((options) => getCookies(options));

async function prepareCookieJar(
  request: MediaCookieRequest,
  directory: string,
  provider: MediaCookieProvider,
): Promise<CookieJarResult> {
  let provided: unknown;
  try {
    provided = await provider(request);
  } catch {
    return { ok: false, warning: "Could not read cookies from the explicitly selected browser." };
  }
  const filtered = filterCookieProviderResult(provided, request.url);
  if (!filtered.validShape) {
    return { ok: false, warning: "The selected browser cookie provider returned malformed data." };
  }
  if (filtered.cookies.length === 0) {
    return {
      ok: false,
      warning: filtered.rejected === 0
        ? "No origin-scoped cookies were found in the explicitly selected browser."
        : `No usable origin-scoped cookies were found; rejected ${filtered.rejected} malformed, expired, or out-of-scope record(s).`,
    };
  }

  const body = renderNetscapeCookieJar(filtered.cookies, request.url);
  if (Buffer.byteLength(body, "utf8") > MAX_COOKIE_BYTES) {
    return { ok: false, warning: "Origin-scoped browser cookies exceeded the private jar size limit." };
  }
  const path = join(directory, "cookies.txt");
  try {
    writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    return { ok: false, warning: "Could not create the private temporary cookie jar." };
  }
  const warnings: string[] = [];
  if (filtered.rejected > 0) {
    warnings.push(`Ignored ${filtered.rejected} malformed, expired, or out-of-scope browser cookie record(s).`);
  }
  if (filtered.providerWarningCount > 0) {
    warnings.push(`The browser cookie provider reported ${filtered.providerWarningCount} non-fatal warning(s).`);
  }
  return { ok: true, path, warnings };
}

function metadataTemplate(): string {
  return `${metadataPrefix}{"id":%(id)j,"title":%(title)j,"description":%(description)j,` +
    `"uploader":%(uploader)j,"uploader_id":%(uploader_id)j,"webpage_url":%(webpage_url)j,` +
    `"channel":%(channel)j,"channel_id":%(channel_id)j,"extractor":%(extractor)j,` +
    `"duration":%(duration)j,"timestamp":%(timestamp)j}`;
}

function commandArguments(
  executable: string,
  options: CaptureMediaOptions,
  cookieFile: string | undefined,
  proxyUrl: string,
): readonly string[] {
  const arguments_: string[] = [
    executable,
    "--ignore-config",
    "--no-playlist",
    "--max-downloads",
    "1",
    "--max-filesize",
    String(options.maxFileBytes),
    "--restrict-filenames",
    "--no-overwrites",
    "--no-progress",
    "--newline",
    "--no-colors",
    "--socket-timeout",
    String(Math.max(1, Math.ceil(options.timeoutMs / 1_000))),
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--proxy",
    proxyUrl,
    "--batch-file",
    "-",
    "--downloader",
    "native",
    "--output",
    "media-%(id).80B.%(ext)s",
    "--print",
    `after_move:${metadataTemplate()}`,
  ];
  if (options.userAgent !== undefined) arguments_.push("--user-agent", options.userAgent);
  if (cookieFile !== undefined) arguments_.push("--cookies", cookieFile);
  return arguments_;
}

function videoContextCommandArguments(
  executable: string,
  options: CaptureVideoContextOptions,
  language: string,
  cookieFile: string | undefined,
  proxyUrl: string,
  nodeRuntime: string | null,
): readonly string[] {
  const arguments_: string[] = [
    executable,
    "--ignore-config",
    "--no-playlist",
    "--max-downloads",
    "1",
    "--max-filesize",
    String(options.maxFileBytes),
    "--restrict-filenames",
    "--no-overwrites",
    "--no-progress",
    "--newline",
    "--no-colors",
    "--socket-timeout",
    String(Math.max(1, Math.ceil(options.timeoutMs / 1_000))),
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--proxy",
    proxyUrl,
    "--batch-file",
    "-",
    "--skip-download",
    "--no-simulate",
    "--ignore-no-formats-error",
    "--write-thumbnail",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    language,
    "--sub-format",
    "vtt",
    "--output",
    "unused-%(id).80B.%(ext)s",
    "--output",
    "thumbnail:thumbnail-%(id).80B.%(ext)s",
    "--output",
    "subtitle:transcript-%(id).80B.%(language).16B.%(ext)s",
    "--print",
    metadataTemplate(),
  ];
  if (nodeRuntime !== null) arguments_.push("--js-runtimes", `node:${nodeRuntime}`);
  if (options.userAgent !== undefined) arguments_.push("--user-agent", options.userAgent);
  if (cookieFile !== undefined) arguments_.push("--cookies", cookieFile);
  return arguments_;
}

function privateMediaUrlInput(url: URL): string {
  const value = url.href;
  if (/[\0\r\n]/.test(value)) throw new Error("media URL contains an invalid batch-file control character");
  return `${value}\n`;
}

function errorClassification(stderr: string): { readonly status: MediaCaptureStatus; readonly warning: string } {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("unsupported url") || normalized.includes("no suitable extractor")) {
    return { status: "unsupported", warning: "yt-dlp does not support media capture for this URL." };
  }
  if (normalized.includes("drm")) {
    return { status: "unsupported", warning: "The media is DRM-protected; clip does not bypass DRM or access controls." };
  }
  if (normalized.includes("login") || normalized.includes("sign in") || normalized.includes("cookies")) {
    return { status: "failed", warning: "The site requires an authorized session; explicitly select a cookie source or cookie file." };
  }
  if (normalized.includes("requested format is not available") || normalized.includes("no video formats found")) {
    return { status: "unsupported", warning: "No downloadable, non-DRM media format was exposed for this page." };
  }
  return { status: "failed", warning: "yt-dlp could not capture media for this page; page text and images can still be clipped." };
}

function safeRunnerFailure(message: string): string {
  const safePatterns = [
    /^media command timed out after \d+ms$/,
    /^media command output exceeded \d+ bytes$/,
    /^media capture created more than \d+ files$/,
    /^media capture created a file larger than \d+ bytes$/,
    /^media capture exceeded the \d+-byte total limit$/,
  ];
  return safePatterns.some((pattern) => pattern.test(message))
    ? message
    : "yt-dlp media capture failed; page text and images can still be clipped.";
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1
    ? fallback
    : Math.min(value, maximum);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\ufffd$/u, "");
}

function decodeVttEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi, (_match, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal === undefined ? 10 : 16);
      return Number.isSafeInteger(codePoint)
        && codePoint > 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function cleanVttCue(value: string): string {
  return decodeVttEntities(value.replace(/<[^>\n]{0,512}>/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16_384);
}

function escapeTranscriptMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_~[\]])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function vttTimestamp(value: string): number | null {
  const timestamp = value.trim().split(/\s+/u)[0];
  if (timestamp === undefined) return null;
  const clock = timestamp.replace(",", ".").split(".");
  if (clock.length !== 2 || clock[1] === undefined || !/^\d{3}$/.test(clock[1])) return null;
  const pieces = clock[0]?.split(":") ?? [];
  if (pieces.length !== 2 && pieces.length !== 3) return null;
  if (pieces.some((piece) => !/^\d{2}$/.test(piece))) return null;
  const seconds = Number(pieces.at(-1));
  const minutes = Number(pieces.at(-2));
  const hours = pieces.length === 3 ? Number(pieces[0]) : 0;
  if (
    !Number.isSafeInteger(hours)
    || !Number.isSafeInteger(minutes)
    || !Number.isSafeInteger(seconds)
    || minutes > 59
    || seconds > 59
  ) return null;
  return hours * 3_600 + minutes * 60 + seconds;
}

function formatTranscriptTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function rollingCaptionDelta(previous: string | null, current: string): string | null {
  if (previous === null) return current;
  if (previous === current || previous.includes(current)) return null;
  const previousWords = previous.split(" ");
  const currentWords = current.split(" ");
  const maximumOverlap = Math.min(previousWords.length, currentWords.length, 256);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previousWords[previousWords.length - overlap + index] !== currentWords[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const delta = currentWords.slice(overlap).join(" ").trim();
      return delta === "" ? null : delta;
    }
  }
  return current;
}

/** Parse bounded WebVTT into timestamped Markdown while removing rolling-caption overlap. */
export function parseWebVtt(input: string, options: ParseWebVttOptions = {}): ParsedWebVtt {
  const maxInputBytes = positiveBound(options.maxInputBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const maxCues = positiveBound(options.maxCues, 20_000, 100_000);
  const maxOutputBytes = positiveBound(options.maxOutputBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const inputWasTruncated = Buffer.byteLength(input) > maxInputBytes;
  const boundedInput = inputWasTruncated ? utf8Prefix(input, maxInputBytes) : input;
  const lines = boundedInput.replace(/\r\n?/g, "\n").split("\n");
  const markdown: string[] = [];
  let outputBytes = 0;
  let previousCue: string | null = null;
  let truncated = inputWasTruncated;

  for (let index = 0; index < lines.length;) {
    const timing = lines[index] ?? "";
    const arrow = timing.indexOf("-->");
    if (arrow < 0) {
      index += 1;
      continue;
    }
    const seconds = vttTimestamp(timing.slice(0, arrow));
    index += 1;
    const cueLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      if ((lines[index] ?? "").includes("-->")) break;
      cueLines.push(lines[index] ?? "");
      index += 1;
    }
    if (seconds === null) continue;
    const current = cleanVttCue(cueLines.join(" "));
    if (current === "") continue;
    const delta = rollingCaptionDelta(previousCue, current);
    previousCue = current;
    if (delta === null) continue;
    if (markdown.length >= maxCues) {
      truncated = true;
      break;
    }
    const line = `- [${formatTranscriptTimestamp(seconds)}] ${escapeTranscriptMarkdown(delta)}`;
    const lineBytes = Buffer.byteLength(line) + (markdown.length === 0 ? 0 : 1);
    if (outputBytes + lineBytes > maxOutputBytes) {
      truncated = true;
      break;
    }
    markdown.push(line);
    outputBytes += lineBytes;
  }

  return {
    markdown: markdown.length === 0 ? "" : `${markdown.join("\n")}\n`,
    cueCount: markdown.length,
    truncated,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined || value === "") return "media";
  const pieces = value.split("/").filter((piece) => piece !== "" && piece !== ".");
  if (pieces.length === 0 || pieces.some((piece) => piece === ".." || /[\\\0]/.test(piece))) return "media";
  return pieces.join("/");
}

function promoteMediaFiles(
  runDirectory: string,
  outputDirectory: string,
  relativePrefix: string,
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
): { readonly records: readonly MediaRecord[]; readonly warnings: readonly string[] } {
  const violation = inspectMonitoredDirectory(runDirectory, maxFiles, maxFileBytes, maxTotalBytes);
  if (violation !== null) return { records: [], warnings: [violation] };
  const recordsByHash = new Map<string, MediaRecord>();
  const warnings: string[] = [];
  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const source = join(runDirectory, entry.name);
    const stats = statSync(source);
    if (!stats.isFile() || stats.size > maxFileBytes) {
      warnings.push(`Ignored invalid or oversized yt-dlp output ${basename(entry.name)}.`);
      continue;
    }
    const bytes = readFileSync(source);
    const mimeType = sniffMediaMimeType(bytes, extension);
    if (mimeType === null) {
      warnings.push(`Ignored unrecognized or mislabeled yt-dlp output ${basename(entry.name)}.`);
      continue;
    }
    const digest = sha256(bytes);
    const filename = `${digest}${extension}`;
    const destination = join(outputDirectory, filename);
    if (existsSync(destination)) {
      const destinationStats = lstatSync(destination);
      if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
        warnings.push(`Refused unsafe existing media destination ${filename}.`);
        continue;
      }
      const destinationDigest = sha256(readFileSync(destination));
      if (destinationDigest !== digest) {
        warnings.push(`Refused conflicting existing media destination ${filename}.`);
        continue;
      }
      unlinkSync(source);
    } else renameSync(source, destination);
    if (!recordsByHash.has(digest)) {
      recordsByHash.set(digest, {
        path: `${relativePrefix}/${filename}`,
        mimeType,
        bytes: stats.size,
        sha256: digest,
      });
    }
  }
  return {
    records: [...recordsByHash.values()].sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

function promoteVideoContextFiles(
  runDirectory: string,
  outputDirectory: string,
  relativePrefix: string,
  language: string,
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
): {
  readonly thumbnail: MediaRecord | null;
  readonly transcript: VideoTranscript | null;
  readonly warnings: readonly string[];
} {
  const violation = inspectMonitoredDirectory(runDirectory, maxFiles, maxFileBytes, maxTotalBytes);
  if (violation !== null) return { thumbnail: null, transcript: null, warnings: [violation] };
  const warnings: string[] = [];
  let thumbnailCandidate: {
    readonly source: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly extension: string;
  } | null = null;
  let transcriptCandidate: ParsedWebVtt | null = null;

  const entries = readdirSync(runDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = join(runDirectory, entry.name);
    const stats = statSync(source);
    if (!stats.isFile() || stats.size > maxFileBytes) {
      warnings.push("Ignored an invalid or oversized yt-dlp sidecar.");
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (extension === ".vtt") {
      const contents = readFileSync(source, "utf8");
      unlinkSync(source);
      const parsed = parseWebVtt(contents, {
        maxInputBytes: Math.min(maxFileBytes, 8 * 1024 * 1024),
        maxOutputBytes: Math.min(maxFileBytes, 8 * 1024 * 1024),
      });
      if (parsed.cueCount > 0 && (transcriptCandidate === null || parsed.cueCount > transcriptCandidate.cueCount)) {
        transcriptCandidate = parsed;
      }
      continue;
    }
    const bytes = readFileSync(source);
    const image = sniffImage(bytes);
    if (image === null) {
      warnings.push("Ignored an unrecognized yt-dlp sidecar.");
      continue;
    }
    if (thumbnailCandidate === null || bytes.byteLength > thumbnailCandidate.bytes.byteLength) {
      thumbnailCandidate = {
        source,
        bytes,
        mimeType: image.mimeType,
        extension: `.${image.extension}`,
      };
    }
  }

  let thumbnail: MediaRecord | null = null;
  if (thumbnailCandidate !== null) {
    const digest = sha256(thumbnailCandidate.bytes);
    const filename = `${digest}${thumbnailCandidate.extension}`;
    const destination = join(outputDirectory, filename);
    let promoted = false;
    if (existsSync(destination)) {
      const destinationStats = lstatSync(destination);
      if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
        warnings.push("Refused an unsafe existing video-thumbnail destination.");
      } else if (sha256(readFileSync(destination)) !== digest) {
        warnings.push("Refused a conflicting existing video-thumbnail destination.");
      } else {
        unlinkSync(thumbnailCandidate.source);
        promoted = true;
      }
    } else {
      renameSync(thumbnailCandidate.source, destination);
      promoted = true;
    }
    if (promoted) {
      thumbnail = {
        path: `${relativePrefix}/${filename}`,
        mimeType: thumbnailCandidate.mimeType,
        bytes: thumbnailCandidate.bytes.byteLength,
        sha256: digest,
      };
    }
  }

  if (transcriptCandidate?.truncated === true) {
    warnings.push("The video transcript reached its bounded parse limit and was truncated.");
  }
  return {
    thumbnail,
    transcript: transcriptCandidate === null
      ? null
      : {
          language,
          markdown: transcriptCandidate.markdown,
          cueCount: transcriptCandidate.cueCount,
          truncated: transcriptCandidate.truncated,
        },
    warnings,
  };
}

function validateOptions(options: CaptureMediaOptions): string | null {
  if (options.url.protocol !== "http:" && options.url.protocol !== "https:") return "Media URL must use HTTP or HTTPS.";
  if (options.url.username !== "" || options.url.password !== "") return "Media URL must not contain credentials.";
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return "Media timeout must be a positive integer.";
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) return "Per-file media limit must be positive.";
  if (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < options.maxFileBytes) {
    return "Total media limit must be at least the per-file limit.";
  }
  if (options.cookiesFile !== undefined) {
    try {
      const cookieFileStats = lstatSync(resolve(options.cookiesFile));
      if (!cookieFileStats.isFile()) return "The explicitly selected cookie file is not a regular file.";
      if (cookieFileStats.size > MAX_COOKIE_BYTES) return "The explicitly selected cookie file exceeds the 2mb input limit.";
    } catch {
      return "The explicitly selected cookie file is unavailable.";
    }
  }
  if (options.cookieBrowser !== undefined && !validProfile(options.cookieBrowser.profile)) {
    return "The explicitly selected browser cookie profile is invalid.";
  }
  return null;
}

/**
 * Capture accessible audio/video with yt-dlp. This is opt-in, never bypasses DRM or access controls,
 * and converts all operational failures into an honest status plus warnings.
 */
export async function captureMedia(options: CaptureMediaOptions): Promise<MediaCaptureResult> {
  const validation = validateOptions(options);
  if (validation !== null) return { status: "failed", records: [], metadata: null, warnings: [validation] };
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? discoverYtDlp({
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    exists,
    ...(options.which === undefined ? {} : { which: options.which }),
  });
  if (executable === null || !exists(executable)) {
    return {
      status: "unavailable",
      records: [],
      metadata: null,
      warnings: ["yt-dlp is not installed; skipped optional audio/video capture."],
    };
  }

  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 12, 100));
  const maxOutputBytes = Math.max(4_096, Math.min(options.maxOutputBytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024));
  const outputDirectory = resolve(options.outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    const outputStats = lstatSync(outputDirectory);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      return { status: "failed", records: [], metadata: null, warnings: ["Media destination must be a real directory, not a symlink."] };
    }
  } catch {
    return { status: "failed", records: [], metadata: null, warnings: ["Could not create the media destination directory."] };
  }

  const realOutputDirectory = realpathSync(outputDirectory);
  const runDirectory = mkdtempSync(join(realOutputDirectory, ".clip-media-"));
  let authDirectory: string | null = null;
  let networkProxy: LocalNetworkProxy | null = null;
  const run = options.run ?? runMediaCommand;
  const authenticationWarnings: string[] = [];
  try {
    let cookieFile: string | undefined;
    let cookieRequest: MediaCookieRequest | undefined;
    if (options.cookiesFile !== undefined) {
      cookieRequest = {
        url: options.url,
        source: "file",
        file: resolve(options.cookiesFile),
        timeoutMs: options.timeoutMs,
      };
      if (options.cookieBrowser !== undefined) {
        authenticationWarnings.push("The explicit cookie file took precedence over the selected browser cookie source.");
      }
    } else if (options.cookieBrowser !== undefined) {
      cookieRequest = {
        url: options.url,
        source: options.cookieBrowser.source,
        timeoutMs: options.timeoutMs,
        ...(options.cookieBrowser.profile === undefined ? {} : { profile: options.cookieBrowser.profile }),
      };
    }
    if (cookieRequest !== undefined) {
      // Credential material must never enter the repository/output staging tree, even transiently.
      authDirectory = mkdtempSync(join(tmpdir(), "hraness-oh-auth-"));
      chmodSync(authDirectory, 0o700);
      const prepared = await prepareCookieJar(cookieRequest, authDirectory, options.cookieProvider ?? readMediaCookies);
      if (!prepared.ok) {
        return { status: "failed", records: [], metadata: null, warnings: [prepared.warning] };
      }
      cookieFile = prepared.path;
      authenticationWarnings.push(...prepared.warnings);
    }

    networkProxy = await (options.startProxy ?? startNetworkProxy)({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      timeoutMs: options.timeoutMs,
      maxTransferredBytes: Math.max(
        64 * 1024 * 1024,
        Math.min(Number.MAX_SAFE_INTEGER, options.maxTotalBytes * 3),
      ),
    });

    const result = await run({
      command: commandArguments(executable, options, cookieFile, networkProxy.url),
      stdin: privateMediaUrlInput(options.url),
      cwd: runDirectory,
      timeoutMs: options.timeoutMs,
      maxOutputBytes,
      monitoredDirectory: runDirectory,
      maxFiles,
      maxFileBytes: options.maxFileBytes,
      maxTotalBytes: options.maxTotalBytes,
    });
    const metadata = parseMediaMetadata(result.stdout);
    if (result.exitCode !== 0 && result.exitCode !== 101) {
      const classification = errorClassification(result.stderr);
      return {
        status: classification.status,
        records: [],
        metadata,
        warnings: [...authenticationWarnings, classification.warning],
      };
    }
    const promoted = promoteMediaFiles(
      runDirectory,
      realOutputDirectory,
      normalizePrefix(options.relativePrefix),
      maxFiles,
      options.maxFileBytes,
      options.maxTotalBytes,
    );
    // yt-dlp reports its intentional --max-downloads boundary as 101 after emitting
    // the one requested item. A validated promoted file makes that a bounded success.
    if (result.exitCode === 101 && promoted.records.length === 0) {
      const classification = errorClassification(result.stderr);
      return {
        status: classification.status,
        records: [],
        metadata,
        warnings: [...authenticationWarnings, ...promoted.warnings, classification.warning],
      };
    }
    if (promoted.records.length === 0) {
      return {
        status: "unsupported",
        records: [],
        metadata,
        warnings: [
          ...authenticationWarnings,
          ...promoted.warnings,
          "yt-dlp completed without a supported audio/video file.",
        ],
      };
    }
    return {
      status: "captured",
      records: promoted.records,
      metadata,
      warnings: [...authenticationWarnings, ...promoted.warnings],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      records: [],
      metadata: null,
      warnings: [...authenticationWarnings, safeRunnerFailure(message)],
    };
  } finally {
    try {
      await networkProxy?.close();
    } finally {
      if (authDirectory !== null) rmSync(authDirectory, { recursive: true, force: true });
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}

function transcriptLanguage(value: string | undefined): string | null {
  const language = (value ?? "en").trim();
  return language.length <= 64 && /^[A-Za-z0-9]{1,16}(?:[-_][A-Za-z0-9]{1,16})*$/.test(language)
    ? language
    : null;
}

function nodeRuntimeFor(
  options: CaptureVideoContextOptions,
  exists: (path: string) => boolean,
): { readonly path: string | null; readonly warnings: readonly string[] } {
  if (options.nodeExecutable === null) return { path: null, warnings: [] };
  const readVersion = options.readNodeVersion ?? readInstalledNodeVersion;
  if (options.nodeExecutable !== undefined) {
    if (
      exists(options.nodeExecutable)
      && supportsYtDlpNodeRuntime(readVersion(options.nodeExecutable))
    ) return { path: options.nodeExecutable, warnings: [] };
    return {
      path: null,
      warnings: ["The selected Node.js runtime was unavailable or older than Node.js 22; yt-dlp used its default runtime discovery."],
    };
  }
  return {
    path: discoverNodeRuntime({
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      exists,
      ...(options.which === undefined ? {} : { which: options.which }),
      readVersion,
    }),
    warnings: [],
  };
}

/**
 * Capture only reusable video context: metadata, one thumbnail, and one exact-language transcript.
 * The main audio/video payload is deliberately skipped; `captureMedia` remains the explicit full-media API.
 */
export async function captureVideoContext(
  options: CaptureVideoContextOptions,
): Promise<VideoContextCaptureResult> {
  const validation = validateOptions(options);
  if (validation !== null) {
    return { status: "failed", thumbnail: null, transcript: null, metadata: null, warnings: [validation] };
  }
  const language = transcriptLanguage(options.transcriptLanguage);
  if (language === null) {
    return {
      status: "failed",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: ["Transcript language must be one exact language identifier such as en or en-US."],
    };
  }

  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? discoverYtDlp({
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    exists,
    ...(options.which === undefined ? {} : { which: options.which }),
  });
  if (executable === null || !exists(executable)) {
    return {
      status: "unavailable",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: ["yt-dlp is not installed; skipped optional video context capture."],
    };
  }

  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 12, 100));
  const maxOutputBytes = Math.max(4_096, Math.min(options.maxOutputBytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024));
  const outputDirectory = resolve(options.outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    const outputStats = lstatSync(outputDirectory);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      return {
        status: "failed",
        thumbnail: null,
        transcript: null,
        metadata: null,
        warnings: ["Video-context destination must be a real directory, not a symlink."],
      };
    }
  } catch {
    return {
      status: "failed",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: ["Could not create the video-context destination directory."],
    };
  }

  const realOutputDirectory = realpathSync(outputDirectory);
  const runDirectory = mkdtempSync(join(realOutputDirectory, ".clip-video-context-"));
  let authDirectory: string | null = null;
  let networkProxy: LocalNetworkProxy | null = null;
  const run = options.run ?? runMediaCommand;
  const authenticationWarnings: string[] = [];
  try {
    let cookieFile: string | undefined;
    let cookieRequest: MediaCookieRequest | undefined;
    if (options.cookiesFile !== undefined) {
      cookieRequest = {
        url: options.url,
        source: "file",
        file: resolve(options.cookiesFile),
        timeoutMs: options.timeoutMs,
      };
      if (options.cookieBrowser !== undefined) {
        authenticationWarnings.push("The explicit cookie file took precedence over the selected browser cookie source.");
      }
    } else if (options.cookieBrowser !== undefined) {
      cookieRequest = {
        url: options.url,
        source: options.cookieBrowser.source,
        timeoutMs: options.timeoutMs,
        ...(options.cookieBrowser.profile === undefined ? {} : { profile: options.cookieBrowser.profile }),
      };
    }
    if (cookieRequest !== undefined) {
      authDirectory = mkdtempSync(join(tmpdir(), "hraness-oh-auth-"));
      chmodSync(authDirectory, 0o700);
      const prepared = await prepareCookieJar(cookieRequest, authDirectory, options.cookieProvider ?? readMediaCookies);
      if (!prepared.ok) {
        return {
          status: "failed",
          thumbnail: null,
          transcript: null,
          metadata: null,
          warnings: [prepared.warning],
        };
      }
      cookieFile = prepared.path;
      authenticationWarnings.push(...prepared.warnings);
    }

    networkProxy = await (options.startProxy ?? startNetworkProxy)({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      timeoutMs: options.timeoutMs,
      maxTransferredBytes: Math.max(
        64 * 1024 * 1024,
        Math.min(Number.MAX_SAFE_INTEGER, options.maxTotalBytes * 3),
      ),
    });
    const nodeRuntime = nodeRuntimeFor(options, exists);
    const result = await run({
      command: videoContextCommandArguments(
        executable,
        options,
        language,
        cookieFile,
        networkProxy.url,
        nodeRuntime.path,
      ),
      stdin: privateMediaUrlInput(options.url),
      cwd: runDirectory,
      timeoutMs: options.timeoutMs,
      maxOutputBytes,
      monitoredDirectory: runDirectory,
      maxFiles,
      maxFileBytes: options.maxFileBytes,
      maxTotalBytes: options.maxTotalBytes,
    });
    const metadata = parseMediaMetadata(result.stdout);
    const promoted = promoteVideoContextFiles(
      runDirectory,
      realOutputDirectory,
      normalizePrefix(options.relativePrefix),
      language,
      maxFiles,
      options.maxFileBytes,
      options.maxTotalBytes,
    );
    const capturedSomething = metadata !== null || promoted.thumbnail !== null || promoted.transcript !== null;
    const warnings = [...authenticationWarnings, ...nodeRuntime.warnings, ...promoted.warnings];
    // yt-dlp reports its intentional --max-downloads boundary as 101 after emitting
    // the one requested item's sidecars. Retained context makes that a bounded success.
    if (result.exitCode !== 0 && !(result.exitCode === 101 && capturedSomething)) {
      const classification = errorClassification(result.stderr);
      return {
        status: capturedSomething ? "partial" : classification.status,
        thumbnail: promoted.thumbnail,
        transcript: promoted.transcript,
        metadata,
        warnings: [...warnings, classification.warning],
      };
    }
    if (metadata === null) warnings.push("yt-dlp returned no allowlisted video metadata.");
    if (promoted.thumbnail === null) warnings.push("yt-dlp returned no supported video thumbnail.");
    if (promoted.transcript === null) {
      warnings.push(`yt-dlp returned no ${language} transcript for this video.`);
    }
    return {
      status: metadata !== null && promoted.thumbnail !== null && promoted.transcript !== null
        ? "captured"
        : "partial",
      thumbnail: promoted.thumbnail,
      transcript: promoted.transcript,
      metadata,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: [...authenticationWarnings, safeRunnerFailure(message)],
    };
  } finally {
    try {
      await networkProxy?.close();
    } finally {
      if (authDirectory !== null) rmSync(authDirectory, { recursive: true, force: true });
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}
