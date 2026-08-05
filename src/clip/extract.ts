import type { CaptureScope } from "./args.js";
import type { AcquiredPage } from "./acquire.js";
import {
  articleMetadataLimits,
  resolveRemote,
  scanImageSources,
  type Article,
} from "./lib.js";
import { classifyPlatformUrl, type Platform as ClassifiedPlatform } from "./platforms.js";

export type CaptureStatus =
  | "complete"
  | "partial"
  | "auth-required"
  | "blocked"
  | "unsupported";

export type Platform = ClassifiedPlatform;

export type ExtractedPage = {
  readonly article: Article;
  readonly canonicalUrl: URL;
  readonly platform: Platform;
  readonly status: CaptureStatus;
  readonly score: number;
  readonly wordCount: number;
  readonly expectedItems: number | null;
  readonly capturedItems: number;
  readonly extractor: string;
  readonly warnings: readonly string[];
  readonly acquisition: AcquiredPage;
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const MAX_RENDERED_PAGE_FALLBACK_BYTES = 256 * 1024;
const renderedPageTruncationMarker = "[Rendered page text truncated at the bounded fallback limit.]";

type BoundedRenderedText = {
  readonly content: string;
  readonly truncated: boolean;
  readonly byteLimit: number;
};

function isWhitespaceCodeUnit(code: number): boolean {
  return (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020
    || code === 0x00a0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function utf8CodePointWidth(value: string, index: number): { readonly bytes: number; readonly codeUnits: number } {
  const first = value.charCodeAt(index);
  if (first <= 0x7f) return { bytes: 1, codeUnits: 1 };
  if (first <= 0x7ff) return { bytes: 2, codeUnits: 1 };
  const second = value.charCodeAt(index + 1);
  if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
    return { bytes: 4, codeUnits: 2 };
  }
  return { bytes: 3, codeUnits: 1 };
}

function utf8PrefixEnd(value: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const width = utf8CodePointWidth(value, index);
    if (bytes + width.bytes > maxBytes) break;
    bytes += width.bytes;
    index += width.codeUnits;
  }
  return index;
}

/** Bound unstructured browser text before it can become retained page content. */
export function boundedRenderedPageText(value: unknown, requestedByteLimit?: unknown): BoundedRenderedText | null {
  if (typeof value !== "string") return null;
  const byteLimit = typeof requestedByteLimit === "number"
    && Number.isSafeInteger(requestedByteLimit)
    && requestedByteLimit > 0
    ? Math.min(requestedByteLimit, MAX_RENDERED_PAGE_FALLBACK_BYTES)
    : MAX_RENDERED_PAGE_FALLBACK_BYTES;
  const fullEnd = utf8PrefixEnd(value, byteLimit);
  if (fullEnd === value.length) {
    const content = value.trim();
    return content === "" ? null : { content, truncated: false, byteLimit };
  }

  const detailedMarker = `\n\n${renderedPageTruncationMarker}\n`;
  const detailedMarkerBytes = new TextEncoder().encode(detailedMarker).byteLength;
  const marker = detailedMarkerBytes < byteLimit
    ? detailedMarker
    : byteLimit >= 3 ? "…" : ".".repeat(byteLimit);
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  const boundedEnd = utf8PrefixEnd(value, byteLimit - markerBytes);
  const prefix = value.slice(0, boundedEnd).trim();
  if (prefix === "") return null;
  return { content: `${prefix}${marker}`, truncated: true, byteLimit };
}

function boundedTrimmedSlice(value: string, start: number, end: number, maxCodeUnits: number): string | null {
  while (start < end && isWhitespaceCodeUnit(value.charCodeAt(start))) start += 1;
  while (end > start && isWhitespaceCodeUnit(value.charCodeAt(end - 1))) end -= 1;
  if (start === end) return null;
  if (end - start <= maxCodeUnits) return value.slice(start, end);
  let boundedEnd = start + Math.max(0, maxCodeUnits - 1);
  const finalCode = value.charCodeAt(boundedEnd - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) boundedEnd -= 1;
  return `${value.slice(start, boundedEnd)}…`;
}

function boundedMetadata(value: unknown, maxCodeUnits: number): string | null {
  return typeof value === "string"
    ? boundedTrimmedSlice(value, 0, value.length, maxCodeUnits)
    : null;
}

/** Count ECMAScript whitespace-delimited words without materializing a token array. */
export function countWords(value: string): number {
  let count = 0;
  let insideWord = false;
  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespaceCodeUnit(value.charCodeAt(index))) {
      insideWord = false;
    } else if (!insideWord) {
      count += 1;
      insideWord = true;
    }
  }
  return count;
}

