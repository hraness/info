// @bun
import {
  canonicalizeUrl,
  chooseBestExtraction,
  countWords,
  extractPage,
  localizeAssets,
  sniffImage
} from "./index-0y58zcp8.js";
import {
  adapterCapabilities,
  inspectClipEnvironment,
  renderAdapterCapabilities,
  renderDoctorReport
} from "./index-wty076xc.js";
import {
  acquireBrowser,
  acquireCookieHttp,
  acquireCookieRecords,
  acquireFile,
  acquireHttp,
  assertSafePersistentProfile
} from "./index-qx5jr97w.js";
import {
  CONTENT_REWRITE_TRUNCATION_WARNING,
  buildClipMarkdown,
  classifyPlatformUrl,
  parseBlueskyCapture,
  parseHackerNewsCapture,
  parseRedditCapture,
  renderCapturedDocument,
  rewriteContentWithStatus,
  slugify
} from "./index-hgve9rh2.js";
import {
  abortCaptureBundle,
  beginCaptureBundle,
  commitCaptureBundle,
  redactSensitiveText,
  redactSensitiveTextWithCount,
  sanitizeArtifactUrl,
  writeCaptureBundle
} from "./index-ey9rycsn.js";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText
} from "./index-1xxnjn0d.js";
import {
  captureUrl,
  parseArguments,
  usage
} from "./index-6g2pv9d2.js";
import {
  MAX_COOKIE_BYTES,
  filterCookieProviderResult,
  filterCookies,
  readCookieFile,
  renderCookieHeader,
  renderNetscapeCookieJar
} from "./index-84x0vjjp.js";
import {
  startNetworkProxy
} from "./index-7qhzw38d.js";
import {
  decodeBytes,
  safeFetch
} from "./index-4sh2hh3t.js";
import {
  BoundedByteBuffer
} from "./index-gh719d91.js";
import {
  cloneBrowserProfile
} from "./index-5n05se68.js";

