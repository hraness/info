// @bun
import {
  CONTENT_REWRITE_TRUNCATION_WARNING,
  articleMetadataLimits,
  classifyPlatformUrl,
  resolveRemote,
  rewriteContentWithStatus,
  scanImageSources
} from "./index-hgve9rh2.js";
import {
  FetchFailure,
  safeFetch
} from "./index-4sh2hh3t.js";

// src/clip/assets.ts
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}
function ascii(bytes, start, length) {
  return new TextDecoder().decode(bytes.slice(start, start + length));
}
function sniffImage(bytes) {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (startsWith(bytes, [255, 216, 255]))
    return { mimeType: "image/jpeg", extension: "jpg" };
  const prefix = ascii(bytes, 0, 6);
  if (prefix === "GIF87a" || prefix === "GIF89a")
    return { mimeType: "image/gif", extension: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis")
      return { mimeType: "image/avif", extension: "avif" };
  }
  return null;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function inertAssetUrl(url) {
  const inert = new URL(url);
  inert.username = "";
  inert.password = "";
  inert.search = "";
  inert.hash = "";
  return inert.href;
}
function safeAssetFailure(error) {
  if (!(error instanceof FetchFailure))
    return "image request failed";
  switch (error.code) {
    case "private-network":
      return "image request was blocked by the private-network boundary";
    case "timeout":
      return "image request timed out";
    case "too-large":
      return "image response exceeded its byte limit";
    case "redirect":
      return "image redirect chain was rejected";
    case "dns":
      return "image hostname could not be resolved";
    case "http":
      return "image server returned an unsuccessful response";
    case "invalid-url":
      return "image URL was rejected";
    case "network":
      return "image request failed";
  }
}
async function downloadImage(source, options, maxBytes) {
  const remote = resolveRemote(source, options.baseUrl);
  if (remote === null)
    return { ok: false, source, warning: "Skipped a non-web image target.", networkBytes: 0 };
  let authenticationWarning = null;
  let cookieHeader;
  if (options.cookieHeaderProvider !== undefined) {
    try {
      cookieHeader = await options.cookieHeaderProvider(remote) ?? undefined;
    } catch {
      authenticationWarning = "The explicitly selected cookie source could not provide origin-scoped image cookies.";
    }
  }
  try {
    const response = await (options.fetchResource ?? safeFetch)(remote, {
      timeoutMs: options.timeoutMs,
      maxBytes,
      allowPrivateNetwork: options.allowPrivateNetwork,
      userAgent: options.userAgent,
      referer: options.baseUrl.href,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
      ...cookieHeader === undefined ? {} : { cookieHeader },
      retries: 0
    });
    const image = sniffImage(response.bytes);
    if (image === null) {
      const declared = response.contentType?.split(";")[0]?.trim() ?? "unknown content type";
      return {
        ok: false,
        source,
        warning: `${authenticationWarning === null ? "" : `${authenticationWarning} `}Kept remote ${inertAssetUrl(remote)}: response was not a supported raster image (${declared})`,
        networkBytes: response.bytes.byteLength
      };
    }
    return { ok: true, source, url: response.finalUrl, bytes: response.bytes, image, networkBytes: response.bytes.byteLength };
  } catch (error) {
    return {
      ok: false,
      source,
      warning: `${authenticationWarning === null ? "" : `${authenticationWarning} `}Kept remote ${inertAssetUrl(remote)}: ${safeAssetFailure(error)}`,
      networkBytes: maxBytes
    };
  }
}
async function localizeAssets(content, options) {
  const maxSources = Math.max(1, Math.min(options.maxSources ?? 1000, 1e4));
  const discovery = scanImageSources(content, maxSources + 1);
  const discoveredSources = [...discovery.sources].sort((left, right) => left.localeCompare(right));
  const sources = discoveredSources.slice(0, maxSources);
  const warnings = discoveredSources.length > sources.length ? [`Image localization stopped at ${sources.length} sources; ${discovery.truncated ? "at least " : ""}${discoveredSources.length - sources.length} additional remote image(s) remain inert links.`] : [];
  if (discovery.truncated) {
    warnings.push("Image discovery reached a safety limit; additional or over-limit image candidates remain inert.");
  }
  const rewrittenResult = (localBySource2) => {
    const rewritten2 = rewriteContentWithStatus(content, options.baseUrl, localBySource2, {
      maxImageSources: maxSources + 1
    });
    if (rewritten2.truncated)
      warnings.push(CONTENT_REWRITE_TRUNCATION_WARNING);
    return rewritten2;
  };
  if (discovery.requiresInertFallback) {
    const rewritten2 = rewrittenResult(new Map);
    return {
      ...rewritten2,
      assets: [],
      warnings
    };
  }
  if (discoveredSources.length === 0) {
    const rewritten2 = rewrittenResult(new Map);
    return {
      ...rewritten2,
      assets: [],
      warnings
    };
  }
  mkdirSync(options.assetsDirectory, { recursive: true });
  const results = new Map;
  const workerCount = Math.max(1, Math.min(options.concurrency ?? 4, sources.length, 16));
  let remainingNetworkBytes = options.maxTotalAssetBytes;
  const deadline = Date.now() + options.timeoutMs;
  for (let cursor = 0;cursor < sources.length && remainingNetworkBytes > 0; ) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0)
      break;
    const batchSize = Math.min(workerCount, sources.length - cursor, remainingNetworkBytes);
    const allocation = Math.min(options.maxAssetBytes, Math.floor(remainingNetworkBytes / batchSize));
    const batch = sources.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    remainingNetworkBytes -= allocation * batch.length;
    const downloaded = await Promise.all(batch.map((source) => downloadImage(source, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, remainingTime)) }, allocation)));
    for (const result of downloaded) {
      results.set(result.source, result);
      remainingNetworkBytes += Math.max(0, allocation - result.networkBytes);
    }
  }
  const localBySource = new Map;
  const assetsByHash = new Map;
  let totalBytes = 0;
  let unattempted = 0;
  for (const source of sources) {
    const result = results.get(source);
    if (result === undefined) {
      unattempted += 1;
      continue;
    }
    if (!result.ok) {
      warnings.push(result.warning);
      continue;
    }
    const digest = sha256(result.bytes);
    const existing = assetsByHash.get(digest);
    if (existing !== undefined) {
      localBySource.set(source, existing.path);
      continue;
    }
    if (totalBytes + result.bytes.byteLength > options.maxTotalAssetBytes) {
      warnings.push(`Kept remote ${inertAssetUrl(result.url)}: total asset limit ${options.maxTotalAssetBytes} bytes would be exceeded`);
      continue;
    }
    const filename = `${digest}.${result.image.extension}`;
    const relativePath = `assets/${filename}`;
    writeFileSync(join(options.assetsDirectory, filename), result.bytes, { mode: 420 });
    totalBytes += result.bytes.byteLength;
    const record = {
      source: (() => {
        const resolved = resolveRemote(source, options.baseUrl);
        return resolved === null ? source : inertAssetUrl(resolved);
      })(),
      url: inertAssetUrl(result.url),
      path: relativePath,
      mimeType: result.image.mimeType,
      bytes: result.bytes.byteLength,
      sha256: digest
    };
    assetsByHash.set(digest, record);
    localBySource.set(source, relativePath);
  }
  if (unattempted > 0) {
    const reason = Date.now() >= deadline ? "total asset deadline" : "aggregate asset network-byte budget";
    warnings.push(`${unattempted} remote image source(s) were not requested because the ${reason} was exhausted.`);
  }
  const rewritten = rewrittenResult(localBySource);
  return {
    ...rewritten,
    assets: [...assetsByHash.values()].sort((left, right) => left.path.localeCompare(right.path)),
    warnings
  };
}