function isAsciiWordCodeUnit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || code === 0x5f
    || (code >= 0x61 && code <= 0x7a);
}

function asciiCaseEqualAt(value: string, offset: number, expected: string, end = value.length): boolean {
  if (offset < 0 || offset + expected.length > end) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value.charCodeAt(offset + index);
    const folded = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual;
    if (folded !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function tagHasExactCommentClass(html: string, start: number, end: number): boolean {
  const doubleQuoted = 'class="comment"';
  const singleQuoted = "class='comment'";
  for (let index = start; index < end; index += 1) {
    const preceding = index === 0 ? -1 : html.charCodeAt(index - 1);
    if (preceding >= 0 && isAsciiWordCodeUnit(preceding)) continue;
    if (
      asciiCaseEqualAt(html, index, doubleQuoted, end)
      || asciiCaseEqualAt(html, index, singleQuoted, end)
    ) return true;
  }
  return false;
}

function countDefuddleCommentMarkers(html: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    cursor = start + 1;
    if (!asciiCaseEqualAt(html, start + 1, "div")) continue;
    const afterName = start + 4;
    if (afterName < html.length && isAsciiWordCodeUnit(html.charCodeAt(afterName))) continue;
    const end = html.indexOf(">", afterName);
    if (end < 0) break;
    cursor = end + 1;
    if (tagHasExactCommentClass(html, afterName, end)) count += 1;
  }
  return count;
}

function countDefuddleSeparators(html: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    cursor = start + 1;
    if (!asciiCaseEqualAt(html, start + 1, "hr")) continue;
    const afterName = start + 3;
    const next = html.charCodeAt(afterName);
    if (next === 0x3e) {
      count += 1;
      cursor = afterName + 1;
      continue;
    }
    if (!isWhitespaceCodeUnit(next)) continue;
    const end = html.indexOf(">", afterName + 1);
    if (end < 0) break;
    count += 1;
    cursor = end + 1;
  }
  return count;
}

function countMarkdownMarkers(value: string, kind: "image" | "link", limit: number): number {
  const prefix = kind === "image" ? "![" : "[";
  let count = 0;
  let cursor = 0;
  while (count < limit && cursor < value.length) {
    const start = value.indexOf(prefix, cursor);
    if (start < 0) break;
    const openBracket = kind === "image" ? start + 1 : start;
    const closeBracket = value.indexOf("]", openBracket + 1);
    if (closeBracket < 0) break;
    const nonEmptyLinkLabel = kind === "image" || closeBracket > openBracket + 1;
    if (nonEmptyLinkLabel && value.charCodeAt(closeBracket + 1) === 0x28) {
      count += 1;
      cursor = closeBracket + 2;
    } else {
      cursor = start + prefix.length;
    }
  }
  return count;
}

type DefuddleWorkerResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

export function defuddleWorkerUrl(moduleUrl = import.meta.url): URL {
  return moduleUrl.endsWith(".ts")
    ? new URL("./defuddle-worker.ts", moduleUrl)
    : new URL("./clip/defuddle-worker.js", moduleUrl);
}