// src/clip/capture.ts
import {
  chmodSync as chmodSync2,
  copyFileSync,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  mkdtempSync as mkdtempSync2,
  readFileSync as readFileSync2,
  rmSync as rmSync2,
  statSync as statSync2
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";

// src/clip/media.ts
import { createHash } from "crypto";
import { spawn, spawnSync } from "child_process";
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
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, extname, join, resolve } from "path";
import { getCookies } from "@steipete/sweet-cookie";
var metadataPrefix = "CLIP_MEDIA_JSON\t";
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}
function ascii(bytes, start, length) {
  let result = "";
  for (let index = start;index < start + length && index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}
function sniffMediaMimeType(bytes, extension) {
  const normalized = extension.toLowerCase();
  if (ascii(bytes, 4, 4) === "ftyp") {
    if (normalized === ".mov")
      return "video/quicktime";
    if (normalized === ".m4a")
      return "audio/mp4";
    if (normalized === ".mp4")
      return "video/mp4";
    if (normalized === ".m4v")
      return "video/x-m4v";
    return null;
  }
  if (startsWith(bytes, [26, 69, 223, 163])) {
    if (normalized === ".webm")
      return "video/webm";
    if (normalized === ".mkv")
      return "video/x-matroska";
    return null;
  }
  if (ascii(bytes, 0, 3) === "ID3" || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224) {
    return normalized === ".mp3" ? "audio/mpeg" : null;
  }
  if (ascii(bytes, 0, 4) === "OggS") {
    if (normalized === ".opus")
      return "audio/opus";
    if (normalized === ".ogg")
      return "audio/ogg";
    return null;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return normalized === ".wav" ? "audio/wav" : null;
  }
  if (ascii(bytes, 0, 4) === "fLaC")
    return normalized === ".flac" ? "audio/flac" : null;
  if (bytes[0] === 255 && ((bytes[1] ?? 0) & 246) === 240) {
    return normalized === ".aac" ? "audio/aac" : null;
  }
  return null;
}
async function readBoundedStream(stream, maxBytes) {
  const iterable = stream;
  const bytes = new BoundedByteBuffer(maxBytes);
  for await (const value of iterable) {
    let chunk;
    if (Buffer.isBuffer(value))
      chunk = value;
    else if (typeof value === "string")
      chunk = Buffer.from(value);
    else if (value instanceof Uint8Array)
      chunk = Buffer.from(value);
    else
      throw new Error("media command returned an unsupported output chunk");
    if (!bytes.append(chunk))
      throw new Error(`media command output exceeded ${maxBytes} bytes`);
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}
function inspectMonitoredDirectory(directory, maxFiles, maxFileBytes, maxTotalBytes) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return `could not inspect media staging directory: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (entries.length > maxFiles)
    return `media capture created more than ${maxFiles} files`;
  let totalBytes = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (!entry.isFile() || stats.isSymbolicLink())
      return "media capture created an unexpected non-file output";
    if (stats.size > maxFileBytes)
      return `media capture created a file larger than ${maxFileBytes} bytes`;
    totalBytes += stats.size;
    if (totalBytes > maxTotalBytes)
      return `media capture exceeded the ${maxTotalBytes}-byte total limit`;
  }
  return null;
}
var runMediaCommand = async (specification) => {
  const executable = specification.command[0];
  if (executable === undefined)
    throw new Error("media command is empty");
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(executable, specification.command.slice(1), {
    ...specification.cwd === undefined ? {} : { cwd: specification.cwd },
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdin.once("error", () => {});
  child.stdin.end(specification.stdin ?? "");
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  const signalProcessTree = (signal) => {
    if (useProcessGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    try {
      child.kill(signal);
    } catch {}
  };
  let failure = null;
  let forceKillTimer = null;
  const requestStop = (reason) => {
    if (failure === null)
      failure = reason;
    if (forceKillTimer !== null)
      return;
    signalProcessTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree("SIGKILL"), 1000);
  };
  const timeout = setTimeout(() => {
    requestStop(`media command timed out after ${specification.timeoutMs}ms`);
  }, specification.timeoutMs);
  const monitor = setInterval(() => {
    const violation = inspectMonitoredDirectory(specification.monitoredDirectory, specification.maxFiles, specification.maxFileBytes, specification.maxTotalBytes);
    if (violation !== null)
      requestStop(violation);
  }, 100);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, specification.maxOutputBytes),
      readBoundedStream(child.stderr, specification.maxOutputBytes),
      exited
    ]);
    const finalViolation = inspectMonitoredDirectory(specification.monitoredDirectory, specification.maxFiles, specification.maxFileBytes, specification.maxTotalBytes);
    if (failure !== null)
      throw new Error(failure);
    if (finalViolation !== null)
      throw new Error(finalViolation);
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (failure === null)
      requestStop(error instanceof Error ? error.message : "media command failed");
    await exited.catch(() => 1);
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    if (forceKillTimer !== null)
      clearTimeout(forceKillTimer);
  }
};
function discoverYtDlp(options = {}) {
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name) => Bun.which(name));
  const fromPath = which("yt-dlp");
  if (fromPath !== null && exists(fromPath))
    return fromPath;
  const homeDirectory = options.homeDirectory ?? homedir();
  return [
    join(homeDirectory, ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp"
  ].find((path) => exists(path)) ?? null;
}
function readInstalledNodeVersion(executable) {
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4096,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== "string")
      return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}
function supportsYtDlpNodeRuntime(version) {
  if (version === null)
    return false;
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  if (match?.[1] === undefined)
    return false;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 22;
}
function discoverNodeRuntime(options = {}) {
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name) => Bun.which(name));
  const readVersion = options.readVersion ?? readInstalledNodeVersion;
  const homeDirectory = options.homeDirectory ?? homedir();
  const candidates = [
    which("node"),
    join(homeDirectory, ".local", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node"
  ];
  const seen = new Set;
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate))
      continue;
    seen.add(candidate);
    if (exists(candidate) && supportsYtDlpNodeRuntime(readVersion(candidate)))
      return candidate;
  }
  return null;
}
function cleanString(value, maximumLength) {
  if (typeof value !== "string")
    return;
  const cleaned = value.replace(/\0/g, "").trim();
  if (cleaned === "" || cleaned.length > maximumLength)
    return;
  return cleaned;
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function safeWebUrl(value) {
  const candidate = cleanString(value, 8192);
  if (candidate === undefined)
    return;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return;
    }
    return url.href;
  } catch {
    return;
  }
}
function parseMediaMetadata(stdout) {
  const scanStart = Math.max(0, stdout.length - 2 * 1024 * 1024);
  let lineEnd = stdout.length;
  while (lineEnd >= scanStart) {
    const newline = stdout.lastIndexOf(`
`, lineEnd - 1);
    const lineStart = Math.max(scanStart, newline + 1);
    const rawLine = stdout.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    lineEnd = newline < scanStart ? scanStart - 1 : newline;
    if (!line.startsWith(metadataPrefix))
      continue;
    try {
      const parsed = JSON.parse(line.slice(metadataPrefix.length));
      if (!isRecord(parsed))
        continue;
      const id = cleanString(parsed.id, 512);
      const title = cleanString(parsed.title, 8192);
      const description = cleanString(parsed.description, 500000);
      const uploader = cleanString(parsed.uploader, 8192);
      const uploaderId = cleanString(parsed.uploader_id, 8192);
      const channel = cleanString(parsed.channel, 8192);
      const channelId = cleanString(parsed.channel_id, 8192);
      const webpageUrl = safeWebUrl(parsed.webpage_url);
      const extractor = cleanString(parsed.extractor, 1024);
      const durationSeconds = finiteNonNegative(parsed.duration);
      const timestamp = finiteNonNegative(parsed.timestamp);
      return {
        ...id === undefined ? {} : { id },
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
        ...uploader === undefined ? {} : { uploader },
        ...uploaderId === undefined ? {} : { uploaderId },
        ...channel === undefined ? {} : { channel },
        ...channelId === undefined ? {} : { channelId },
        ...webpageUrl === undefined ? {} : { webpageUrl },
        ...extractor === undefined ? {} : { extractor },
        ...durationSeconds === undefined ? {} : { durationSeconds },
        ...timestamp === undefined ? {} : { timestamp }
      };
    } catch {}
  }
  return null;
}
function validProfile(profile) {
  return profile === undefined || profile.trim() !== "" && profile.length <= 4096 && !/\p{Cc}/u.test(profile);
}
function buildMediaCookieOptions(request) {
  const common = {
    url: request.url.href,
    timeoutMs: request.timeoutMs,
    mode: "first",
    debug: false
  };
  const profile = request.profile?.trim();
  if (request.source === "edge") {
    return {
      ...common,
      browsers: ["edge"],
      edgeProfile: profile ?? ""
    };
  }
  if (request.source === "firefox") {
    return {
      ...common,
      browsers: ["firefox"],
      firefoxProfile: profile ?? ""
    };
  }
  if (request.source === "safari") {
    return {
      ...common,
      browsers: ["safari"],
      ...profile === undefined ? {} : { safariCookiesFile: profile }
    };
  }
  return {
    ...common,
    browsers: ["chrome"],
    chromiumBrowser: request.source,
    chromeProfile: profile ?? ""
  };
}
function createMediaCookieProvider(reader) {
  return (request) => {
    if (request.source !== "file")
      return reader(buildMediaCookieOptions(request));
    const parsed = readCookieFile(request.file, request.url);
    return Promise.resolve(parsed.ok ? {
      cookies: parsed.cookies,
      warnings: parsed.rejected === 0 ? [] : [`Ignored ${parsed.rejected} malformed, expired, or out-of-scope cookie record(s).`]
    } : { cookies: [], warnings: [] });
  };
}
var readMediaCookies = createMediaCookieProvider((options) => getCookies(options));
async function prepareCookieJar(request, directory, provider) {
  let provided;
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
      warning: filtered.rejected === 0 ? "No origin-scoped cookies were found in the explicitly selected browser." : `No usable origin-scoped cookies were found; rejected ${filtered.rejected} malformed, expired, or out-of-scope record(s).`
    };
  }
  const body = renderNetscapeCookieJar(filtered.cookies, request.url);
  if (Buffer.byteLength(body, "utf8") > MAX_COOKIE_BYTES) {
    return { ok: false, warning: "Origin-scoped browser cookies exceeded the private jar size limit." };
  }
  const path = join(directory, "cookies.txt");
  try {
    writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 384 });
    chmodSync(path, 384);
  } catch {
    return { ok: false, warning: "Could not create the private temporary cookie jar." };
  }
  const warnings = [];
  if (filtered.rejected > 0) {
    warnings.push(`Ignored ${filtered.rejected} malformed, expired, or out-of-scope browser cookie record(s).`);
  }
  if (filtered.providerWarningCount > 0) {
    warnings.push(`The browser cookie provider reported ${filtered.providerWarningCount} non-fatal warning(s).`);
  }
  return { ok: true, path, warnings };
}
function metadataTemplate() {
  return `${metadataPrefix}{"id":%(id)j,"title":%(title)j,"description":%(description)j,` + `"uploader":%(uploader)j,"uploader_id":%(uploader_id)j,"webpage_url":%(webpage_url)j,` + `"channel":%(channel)j,"channel_id":%(channel_id)j,"extractor":%(extractor)j,` + `"duration":%(duration)j,"timestamp":%(timestamp)j}`;
}
function commandArguments(executable, options, cookieFile, proxyUrl) {
  const arguments_ = [
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
    String(Math.max(1, Math.ceil(options.timeoutMs / 1000))),
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
    `after_move:${metadataTemplate()}`
  ];
  if (options.userAgent !== undefined)
    arguments_.push("--user-agent", options.userAgent);
  if (cookieFile !== undefined)
    arguments_.push("--cookies", cookieFile);
  return arguments_;
}
function videoContextCommandArguments(executable, options, language, cookieFile, proxyUrl, nodeRuntime) {
  const arguments_ = [
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
    String(Math.max(1, Math.ceil(options.timeoutMs / 1000))),
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
    metadataTemplate()
  ];
  if (nodeRuntime !== null)
    arguments_.push("--js-runtimes", `node:${nodeRuntime}`);
  if (options.userAgent !== undefined)
    arguments_.push("--user-agent", options.userAgent);
  if (cookieFile !== undefined)
    arguments_.push("--cookies", cookieFile);
  return arguments_;
}
function privateMediaUrlInput(url) {
  const value = url.href;
  if (/[\0\r\n]/.test(value))
    throw new Error("media URL contains an invalid batch-file control character");
  return `${value}
`;
}
function errorClassification(stderr) {
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
function safeRunnerFailure(message) {
  const safePatterns = [
    /^media command timed out after \d+ms$/,
    /^media command output exceeded \d+ bytes$/,
    /^media capture created more than \d+ files$/,
    /^media capture created a file larger than \d+ bytes$/,
    /^media capture exceeded the \d+-byte total limit$/
  ];
  return safePatterns.some((pattern) => pattern.test(message)) ? message : "yt-dlp media capture failed; page text and images can still be clipped.";
}
function positiveBound(value, fallback, maximum) {
  return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : Math.min(value, maximum);
}
function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes)
    return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\ufffd$/u, "");
}
function decodeVttEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi, (_match, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal === undefined ? 10 : 16);
    return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 1114111 && !(codePoint >= 55296 && codePoint <= 57343) ? String.fromCodePoint(codePoint) : "";
  });
}
function cleanVttCue(value) {
  return decodeVttEntities(value.replace(/<[^>\n]{0,512}>/g, "")).replace(/\s+/g, " ").trim().slice(0, 16384);
}
function escapeTranscriptMarkdown(value) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_~[\]])/g, "\\$1").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function vttTimestamp(value) {
  const timestamp = value.trim().split(/\s+/u)[0];
  if (timestamp === undefined)
    return null;
  const clock = timestamp.replace(",", ".").split(".");
  if (clock.length !== 2 || clock[1] === undefined || !/^\d{3}$/.test(clock[1]))
    return null;
  const pieces = clock[0]?.split(":") ?? [];
  if (pieces.length !== 2 && pieces.length !== 3)
    return null;
  if (pieces.some((piece) => !/^\d{2}$/.test(piece)))
    return null;
  const seconds = Number(pieces.at(-1));
  const minutes = Number(pieces.at(-2));
  const hours = pieces.length === 3 ? Number(pieces[0]) : 0;
  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || !Number.isSafeInteger(seconds) || minutes > 59 || seconds > 59)
    return null;
  return hours * 3600 + minutes * 60 + seconds;
}
function formatTranscriptTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}
function rollingCaptionDelta(previous, current) {
  if (previous === null)
    return current;
  if (previous === current || previous.includes(current))
    return null;
  const previousWords = previous.split(" ");
  const currentWords = current.split(" ");
  const maximumOverlap = Math.min(previousWords.length, currentWords.length, 256);
  for (let overlap = maximumOverlap;overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0;index < overlap; index += 1) {
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
function parseWebVtt(input, options = {}) {
  const maxInputBytes = positiveBound(options.maxInputBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const maxCues = positiveBound(options.maxCues, 20000, 1e5);
  const maxOutputBytes = positiveBound(options.maxOutputBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const inputWasTruncated = Buffer.byteLength(input) > maxInputBytes;
  const boundedInput = inputWasTruncated ? utf8Prefix(input, maxInputBytes) : input;
  const lines = boundedInput.replace(/\r\n?/g, `
`).split(`
`);
  const markdown = [];
  let outputBytes = 0;
  let previousCue = null;
  let truncated = inputWasTruncated;
  for (let index = 0;index < lines.length; ) {
    const timing = lines[index] ?? "";
    const arrow = timing.indexOf("-->");
    if (arrow < 0) {
      index += 1;
      continue;
    }
    const seconds = vttTimestamp(timing.slice(0, arrow));
    index += 1;
    const cueLines = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      if ((lines[index] ?? "").includes("-->"))
        break;
      cueLines.push(lines[index] ?? "");
      index += 1;
    }
    if (seconds === null)
      continue;
    const current = cleanVttCue(cueLines.join(" "));
    if (current === "")
      continue;
    const delta = rollingCaptionDelta(previousCue, current);
    previousCue = current;
    if (delta === null)
      continue;
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
    markdown: markdown.length === 0 ? "" : `${markdown.join(`
`)}
`,
    cueCount: markdown.length,
    truncated
  };
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function normalizePrefix(value) {
  if (value === undefined || value === "")
    return "media";
  const pieces = value.split("/").filter((piece) => piece !== "" && piece !== ".");
  if (pieces.length === 0 || pieces.some((piece) => piece === ".." || /[\\\0]/.test(piece)))
    return "media";
  return pieces.join("/");
}
function promoteMediaFiles(runDirectory, outputDirectory, relativePrefix, maxFiles, maxFileBytes, maxTotalBytes) {
  const violation = inspectMonitoredDirectory(runDirectory, maxFiles, maxFileBytes, maxTotalBytes);
  if (violation !== null)
    return { records: [], warnings: [violation] };
  const recordsByHash = new Map;
  const warnings = [];
  for (const entry of readdirSync(runDirectory, { withFileTypes: true })) {
    if (!entry.isFile())
      continue;
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
    } else
      renameSync(source, destination);
    if (!recordsByHash.has(digest)) {
      recordsByHash.set(digest, {
        path: `${relativePrefix}/${filename}`,
        mimeType,
        bytes: stats.size,
        sha256: digest
      });
    }
  }
  return {
    records: [...recordsByHash.values()].sort((left, right) => left.path.localeCompare(right.path)),
    warnings
  };
}
function promoteVideoContextFiles(runDirectory, outputDirectory, relativePrefix, language, maxFiles, maxFileBytes, maxTotalBytes) {
  const violation = inspectMonitoredDirectory(runDirectory, maxFiles, maxFileBytes, maxTotalBytes);
  if (violation !== null)
    return { thumbnail: null, transcript: null, warnings: [violation] };
  const warnings = [];
  let thumbnailCandidate = null;
  let transcriptCandidate = null;
  const entries = readdirSync(runDirectory, { withFileTypes: true }).filter((entry) => entry.isFile()).sort((left, right) => left.name.localeCompare(right.name));
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
        maxOutputBytes: Math.min(maxFileBytes, 8 * 1024 * 1024)
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
        extension: `.${image.extension}`
      };
    }
  }
  let thumbnail = null;
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
        sha256: digest
      };
    }
  }
  if (transcriptCandidate?.truncated === true) {
    warnings.push("The video transcript reached its bounded parse limit and was truncated.");
  }
  return {
    thumbnail,
    transcript: transcriptCandidate === null ? null : {
      language,
      markdown: transcriptCandidate.markdown,
      cueCount: transcriptCandidate.cueCount,
      truncated: transcriptCandidate.truncated
    },
    warnings
  };
}
function validateOptions(options) {
  if (options.url.protocol !== "http:" && options.url.protocol !== "https:")
    return "Media URL must use HTTP or HTTPS.";
  if (options.url.username !== "" || options.url.password !== "")
    return "Media URL must not contain credentials.";
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    return "Media timeout must be a positive integer.";
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1)
    return "Per-file media limit must be positive.";
  if (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < options.maxFileBytes) {
    return "Total media limit must be at least the per-file limit.";
  }
  if (options.cookiesFile !== undefined) {
    try {
      const cookieFileStats = lstatSync(resolve(options.cookiesFile));
      if (!cookieFileStats.isFile())
        return "The explicitly selected cookie file is not a regular file.";
      if (cookieFileStats.size > MAX_COOKIE_BYTES)
        return "The explicitly selected cookie file exceeds the 2mb input limit.";
    } catch {
      return "The explicitly selected cookie file is unavailable.";
    }
  }
  if (options.cookieBrowser !== undefined && !validProfile(options.cookieBrowser.profile)) {
    return "The explicitly selected browser cookie profile is invalid.";
  }
  return null;
}
async function captureMedia(options) {
  const validation = validateOptions(options);
  if (validation !== null)
    return { status: "failed", records: [], metadata: null, warnings: [validation] };
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? discoverYtDlp({
    ...options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory },
    exists,
    ...options.which === undefined ? {} : { which: options.which }
  });
  if (executable === null || !exists(executable)) {
    return {
      status: "unavailable",
      records: [],
      metadata: null,
      warnings: ["yt-dlp is not installed; skipped optional audio/video capture."]
    };
  }
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 12, 100));
  const maxOutputBytes = Math.max(4096, Math.min(options.maxOutputBytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024));
  const outputDirectory = resolve(options.outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 493 });
    const outputStats = lstatSync(outputDirectory);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      return { status: "failed", records: [], metadata: null, warnings: ["Media destination must be a real directory, not a symlink."] };
    }
  } catch {
    return { status: "failed", records: [], metadata: null, warnings: ["Could not create the media destination directory."] };
  }
  const realOutputDirectory = realpathSync(outputDirectory);
  const runDirectory = mkdtempSync(join(realOutputDirectory, ".clip-media-"));
  let authDirectory = null;
  let networkProxy = null;
  const run = options.run ?? runMediaCommand;
  const authenticationWarnings = [];
  try {
    let cookieFile;
    let cookieRequest;
    if (options.cookiesFile !== undefined) {
      cookieRequest = {
        url: options.url,
        source: "file",
        file: resolve(options.cookiesFile),
        timeoutMs: options.timeoutMs
      };
      if (options.cookieBrowser !== undefined) {
        authenticationWarnings.push("The explicit cookie file took precedence over the selected browser cookie source.");
      }
    } else if (options.cookieBrowser !== undefined) {
      cookieRequest = {
        url: options.url,
        source: options.cookieBrowser.source,
        timeoutMs: options.timeoutMs,
        ...options.cookieBrowser.profile === undefined ? {} : { profile: options.cookieBrowser.profile }
      };
    }
    if (cookieRequest !== undefined) {
      authDirectory = mkdtempSync(join(tmpdir(), "hraness-kb-auth-"));
      chmodSync(authDirectory, 448);
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
      maxTransferredBytes: Math.max(64 * 1024 * 1024, Math.min(Number.MAX_SAFE_INTEGER, options.maxTotalBytes * 3))
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
      maxTotalBytes: options.maxTotalBytes
    });
    const metadata = parseMediaMetadata(result.stdout);
    if (result.exitCode !== 0 && result.exitCode !== 101) {
      const classification = errorClassification(result.stderr);
      return {
        status: classification.status,
        records: [],
        metadata,
        warnings: [...authenticationWarnings, classification.warning]
      };
    }
    const promoted = promoteMediaFiles(runDirectory, realOutputDirectory, normalizePrefix(options.relativePrefix), maxFiles, options.maxFileBytes, options.maxTotalBytes);
    if (result.exitCode === 101 && promoted.records.length === 0) {
      const classification = errorClassification(result.stderr);
      return {
        status: classification.status,
        records: [],
        metadata,
        warnings: [...authenticationWarnings, ...promoted.warnings, classification.warning]
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
          "yt-dlp completed without a supported audio/video file."
        ]
      };
    }
    return {
      status: "captured",
      records: promoted.records,
      metadata,
      warnings: [...authenticationWarnings, ...promoted.warnings]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      records: [],
      metadata: null,
      warnings: [...authenticationWarnings, safeRunnerFailure(message)]
    };
  } finally {
    try {
      await networkProxy?.close();
    } finally {
      if (authDirectory !== null)
        rmSync(authDirectory, { recursive: true, force: true });
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}
function transcriptLanguage(value) {
  const language = (value ?? "en").trim();
  return language.length <= 64 && /^[A-Za-z0-9]{1,16}(?:[-_][A-Za-z0-9]{1,16})*$/.test(language) ? language : null;
}
function nodeRuntimeFor(options, exists) {
  if (options.nodeExecutable === null)
    return { path: null, warnings: [] };
  const readVersion = options.readNodeVersion ?? readInstalledNodeVersion;
  if (options.nodeExecutable !== undefined) {
    if (exists(options.nodeExecutable) && supportsYtDlpNodeRuntime(readVersion(options.nodeExecutable)))
      return { path: options.nodeExecutable, warnings: [] };
    return {
      path: null,
      warnings: ["The selected Node.js runtime was unavailable or older than Node.js 22; yt-dlp used its default runtime discovery."]
    };
  }
  return {
    path: discoverNodeRuntime({
      ...options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory },
      exists,
      ...options.which === undefined ? {} : { which: options.which },
      readVersion
    }),
    warnings: []
  };
}
async function captureVideoContext(options) {
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
      warnings: ["Transcript language must be one exact language identifier such as en or en-US."]
    };
  }
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? discoverYtDlp({
    ...options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory },
    exists,
    ...options.which === undefined ? {} : { which: options.which }
  });
  if (executable === null || !exists(executable)) {
    return {
      status: "unavailable",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: ["yt-dlp is not installed; skipped optional video context capture."]
    };
  }
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 12, 100));
  const maxOutputBytes = Math.max(4096, Math.min(options.maxOutputBytes ?? 2 * 1024 * 1024, 16 * 1024 * 1024));
  const outputDirectory = resolve(options.outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 493 });
    const outputStats = lstatSync(outputDirectory);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      return {
        status: "failed",
        thumbnail: null,
        transcript: null,
        metadata: null,
        warnings: ["Video-context destination must be a real directory, not a symlink."]
      };
    }
  } catch {
    return {
      status: "failed",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: ["Could not create the video-context destination directory."]
    };
  }
  const realOutputDirectory = realpathSync(outputDirectory);
  const runDirectory = mkdtempSync(join(realOutputDirectory, ".clip-video-context-"));
  let authDirectory = null;
  let networkProxy = null;
  const run = options.run ?? runMediaCommand;
  const authenticationWarnings = [];
  try {
    let cookieFile;
    let cookieRequest;
    if (options.cookiesFile !== undefined) {
      cookieRequest = {
        url: options.url,
        source: "file",
        file: resolve(options.cookiesFile),
        timeoutMs: options.timeoutMs
      };
      if (options.cookieBrowser !== undefined) {
        authenticationWarnings.push("The explicit cookie file took precedence over the selected browser cookie source.");
      }
    } else if (options.cookieBrowser !== undefined) {
      cookieRequest = {
        url: options.url,
        source: options.cookieBrowser.source,
        timeoutMs: options.timeoutMs,
        ...options.cookieBrowser.profile === undefined ? {} : { profile: options.cookieBrowser.profile }
      };
    }
    if (cookieRequest !== undefined) {
      authDirectory = mkdtempSync(join(tmpdir(), "hraness-kb-auth-"));
      chmodSync(authDirectory, 448);
      const prepared = await prepareCookieJar(cookieRequest, authDirectory, options.cookieProvider ?? readMediaCookies);
      if (!prepared.ok) {
        return {
          status: "failed",
          thumbnail: null,
          transcript: null,
          metadata: null,
          warnings: [prepared.warning]
        };
      }
      cookieFile = prepared.path;
      authenticationWarnings.push(...prepared.warnings);
    }
    networkProxy = await (options.startProxy ?? startNetworkProxy)({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      timeoutMs: options.timeoutMs,
      maxTransferredBytes: Math.max(64 * 1024 * 1024, Math.min(Number.MAX_SAFE_INTEGER, options.maxTotalBytes * 3))
    });
    const nodeRuntime = nodeRuntimeFor(options, exists);
    const result = await run({
      command: videoContextCommandArguments(executable, options, language, cookieFile, networkProxy.url, nodeRuntime.path),
      stdin: privateMediaUrlInput(options.url),
      cwd: runDirectory,
      timeoutMs: options.timeoutMs,
      maxOutputBytes,
      monitoredDirectory: runDirectory,
      maxFiles,
      maxFileBytes: options.maxFileBytes,
      maxTotalBytes: options.maxTotalBytes
    });
    const metadata = parseMediaMetadata(result.stdout);
    const promoted = promoteVideoContextFiles(runDirectory, realOutputDirectory, normalizePrefix(options.relativePrefix), language, maxFiles, options.maxFileBytes, options.maxTotalBytes);
    const capturedSomething = metadata !== null || promoted.thumbnail !== null || promoted.transcript !== null;
    const warnings = [...authenticationWarnings, ...nodeRuntime.warnings, ...promoted.warnings];
    if (result.exitCode !== 0 && !(result.exitCode === 101 && capturedSomething)) {
      const classification = errorClassification(result.stderr);
      return {
        status: capturedSomething ? "partial" : classification.status,
        thumbnail: promoted.thumbnail,
        transcript: promoted.transcript,
        metadata,
        warnings: [...warnings, classification.warning]
      };
    }
    if (metadata === null)
      warnings.push("yt-dlp returned no allowlisted video metadata.");
    if (promoted.thumbnail === null)
      warnings.push("yt-dlp returned no supported video thumbnail.");
    if (promoted.transcript === null) {
      warnings.push(`yt-dlp returned no ${language} transcript for this video.`);
    }
    return {
      status: metadata !== null && promoted.thumbnail !== null && promoted.transcript !== null ? "captured" : "partial",
      thumbnail: promoted.thumbnail,
      transcript: promoted.transcript,
      metadata,
      warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      thumbnail: null,
      transcript: null,
      metadata: null,
      warnings: [...authenticationWarnings, safeRunnerFailure(message)]
    };
  } finally {
    try {
      await networkProxy?.close();
    } finally {
      if (authDirectory !== null)
        rmSync(authDirectory, { recursive: true, force: true });
      rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}

// src/clip/structured.ts
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var itemId = (value) => {
  if (typeof value === "string" && /^\d+$/.test(value))
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return null;
};
var enqueueHackerNewsChildren = (value, depth, maximumQueueSize, queue, scheduled) => {
  if (!isRecord2(value) || !Array.isArray(value.kids))
    return { duplicate: false, truncated: false };
  let duplicate = false;
  for (const child of value.kids) {
    const id = itemId(child);
    if (id === null)
      continue;
    if (scheduled.has(id)) {
      duplicate = true;
      continue;
    }
    if (queue.length >= maximumQueueSize)
      return { duplicate, truncated: true };
    scheduled.add(id);
    queue.push({ id, depth });
  }
  return { duplicate, truncated: false };
};
async function defaultJsonFetcher(options, url, maxBytes, timeoutMs = options.timeoutMs) {
  const response = await safeFetch(url, {
    timeoutMs,
    maxBytes,
    allowPrivateNetwork: options.allowPrivateNetwork,
    userAgent: options.userAgent,
    accept: "application/json",
    retries: 2
  });
  const text = decodeBytes(response.bytes, response.contentType);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON from ${url.origin}`, { cause: error });
  }
}
function serializedBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function walkDocument(document) {
  let pageItems = 0;
  let scopedItems = 0;
  let incomplete = false;
  let rootIncomplete = false;
  let blockedRoot = false;
  const active = new WeakSet;
  const visit = (entry, location) => {
    if (active.has(entry)) {
      incomplete = true;
      return;
    }
    active.add(entry);
    if (entry.kind === "boundary" || entry.kind === "more") {
      incomplete = true;
      if (location === "root")
        rootIncomplete = true;
      active.delete(entry);
      return;
    }
    const unavailable = entry.kind === "unavailable";
    const unavailableButRepresented = unavailable && (entry.reason === "deleted" || entry.reason === "dead" || entry.reason === "removed");
    const captured = entry.kind === "content" || unavailableButRepresented;
    if (location === "root" && captured)
      pageItems += 1;
    if (location === "reply" && captured)
      scopedItems += 1;
    if (unavailable && (entry.reason === "not-found" || entry.reason === "blocked"))
      incomplete = true;
    if (location === "root" && unavailable && (entry.reason === "not-found" || entry.reason === "blocked")) {
      rootIncomplete = true;
    }
    if (location === "root" && unavailable && entry.reason === "blocked")
      blockedRoot = true;
    if (entry.kind === "content") {
      for (const quote of entry.quotes)
        visit(quote, "quote");
      for (const reply of entry.replies)
        visit(reply, "reply");
    } else if (entry.kind === "unavailable") {
      for (const reply of entry.replies)
        visit(reply, "reply");
    }
    active.delete(entry);
  };
  for (const entry of document.ancestors)
    visit(entry, "ancestor");
  for (const entry of document.roots)
    visit(entry, "root");
  return { pageItems, scopedItems, incomplete, rootIncomplete, blockedRoot };
}
var rootContent = (document) => {
  const root = document.roots[0];
  return root?.kind === "content" ? root : null;
};
function structuredStatus(document, scope, adapterWarnings) {
  const walked = walkDocument(document);
  const root = rootContent(document);
  if (scope === "page") {
    return {
      status: walked.blockedRoot ? "blocked" : walked.rootIncomplete || walked.pageItems === 0 || adapterWarnings.length > 0 ? "partial" : "complete",
      capturedItems: walked.pageItems,
      expectedItems: null,
      declaredItems: null
    };
  }
  const declaredItems = root?.metrics.replies ?? null;
  const expectedItems = declaredItems === null ? null : Math.max(declaredItems, walked.scopedItems);
  if (walked.blockedRoot) {
    return { status: "blocked", capturedItems: walked.scopedItems, expectedItems, declaredItems };
  }
  const shortOfDeclared = declaredItems !== null && walked.scopedItems < declaredItems;
  return {
    status: walked.incomplete || shortOfDeclared || adapterWarnings.length > 0 ? "partial" : "complete",
    capturedItems: walked.scopedItems,
    expectedItems,
    declaredItems
  };
}
function structuredCaptureFromDocument(options, document, evidence, method, adapterWarnings, extractor = `${document.platform}-public-api`) {
  const rendered = renderCapturedDocument(document);
  const content = rendered.replace(/^# [^\n]+\n\n/, "").trim();
  const root = rootContent(document);
  const article = {
    content,
    title: document.title,
    author: root?.author?.name ?? null,
    published: root?.createdAt ?? null,
    description: null
  };
  const completeness = structuredStatus(document, options.scope, [...adapterWarnings, ...document.warnings]);
  const warnings = [...adapterWarnings, ...document.warnings];
  if (completeness.declaredItems !== null && completeness.capturedItems > completeness.declaredItems) {
    warnings.push(`The source declared ${completeness.declaredItems} scoped items, but ${completeness.capturedItems} distinct items were captured; the expected count was normalized to the observed count.`);
  }
  if (completeness.status !== "complete") {
    warnings.push(`Structured ${document.platform} capture is ${completeness.status}; limits or unavailable branches remain.`);
  }
  const acquisition = {
    body: JSON.stringify(evidence),
    contentType: "application/json",
    finalUrl: captureUrl(options),
    method,
    warnings
  };
  const wordCount = countWords(content);
  const statusWeight = {
    complete: 1e5,
    partial: 60000,
    "auth-required": 0,
    blocked: -1e4,
    unsupported: -20000
  };
  return {
    extraction: {
      article,
      canonicalUrl: new URL(document.sourceUrl),
      platform: document.platform,
      status: completeness.status,
      score: statusWeight[completeness.status] + Math.min(content.length, 50000) + completeness.capturedItems * 50,
      wordCount,
      expectedItems: completeness.expectedItems,
      capturedItems: completeness.capturedItems,
      extractor,
      warnings,
      acquisition
    },
    evidence: `${JSON.stringify(evidence, null, 2)}
`
  };
}
async function captureHackerNews(options, classified, fetchJson) {
  const endpoint = (id) => new URL(`https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(id)}.json`);
  const deadline = Date.now() + options.timeoutMs;
  let remainingBytes = options.maxHtmlBytes;
  const remainingTime = () => {
    const value = deadline - Date.now();
    if (value <= 0)
      throw new Error(`Hacker News capture exceeded the ${options.timeoutMs}ms total deadline`);
    return value;
  };
  const rootAllocation = Math.min(remainingBytes, 1024 * 1024);
  if (rootAllocation < 1)
    throw new Error("Hacker News capture has no remaining response-byte budget");
  remainingBytes -= rootAllocation;
  const root = await fetchJson(endpoint(classified.itemId), rootAllocation, remainingTime());
  const rootBytes = serializedBytes(root);
  if (!Number.isFinite(rootBytes) || rootBytes > rootAllocation) {
    throw new Error("Hacker News root item exceeded its bounded JSON allocation");
  }
  remainingBytes += rootAllocation - rootBytes;
  if (!isRecord2(root) || itemId(root.id) === null)
    throw new Error("Hacker News API returned no root item");
  if (options.scope === "page") {
    const evidence2 = { root, descendants: [] };
    const parsed2 = parseHackerNewsCapture(evidence2, classified.href, {
      limits: { maxItems: options.maxItems, maxDepth: options.maxDepth }
    });
    if (!parsed2.ok)
      throw new Error(parsed2.error.message);
    return structuredCaptureFromDocument(options, parsed2.document, evidence2, "hacker-news-api", []);
  }
  const descendants = [];
  const warnings = [];
  const scheduled = new Set([classified.itemId]);
  const queue = [];
  const initialChildren = enqueueHackerNewsChildren(root, 1, Math.max(0, options.maxItems - 1), queue, scheduled);
  let duplicateChildren = initialChildren.duplicate;
  let limited = initialChildren.truncated;
  while (queue.length > 0 && descendants.length + 1 < options.maxItems) {
    const remaining = options.maxItems - descendants.length - 1;
    const batchSize = Math.min(8, remaining, queue.length, remainingBytes);
    if (batchSize < 1) {
      limited = true;
      break;
    }
    const batch = queue.splice(0, batchSize);
    const allocation = Math.min(64 * 1024, Math.floor(remainingBytes / batch.length));
    remainingBytes -= allocation * batch.length;
    const fetched = await Promise.all(batch.map(async ({ id, depth }) => {
      try {
        const value = await fetchJson(endpoint(id), allocation, remainingTime());
        const bytes = serializedBytes(value);
        if (!Number.isFinite(bytes) || bytes > allocation) {
          return { id, depth, value: null, warning: `Hacker News item ${id} exceeded its bounded JSON allocation.` };
        }
        remainingBytes += allocation - bytes;
        return { id, depth, value, warning: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, depth, value: null, warning: `Could not fetch Hacker News item ${id}: ${message}` };
      }
    }));
    const childrenToSchedule = [];
    for (const result of fetched) {
      if (result.warning !== null)
        warnings.push(result.warning);
      if (result.value === null)
        continue;
      descendants.push(result.value);
      childrenToSchedule.push({ value: result.value, depth: result.depth });
    }
    const maximumQueueSize = Math.max(0, options.maxItems - descendants.length - 1);
    for (const result of childrenToSchedule) {
      const atDepthLimit = result.depth >= options.maxDepth - 1;
      const enqueued = enqueueHackerNewsChildren(result.value, result.depth + 1, atDepthLimit ? queue.length : maximumQueueSize, queue, scheduled);
      duplicateChildren = duplicateChildren || enqueued.duplicate;
      limited = limited || enqueued.truncated;
    }
  }
  if (duplicateChildren)
    warnings.push("Hacker News duplicate or cyclic child IDs were skipped.");
  if (queue.length > 0 || limited) {
    warnings.push("Hacker News descendants exceeded the configured item, depth, byte, or total-deadline limit.");
  }
  const evidence = { root, descendants };
  const parsed = parseHackerNewsCapture(evidence, classified.href, {
    limits: { maxItems: options.maxItems, maxDepth: options.maxDepth }
  });
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  const document = {
    ...parsed.document,
    warnings: [...parsed.document.warnings, ...warnings]
  };
  return structuredCaptureFromDocument(options, document, evidence, "hacker-news-api", warnings);
}
async function captureBluesky(options, classified, fetchJson) {
  let did = classified.actor;
  const evidence = {};
  if (!did.startsWith("did:")) {
    const resolveUrl = new URL("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle");
    resolveUrl.searchParams.set("handle", did);
    const resolution = await fetchJson(resolveUrl, Math.min(options.maxHtmlBytes, 1024 * 1024));
    evidence.resolution = resolution;
    if (!isRecord2(resolution) || typeof resolution.did !== "string" || !resolution.did.startsWith("did:")) {
      throw new Error(`Bluesky could not resolve ${classified.actor}`);
    }
    did = resolution.did;
  }
  const threadUrl = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread");
  threadUrl.searchParams.set("uri", `at://${did}/app.bsky.feed.post/${classified.postId}`);
  threadUrl.searchParams.set("depth", options.scope === "page" ? "0" : String(Math.min(options.maxDepth, 1000)));
  threadUrl.searchParams.set("parentHeight", String(Math.min(options.maxDepth, 1000)));
  const thread = await fetchJson(threadUrl, options.maxHtmlBytes);
  evidence.thread = thread;
  const parsed = parseBlueskyCapture(thread, classified.href, {
    limits: { maxItems: options.maxItems, maxDepth: options.maxDepth }
  });
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return structuredCaptureFromDocument(options, parsed.document, evidence, "bluesky-api", []);
}
function rootOnlyRedditInput(input) {
  if (!Array.isArray(input))
    return input;
  const values = input;
  const post = values[0];
  return post === undefined ? values : [post];
}
function redditHasPagination(input) {
  if (!Array.isArray(input))
    return false;
  const comments = input[1];
  if (!isRecord2(comments))
    return false;
  const data = isRecord2(comments.data) ? comments.data : null;
  return data !== null && data.after !== undefined && data.after !== null;
}
async function captureReddit(options, classified, fetchJson) {
  const endpoint = new URL(`https://www.reddit.com/comments/${encodeURIComponent(classified.postId)}.json`);
  endpoint.searchParams.set("raw_json", "1");
  endpoint.searchParams.set("limit", String(Math.max(1, options.maxItems - 1)));
  endpoint.searchParams.set("depth", String(options.scope === "page" ? 0 : options.maxDepth));
  if (classified.commentId !== null)
    endpoint.searchParams.set("comment", classified.commentId);
  const evidence = await fetchJson(endpoint, options.maxHtmlBytes, options.timeoutMs);
  const parserInput = options.scope === "page" ? rootOnlyRedditInput(evidence) : evidence;
  const parsed = parseRedditCapture(parserInput, classified.href, {
    limits: { maxItems: options.maxItems, maxDepth: options.maxDepth }
  });
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  const warnings = options.scope !== "page" && redditHasPagination(evidence) ? ["Reddit JSON returned a pagination cursor; additional comments remain uncaptured."] : [];
  const storedEvidence = options.scope === "page" ? parserInput : evidence;
  return structuredCaptureFromDocument(options, parsed.document, storedEvidence, "reddit-json", warnings, "reddit-json");
}
async function acquirePublicStructured(options, dependencies = {}) {
  const classified = classifyPlatformUrl(captureUrl(options).href);
  if (classified === null)
    return null;
  const fetchJson = dependencies.fetchJson ?? ((url, maxBytes, timeoutMs) => defaultJsonFetcher(options, url, maxBytes, timeoutMs));
  if (classified.platform === "hacker-news")
    return captureHackerNews(options, classified, fetchJson);
  if (classified.platform === "bluesky")
    return captureBluesky(options, classified, fetchJson);
  if (classified.platform === "reddit")
    return captureReddit(options, classified, fetchJson);
  return null;
}

// src/clip/capture.ts
var browserFirstPlatforms = new Set([
  "x",
  "instagram",
  "linkedin",
  "reddit",
  "facebook",
  "tiktok",
  "threads",
  "whatsapp",
  "youtube"
]);
function effectiveScope(platform, scope) {
  if (scope !== "auto")
    return scope;
  if (platform === "hacker-news" || platform === "reddit" || platform === "github" || platform === "discourse") {
    return "comments";
  }
  if (platform === "x" || platform === "bluesky")
    return "thread";
  return "page";
}
function stableContentId(url) {
  const classified = classifyPlatformUrl(url.href);
  if (classified === null)
    return null;
  switch (classified.platform) {
    case "x":
    case "bluesky":
      return classified.postId;
    case "hacker-news":
      return classified.itemId;
    case "reddit":
      return classified.commentId ?? classified.postId;
    case "github":
      return classified.contentId;
    case "discourse":
      return classified.topicId;
    case "instagram":
    case "linkedin":
    case "facebook":
    case "tiktok":
    case "threads":
    case "whatsapp":
    case "youtube":
      return classified.contentId;
    case "substack":
    case "generic":
      return null;
  }
}
function captureSlug(options, extraction) {
  if (options.slug !== undefined)
    return slugify(options.slug);
  const fallback = extraction.canonicalUrl.pathname.split("/").filter(Boolean).at(-1) ?? extraction.canonicalUrl.hostname;
  const base = slugify(redactSensitiveText(extraction.article.title ?? fallback));
  const id = stableContentId(extraction.canonicalUrl);
  if (id === null)
    return base;
  const idSlug = slugify(id);
  if (idSlug === "" || base.endsWith(`-${idSlug}`) || base === idSlug)
    return base;
  const available = Math.max(1, 80 - [...idSlug].length - 1);
  const shortened = [...base].slice(0, available).join("").replace(/-+$/g, "") || "post";
  return `${shortened}-${idSlug}`;
}
function shouldUseBrowser(options, platform, scope, directCandidates) {
  if (options.mode === "browser")
    return true;
  if (options.mode !== "auto")
    return false;
  if (options.browserProfile !== undefined || options.browserLive || options.cdp !== undefined)
    return true;
  if (options.evidence === "screenshot" || options.evidence === "all")
    return true;
  if (browserFirstPlatforms.has(platform))
    return true;
  if (scope !== "page" && platform !== "hacker-news" && platform !== "bluesky")
    return true;
  const boundedStructured = directCandidates.some((candidate) => (candidate.acquisition.method === "hacker-news-api" || candidate.acquisition.method === "bluesky-api") && candidate.warnings.some((warning) => /configured (?:item|depth)|item (?:or depth )?limit|depth limit|capture stopped at \d+ items?/i.test(warning)));
  if (boundedStructured)
    return false;
  const best = chooseBestExtraction(directCandidates);
  return best === null || best.status !== "complete" || best.wordCount < 60;
}
function safeAttemptMessage(value) {
  const message = value instanceof Error ? value.message : String(value);
  return redactSensitiveText(message).replace(/[\r\n]+/g, " ").slice(0, 1000);
}
function finalizedWarnings(values, markdownRedactions = 0) {
  const sanitized = values.map((value) => safeAttemptMessage(value));
  if (markdownRedactions > 0) {
    sanitized.push(`Redacted ${markdownRedactions} credential-shaped occurrence${markdownRedactions === 1 ? "" : "s"} from captured Markdown.`);
  }
  return [...new Set(sanitized)];
}
function statusAfterContentRewrite(status, truncated) {
  return truncated && status === "complete" ? "partial" : status;
}
function chooseCaptureExtraction(candidates, structuredCapture) {
  const structured = structuredCapture?.extraction;
  if (structured !== undefined && (structured.acquisition.method === "hacker-news-api" || structured.acquisition.method === "bluesky-api") && (structured.status === "complete" || structured.status === "partial")) {
    return structured;
  }
  return chooseBestExtraction(candidates);
}
async function tryAcquisition(method, acquire, scope, timeoutMs, extractor, candidates, attempts) {
  try {
    const acquisition = await acquire();
    const extracted = await extractor(acquisition, scope, timeoutMs);
    if (extracted === null) {
      attempts.push({ method, outcome: "failed", message: "acquisition yielded no extractable content" });
      return acquisition;
    }
    candidates.push(extracted);
    attempts.push({
      method: acquisition.method,
      outcome: "succeeded",
      message: `${extracted.status}; ${extracted.wordCount} words; ${extracted.capturedItems} items`
    });
    return acquisition;
  } catch (error) {
    attempts.push({ method, outcome: "failed", message: safeAttemptMessage(error) });
    return null;
  }
}
function screenshotIntoBundle(screenshotPath, transaction, maxBytes) {
  if (screenshotPath === null || !existsSync2(screenshotPath))
    return null;
  const stats = statSync2(screenshotPath);
  if (!stats.isFile() || stats.size > maxBytes)
    return null;
  const bytes = readFileSync2(screenshotPath);
  if (sniffImage(bytes)?.mimeType !== "image/png")
    return null;
  const evidenceDirectory = join2(transaction.stagingDirectory, "evidence");
  mkdirSync2(evidenceDirectory, { recursive: true, mode: 448 });
  const destination = join2(evidenceDirectory, "page.png");
  copyFileSync(screenshotPath, destination);
  chmodSync2(destination, 384);
  return "evidence/page.png";
}
var mediaRecordManifestAsset = (record, sourceUrl) => ({
  source: sourceUrl,
  url: sourceUrl,
  path: record.path,
  mimeType: record.mimeType,
  bytes: record.bytes,
  sha256: record.sha256
});
var mediaManifestAssets = (result, sourceUrl) => result.records.map((record) => mediaRecordManifestAsset(record, sourceUrl));
function safeMediaPath(path) {
  if (path === "" || path.startsWith("/") || /[\\\0\r\n?#]/.test(path))
    return null;
  const pieces = path.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === ".."))
    return null;
  return pieces.map((piece) => encodeURIComponent(piece)).join("/");
}
function appendCapturedMedia(content, records) {
  const lines = [];
  for (const record of records) {
    const path = safeMediaPath(record.path);
    if (path === null)
      continue;
    if (record.mimeType.startsWith("video/")) {
      lines.push(`<video controls preload="metadata" src="${path}"></video>`, `[Download video](${path})`);
    } else if (record.mimeType.startsWith("audio/")) {
      lines.push(`<audio controls preload="metadata" src="${path}"></audio>`, `[Download audio](${path})`);
    } else
      lines.push(`[Download media](${path})`);
  }
  if (lines.length === 0)
    return content;
  return `${content.trimEnd()}

## Media

${lines.join(`

`)}
`;
}
function escapedVideoMetadata(value) {
  return value.replace(/\\/gu, "\\\\").replace(/([`*_[\]<>#])/gu, "\\$1");
}
function videoDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function appendVideoContext(content, context) {
  const metadata = context.metadata;
  const details = [];
  if (metadata?.title !== undefined)
    details.push(`- **Title:** ${escapedVideoMetadata(metadata.title)}`);
  const channel = metadata?.channel ?? metadata?.uploader;
  if (channel !== undefined)
    details.push(`- **Channel:** ${escapedVideoMetadata(channel)}`);
  if (metadata?.durationSeconds !== undefined) {
    details.push(`- **Duration:** ${videoDuration(metadata.durationSeconds)}`);
  }
  if (metadata?.id !== undefined)
    details.push(`- **Video ID:** ${escapedVideoMetadata(metadata.id)}`);
  const thumbnailPath = context.thumbnail === null ? null : safeMediaPath(context.thumbnail.path);
  const sections = [];
  if (details.length > 0 || thumbnailPath !== null || metadata?.description !== undefined) {
    const video = ["## Video"];
    if (details.length > 0)
      video.push("", details.join(`
`));
    if (thumbnailPath !== null)
      video.push("", `![Video thumbnail](${thumbnailPath})`);
    if (metadata?.description !== undefined && metadata.description.trim() !== "") {
      const description = metadata.description.split(/\r?\n/gu).map(escapedVideoMetadata).join(`
`);
      video.push("", "### Description", "", description);
    }
    sections.push(video.join(`
`));
  }
  if (context.transcript !== null && context.transcript.markdown.trim() !== "") {
    sections.push(`## Transcript

${context.transcript.markdown.trimEnd()}`);
  }
  return sections.length === 0 ? content : `${content.trimEnd()}

${sections.join(`

`)}
`;
}
function articleWithVideoMetadata(article, metadata) {
  if (metadata === null)
    return article;
  const published = metadata.timestamp === undefined ? article.published : (() => {
    const date = new Date(metadata.timestamp * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : article.published;
  })();
  return {
    content: article.content,
    title: metadata.title ?? article.title,
    author: metadata.channel ?? metadata.uploader ?? article.author,
    published,
    description: metadata.description ?? article.description
  };
}
function cookieMediaOptions(options) {
  const source = options.cookieSources[0] ?? (options.browserProfile === undefined ? undefined : "chrome");
  const profile = options.cookieSources.length > 0 ? options.cookieProfile : selectedBrowserCookieProfile(options);
  return {
    ...source === undefined ? {} : { cookieBrowser: { source, ...profile === undefined ? {} : { profile } } },
    ...options.cookiesFile === undefined ? {} : { cookiesFile: options.cookiesFile }
  };
}
function selectedBrowserCookieProfile(options) {
  if (options.browserProfile === undefined)
    return;
  return options.browserProfileDirectory === undefined ? options.browserProfile : join2(options.browserProfile, options.browserProfileDirectory);
}
function assetCookieProvider(options, reader, authorizedUrl) {
  const explicit = options.cookieSources.length > 0 || options.cookiesFile !== undefined;
  if (!explicit && options.browserProfile === undefined)
    return;
  const effective = explicit ? options : {
    ...options,
    cookieSources: ["chrome"],
    cookieProfile: selectedBrowserCookieProfile(options)
  };
  let records;
  return (url) => {
    if (url.origin !== authorizedUrl.origin)
      return Promise.resolve(null);
    records ??= reader(effective, authorizedUrl);
    return records.then((result) => {
      const header = renderCookieHeader(filterCookies(result.cookies, url).cookies);
      return header === "" ? null : header;
    });
  };
}
function withBrowserProfileSnapshot(options, temporaryDirectory) {
  if (options.browserProfile === undefined || options.browserProfileOwnership === "owned")
    return options;
  const source = assertSafePersistentProfile(options);
  if (source === null)
    return options;
  const cloned = cloneBrowserProfile(source, temporaryDirectory);
  return {
    ...options,
    browserProfile: cloned.userDataPath,
    browserProfileOwnership: "owned",
    ...cloned.profileDirectory === undefined ? {} : { browserProfileDirectory: cloned.profileDirectory }
  };
}
async function runCapture(rawOptions, dependencies = {}) {
  if (rawOptions.stdout && (rawOptions.media !== "none" || rawOptions.evidence !== "none")) {
    throw new Error("stdout capture cannot request persisted media or evidence");
  }
  const deps = {
    acquireFile: dependencies.acquireFile ?? acquireFile,
    acquireHttp: dependencies.acquireHttp ?? acquireHttp,
    acquireCookieHttp: dependencies.acquireCookieHttp ?? acquireCookieHttp,
    acquireCookieRecords: dependencies.acquireCookieRecords ?? acquireCookieRecords,
    acquireBrowser: dependencies.acquireBrowser ?? acquireBrowser,
    acquirePublicStructured: dependencies.acquirePublicStructured ?? acquirePublicStructured,
    extractPage: dependencies.extractPage ?? extractPage,
    localizeAssets: dependencies.localizeAssets ?? localizeAssets,
    captureMedia: dependencies.captureMedia ?? captureMedia,
    captureVideoContext: dependencies.captureVideoContext ?? captureVideoContext,
    now: dependencies.now ?? (() => new Date)
  };
  const browserTemporaryDirectory = mkdtempSync2(join2(tmpdir2(), "hraness-kb-browser-"));
  chmodSync2(browserTemporaryDirectory, 448);
  try {
    const preparedOptions = withBrowserProfileSnapshot(rawOptions, browserTemporaryDirectory);
    let currentBrowser = null;
    let resolvedOptions = preparedOptions;
    if (preparedOptions.currentTab) {
      try {
        const acquired = await deps.acquireBrowser(preparedOptions, browserTemporaryDirectory, false);
        const sanitizedUrl = new URL(sanitizeArtifactUrl(acquired.finalUrl.href));
        currentBrowser = sanitizedUrl.href === acquired.finalUrl.href ? acquired : { ...acquired, finalUrl: sanitizedUrl };
      } catch (error) {
        throw new Error(`current browser acquisition failed: ${safeAttemptMessage(error)}`, { cause: error });
      }
      resolvedOptions = { ...preparedOptions, url: currentBrowser.finalUrl, mode: "browser" };
    }
    const requestedUrl = captureUrl(resolvedOptions);
    const platform = classifyPlatformUrl(requestedUrl.href)?.platform ?? "generic";
    const sourceUrl = canonicalizeUrl(requestedUrl, platform).href;
    const scope = effectiveScope(platform, resolvedOptions.scope);
    const options = { ...resolvedOptions, scope };
    const candidates = [];
    const attempts = [];
    const browserOperationalWarnings = [];
    let structuredCapture = null;
    const browserScreenshots = new Map;
    const eagerBrowserCandidates = [];
    const eagerBrowserAttempts = [];
    const eagerBrowserRequested = options.mode === "auto" && browserFirstPlatforms.has(platform);
    if (eagerBrowserRequested && (options.browserLive || options.cdp !== undefined)) {
      browserOperationalWarnings.push("An attached browser attempt may have navigated and scrolled the active tab even if that candidate was not selected.");
    } else if (eagerBrowserRequested && options.browserProfile !== undefined && options.browserProfileOwnership !== "owned") {
      browserOperationalWarnings.push("A selected browser profile was exercised even if that candidate was not selected; a path-backed persistent profile may have been updated by page activity.");
    }
    const eagerBrowser = eagerBrowserRequested ? tryAcquisition(options.browserLive ? "browser-live" : options.cdp === undefined ? "browser" : "browser-cdp", () => deps.acquireBrowser(options, browserTemporaryDirectory, false), scope, options.timeoutMs, deps.extractPage, eagerBrowserCandidates, eagerBrowserAttempts) : null;
    if (options.currentTab) {
      if (currentBrowser === null)
        throw new Error("current browser acquisition did not produce a page");
      const browser = await tryAcquisition(options.browserLive ? "browser-live-current" : "browser-cdp-current", () => Promise.resolve(currentBrowser), scope, options.timeoutMs, deps.extractPage, candidates, attempts);
      if (browser !== null)
        browserOperationalWarnings.push(...browser.warnings);
      if (browser?.screenshotPath !== undefined)
        browserScreenshots.set(browser, browser.screenshotPath);
    } else if (options.mode === "file") {
      await tryAcquisition("file", () => deps.acquireFile(options), scope, options.timeoutMs, deps.extractPage, candidates, attempts);
    } else {
      if (options.mode === "auto" || options.mode === "http") {
        try {
          structuredCapture = await deps.acquirePublicStructured(options);
          if (structuredCapture !== null) {
            candidates.push(structuredCapture.extraction);
            attempts.push({
              method: structuredCapture.extraction.acquisition.method,
              outcome: "succeeded",
              message: `${structuredCapture.extraction.status}; ${structuredCapture.extraction.capturedItems} items`
            });
          } else {
            attempts.push({ method: "public-api", outcome: "skipped", message: "no stable public structured adapter" });
          }
        } catch (error) {
          attempts.push({ method: "public-api", outcome: "failed", message: safeAttemptMessage(error) });
        }
        await tryAcquisition("http", () => deps.acquireHttp(options), scope, options.timeoutMs, deps.extractPage, candidates, attempts);
        if (options.cookieSources.length > 0 || options.cookiesFile !== undefined) {
          await tryAcquisition("cookie-http", () => deps.acquireCookieHttp(options), scope, options.timeoutMs, deps.extractPage, candidates, attempts);
        }
      }
      if (eagerBrowser !== null) {
        const browser = await eagerBrowser;
        candidates.push(...eagerBrowserCandidates);
        attempts.push(...eagerBrowserAttempts);
        if (browser !== null)
          browserOperationalWarnings.push(...browser.warnings);
        if (browser?.screenshotPath !== undefined)
          browserScreenshots.set(browser, browser.screenshotPath);
      } else if (shouldUseBrowser(options, platform, scope, candidates)) {
        if (options.browserLive || options.cdp !== undefined) {
          browserOperationalWarnings.push("An attached browser attempt may have navigated and scrolled the active tab even if that candidate was not selected.");
        } else if (options.browserProfile !== undefined && options.browserProfileOwnership !== "owned") {
          browserOperationalWarnings.push("A selected browser profile was exercised even if that candidate was not selected; a path-backed persistent profile may have been updated by page activity.");
        }
        const browser = await tryAcquisition(options.browserLive ? "browser-live" : options.cdp === undefined ? "browser" : "browser-cdp", () => deps.acquireBrowser(options, browserTemporaryDirectory, false), scope, options.timeoutMs, deps.extractPage, candidates, attempts);
        if (browser !== null)
          browserOperationalWarnings.push(...browser.warnings);
        if (browser?.screenshotPath !== undefined)
          browserScreenshots.set(browser, browser.screenshotPath);
      }
    }
    const best = chooseCaptureExtraction(candidates, structuredCapture);
    if (best === null) {
      const details = attempts.filter(({ outcome }) => outcome === "failed").map(({ method, message }) => `${method}: ${message}`);
      throw new Error(`no acquisition produced usable content${details.length === 0 ? "" : ` (${details.join("; ")})`}`);
    }
    const slug = captureSlug(options, best);
    if (slug === "") {
      throw new Error(options.slug === undefined ? "could not derive a safe slug; pass one after the URL" : `slug ${JSON.stringify(options.slug)} contains no letters or digits`);
    }
    const capturedAt = deps.now().toISOString();
    const attemptWarnings = attempts.filter(({ outcome }) => outcome === "failed").map(({ method, message }) => `${method} attempt failed: ${message}`);
    const warnings = [...new Set([...best.warnings, ...browserOperationalWarnings, ...attemptWarnings])];
    if (options.stdout) {
      const rewritten = rewriteContentWithStatus(best.article.content, best.canonicalUrl, new Map);
      const status = statusAfterContentRewrite(best.status, rewritten.truncated);
      const redactedMarkdown = redactSensitiveTextWithCount(buildClipMarkdown(best.article, {
        slug,
        sourceHref: best.canonicalUrl.href,
        clipped: capturedAt.slice(0, 10),
        content: rewritten.content,
        platform: best.platform,
        captureStatus: status,
        captureMethod: best.acquisition.method,
        captureScope: scope
      }));
      const wordCount = countWords(redactedMarkdown.text);
      return {
        status,
        sourceUrl,
        canonicalUrl: best.canonicalUrl.href,
        platform: best.platform,
        scope,
        slug,
        acquisitionMethod: best.acquisition.method,
        extractor: best.extractor,
        wordCount,
        capturedItems: best.capturedItems,
        expectedItems: best.expectedItems,
        outputDirectory: null,
        markdownPath: null,
        assetCount: 0,
        warnings: finalizedWarnings([
          ...warnings,
          ...rewritten.truncated ? [CONTENT_REWRITE_TRUNCATION_WARNING] : []
        ], redactedMarkdown.count),
        attempts,
        markdown: redactedMarkdown.text,
        manifest: null
      };
    }
    const transaction = beginCaptureBundle({ outputRoot: options.outputBase, slug, force: options.force });
    try {
      const imageCookieProvider = assetCookieProvider(options, deps.acquireCookieRecords, best.canonicalUrl);
      const localized = options.media === "none" ? {
        ...rewriteContentWithStatus(best.article.content, best.canonicalUrl, new Map),
        assets: [],
        warnings: []
      } : await deps.localizeAssets(best.article.content, {
        assetsDirectory: transaction.assetsDirectory,
        baseUrl: best.canonicalUrl,
        userAgent: options.userAgent,
        timeoutMs: options.timeoutMs,
        maxAssetBytes: options.maxAssetBytes,
        maxTotalAssetBytes: options.maxTotalAssetBytes,
        allowPrivateNetwork: options.allowPrivateNetwork,
        ...imageCookieProvider === undefined ? {} : { cookieHeaderProvider: imageCookieProvider }
      });
      const combinedWarnings = [
        ...warnings,
        ...localized.warnings,
        ...localized.truncated ? [CONTENT_REWRITE_TRUNCATION_WARNING] : []
      ];
      const status = statusAfterContentRewrite(best.status, localized.truncated);
      const manifestAssets = [...localized.assets];
      let videoContext = null;
      let videoContextStatus = "not-requested";
      const videoContextRequested = best.platform === "youtube" && options.media !== "none";
      if (videoContextRequested) {
        const usedBytes = manifestAssets.reduce((sum, asset) => sum + asset.bytes, 0);
        const remainingBytes = options.maxTotalAssetBytes - usedBytes;
        if (remainingBytes < 1) {
          videoContextStatus = "partial";
          combinedWarnings.push("Skipped YouTube thumbnail and transcript because the configured asset byte budget was exhausted.");
        } else {
          videoContext = await deps.captureVideoContext({
            url: best.canonicalUrl,
            outputDirectory: join2(transaction.assetsDirectory, "video"),
            relativePrefix: "assets/video",
            timeoutMs: options.timeoutMs,
            maxFileBytes: Math.min(options.maxAssetBytes, remainingBytes),
            maxTotalBytes: remainingBytes,
            allowPrivateNetwork: options.allowPrivateNetwork,
            maxFiles: Math.max(3, Math.min(options.maxItems, 12)),
            userAgent: options.userAgent,
            ...cookieMediaOptions(options)
          });
          videoContextStatus = videoContext.status === "captured" && videoContext.warnings.length > 0 ? "partial" : videoContext.status;
          if (videoContext.thumbnail !== null) {
            manifestAssets.push(mediaRecordManifestAsset(videoContext.thumbnail, best.canonicalUrl.href));
          }
          combinedWarnings.push(...videoContext.warnings);
        }
      }
      let mediaRecords = [];
      let mediaStatus = "not-requested";
      if (options.media === "all") {
        const usedBytes = manifestAssets.reduce((sum, asset) => sum + asset.bytes, 0);
        const remainingBytes = options.maxTotalAssetBytes - usedBytes;
        if (remainingBytes < 1) {
          mediaStatus = "partial";
          combinedWarnings.push("Skipped full media because the configured asset byte budget was exhausted.");
        } else {
          const media = await deps.captureMedia({
            url: best.canonicalUrl,
            outputDirectory: join2(transaction.assetsDirectory, "media"),
            relativePrefix: "assets/media",
            timeoutMs: options.timeoutMs,
            maxFileBytes: Math.min(options.maxAssetBytes, remainingBytes),
            maxTotalBytes: remainingBytes,
            allowPrivateNetwork: options.allowPrivateNetwork,
            maxFiles: Math.min(options.maxItems, 100),
            userAgent: options.userAgent,
            ...cookieMediaOptions(options)
          });
          mediaStatus = media.status === "captured" && media.warnings.length > 0 ? "partial" : media.status;
          mediaRecords = media.records;
          manifestAssets.push(...mediaManifestAssets(media, best.canonicalUrl.href));
          combinedWarnings.push(...media.warnings);
        }
      }
      const requestedScreenshot = options.evidence === "screenshot" || options.evidence === "all";
      const selectedScreenshot = browserScreenshots.get(best.acquisition) ?? null;
      const screenshotPath = requestedScreenshot ? screenshotIntoBundle(selectedScreenshot, transaction, options.maxAssetBytes) : null;
      if (requestedScreenshot && screenshotPath === null) {
        combinedWarnings.push(browserScreenshots.size > 0 ? "A screenshot was captured for a different acquisition candidate, so it was not attached to the selected content." : "A screenshot was requested but no valid bounded PNG was captured.");
      }
      const article = articleWithVideoMetadata(best.article, videoContext?.metadata ?? null);
      const contentWithVideo = videoContext === null ? localized.content : appendVideoContext(localized.content, videoContext);
      const redactedMarkdown = redactSensitiveTextWithCount(buildClipMarkdown(article, {
        slug,
        sourceHref: best.canonicalUrl.href,
        clipped: capturedAt.slice(0, 10),
        content: appendCapturedMedia(contentWithVideo, mediaRecords),
        platform: best.platform,
        captureStatus: status,
        captureMethod: best.acquisition.method,
        captureScope: scope
      }));
      const wordCount = countWords(redactedMarkdown.text);
      const finalWarnings = finalizedWarnings(combinedWarnings, redactedMarkdown.count);
      const includeSource = options.evidence === "source" || options.evidence === "all";
      const manifestInput = {
        sourceUrl,
        canonicalUrl: best.canonicalUrl.href,
        capturedAt,
        platform: best.platform,
        status,
        scope,
        acquisition: {
          method: best.acquisition.method,
          finalUrl: canonicalizeUrl(best.acquisition.finalUrl, best.platform).href,
          contentType: best.acquisition.contentType
        },
        extraction: {
          extractor: best.extractor,
          score: best.score,
          wordCount,
          capturedItems: best.capturedItems,
          expectedItems: best.expectedItems
        },
        attempts,
        assets: manifestAssets,
        artifacts: {
          images: {
            requested: options.media !== "none",
            status: options.media === "none" ? "not-requested" : localized.truncated || localized.warnings.length > 0 ? "partial" : "captured",
            files: localized.assets.length
          },
          media: {
            requested: options.media === "all",
            status: mediaStatus,
            files: mediaRecords.length
          },
          videoContext: {
            requested: videoContextRequested,
            status: videoContextStatus,
            thumbnailPath: videoContext?.thumbnail?.path ?? null,
            transcriptLanguage: videoContext?.transcript?.language ?? null,
            transcriptCueCount: videoContext?.transcript?.cueCount ?? 0,
            transcriptTruncated: videoContext?.transcript?.truncated ?? false,
            metadata: videoContext?.metadata ?? null
          }
        },
        evidence: {
          requested: options.evidence,
          screenshotPath,
          screenshotStatus: requestedScreenshot ? screenshotPath === null ? "unavailable" : "captured" : "not-requested",
          sourceHtmlStatus: includeSource ? "captured" : "not-requested"
        },
        warnings: finalWarnings
      };
      const manifest = writeCaptureBundle(transaction, {
        markdown: redactedMarkdown.text,
        manifest: manifestInput,
        ...includeSource ? { sourceHtml: best.acquisition.sourceEvidence ?? best.acquisition.body } : {}
      });
      const outputDirectory = commitCaptureBundle(transaction);
      return {
        status,
        sourceUrl,
        canonicalUrl: best.canonicalUrl.href,
        platform: best.platform,
        scope,
        slug,
        acquisitionMethod: best.acquisition.method,
        extractor: best.extractor,
        wordCount,
        capturedItems: best.capturedItems,
        expectedItems: best.expectedItems,
        outputDirectory,
        markdownPath: join2(outputDirectory, `${slug}.md`),
        assetCount: manifestAssets.length,
        warnings: finalWarnings,
        attempts,
        markdown: redactedMarkdown.text,
        manifest
      };
    } catch (error) {
      abortCaptureBundle(transaction);
      throw error;
    }
  } finally {
    rmSync2(browserTemporaryDirectory, { recursive: true, force: true });
  }
}

// src/clip/cli.ts
var defaultOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};
function line(value) {
  return value.endsWith(`
`) ? value : `${value}
`;
}
function safe(value) {
  return sanitizeTerminalLine(redactSensitiveText(value));
}
function redacted(value) {
  return redactSensitiveText(value);
}
function terminalSafeJson(value) {
  return `${JSON.stringify(value, (_key, candidate) => typeof candidate === "string" ? sanitizeTerminalText(candidate) : candidate, 2)}
`;
}
function captureSummary(outcome) {
  return {
    ok: captureSucceeded(outcome),
    status: outcome.status,
    sourceUrl: redacted(outcome.sourceUrl),
    canonicalUrl: redacted(outcome.canonicalUrl),
    platform: outcome.platform,
    scope: outcome.scope,
    slug: outcome.slug,
    acquisitionMethod: outcome.acquisitionMethod,
    extractor: outcome.extractor,
    wordCount: outcome.wordCount,
    capturedItems: outcome.capturedItems,
    expectedItems: outcome.expectedItems,
    outputDirectory: outcome.outputDirectory,
    markdownPath: outcome.markdownPath,
    assetCount: outcome.assetCount,
    warnings: outcome.warnings.map((warning) => redacted(warning)),
    attempts: outcome.attempts.map((attempt) => ({ ...attempt, message: redacted(attempt.message) })),
    manifest: outcome.manifest
  };
}
function captureSucceeded(outcome) {
  return outcome.status === "complete" || outcome.status === "partial";
}
function captureExitCode(outcome) {
  return captureSucceeded(outcome) ? 0 : 3;
}
async function diagnosticCommand(arguments_, output, inspectEnvironment) {
  const report = await inspectEnvironment();
  output.stdout(arguments_.json ? terminalSafeJson(report) : sanitizeTerminalText(renderDoctorReport(report)));
  const requiredReady = report.bun.status === "ready" && report.dependencies.every(({ status }) => status === "ready");
  return requiredReady ? 0 : 4;
}
async function main(rawArguments = process.argv.slice(2), environment = process.env, output = defaultOutput, dependencies = {}, runtimeOptions = {}) {
  const parsed = parseArguments(rawArguments, environment);
  if (!parsed.ok) {
    output.stderr(`error: ${safe(parsed.message)}

${sanitizeTerminalText(usage)}`);
    return 2;
  }
  const arguments_ = parsed.value;
  if (arguments_.command === "help") {
    output.stdout(sanitizeTerminalText(usage));
    return 0;
  }
  if (arguments_.command === "doctor") {
    return diagnosticCommand(arguments_, output, dependencies.inspectClipEnvironment ?? inspectClipEnvironment);
  }
  if (arguments_.command === "adapters") {
    output.stdout(arguments_.json ? terminalSafeJson({ schemaVersion: 1, adapters: adapterCapabilities }) : sanitizeTerminalText(renderAdapterCapabilities()));
    return 0;
  }
  if (!arguments_.quiet && !arguments_.json) {
    const target = arguments_.currentTab ? "the current browser tab" : safe(arguments_.url?.href ?? "current");
    output.stderr(`Capturing ${target} (${arguments_.mode}, ${arguments_.scope}) ...
`);
  }
  try {
    if (runtimeOptions.ownedBrowserProfile !== undefined && arguments_.browserProfile !== runtimeOptions.ownedBrowserProfile.path) {
      throw new Error("owned browser-profile execution does not match the selected private profile path");
    }
    const captureArguments = runtimeOptions.ownedBrowserProfile === undefined ? {
      ...arguments_,
      ...runtimeOptions.browserExecutable === undefined ? {} : { browserExecutable: runtimeOptions.browserExecutable }
    } : {
      ...arguments_,
      browserProfileOwnership: "owned",
      ...runtimeOptions.browserExecutable === undefined ? {} : { browserExecutable: runtimeOptions.browserExecutable },
      ...runtimeOptions.ownedBrowserProfile.profileDirectory === undefined ? {} : { browserProfileDirectory: runtimeOptions.ownedBrowserProfile.profileDirectory }
    };
    const outcome = await (dependencies.runCapture ?? runCapture)(captureArguments);
    if (arguments_.json) {
      output.stdout(terminalSafeJson(captureSummary(outcome)));
    } else if (arguments_.stdout) {
      output.stdout(sanitizeTerminalText(outcome.markdown));
    } else {
      output.stdout(line(safe(`Done: ${outcome.markdownPath ?? outcome.outputDirectory ?? outcome.slug}`)));
      output.stdout(line(safe(`Status: ${outcome.status}; ${outcome.wordCount} words; ${outcome.capturedItems}${outcome.expectedItems === null ? "" : `/${outcome.expectedItems}`} items; ${outcome.assetCount} assets.`)));
    }
    if (!arguments_.quiet && outcome.warnings.length > 0) {
      for (const warning of outcome.warnings)
        output.stderr(`warning: ${safe(warning)}
`);
    }
    return captureExitCode(outcome);
  } catch (error) {
    const message = safe(error instanceof Error ? error.message : String(error));
    if (arguments_.json)
      output.stdout(terminalSafeJson({ ok: false, error: message }));
    else
      output.stderr(`error: ${message}
`);
    return 1;
  }
}
if (import.meta.main)
  process.exitCode = await main();

export { runCapture, captureSummary, captureSucceeded, captureExitCode, main };