// src/clip/extract.ts
var nonEmpty = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var MAX_RENDERED_PAGE_FALLBACK_BYTES = 256 * 1024;
var renderedPageTruncationMarker = "[Rendered page text truncated at the bounded fallback limit.]";
function isWhitespaceCodeUnit(code) {
  return code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function utf8CodePointWidth(value, index) {
  const first = value.charCodeAt(index);
  if (first <= 127)
    return { bytes: 1, codeUnits: 1 };
  if (first <= 2047)
    return { bytes: 2, codeUnits: 1 };
  const second = value.charCodeAt(index + 1);
  if (first >= 55296 && first <= 56319 && second >= 56320 && second <= 57343) {
    return { bytes: 4, codeUnits: 2 };
  }
  return { bytes: 3, codeUnits: 1 };
}
function utf8PrefixEnd(value, maxBytes) {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const width = utf8CodePointWidth(value, index);
    if (bytes + width.bytes > maxBytes)
      break;
    bytes += width.bytes;
    index += width.codeUnits;
  }
  return index;
}
function boundedRenderedPageText(value, requestedByteLimit) {
  if (typeof value !== "string")
    return null;
  const byteLimit = typeof requestedByteLimit === "number" && Number.isSafeInteger(requestedByteLimit) && requestedByteLimit > 0 ? Math.min(requestedByteLimit, MAX_RENDERED_PAGE_FALLBACK_BYTES) : MAX_RENDERED_PAGE_FALLBACK_BYTES;
  const fullEnd = utf8PrefixEnd(value, byteLimit);
  if (fullEnd === value.length) {
    const content = value.trim();
    return content === "" ? null : { content, truncated: false, byteLimit };
  }
  const detailedMarker = `

${renderedPageTruncationMarker}
`;
  const detailedMarkerBytes = new TextEncoder().encode(detailedMarker).byteLength;
  const marker = detailedMarkerBytes < byteLimit ? detailedMarker : byteLimit >= 3 ? "\u2026" : ".".repeat(byteLimit);
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  const boundedEnd = utf8PrefixEnd(value, byteLimit - markerBytes);
  const prefix = value.slice(0, boundedEnd).trim();
  if (prefix === "")
    return null;
  return { content: `${prefix}${marker}`, truncated: true, byteLimit };
}
function boundedTrimmedSlice(value, start, end, maxCodeUnits) {
  while (start < end && isWhitespaceCodeUnit(value.charCodeAt(start)))
    start += 1;
  while (end > start && isWhitespaceCodeUnit(value.charCodeAt(end - 1)))
    end -= 1;
  if (start === end)
    return null;
  if (end - start <= maxCodeUnits)
    return value.slice(start, end);
  let boundedEnd = start + Math.max(0, maxCodeUnits - 1);
  const finalCode = value.charCodeAt(boundedEnd - 1);
  if (finalCode >= 55296 && finalCode <= 56319)
    boundedEnd -= 1;
  return `${value.slice(start, boundedEnd)}\u2026`;
}
function boundedMetadata(value, maxCodeUnits) {
  return typeof value === "string" ? boundedTrimmedSlice(value, 0, value.length, maxCodeUnits) : null;
}
function countWords(value) {
  let count = 0;
  let insideWord = false;
  for (let index = 0;index < value.length; index += 1) {
    if (isWhitespaceCodeUnit(value.charCodeAt(index))) {
      insideWord = false;
    } else if (!insideWord) {
      count += 1;
      insideWord = true;
    }
  }
  return count;
}
function isAsciiWordCodeUnit(code) {
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code === 95 || code >= 97 && code <= 122;
}
function asciiCaseEqualAt(value, offset, expected, end = value.length) {
  if (offset < 0 || offset + expected.length > end)
    return false;
  for (let index = 0;index < expected.length; index += 1) {
    const actual = value.charCodeAt(offset + index);
    const folded = actual >= 65 && actual <= 90 ? actual + 32 : actual;
    if (folded !== expected.charCodeAt(index))
      return false;
  }
  return true;
}
function tagHasExactCommentClass(html, start, end) {
  const doubleQuoted = 'class="comment"';
  const singleQuoted = "class='comment'";
  for (let index = start;index < end; index += 1) {
    const preceding = index === 0 ? -1 : html.charCodeAt(index - 1);
    if (preceding >= 0 && isAsciiWordCodeUnit(preceding))
      continue;
    if (asciiCaseEqualAt(html, index, doubleQuoted, end) || asciiCaseEqualAt(html, index, singleQuoted, end))
      return true;
  }
  return false;
}
function countDefuddleCommentMarkers(html) {
  let count = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0)
      break;
    cursor = start + 1;
    if (!asciiCaseEqualAt(html, start + 1, "div"))
      continue;
    const afterName = start + 4;
    if (afterName < html.length && isAsciiWordCodeUnit(html.charCodeAt(afterName)))
      continue;
    const end = html.indexOf(">", afterName);
    if (end < 0)
      break;
    cursor = end + 1;
    if (tagHasExactCommentClass(html, afterName, end))
      count += 1;
  }
  return count;
}
function countDefuddleSeparators(html) {
  let count = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0)
      break;
    cursor = start + 1;
    if (!asciiCaseEqualAt(html, start + 1, "hr"))
      continue;
    const afterName = start + 3;
    const next = html.charCodeAt(afterName);
    if (next === 62) {
      count += 1;
      cursor = afterName + 1;
      continue;
    }
    if (!isWhitespaceCodeUnit(next))
      continue;
    const end = html.indexOf(">", afterName + 1);
    if (end < 0)
      break;
    count += 1;
    cursor = end + 1;
  }
  return count;
}
function countMarkdownMarkers(value, kind, limit) {
  const prefix = kind === "image" ? "![" : "[";
  let count = 0;
  let cursor = 0;
  while (count < limit && cursor < value.length) {
    const start = value.indexOf(prefix, cursor);
    if (start < 0)
      break;
    const openBracket = kind === "image" ? start + 1 : start;
    const closeBracket = value.indexOf("]", openBracket + 1);
    if (closeBracket < 0)
      break;
    const nonEmptyLinkLabel = kind === "image" || closeBracket > openBracket + 1;
    if (nonEmptyLinkLabel && value.charCodeAt(closeBracket + 1) === 40) {
      count += 1;
      cursor = closeBracket + 2;
    } else {
      cursor = start + prefix.length;
    }
  }
  return count;
}
function defuddleWorkerUrl(moduleUrl = import.meta.url) {
  return moduleUrl.endsWith(".ts") ? new URL("./defuddle-worker.ts", moduleUrl) : new URL("./clip/defuddle-worker.js", moduleUrl);
}
async function runDefuddleWorker(acquisition, scope, timeoutMs) {
  const worker = new Worker(defuddleWorkerUrl().href, { type: "module" });
  let timeout;
  try {
    const result = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Defuddle exceeded the ${timeoutMs}ms extraction deadline.`));
      }, timeoutMs);
      worker.onmessage = (event) => {
        const message = event.data;
        if (!isRecord(message) || typeof message.ok !== "boolean") {
          reject(new Error("Defuddle worker returned malformed data."));
          return;
        }
        if (message.ok === true && isRecord(message.value)) {
          resolve({ ok: true, value: message.value });
          return;
        }
        resolve({
          ok: false,
          message: typeof message.message === "string" ? message.message.slice(0, 1000) : "Defuddle worker failed."
        });
      };
      worker.onerror = () => reject(new Error("Defuddle worker failed."));
      worker.postMessage({
        html: acquisition.body,
        url: acquisition.finalUrl.href,
        includeReplies: scope === "page" ? false : scope === "comments" ? true : "extractors"
      });
    });
    if (!result.ok)
      throw new Error(result.message);
    return result.value;
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
    worker.terminate();
  }
}
function detectPlatform(url) {
  return classifyPlatformUrl(url.href)?.platform ?? "generic";
}
function detectedExtractorPlatform(value, fallback) {
  if (fallback !== "generic")
    return fallback;
  return value === "github" ? "github" : value === "discourse" ? "discourse" : fallback;
}
var trackingKeys = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "mibextid"
]);
var credentialQueryKey = /(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|auth(?:orization)?|api[-_]?key|credential|csrf|xsrf|jwt|pass(?:word|wd)?|secret|session[-_]?id|signature|sig|code|ticket|otp|nonce|key|magic[-_]?link|one[-_]?time)(?:$|[-_])/i;
function canonicalizeUrl(url, platform = detectPlatform(url)) {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || trackingKeys.has(key.toLowerCase()) || credentialQueryKey.test(key)) {
      canonical.searchParams.delete(key);
    }
  }
  if (platform === "x") {
    canonical.hostname = "x.com";
    canonical.searchParams.delete("s");
    canonical.searchParams.delete("t");
  }
  return canonical;
}
var MAX_SCHEMA_COMMENT_NODES = 50000;
function schemaCommentCount(value) {
  const seen = new Set;
  const stack = [value];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SCHEMA_COMMENT_NODES) {
    const current = stack.pop();
    visited += 1;
    if (typeof current !== "object" || current === null || seen.has(current))
      continue;
    seen.add(current);
    if (Array.isArray(current)) {
      const remaining2 = MAX_SCHEMA_COMMENT_NODES - visited;
      for (let index = Math.min(current.length, remaining2) - 1;index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current))
      continue;
    const own = current.commentCount;
    if (typeof own === "number" && Number.isSafeInteger(own) && own >= 0)
      return own;
    if (typeof own === "string" && /^\d+$/.test(own)) {
      const parsed = Number(own);
      if (Number.isSafeInteger(parsed))
        return parsed;
    }
    const children = [];
    const remaining = MAX_SCHEMA_COMMENT_NODES - visited;
    if (remaining <= 0)
      continue;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key))
        continue;
      children.push(current[key]);
      if (children.length >= remaining)
        break;
    }
    for (let index = children.length - 1;index >= 0; index -= 1)
      stack.push(children[index]);
  }
  return null;
}
function countDefuddleConversationItems(response, platform) {
  const html = nonEmpty(response.content);
  const extractorType = nonEmpty(response.extractorType);
  if (html === null || extractorType === null)
    return null;
  const supported = new Set(["twitter", "reddit", "hackernews", "github", "discourse", "linkedin"]);
  if (!supported.has(extractorType))
    return null;
  const comments = countDefuddleCommentMarkers(html);
  if (platform !== "x" || extractorType !== "twitter")
    return comments;
  const separators = countDefuddleSeparators(html);
  return comments + Math.max(0, separators - (comments > 0 ? 1 : 0));
}
function restoreXPostLineBreaks(content, description) {
  if (description === null || !/[\r\n]/.test(description))
    return content;
  const preserved = description.replace(/\r\n?/g, `
`).trim();
  const flattened = preserved.replace(/\s+/g, " ");
  const offset = content.indexOf(flattened);
  if (offset < 0)
    return content;
  const literal = preserved.split(`
`).map((line) => {
    let escaped = line.replace(/\\/g, "\\\\").replace(/([`*_~[\]])/g, "\\$1").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    escaped = escaped.replace(/^(\s*)(#{1,6}|[-+]|\d+[.)])(?=\s)/, "$1\\$2");
    if (/^\s*-{3,}\s*$/.test(escaped))
      escaped = escaped.replace("-", "\\-");
    if (/^(?: {4}|\t)/.test(escaped))
      escaped = `&#32;${escaped.slice(1)}`;
    return escaped;
  }).join(`
`);
  return `${content.slice(0, offset)}${literal}${content.slice(offset + flattened.length)}`;
}
function normalizedDefuddleMediaUrl(value, baseUrl) {
  const candidate = nonEmpty(value);
  if (candidate === null || candidate.length > 8192)
    return null;
  const resolved = resolveRemote(candidate, baseUrl);
  if (resolved === null || resolved.username !== "" || resolved.password !== "")
    return null;
  resolved.hash = "";
  return resolved;
}
var defuddleInlineImage = /!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]*)>|([^()\s\r\n]+))((?:\s+"[^"\r\n]*")?)\)/g;
function removeDefuddleSamePageImages(content, reportedImage, baseUrl) {
  const exactCandidates = new Set;
  const exactPage = new URL(baseUrl);
  exactPage.hash = "";
  exactCandidates.add(exactPage.href);
  const reported = normalizedDefuddleMediaUrl(reportedImage, baseUrl);
  if (reported !== null && reported.origin === baseUrl.origin && reported.pathname === baseUrl.pathname)
    exactCandidates.add(reported.href);
  return content.replace(defuddleInlineImage, (whole, _alt, bracketed, bare) => {
    const image = normalizedDefuddleMediaUrl(bracketed ?? bare, baseUrl);
    return image !== null && exactCandidates.has(image.href) ? "" : whole;
  });
}
function retainDefuddleMedia(content, response, baseUrl) {
  content = removeDefuddleSamePageImages(content, response.image, baseUrl);
  const existing = new Set;
  const scan = scanImageSources(content);
  for (const source of scan.sources) {
    const url = normalizedDefuddleMediaUrl(source, baseUrl);
    if (url !== null)
      existing.add(url.href);
  }
  const candidates = [
    { value: response.image, label: "Cover image" }
  ];
  if (Array.isArray(response.captureVideoPosters)) {
    const maximum = Math.min(response.captureVideoPosters.length, 64);
    for (let index = 0;index < maximum; index += 1) {
      candidates.push({ value: response.captureVideoPosters[index], label: "Video thumbnail" });
    }
  }
  const additions = [];
  for (const candidate of candidates) {
    const url = normalizedDefuddleMediaUrl(candidate.value, baseUrl);
    if (url === null || existing.has(url.href) || url.origin === baseUrl.origin && url.pathname === baseUrl.pathname)
      continue;
    existing.add(url.href);
    additions.push(`![${candidate.label}](<${url.href}>)`);
  }
  return additions.length === 0 ? content : `${content.trimEnd()}

${additions.join(`

`)}
`;
}
function compactCount(value, suffix) {
  const number = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0)
    return null;
  const multiplier = suffix?.toLowerCase() === "m" ? 1e6 : suffix?.toLowerCase() === "k" ? 1000 : 1;
  const result = Math.floor(number * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}
function visibleCommentCount(content, platform) {
  const patterns = platform === "x" ? [/\bread\s+([\d,.]+)\s*([km])?\s+repl(?:y|ies)\b/i, /\b([\d,.]+)\s*([km])?\s+repl(?:y|ies)\b/i] : [/\b(?:view|read|show)\s+(?:all\s+)?([\d,.]+)\s*([km])?\s+comments?\b/i];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[1] === undefined)
      continue;
    const count = compactCount(match[1], match[2]);
    if (count !== null)
      return count;
  }
  return null;
}
var blockedPattern = /(?:verify (?:that )?you are (?:a )?human|(?:complete|solve) (?:the )?captcha|\bcaptcha\b|access denied|request (?:has been )?blocked|unusual traffic|cloudflare ray id)/i;
var blockedTitlePattern = /^(?:403(?: forbidden)?|access denied|request blocked|unusual traffic|verify (?:that )?you are (?:a )?human|human verification|captcha|security (?:check|verification)|attention required|just a moment(?:\.{3})?)$/i;
var blockedContextPattern = /(?:\b(?:please )?(?:verify|confirm) (?:that )?you are (?:a )?human\b|\b(?:complete|solve) (?:the )?captcha\b|\b(?:you (?:do not|don't) have permission|you have been blocked)\b|\b(?:your|this) (?:request|access|ip(?: address)?) (?:has been|was|is) blocked\b|\bunusual traffic from your (?:computer )?network\b|\bautomated (?:queries|requests)\b|\b(?:before proceeding|to continue),? (?:please )?(?:verify|complete|enable)\b|\bcloudflare ray id\b)/i;
var blockedStandaloneLinePattern = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:403(?: forbidden)?|access denied|request blocked|unusual traffic|verify (?:that )?you are (?:a )?human|captcha|security (?:check|verification))[.!]?[ \t]*(?:\r?\n|$)/i;
var articleDiscussionPattern = /(?:\bhow to\b|\btroubleshoot(?:ing)?\b|\b(?:this|the) (?:article|guide|tutorial)\b|\b(?:this|the) (?:article|guide|tutorial) explains?\b|\blearn (?:how|why)\b)/i;
var MAX_BLOCKED_SHELL_CODE_UNITS = 4096;
var MAX_BLOCKED_SHELL_WORDS = 160;
var MAX_STANDALONE_BLOCKED_SHELL_WORDS = 24;
function looksLikeBlockedShell(content, title) {
  if (content.length > MAX_BLOCKED_SHELL_CODE_UNITS)
    return false;
  const wordCount = countWords(content);
  if (wordCount > MAX_BLOCKED_SHELL_WORDS)
    return false;
  const normalizedTitle = (title ?? "").slice(0, articleMetadataLimits.title).replace(/\s+/g, " ").trim();
  const boundedVisible = `${normalizedTitle}
${content}`;
  if (articleDiscussionPattern.test(boundedVisible))
    return false;
  if (wordCount <= MAX_STANDALONE_BLOCKED_SHELL_WORDS && blockedStandaloneLinePattern.test(content))
    return true;
  const exactGateTitle = blockedTitlePattern.test(normalizedTitle);
  const hasBlockSignal = exactGateTitle || blockedPattern.test(content);
  return hasBlockSignal && (exactGateTitle || blockedContextPattern.test(content));
}
var authenticationGatePattern = /(?:\b(?:sign|log) in to (?:continue|read|view|see|access|comment|reply)\b|\blogin required\b|\bmembers? only\b|\bsubscriber-only\b|\bsubscribe to (?:continue|read)\b|\bthis content is private\b|\byou must be logged in\b)/i;
var shellPattern = /(?:enable javascript|javascript is disabled|something went wrong|try reloading)/i;
var xReplyGatePattern = /\bjoin\s+x\s+now\s+to\s+read\s+repl(?:y|ies)\b/i;
var xCombinedAccountShellPattern = /\blog\s*in\s*sign\s*up\b/i;
var loginShellPattern = /\blog\s*in\b/i;
var signupShellPattern = /\bsign\s*up\b/i;
function isRenderedConversationAccessGate(content, platform) {
  if (authenticationGatePattern.test(content))
    return true;
  return platform === "x" && (xReplyGatePattern.test(content) || xCombinedAccountShellPattern.test(content) || loginShellPattern.test(content) && signupShellPattern.test(content));
}
function statusFor(content, title, scope, contentTruncated, renderedTextFallback) {
  const visible = `${title ?? ""}
${content}`;
  if (looksLikeBlockedShell(content, title))
    return "blocked";
  if (authenticationGatePattern.test(visible) && content.length < 1500)
    return "auth-required";
  if (shellPattern.test(visible) && content.length < 500)
    return "unsupported";
  if (content.trim().length < 40)
    return "unsupported";
  if (authenticationGatePattern.test(visible))
    return "partial";
  if (contentTruncated || renderedTextFallback)
    return "partial";
  if (scope === "thread" || scope === "comments")
    return "partial";
  return "complete";
}
function qualityScore(article, status, wordCount, capturedItems, acquisition) {
  const statusWeight = {
    complete: 5000,
    partial: 2000,
    "auth-required": -2000,
    blocked: -4000,
    unsupported: -5000
  };
  const images = countMarkdownMarkers(article.content, "image", 100);
  const links = countMarkdownMarkers(article.content, "link", 500);
  const acquisitionAdjustment = acquisition.method.startsWith("browser") ? acquisition.contentType?.toLowerCase().includes("text/plain") === true ? -500 : 0 : 0;
  return statusWeight[status] + Math.min(article.content.length, 50000) + Math.min(wordCount, 1e4) * 5 + Math.min(capturedItems, 1000) * 50 + images * 100 + links * 5 + acquisitionAdjustment;
}
function plainTextArticle(acquisition) {
  const content = acquisition.body.trim();
  if (content === "")
    return null;
  const browserTitle = boundedMetadata(acquisition.browserTitle, articleMetadataLimits.title);
  const firstHeading = browserTitle === null ? firstMarkdownHeading(content) : null;
  const pathname = acquisition.finalUrl.pathname;
  let pathEnd = pathname.length;
  while (pathEnd > 0 && pathname.charCodeAt(pathEnd - 1) === 47)
    pathEnd -= 1;
  const pathStart = pathname.lastIndexOf("/", pathEnd - 1) + 1;
  const lastSegment = boundedTrimmedSlice(pathname, pathStart, pathEnd, articleMetadataLimits.title);
  return {
    content,
    title: browserTitle ?? firstHeading ?? lastSegment ?? boundedMetadata(acquisition.finalUrl.hostname, articleMetadataLimits.title),
    author: null,
    published: null,
    description: null
  };
}
function firstMarkdownHeading(content) {
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf(`
`, lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    let cursor = lineStart;
    let hashes = 0;
    while (hashes < 3 && cursor < lineEnd && content.charCodeAt(cursor) === 35) {
      hashes += 1;
      cursor += 1;
    }
    if (hashes > 0 && cursor < lineEnd && (content.charCodeAt(cursor) === 32 || content.charCodeAt(cursor) === 9)) {
      const heading = boundedTrimmedSlice(content, cursor, lineEnd, articleMetadataLimits.title);
      if (heading !== null)
        return heading;
    }
    if (newline < 0)
      break;
    lineStart = newline + 1;
  }
  return null;
}
async function extractPage(acquisition, scope, timeoutMs = 30000) {
  let platform = detectPlatform(acquisition.finalUrl);
  const contentType = acquisition.contentType?.toLowerCase() ?? "";
  let article = null;
  let wordCount = 0;
  let expectedItems = null;
  let structurallyCapturedItems = null;
  let extractor = "plain-text";
  const warnings = [...acquisition.warnings];
  const renderedPage = scope === "page" && acquisition.method.startsWith("browser") ? boundedRenderedPageText(acquisition.renderedText, acquisition.renderedTextByteLimit) : null;
  let renderedPageFallback = false;
  let renderedPageFallbackTruncated = false;
  if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
    article = plainTextArticle(acquisition);
    wordCount = article === null ? 0 : countWords(article.content);
    if (acquisition.method.startsWith("browser")) {
      warnings.push("Rendered readable-text fallback may include surrounding account or interface content; review it before reuse.");
    }
  } else {
    try {
      const response = await runDefuddleWorker(acquisition, scope, timeoutMs);
      platform = detectedExtractorPlatform(response.extractorType, platform);
      const content = nonEmpty(response.contentMarkdown) ?? nonEmpty(response.content);
      if (content !== null) {
        const description = boundedMetadata(response.description, articleMetadataLimits.description);
        const restoredContent = platform === "x" ? restoreXPostLineBreaks(content, description) : content;
        article = {
          content: retainDefuddleMedia(restoredContent, response, acquisition.finalUrl),
          title: boundedMetadata(response.title, articleMetadataLimits.title) ?? boundedMetadata(acquisition.browserTitle, articleMetadataLimits.title),
          author: boundedMetadata(response.author, articleMetadataLimits.author),
          published: boundedMetadata(response.published, articleMetadataLimits.published),
          description
        };
        wordCount = typeof response.wordCount === "number" && Number.isSafeInteger(response.wordCount) && response.wordCount >= 0 ? response.wordCount : countWords(content);
        expectedItems = schemaCommentCount(response.schemaOrgData);
        structurallyCapturedItems = countDefuddleConversationItems(response, platform);
        extractor = platform === "generic" ? "defuddle" : `defuddle:${platform}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (renderedPage !== null) {
        warnings.push("Article extraction failed; evaluated the bounded rendered-page text fallback from the same browser navigation.");
      } else {
        throw new Error(`Defuddle could not parse this acquisition: ${message}`, { cause: error });
      }
    }
  }
  if (renderedPage !== null) {
    const primaryStatus = article === null ? "unsupported" : statusFor(article.content, article.title, scope, acquisition.contentTruncated === true, false);
    const fallbackBase = plainTextArticle({
      ...acquisition,
      body: renderedPage.content,
      contentType: "text/plain; charset=utf-8"
    });
    if (fallbackBase !== null) {
      const fallbackStatus = statusFor(fallbackBase.content, fallbackBase.title, scope, renderedPage.truncated || acquisition.renderedTextTruncated === true, true);
      if (article === null || primaryStatus === "unsupported" && fallbackStatus !== "unsupported") {
        const primary = article;
        article = {
          ...fallbackBase,
          title: primary?.title ?? fallbackBase.title,
          author: primary?.author ?? fallbackBase.author,
          published: primary?.published ?? fallbackBase.published,
          description: primary?.description ?? fallbackBase.description
        };
        wordCount = countWords(article.content);
        extractor = primary === null ? "rendered-page" : `${extractor}+rendered-page`;
        renderedPageFallback = true;
        renderedPageFallbackTruncated = renderedPage.truncated || acquisition.renderedTextTruncated === true;
        warnings.push("Used bounded rendered-page text because article extraction produced no usable page body; it may include surrounding account or interface text and cannot prove feed completeness.");
        if (renderedPageFallbackTruncated) {
          warnings.push(`Rendered-page text reached the ${renderedPage.byteLimit}-byte fallback limit or the browser read boundary and was truncated.`);
        }
      }
    }
  }
  if (article === null)
    return null;
  const renderedConversation = scope !== "page" && structurallyCapturedItems === null ? nonEmpty(acquisition.renderedText) : null;
  if (renderedConversation !== null && renderedConversation !== article.content.trim()) {
    if (isRenderedConversationAccessGate(renderedConversation, platform)) {
      warnings.push("Skipped the separately rendered conversation context because it exposed an access gate rather than a trustworthy reply or comment tree.");
    } else {
      article = {
        ...article,
        content: `${article.content.trimEnd()}

## Rendered conversation context

${renderedConversation}
`
      };
      wordCount = countWords(article.content);
      extractor = `${extractor}+rendered-context`;
      warnings.push("Preserved the separately rendered conversation context because the article extractor exposed no trustworthy item tree; it can include duplicated article, account, or interface text.");
    }
  }
  expectedItems ??= visibleCommentCount(article.content, platform);
  const capturedItems = scope === "page" ? 1 : structurallyCapturedItems ?? 0;
  if (scope === "page") {
    expectedItems = null;
  } else if (structurallyCapturedItems === null) {
    warnings.push("The rendered response exposed no trustworthy per-item structure; capturedItems is conservatively reported as 0.");
  } else if (expectedItems !== null && capturedItems > expectedItems) {
    warnings.push(`The source declared ${expectedItems} scoped items, but ${capturedItems} items were observed; the expected count was normalized to the observed count.`);
    expectedItems = capturedItems;
  }
  const status = statusFor(article.content, article.title, scope, renderedPageFallback ? renderedPageFallbackTruncated : acquisition.contentTruncated === true, renderedPageFallback || acquisition.method.startsWith("browser") && contentType.includes("text/plain"));
  if (status !== "complete")
    warnings.push(`Capture status is ${status}; inspect the source before relying on completeness.`);
  const canonicalUrl = canonicalizeUrl(acquisition.finalUrl, platform);
  return {
    article,
    canonicalUrl,
    platform,
    status,
    score: qualityScore(article, status, wordCount, capturedItems, acquisition),
    wordCount,
    expectedItems,
    capturedItems,
    extractor,
    warnings,
    acquisition
  };
}
function chooseBestExtraction(candidates) {
  const statusRank = {
    complete: 5,
    partial: 4,
    "auth-required": 3,
    blocked: 2,
    unsupported: 1
  };
  let best = null;
  for (const candidate of candidates) {
    if (best === null || statusRank[candidate.status] > statusRank[best.status] || statusRank[candidate.status] === statusRank[best.status] && candidate.score > best.score)
      best = candidate;
  }
  return best;
}

export { sniffImage, localizeAssets, countWords, canonicalizeUrl, extractPage, chooseBestExtraction };