async function runDefuddleWorker(
  acquisition: AcquiredPage,
  scope: CaptureScope,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const worker = new Worker(defuddleWorkerUrl().href, { type: "module" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<DefuddleWorkerResult>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Defuddle exceeded the ${timeoutMs}ms extraction deadline.`));
      }, timeoutMs);
      worker.onmessage = (event: MessageEvent<unknown>): void => {
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
          message: typeof message.message === "string"
            ? message.message.slice(0, 1_000)
            : "Defuddle worker failed.",
        });
      };
      worker.onerror = (): void => reject(new Error("Defuddle worker failed."));
      worker.postMessage({
        html: acquisition.body,
        url: acquisition.finalUrl.href,
        includeReplies: scope === "page" ? false : scope === "comments" ? true : "extractors",
      });
    });
    if (!result.ok) throw new Error(result.message);
    return result.value;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    worker.terminate();
  }
}

export function detectPlatform(url: URL): Platform {
  return classifyPlatformUrl(url.href)?.platform ?? "generic";
}

function detectedExtractorPlatform(value: unknown, fallback: Platform): Platform {
  if (fallback !== "generic") return fallback;
  return value === "github" ? "github" : value === "discourse" ? "discourse" : fallback;
}

const trackingKeys = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "mibextid",
]);
const credentialQueryKey = /(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|auth(?:orization)?|api[-_]?key|credential|csrf|xsrf|jwt|pass(?:word|wd)?|secret|session[-_]?id|signature|sig|code|ticket|otp|nonce|key|magic[-_]?link|one[-_]?time)(?:$|[-_])/i;

/** Remove known tracking parameters while preserving content-bearing query state. */
export function canonicalizeUrl(url: URL, platform = detectPlatform(url)): URL {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_")
      || trackingKeys.has(key.toLowerCase())
      || credentialQueryKey.test(key)
    ) {
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

const MAX_SCHEMA_COMMENT_NODES = 50_000;

/** Find the first depth-first schema.org comment count without recursive or unbounded traversal. */
export function schemaCommentCount(value: unknown): number | null {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SCHEMA_COMMENT_NODES) {
    const current = stack.pop();
    visited += 1;
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      const remaining = MAX_SCHEMA_COMMENT_NODES - visited;
      for (let index = Math.min(current.length, remaining) - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current)) continue;
    const own = current.commentCount;
    if (typeof own === "number" && Number.isSafeInteger(own) && own >= 0) return own;
    if (typeof own === "string" && /^\d+$/.test(own)) {
      const parsed = Number(own);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    const children: unknown[] = [];
    const remaining = MAX_SCHEMA_COMMENT_NODES - visited;
    if (remaining <= 0) continue;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      children.push(current[key]);
      if (children.length >= remaining) break;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return null;
}

/** Count only the fixed structural markers emitted by Defuddle's conversational extractors. */
export function countDefuddleConversationItems(response: Readonly<Record<string, unknown>>, platform: Platform): number | null {
  const html = nonEmpty(response.content);
  const extractorType = nonEmpty(response.extractorType);
  if (html === null || extractorType === null) return null;
  const supported = new Set(["twitter", "reddit", "hackernews", "github", "discourse", "linkedin"]);
  if (!supported.has(extractorType)) return null;
  const comments = countDefuddleCommentMarkers(html);
  if (platform !== "x" || extractorType !== "twitter") return comments;

  // Twitter self-replies are emitted as top-level post fragments separated by <hr>;
  // a populated public-replies section contributes exactly one additional separator.
  const separators = countDefuddleSeparators(html);
  return comments + Math.max(0, separators - (comments > 0 ? 1 : 0));
}

/** Restore deliberate X post line breaks when Defuddle's tweet HTML flattens them. */
export function restoreXPostLineBreaks(content: string, description: string | null): string {
  if (description === null || !/[\r\n]/.test(description)) return content;
  const preserved = description.replace(/\r\n?/g, "\n").trim();
  const flattened = preserved.replace(/\s+/g, " ");
  const offset = content.indexOf(flattened);
  if (offset < 0) return content;
  const literal = preserved.split("\n").map((line) => {
    let escaped = line
      .replace(/\\/g, "\\\\")
      .replace(/([`*_~[\]])/g, "\\$1")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    escaped = escaped.replace(/^(\s*)(#{1,6}|[-+]|\d+[.)])(?=\s)/, "$1\\$2");
    if (/^\s*-{3,}\s*$/.test(escaped)) escaped = escaped.replace("-", "\\-");
    if (/^(?: {4}|\t)/.test(escaped)) escaped = `&#32;${escaped.slice(1)}`;
    return escaped;
  }).join("\n");
  return `${content.slice(0, offset)}${literal}${content.slice(offset + flattened.length)}`;
}

function normalizedDefuddleMediaUrl(value: unknown, baseUrl: URL): URL | null {
  const candidate = nonEmpty(value);
  if (candidate === null || candidate.length > 8_192) return null;
  const resolved = resolveRemote(candidate, baseUrl);
  if (resolved === null || resolved.username !== "" || resolved.password !== "") return null;
  resolved.hash = "";
  return resolved;
}

const defuddleInlineImage = /!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]*)>|([^()\s\r\n]+))((?:\s+"[^"\r\n]*")?)\)/g;

function removeDefuddleSamePageImages(
  content: string,
  reportedImage: unknown,
  baseUrl: URL,
): string {
  const exactCandidates = new Set<string>();
  const exactPage = new URL(baseUrl);
  exactPage.hash = "";
  exactCandidates.add(exactPage.href);
  const reported = normalizedDefuddleMediaUrl(reportedImage, baseUrl);
  if (
    reported !== null
    && reported.origin === baseUrl.origin
    && reported.pathname === baseUrl.pathname
  ) exactCandidates.add(reported.href);

  return content.replace(
    defuddleInlineImage,
    (
      whole,
      _alt: string,
      bracketed: string | undefined,
      bare: string | undefined,
    ) => {
      const image = normalizedDefuddleMediaUrl(bracketed ?? bare, baseUrl);
      return image !== null && exactCandidates.has(image.href)
        ? ""
        : whole;
    },
  );
}

/**
 * Preserve Defuddle's separate main-image field and poster attributes that its Markdown conversion can omit.
 * Existing Markdown/HTML images are compared after URL resolution so LinkedIn and other extractors do not duplicate them.
 */
export function retainDefuddleMedia(
  content: string,
  response: Readonly<Record<string, unknown>>,
  baseUrl: URL,
): string {
  content = removeDefuddleSamePageImages(content, response.image, baseUrl);
  const existing = new Set<string>();
  const scan = scanImageSources(content);
  for (const source of scan.sources) {
    const url = normalizedDefuddleMediaUrl(source, baseUrl);
    if (url !== null) existing.add(url.href);
  }

  const candidates: Array<{ readonly value: unknown; readonly label: string }> = [
    { value: response.image, label: "Cover image" },
  ];
  if (Array.isArray(response.captureVideoPosters)) {
    const maximum = Math.min(response.captureVideoPosters.length, 64);
    for (let index = 0; index < maximum; index += 1) {
      candidates.push({ value: response.captureVideoPosters[index], label: "Video thumbnail" });
    }
  }

  const additions: string[] = [];
  for (const candidate of candidates) {
    const url = normalizedDefuddleMediaUrl(candidate.value, baseUrl);
    if (
      url === null
      || existing.has(url.href)
      || (url.origin === baseUrl.origin && url.pathname === baseUrl.pathname)
    ) continue;
    existing.add(url.href);
    additions.push(`![${candidate.label}](<${url.href}>)`);
  }
  return additions.length === 0
    ? content
    : `${content.trimEnd()}\n\n${additions.join("\n\n")}\n`;
}

function compactCount(value: string, suffix: string | undefined): number | null {
  const number = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(number) || number < 0) return null;
  const multiplier = suffix?.toLowerCase() === "m" ? 1_000_000 : suffix?.toLowerCase() === "k" ? 1_000 : 1;
  const result = Math.floor(number * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}

function visibleCommentCount(content: string, platform: Platform): number | null {
  const patterns = platform === "x"
    ? [/\bread\s+([\d,.]+)\s*([km])?\s+repl(?:y|ies)\b/i, /\b([\d,.]+)\s*([km])?\s+repl(?:y|ies)\b/i]
    : [/\b(?:view|read|show)\s+(?:all\s+)?([\d,.]+)\s*([km])?\s+comments?\b/i];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[1] === undefined) continue;
    const count = compactCount(match[1], match[2]);
    if (count !== null) return count;
  }
  return null;
}

const blockedPattern = /(?:verify (?:that )?you are (?:a )?human|(?:complete|solve) (?:the )?captcha|\bcaptcha\b|access denied|request (?:has been )?blocked|unusual traffic|cloudflare ray id)/i;
const blockedTitlePattern = /^(?:403(?: forbidden)?|access denied|request blocked|unusual traffic|verify (?:that )?you are (?:a )?human|human verification|captcha|security (?:check|verification)|attention required|just a moment(?:\.{3})?)$/i;
const blockedContextPattern = /(?:\b(?:please )?(?:verify|confirm) (?:that )?you are (?:a )?human\b|\b(?:complete|solve) (?:the )?captcha\b|\b(?:you (?:do not|don't) have permission|you have been blocked)\b|\b(?:your|this) (?:request|access|ip(?: address)?) (?:has been|was|is) blocked\b|\bunusual traffic from your (?:computer )?network\b|\bautomated (?:queries|requests)\b|\b(?:before proceeding|to continue),? (?:please )?(?:verify|complete|enable)\b|\bcloudflare ray id\b)/i;
const blockedStandaloneLinePattern = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:403(?: forbidden)?|access denied|request blocked|unusual traffic|verify (?:that )?you are (?:a )?human|captcha|security (?:check|verification))[.!]?[ \t]*(?:\r?\n|$)/i;
const rateLimitSignalPattern = /\b(?:429(?: too many requests)?|too many requests|rate limit(?:ed| exceeded)?)\b/i;
const rateLimitTitlePattern = /^(?:429(?: too many requests)?|too many requests|rate limit(?:ed| exceeded)?)$/i;
const rateLimitStandaloneLinePattern = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:429(?: too many requests)?|too many requests|rate limit(?:ed| exceeded)?)[.!]?[ \t]*(?:\r?\n|$)/i;
const rateLimitRetryContextPattern = /\b(?:please )?(?:(?:try|retry) again(?: later| in \d+)|wait (?:a moment|before retrying)|respect the retry-after header)\b/i;
const articleDiscussionPattern = /(?:\bhow to\b|\btroubleshoot(?:ing)?\b|\b(?:this|the) (?:article|guide|tutorial)\b|\b(?:this|the) (?:article|guide|tutorial) explains?\b|\blearn (?:how|why)\b)/i;
const MAX_BLOCKED_SHELL_CODE_UNITS = 4_096;
const MAX_BLOCKED_SHELL_WORDS = 160;
const MAX_STANDALONE_BLOCKED_SHELL_WORDS = 24;

/** Treat block phrases as a gate only in a bounded shell-shaped context, not ordinary prose. */
function looksLikeBlockedShell(content: string, title: string | null): boolean {
  if (content.length > MAX_BLOCKED_SHELL_CODE_UNITS) return false;
  const wordCount = countWords(content);
  if (wordCount > MAX_BLOCKED_SHELL_WORDS) return false;
  const normalizedTitle = (title ?? "").slice(0, articleMetadataLimits.title).replace(/\s+/g, " ").trim();
  const boundedVisible = `${normalizedTitle}\n${content}`;
  if (articleDiscussionPattern.test(boundedVisible)) return false;
  if (
    wordCount <= MAX_STANDALONE_BLOCKED_SHELL_WORDS
    && (blockedStandaloneLinePattern.test(content) || rateLimitStandaloneLinePattern.test(content))
  ) return true;
  const exactGateTitle = blockedTitlePattern.test(normalizedTitle) || rateLimitTitlePattern.test(normalizedTitle);
  const rateLimitShell = rateLimitSignalPattern.test(content) && rateLimitRetryContextPattern.test(content);
  const hasBlockSignal = exactGateTitle || blockedPattern.test(content) || rateLimitShell;
  return hasBlockSignal && (exactGateTitle || blockedContextPattern.test(content) || rateLimitShell);
}
const authenticationGatePattern = /(?:\b(?:sign|log) in to (?:continue|read|view|see|access|comment|reply)\b|\blogin required\b|\bmembers? only\b|\bsubscriber-only\b|\bsubscribe to (?:continue|read)\b|\bthis content is private\b|\byou must be logged in\b)/i;
const paywallCallToActionPattern = /\b(?:subscribe(?: now)? to (?:unlock (?:this|the) (?:article|story|content)|(?:keep|continue) reading)|create (?:an? |your )?account to (?:keep|continue) reading|register to (?:keep|continue) reading|sign up to (?:keep|continue) reading)\b/i;
const paywallTitlePattern = /^(?:subscribe(?: now)? to (?:unlock (?:this|the) (?:article|story|content)|(?:keep|continue) reading)|create (?:an? |your )?account to (?:keep|continue) reading|register to (?:keep|continue) reading|sign up to (?:keep|continue) reading)[.!]?$/i;
const paywallStandaloneLinePattern = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:subscribe(?: now)? to (?:unlock (?:this|the) (?:article|story|content)|(?:keep|continue) reading)|create (?:an? |your )?account to (?:keep|continue) reading|register to (?:keep|continue) reading|sign up to (?:keep|continue) reading)[.!]?[ \t]*(?:\r?\n|$)/i;
const paywallDiscussionPattern = /\b(?:analy[sz](?:e|es|ed|ing)|discuss(?:es|ed|ing)?|examin(?:e|es|ed|ing)|quot(?:e|es|ed|ing)|stud(?:y|ies|ied|ying)|interface copy|wording|publishers? (?:sometimes )?(?:say|write|use))\b/i;
const shellPattern = /(?:enable javascript|javascript is disabled|something went wrong|try reloading)/i;
const xReplyGatePattern = /\bjoin\s+x\s+now\s+to\s+read\s+repl(?:y|ies)\b/i;
const xCombinedAccountShellPattern = /\blog\s*in\s*sign\s*up\b/i;
const loginShellPattern = /\blog\s*in\b/i;
const signupShellPattern = /\bsign\s*up\b/i;

/** Recognize compact paywall calls to action without treating quoted interface language as a gate. */
function looksLikePaywallShell(content: string, title: string | null): boolean {
  if (content.length > MAX_BLOCKED_SHELL_CODE_UNITS) return false;
  const wordCount = countWords(content);
  if (wordCount > MAX_BLOCKED_SHELL_WORDS) return false;
  const normalizedTitle = (title ?? "").slice(0, articleMetadataLimits.title).replace(/\s+/g, " ").trim();
  if (paywallTitlePattern.test(normalizedTitle) || paywallStandaloneLinePattern.test(content)) return true;
  if (wordCount > 48) return false;
  const boundedVisible = `${normalizedTitle}\n${content}`;
  return paywallCallToActionPattern.test(boundedVisible) && !paywallDiscussionPattern.test(boundedVisible);
}

function isRenderedConversationAccessGate(content: string, platform: Platform): boolean {
  if (authenticationGatePattern.test(content)) return true;
  return platform === "x"
    && (
      xReplyGatePattern.test(content)
      || xCombinedAccountShellPattern.test(content)
      || (loginShellPattern.test(content) && signupShellPattern.test(content))
    );
}

function statusFor(
  content: string,
  title: string | null,
  scope: CaptureScope,
  contentTruncated: boolean,
  renderedTextFallback: boolean,
): CaptureStatus {
  const visible = `${title ?? ""}\n${content}`;
  if (looksLikeBlockedShell(content, title)) return "blocked";
  const accessGate = authenticationGatePattern.test(visible) || looksLikePaywallShell(content, title);
  if (accessGate && content.length < 1_500) return "auth-required";
  if (shellPattern.test(visible) && content.length < 500) return "unsupported";
  if (content.trim().length < 40) return "unsupported";
  if (accessGate) return "partial";
  if (contentTruncated || renderedTextFallback) return "partial";
  // Only structured adapters can prove traversal completeness. A rendered DOM,
  // saved page, or cookie-authenticated HTML can omit pagination invisibly.
  if (scope === "thread" || scope === "comments") return "partial";
  return "complete";
}

/** Preserve access-control evidence even when useful surrounding content makes the extraction partial. */
export function extractionShowsAccessControl(extraction: ExtractedPage): boolean {
  if (extraction.status === "auth-required" || extraction.status === "blocked") return true;
  const { content, title } = extraction.article;
  return looksLikeBlockedShell(content, title)
    || looksLikePaywallShell(content, title)
    || authenticationGatePattern.test(`${title ?? ""}\n${content}`);
}

export function scoreExtraction(
  article: Article,
  status: CaptureStatus,
  wordCount: number,
  capturedItems: number,
  acquisition: AcquiredPage,
): number {
  const statusWeight: Readonly<Record<CaptureStatus, number>> = {
    complete: 5_000,
    partial: 2_000,
    "auth-required": -2_000,
    blocked: -4_000,
    unsupported: -5_000,
  };
  const images = countMarkdownMarkers(article.content, "image", 100);
  const links = countMarkdownMarkers(article.content, "link", 500);
  const acquisitionAdjustment = acquisition.method.startsWith("browser")
    ? acquisition.contentType?.toLowerCase().includes("text/plain") === true ? -500 : 0
    : 0;
  return statusWeight[status]
    + Math.min(article.content.length, 50_000)
    + Math.min(wordCount, 10_000) * 5
    + Math.min(capturedItems, 1_000) * 50
    + images * 100
    + links * 5
    + acquisitionAdjustment;
}

function plainTextArticle(acquisition: AcquiredPage): Article | null {
  const content = acquisition.body.trim();
  if (content === "") return null;
  const browserTitle = boundedMetadata(acquisition.browserTitle, articleMetadataLimits.title);
  const firstHeading = browserTitle === null ? firstMarkdownHeading(content) : null;
  const pathname = acquisition.finalUrl.pathname;
  let pathEnd = pathname.length;
  while (pathEnd > 0 && pathname.charCodeAt(pathEnd - 1) === 0x2f) pathEnd -= 1;
  const pathStart = pathname.lastIndexOf("/", pathEnd - 1) + 1;
  const lastSegment = boundedTrimmedSlice(pathname, pathStart, pathEnd, articleMetadataLimits.title);
  return {
    content,
    title: browserTitle
      ?? firstHeading
      ?? lastSegment
      ?? boundedMetadata(acquisition.finalUrl.hostname, articleMetadataLimits.title),
    author: null,
    published: null,
    description: null,
  };
}

function firstMarkdownHeading(content: string): string | null {
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    let cursor = lineStart;
    let hashes = 0;
    while (hashes < 3 && cursor < lineEnd && content.charCodeAt(cursor) === 0x23) {
      hashes += 1;
      cursor += 1;
    }
    if (
      hashes > 0
      && cursor < lineEnd
      && (content.charCodeAt(cursor) === 0x20 || content.charCodeAt(cursor) === 0x09)
    ) {
      const heading = boundedTrimmedSlice(content, cursor, lineEnd, articleMetadataLimits.title);
      if (heading !== null) return heading;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return null;
}

/** Convert one acquired response into normalized Markdown and auditable completeness metadata. */
export async function extractPage(
  acquisition: AcquiredPage,
  scope: CaptureScope,
  timeoutMs = 30_000,
): Promise<ExtractedPage | null> {
  let platform = detectPlatform(acquisition.finalUrl);
  const contentType = acquisition.contentType?.toLowerCase() ?? "";
  let article: Article | null = null;
  let wordCount = 0;
  let expectedItems: number | null = null;
  let structurallyCapturedItems: number | null = null;
  let extractor = "plain-text";
  const warnings = [...acquisition.warnings];
  const renderedPage = scope === "page" && acquisition.method.startsWith("browser")
    ? boundedRenderedPageText(acquisition.renderedText, acquisition.renderedTextByteLimit)
    : null;
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
          title: boundedMetadata(response.title, articleMetadataLimits.title)
            ?? boundedMetadata(acquisition.browserTitle, articleMetadataLimits.title),
          author: boundedMetadata(response.author, articleMetadataLimits.author),
          published: boundedMetadata(response.published, articleMetadataLimits.published),
          description,
        };
        wordCount = typeof response.wordCount === "number" && Number.isSafeInteger(response.wordCount) && response.wordCount >= 0
          ? response.wordCount
          : countWords(content);
        expectedItems = schemaCommentCount(response.schemaOrgData);
        structurallyCapturedItems = countDefuddleConversationItems(response, platform);
        extractor = platform === "generic" ? "defuddle" : `defuddle:${platform}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (renderedPage !== null) {
        warnings.push(
          "Article extraction failed; evaluated the bounded rendered-page text fallback from the same browser navigation.",
        );
      } else {
        throw new Error(`Defuddle could not parse this acquisition: ${message}`, { cause: error });
      }
    }
  }

  if (renderedPage !== null) {
    const primaryStatus = article === null
      ? "unsupported"
      : statusFor(
          article.content,
          article.title,
          scope,
          acquisition.contentTruncated === true,
          false,
        );
    const fallbackBase = plainTextArticle({
      ...acquisition,
      body: renderedPage.content,
      contentType: "text/plain; charset=utf-8",
    });
    if (fallbackBase !== null) {
      const fallbackStatus = statusFor(
        fallbackBase.content,
        fallbackBase.title,
        scope,
        renderedPage.truncated || acquisition.renderedTextTruncated === true,
        true,
      );
      if (article === null || (primaryStatus === "unsupported" && fallbackStatus !== "unsupported")) {
        const primary = article;
        article = {
          ...fallbackBase,
          title: primary?.title ?? fallbackBase.title,
          author: primary?.author ?? fallbackBase.author,
          published: primary?.published ?? fallbackBase.published,
          description: primary?.description ?? fallbackBase.description,
        };
        wordCount = countWords(article.content);
        extractor = primary === null ? "rendered-page" : `${extractor}+rendered-page`;
        renderedPageFallback = true;
        renderedPageFallbackTruncated = renderedPage.truncated || acquisition.renderedTextTruncated === true;
        warnings.push(
          "Used bounded rendered-page text because article extraction produced no usable page body; it may include surrounding account or interface text and cannot prove feed completeness.",
        );
        if (renderedPageFallbackTruncated) {
          warnings.push(
            `Rendered-page text reached the ${renderedPage.byteLimit}-byte fallback limit or the browser read boundary and was truncated.`,
          );
        }
      }
    }
  }
  if (article === null) return null;

  const renderedConversation = scope !== "page" && structurallyCapturedItems === null
    ? nonEmpty(acquisition.renderedText)
    : null;
  if (renderedConversation !== null && renderedConversation !== article.content.trim()) {
    if (isRenderedConversationAccessGate(renderedConversation, platform)) {
      warnings.push(
        "Skipped the separately rendered conversation context because it exposed an access gate rather than a trustworthy reply or comment tree.",
      );
    } else {
      article = {
        ...article,
        content: `${article.content.trimEnd()}\n\n## Rendered conversation context\n\n${renderedConversation}\n`,
      };
      wordCount = countWords(article.content);
      extractor = `${extractor}+rendered-context`;
      warnings.push(
        "Preserved the separately rendered conversation context because the article extractor exposed no trustworthy item tree; it can include duplicated article, account, or interface text.",
      );
    }
  }

  expectedItems ??= visibleCommentCount(article.content, platform);
  const capturedItems = scope === "page" ? 1 : structurallyCapturedItems ?? 0;
  if (scope === "page") {
    expectedItems = null;
  } else if (structurallyCapturedItems === null) {
    warnings.push("The rendered response exposed no trustworthy per-item structure; capturedItems is conservatively reported as 0.");
  } else if (expectedItems !== null && capturedItems > expectedItems) {
    warnings.push(
      `The source declared ${expectedItems} scoped items, but ${capturedItems} items were observed; the expected count was normalized to the observed count.`,
    );
    expectedItems = capturedItems;
  }
  const status = statusFor(
    article.content,
    article.title,
    scope,
    renderedPageFallback ? renderedPageFallbackTruncated : acquisition.contentTruncated === true,
    renderedPageFallback || (acquisition.method.startsWith("browser") && contentType.includes("text/plain")),
  );
  if (status !== "complete") warnings.push(`Capture status is ${status}; inspect the source before relying on completeness.`);
  const canonicalUrl = canonicalizeUrl(acquisition.finalUrl, platform);
  return {
    article,
    canonicalUrl,
    platform,
    status,
    score: scoreExtraction(article, status, wordCount, capturedItems, acquisition),
    wordCount,
    expectedItems,
    capturedItems,
    extractor,
    warnings,
    acquisition,
  };
}

export function chooseBestExtraction(candidates: readonly ExtractedPage[]): ExtractedPage | null {
  const statusRank: Readonly<Record<CaptureStatus, number>> = {
    complete: 5,
    partial: 4,
    "auth-required": 3,
    blocked: 2,
    unsupported: 1,
  };
  let best: ExtractedPage | null = null;
  for (const candidate of candidates) {
    if (
      best === null
      || statusRank[candidate.status] > statusRank[best.status]
      || (statusRank[candidate.status] === statusRank[best.status] && candidate.score > best.score)
    ) best = candidate;
  }
  return best;
}
