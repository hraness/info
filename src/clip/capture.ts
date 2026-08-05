import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireBrowser,
  acquireCookieHttp,
  acquireCookieRecords,
  acquireFile,
  acquireHttp,
  assertSafePersistentProfile,
  type AcquiredPage,
  type AcquisitionMethod,
} from "./acquire.js";
import { captureUrl, type CaptureArguments, type CaptureScope } from "./args.js";
import { localizeAssets, sniffImage, type AssetRecord } from "./assets.js";
import { cloneBrowserProfile } from "./browser-profiles.js";
import {
  canonicalizeUrl,
  chooseBestExtraction,
  countWords,
  extractPage,
  extractionShowsAccessControl,
  scoreExtraction,
  type ExtractedPage,
  type Platform,
} from "./extract.js";
import {
  buildClipMarkdown,
  CONTENT_REWRITE_TRUNCATION_WARNING,
  rewriteContentWithStatus,
  slugify,
  type Article,
} from "./lib.js";
import { filterCookies, renderCookieHeader } from "./cookies.js";
import {
  captureMedia,
  captureVideoContext,
  type MediaCaptureResult,
  type MediaMetadata,
  type MediaRecord,
  type VideoContextCaptureResult,
} from "./media.js";
import {
  abortCaptureBundle,
  beginCaptureBundle,
  commitCaptureBundle,
  redactSensitiveText,
  redactSensitiveTextWithCount,
  sanitizeArtifactUrl,
  writeCaptureBundle,
  type CaptureBundleTransaction,
  type CaptureManifest,
  type CaptureManifestAsset,
  type CaptureManifestInput,
} from "./persist.js";
import { classifyPlatformUrl } from "./platforms.js";
import { acquirePublicStructured, type PublicStructuredCapture } from "./structured.js";
import {
  acquireArchiveTodaySnapshot,
  discoverArchiveTodaySnapshot,
  type ArchiveTodayDiscovery,
} from "./archive-today.js";
import { FetchFailure } from "./network.js";

export type AttemptOutcome = "succeeded" | "failed" | "skipped";

export type CaptureAttempt = {
  readonly method: string;
  readonly outcome: AttemptOutcome;
  readonly message: string;
};

export type CaptureOutcome = {
  readonly status: ExtractedPage["status"];
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly platform: Platform;
  readonly scope: Exclude<CaptureScope, "auto">;
  readonly slug: string;
  readonly acquisitionMethod: AcquisitionMethod;
  readonly extractor: string;
  readonly wordCount: number;
  readonly capturedItems: number;
  readonly expectedItems: number | null;
  readonly outputDirectory: string | null;
  readonly markdownPath: string | null;
  readonly assetCount: number;
  readonly warnings: readonly string[];
  readonly attempts: readonly CaptureAttempt[];
  readonly markdown: string;
  readonly manifest: CaptureManifest | null;
};

export type CaptureDependencies = {
  readonly acquireFile?: typeof acquireFile;
  readonly acquireHttp?: typeof acquireHttp;
  readonly acquireCookieHttp?: typeof acquireCookieHttp;
  readonly acquireCookieRecords?: typeof acquireCookieRecords;
  readonly acquireBrowser?: typeof acquireBrowser;
  readonly acquirePublicStructured?: typeof acquirePublicStructured;
  readonly discoverArchiveTodaySnapshot?: typeof discoverArchiveTodaySnapshot;
  readonly acquireArchiveTodaySnapshot?: typeof acquireArchiveTodaySnapshot;
  readonly extractPage?: typeof extractPage;
  readonly localizeAssets?: typeof localizeAssets;
  readonly captureMedia?: typeof captureMedia;
  readonly captureVideoContext?: typeof captureVideoContext;
  readonly now?: () => Date;
};

const browserFirstPlatforms = new Set<Platform>([
  "x",
  "instagram",
  "linkedin",
  "reddit",
  "facebook",
  "tiktok",
  "threads",
  "whatsapp",
  "youtube",
]);

/** Resolve `auto` to the useful default for each content family. */
export function effectiveScope(platform: Platform, scope: CaptureScope): Exclude<CaptureScope, "auto"> {
  if (scope !== "auto") return scope;
  if (platform === "hacker-news" || platform === "reddit" || platform === "github" || platform === "discourse") {
    return "comments";
  }
  if (platform === "x" || platform === "bluesky") return "thread";
  return "page";
}

function stableContentId(url: URL): string | null {
  const classified = classifyPlatformUrl(url.href);
  if (classified === null) return null;
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

/** Prefer readable slugs while retaining stable social IDs to prevent collisions. */
export function captureSlug(options: CaptureArguments, extraction: ExtractedPage): string {
  if (options.slug !== undefined) return slugify(options.slug);
  const fallback = extraction.canonicalUrl.pathname.split("/").filter(Boolean).at(-1)
    ?? extraction.canonicalUrl.hostname;
  // Page titles are foreign content and can reflect credential-bearing URLs.
  // Redact them before they become persistent directory or file names.
  const base = slugify(redactSensitiveText(extraction.article.title ?? fallback));
  const id = stableContentId(extraction.canonicalUrl);
  if (id === null) return base;
  const idSlug = slugify(id);
  if (idSlug === "" || base.endsWith(`-${idSlug}`) || base === idSlug) return base;
  const available = Math.max(1, 80 - [...idSlug].length - 1);
  const shortened = [...base].slice(0, available).join("").replace(/-+$/g, "") || "post";
  return `${shortened}-${idSlug}`;
}

function shouldUseBrowser(
  options: CaptureArguments,
  platform: Platform,
  scope: Exclude<CaptureScope, "auto">,
  directCandidates: readonly ExtractedPage[],
): boolean {
  if (options.mode === "browser") return true;
  if (options.mode !== "auto") return false;
  if (options.browserProfile !== undefined || options.browserLive || options.cdp !== undefined) return true;
  if (options.evidence === "screenshot" || options.evidence === "all") return true;
  if (browserFirstPlatforms.has(platform)) return true;
  if (scope !== "page" && platform !== "hacker-news" && platform !== "bluesky") return true;
  const boundedStructured = directCandidates.some((candidate) =>
    (candidate.acquisition.method === "hacker-news-api" || candidate.acquisition.method === "bluesky-api")
    && candidate.warnings.some((warning) => (
      /configured (?:item|depth)|item (?:or depth )?limit|depth limit|capture stopped at \d+ items?/i.test(warning)
    )));
  if (boundedStructured) return false;
  const best = chooseBestExtraction(directCandidates);
  return best === null || best.status !== "complete" || best.wordCount < 60;
}

function safeAttemptMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return redactSensitiveText(message).replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

function finalizedWarnings(values: readonly string[], markdownRedactions = 0): readonly string[] {
  const sanitized = values.map((value) => safeAttemptMessage(value));
  if (markdownRedactions > 0) {
    sanitized.push(
      `Redacted ${markdownRedactions} credential-shaped occurrence${markdownRedactions === 1 ? "" : "s"} from captured Markdown.`,
    );
  }
  return [...new Set(sanitized)];
}

function statusAfterContentRewrite(
  status: ExtractedPage["status"],
  truncated: boolean,
): ExtractedPage["status"] {
  return truncated && status === "complete" ? "partial" : status;
}

function chooseCaptureExtraction(
  candidates: readonly ExtractedPage[],
  structuredCapture: PublicStructuredCapture | null,
): ExtractedPage | null {
  const structured = structuredCapture?.extraction;
  if (
    structured !== undefined
    && (structured.acquisition.method === "hacker-news-api" || structured.acquisition.method === "bluesky-api")
    && (structured.status === "complete" || structured.status === "partial")
  ) {
    // These official adapters preserve bounded, typed reply structure. A large
    // rendered shell can contain more words while proving zero conversation
    // items, so volume must not displace the authoritative bounded result.
    return structured;
  }
  return chooseBestExtraction(candidates);
}

function authoritativeStructuredExtraction(structuredCapture: PublicStructuredCapture | null): boolean {
  const extraction = structuredCapture?.extraction;
  return extraction !== undefined
    && (extraction.acquisition.method === "hacker-news-api" || extraction.acquisition.method === "bluesky-api")
    && (extraction.status === "complete" || extraction.status === "partial");
}

function shouldTryArchiveFallback(
  options: CaptureArguments,
  candidates: readonly ExtractedPage[],
  structuredCapture: PublicStructuredCapture | null,
): boolean {
  if ((options.mode !== "auto" && options.mode !== "http") || options.currentTab) return false;
  if (authoritativeStructuredExtraction(structuredCapture)) return false;
  const best = chooseBestExtraction(candidates);
  return best === null
    || (best.status !== "complete" && best.status !== "partial")
    || (best.status === "partial" && best.wordCount < 60 && best.capturedItems === 0);
}

const archiveBypassHttpStatuses = new Set([401, 402, 403, 407, 423, 429, 451]);

function recordArchiveFallbackDenial(denials: Set<string>, extraction: ExtractedPage): void {
  if (extractionShowsAccessControl(extraction)) denials.add("access-control response");
}

function recordArchiveFallbackErrorDenial(denials: Set<string>, error: unknown): void {
  if (error instanceof FetchFailure && error.status !== null && archiveBypassHttpStatuses.has(error.status)) {
    denials.add("access-control or rate-limit response");
  }
}

function archiveDiscoveryAttempt(discovery: ArchiveTodayDiscovery): CaptureAttempt {
  switch (discovery.status) {
    case "found":
      return { method: "archive-is-discovery", outcome: "succeeded", message: "found one exact existing snapshot" };
    case "not-found":
      return { method: "archive-is-discovery", outcome: "skipped", message: "no exact existing snapshot was found" };
    case "throttled":
      return { method: "archive-is-discovery", outcome: "failed", message: "provider throttled the read-only lookup" };
    case "unavailable":
      return { method: "archive-is-discovery", outcome: "failed", message: `provider lookup unavailable (${discovery.reason})` };
  }
}

async function tryArchiveFallback(options: {
  readonly sourceUrl: string;
  readonly platform: Platform;
  readonly scope: Exclude<CaptureScope, "auto">;
  readonly captureOptions: CaptureArguments;
  readonly extractor: typeof extractPage;
  readonly discover: typeof discoverArchiveTodaySnapshot;
  readonly acquire: typeof acquireArchiveTodaySnapshot;
  readonly now: () => Date;
  readonly candidates: ExtractedPage[];
  readonly attempts: CaptureAttempt[];
}): Promise<void> {
  let discovery: ArchiveTodayDiscovery;
  try {
    discovery = await options.discover(options.sourceUrl, {
      now: options.now,
      timeoutMs: options.captureOptions.timeoutMs,
      maxBytes: options.captureOptions.maxHtmlBytes,
      userAgent: options.captureOptions.userAgent,
    });
  } catch (error) {
    options.attempts.push({ method: "archive-is-discovery", outcome: "failed", message: safeAttemptMessage(error) });
    return;
  }
  options.attempts.push(archiveDiscoveryAttempt(discovery));
  if (discovery.status !== "found") return;
  try {
    const acquisition = await options.acquire(options.sourceUrl, discovery.snapshot.url, {
      now: options.now,
      timeoutMs: options.captureOptions.timeoutMs,
      maxBytes: options.captureOptions.maxHtmlBytes,
      userAgent: options.captureOptions.userAgent,
    });
    const extracted = await options.extractor(acquisition, options.scope, options.captureOptions.timeoutMs);
    if (extracted === null) {
      options.attempts.push({ method: "archive-is", outcome: "failed", message: "snapshot yielded no extractable content" });
      return;
    }
    const warning = `Captured an Archive.today snapshot from ${discovery.snapshot.capturedAt}; it may differ from the current source.`;
    const archivedStatus = extracted.status === "complete" ? "partial" : extracted.status;
    const archived: ExtractedPage = {
      ...extracted,
      canonicalUrl: new URL(options.sourceUrl),
      platform: options.platform,
      status: archivedStatus,
      score: scoreExtraction(
        extracted.article,
        archivedStatus,
        extracted.wordCount,
        extracted.capturedItems,
        acquisition,
      ),
      warnings: Object.freeze([...extracted.warnings, warning]),
      acquisition,
    };
    options.candidates.push(archived);
    options.attempts.push({
      method: "archive-is",
      outcome: "succeeded",
      message: `${archived.status}; ${archived.wordCount} words; ${archived.capturedItems} items`,
    });
  } catch (error) {
    options.attempts.push({ method: "archive-is", outcome: "failed", message: safeAttemptMessage(error) });
  }
}

async function tryAcquisition(
  method: string,
  acquire: () => Promise<AcquiredPage>,
  scope: CaptureScope,
  timeoutMs: number,
  extractor: typeof extractPage,
  candidates: ExtractedPage[],
  attempts: CaptureAttempt[],
  archiveFallbackDenials: Set<string>,
): Promise<AcquiredPage | null> {
  try {
    const acquisition = await acquire();
    const extracted = await extractor(acquisition, scope, timeoutMs);
    if (extracted === null) {
      attempts.push({ method, outcome: "failed", message: "acquisition yielded no extractable content" });
      return acquisition;
    }
    candidates.push(extracted);
    recordArchiveFallbackDenial(archiveFallbackDenials, extracted);
    attempts.push({
      method: acquisition.method,
      outcome: "succeeded",
      message: `${extracted.status}; ${extracted.wordCount} words; ${extracted.capturedItems} items`,
    });
    return acquisition;
  } catch (error) {
    recordArchiveFallbackErrorDenial(archiveFallbackDenials, error);
    attempts.push({ method, outcome: "failed", message: safeAttemptMessage(error) });
    return null;
  }
}

function screenshotIntoBundle(
  screenshotPath: string | null,
  transaction: CaptureBundleTransaction,
  maxBytes: number,
): string | null {
  if (screenshotPath === null || !existsSync(screenshotPath)) return null;
  const stats = statSync(screenshotPath);
  if (!stats.isFile() || stats.size > maxBytes) return null;
  const bytes = readFileSync(screenshotPath);
  if (sniffImage(bytes)?.mimeType !== "image/png") return null;
  const evidenceDirectory = join(transaction.stagingDirectory, "evidence");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const destination = join(evidenceDirectory, "page.png");
  copyFileSync(screenshotPath, destination);
  chmodSync(destination, 0o600);
  return "evidence/page.png";
}

const mediaRecordManifestAsset = (
  record: MediaRecord,
  sourceUrl: string,
): CaptureManifestAsset => ({
  source: sourceUrl,
  url: sourceUrl,
  path: record.path,
  mimeType: record.mimeType,
  bytes: record.bytes,
  sha256: record.sha256,
});

const mediaManifestAssets = (
  result: MediaCaptureResult,
  sourceUrl: string,
): readonly CaptureManifestAsset[] => result.records.map((record) =>
  mediaRecordManifestAsset(record, sourceUrl));

function safeMediaPath(path: string): string | null {
  if (path === "" || path.startsWith("/") || /[\\\0\r\n?#]/.test(path)) return null;
  const pieces = path.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) return null;
  return pieces.map((piece) => encodeURIComponent(piece)).join("/");
}

/** Add playable local media to the note; image-only captures never call this path. */
export function appendCapturedMedia(content: string, records: readonly MediaRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    const path = safeMediaPath(record.path);
    if (path === null) continue;
    if (record.mimeType.startsWith("video/")) {
      lines.push(`<video controls preload="metadata" src="${path}"></video>`, `[Download video](${path})`);
    } else if (record.mimeType.startsWith("audio/")) {
      lines.push(`<audio controls preload="metadata" src="${path}"></audio>`, `[Download audio](${path})`);
    } else lines.push(`[Download media](${path})`);
  }
  if (lines.length === 0) return content;
  return `${content.trimEnd()}\n\n## Media\n\n${lines.join("\n\n")}\n`;
}

function escapedVideoMetadata(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>#])/gu, "\\$1");
}

function videoDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Add durable YouTube metadata, a local thumbnail, and a bounded transcript to readable Markdown. */
export function appendVideoContext(content: string, context: VideoContextCaptureResult): string {
  const metadata = context.metadata;
  const details: string[] = [];
  if (metadata?.title !== undefined) details.push(`- **Title:** ${escapedVideoMetadata(metadata.title)}`);
  const channel = metadata?.channel ?? metadata?.uploader;
  if (channel !== undefined) details.push(`- **Channel:** ${escapedVideoMetadata(channel)}`);
  if (metadata?.durationSeconds !== undefined) {
    details.push(`- **Duration:** ${videoDuration(metadata.durationSeconds)}`);
  }
  if (metadata?.id !== undefined) details.push(`- **Video ID:** ${escapedVideoMetadata(metadata.id)}`);

  const thumbnailPath = context.thumbnail === null ? null : safeMediaPath(context.thumbnail.path);
  const sections: string[] = [];
  if (details.length > 0 || thumbnailPath !== null || metadata?.description !== undefined) {
    const video: string[] = ["## Video"];
    if (details.length > 0) video.push("", details.join("\n"));
    if (thumbnailPath !== null) video.push("", `![Video thumbnail](${thumbnailPath})`);
    if (metadata?.description !== undefined && metadata.description.trim() !== "") {
      const description = metadata.description
        .split(/\r?\n/gu)
        .map(escapedVideoMetadata)
        .join("\n");
      video.push("", "### Description", "", description);
    }
    sections.push(video.join("\n"));
  }
  if (context.transcript !== null && context.transcript.markdown.trim() !== "") {
    sections.push(`## Transcript\n\n${context.transcript.markdown.trimEnd()}`);
  }
  return sections.length === 0
    ? content
    : `${content.trimEnd()}\n\n${sections.join("\n\n")}\n`;
}

function articleWithVideoMetadata(article: Article, metadata: MediaMetadata | null): Article {
  if (metadata === null) return article;
  const published = metadata.timestamp === undefined
    ? article.published
    : (() => {
        const date = new Date(metadata.timestamp * 1_000);
        return Number.isFinite(date.getTime()) ? date.toISOString() : article.published;
      })();
  return {
    content: article.content,
    title: metadata.title ?? article.title,
    author: metadata.channel ?? metadata.uploader ?? article.author,
    published,
    description: metadata.description ?? article.description,
  };
}

function cookieMediaOptions(options: CaptureArguments): {
  readonly cookieBrowser?: { readonly source: "chrome" | "arc" | "brave" | "chromium" | "edge" | "firefox" | "safari"; readonly profile?: string };
  readonly cookiesFile?: string;
} {
  const source = options.cookieSources[0] ?? (options.browserProfile === undefined ? undefined : "chrome");
  const profile = options.cookieSources.length > 0
    ? options.cookieProfile
    : selectedBrowserCookieProfile(options);
  return {
    ...(source === undefined
      ? {}
      : { cookieBrowser: { source, ...(profile === undefined ? {} : { profile }) } }),
    ...(options.cookiesFile === undefined ? {} : { cookiesFile: options.cookiesFile }),
  };
}

/** Address the selected profile directory, not only its Chromium user-data parent. */
function selectedBrowserCookieProfile(options: CaptureArguments): string | undefined {
  if (options.browserProfile === undefined) return undefined;
  return options.browserProfileDirectory === undefined
    ? options.browserProfile
    : join(options.browserProfile, options.browserProfileDirectory);
}

function assetCookieProvider(
  options: CaptureArguments,
  reader: typeof acquireCookieRecords,
  authorizedUrl: URL,
): ((url: URL) => Promise<string | null>) | undefined {
  const explicit = options.cookieSources.length > 0 || options.cookiesFile !== undefined;
  if (!explicit && options.browserProfile === undefined) return undefined;
  const effective = explicit
    ? options
    : {
        ...options,
        cookieSources: ["chrome"] as const,
        cookieProfile: selectedBrowserCookieProfile(options),
      };
  let records: ReturnType<typeof reader> | undefined;
  return (url) => {
    if (url.origin !== authorizedUrl.origin) return Promise.resolve(null);
    // Read once against the captured page, then narrow the retained records again
    // for each asset path. Attribute-less headers can never be reinterpreted as Path=/.
    records ??= reader(effective, authorizedUrl);
    return records.then((result) => {
      const header = renderCookieHeader(filterCookies(result.cookies, url).cookies);
      return header === "" ? null : header;
    });
  };
}

/** Run path-backed profiles from a temporary copy shared by every browser lane in one capture. */
export function withBrowserProfileSnapshot(
  options: CaptureArguments,
  temporaryDirectory: string,
): CaptureArguments {
  if (options.browserProfile === undefined || options.browserProfileOwnership === "owned") return options;
  const source = assertSafePersistentProfile(options);
  if (source === null) return options;
  const cloned = cloneBrowserProfile(source, temporaryDirectory);
  return {
    ...options,
    browserProfile: cloned.userDataPath,
    browserProfileOwnership: "owned",
    ...(cloned.profileDirectory === undefined
      ? {}
      : { browserProfileDirectory: cloned.profileDirectory }),
  };
}

/** Run the layered acquisition pipeline and optionally persist one atomic capture bundle. */
export async function runCapture(
  rawOptions: CaptureArguments,
  dependencies: CaptureDependencies = {},
): Promise<CaptureOutcome> {
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
    discoverArchiveTodaySnapshot: dependencies.discoverArchiveTodaySnapshot ?? discoverArchiveTodaySnapshot,
    acquireArchiveTodaySnapshot: dependencies.acquireArchiveTodaySnapshot ?? acquireArchiveTodaySnapshot,
    extractPage: dependencies.extractPage ?? extractPage,
    localizeAssets: dependencies.localizeAssets ?? localizeAssets,
    captureMedia: dependencies.captureMedia ?? captureMedia,
    captureVideoContext: dependencies.captureVideoContext ?? captureVideoContext,
    now: dependencies.now ?? (() => new Date()),
  };
  const browserTemporaryDirectory = mkdtempSync(join(tmpdir(), "hraness-kb-browser-"));
  chmodSync(browserTemporaryDirectory, 0o700);

  try {
    const preparedOptions = withBrowserProfileSnapshot(rawOptions, browserTemporaryDirectory);
    let currentBrowser: AcquiredPage | null = null;
    let resolvedOptions = preparedOptions;
    if (preparedOptions.currentTab) {
      try {
        const acquired = await deps.acquireBrowser(preparedOptions, browserTemporaryDirectory, false);
        const sanitizedUrl = new URL(sanitizeArtifactUrl(acquired.finalUrl.href));
        currentBrowser = sanitizedUrl.href === acquired.finalUrl.href
          ? acquired
          : { ...acquired, finalUrl: sanitizedUrl };
      } catch (error) {
        throw new Error(`current browser acquisition failed: ${safeAttemptMessage(error)}`, { cause: error });
      }
      resolvedOptions = { ...preparedOptions, url: currentBrowser.finalUrl, mode: "browser" };
    }
    const requestedUrl = captureUrl(resolvedOptions);
    const platform: Platform = classifyPlatformUrl(requestedUrl.href)?.platform ?? "generic";
    const sourceUrl = canonicalizeUrl(requestedUrl, platform).href;
    const scope = effectiveScope(platform, resolvedOptions.scope);
    const options: CaptureArguments = { ...resolvedOptions, scope };
    const candidates: ExtractedPage[] = [];
    const attempts: CaptureAttempt[] = [];
    const archiveFallbackDenials = new Set<string>();
    const browserOperationalWarnings: string[] = [];
    let structuredCapture: PublicStructuredCapture | null = null;
    const browserScreenshots = new Map<AcquiredPage, string>();
    const eagerBrowserCandidates: ExtractedPage[] = [];
    const eagerBrowserAttempts: CaptureAttempt[] = [];
    const eagerBrowserRequested = options.mode === "auto" && browserFirstPlatforms.has(platform);
    if (eagerBrowserRequested && (options.browserLive || options.cdp !== undefined)) {
      browserOperationalWarnings.push(
        "An attached browser attempt may have navigated and scrolled the active tab even if that candidate was not selected.",
      );
    } else if (
      eagerBrowserRequested
      && options.browserProfile !== undefined
      && options.browserProfileOwnership !== "owned"
    ) {
      browserOperationalWarnings.push(
        "A selected browser profile was exercised even if that candidate was not selected; a path-backed persistent profile may have been updated by page activity.",
      );
    }
    const eagerBrowser = eagerBrowserRequested
      ? tryAcquisition(
          options.browserLive ? "browser-live" : options.cdp === undefined ? "browser" : "browser-cdp",
          () => deps.acquireBrowser(options, browserTemporaryDirectory, false),
          scope,
          options.timeoutMs,
          deps.extractPage,
          eagerBrowserCandidates,
          eagerBrowserAttempts,
          archiveFallbackDenials,
        )
      : null;
    if (options.currentTab) {
      if (currentBrowser === null) throw new Error("current browser acquisition did not produce a page");
      const browser = await tryAcquisition(
        options.browserLive ? "browser-live-current" : "browser-cdp-current",
        () => Promise.resolve(currentBrowser),
        scope,
        options.timeoutMs,
        deps.extractPage,
        candidates,
        attempts,
        archiveFallbackDenials,
      );
      if (browser !== null) browserOperationalWarnings.push(...browser.warnings);
      if (browser?.screenshotPath !== undefined) browserScreenshots.set(browser, browser.screenshotPath);
    } else if (options.mode === "file") {
      await tryAcquisition(
        "file",
        () => deps.acquireFile(options),
        scope,
        options.timeoutMs,
        deps.extractPage,
        candidates,
        attempts,
        archiveFallbackDenials,
      );
    } else {
      if (options.mode === "auto" || options.mode === "http") {
        try {
          structuredCapture = await deps.acquirePublicStructured(options);
          if (structuredCapture !== null) {
            candidates.push(structuredCapture.extraction);
            recordArchiveFallbackDenial(archiveFallbackDenials, structuredCapture.extraction);
            attempts.push({
              method: structuredCapture.extraction.acquisition.method,
              outcome: "succeeded",
              message: `${structuredCapture.extraction.status}; ${structuredCapture.extraction.capturedItems} items`,
            });
          } else {
            attempts.push({ method: "public-api", outcome: "skipped", message: "no stable public structured adapter" });
          }
        } catch (error) {
          recordArchiveFallbackErrorDenial(archiveFallbackDenials, error);
          attempts.push({ method: "public-api", outcome: "failed", message: safeAttemptMessage(error) });
        }
        await tryAcquisition(
          "http",
          () => deps.acquireHttp(options),
          scope,
          options.timeoutMs,
          deps.extractPage,
          candidates,
          attempts,
          archiveFallbackDenials,
        );
        if (options.cookieSources.length > 0 || options.cookiesFile !== undefined) {
          await tryAcquisition(
            "cookie-http",
            () => deps.acquireCookieHttp(options),
            scope,
            options.timeoutMs,
            deps.extractPage,
            candidates,
            attempts,
            archiveFallbackDenials,
          );
        }
      }

      if (eagerBrowser !== null) {
        const browser = await eagerBrowser;
        candidates.push(...eagerBrowserCandidates);
        attempts.push(...eagerBrowserAttempts);
        if (browser !== null) browserOperationalWarnings.push(...browser.warnings);
        if (browser?.screenshotPath !== undefined) browserScreenshots.set(browser, browser.screenshotPath);
      } else if (shouldUseBrowser(options, platform, scope, candidates)) {
        if (options.browserLive || options.cdp !== undefined) {
          browserOperationalWarnings.push(
            "An attached browser attempt may have navigated and scrolled the active tab even if that candidate was not selected.",
          );
        } else if (
          options.browserProfile !== undefined
          && options.browserProfileOwnership !== "owned"
        ) {
          browserOperationalWarnings.push(
            "A selected browser profile was exercised even if that candidate was not selected; a path-backed persistent profile may have been updated by page activity.",
          );
        }
        const browser = await tryAcquisition(
          options.browserLive ? "browser-live" : options.cdp === undefined ? "browser" : "browser-cdp",
          () => deps.acquireBrowser(options, browserTemporaryDirectory, false),
          scope,
          options.timeoutMs,
          deps.extractPage,
          candidates,
          attempts,
          archiveFallbackDenials,
        );
        if (browser !== null) browserOperationalWarnings.push(...browser.warnings);
        if (browser?.screenshotPath !== undefined) browserScreenshots.set(browser, browser.screenshotPath);
      }
    }

    if (shouldTryArchiveFallback(options, candidates, structuredCapture)) {
      if (archiveFallbackDenials.size > 0) {
        attempts.push({
          method: "archive-is-discovery",
          outcome: "skipped",
          message: `archive fallback disabled after ${[...archiveFallbackDenials].sort().join(" and ")}`,
        });
      } else {
        await tryArchiveFallback({
          sourceUrl,
          platform,
          scope,
          captureOptions: options,
          extractor: deps.extractPage,
          discover: deps.discoverArchiveTodaySnapshot,
          acquire: deps.acquireArchiveTodaySnapshot,
          now: deps.now,
          candidates,
          attempts,
        });
      }
    }

    const best = chooseCaptureExtraction(candidates, structuredCapture);
    if (best === null) {
      const details = attempts.filter(({ outcome }) => outcome === "failed").map(({ method, message }) => `${method}: ${message}`);
      throw new Error(`no acquisition produced usable content${details.length === 0 ? "" : ` (${details.join("; ")})`}`);
    }
    const slug = captureSlug(options, best);
    if (slug === "") {
      throw new Error(options.slug === undefined
        ? "could not derive a safe slug; pass one after the URL"
        : `slug ${JSON.stringify(options.slug)} contains no letters or digits`);
    }

    const capturedAt = deps.now().toISOString();
    const attemptWarnings = attempts
      .filter(({ outcome }) => outcome === "failed")
      .map(({ method, message }) => `${method} attempt failed: ${message}`);
    const warnings = [...new Set([...best.warnings, ...browserOperationalWarnings, ...attemptWarnings])];

    if (options.stdout) {
      const rewritten = rewriteContentWithStatus(best.article.content, best.canonicalUrl, new Map());
      const status = statusAfterContentRewrite(best.status, rewritten.truncated);
      const redactedMarkdown = redactSensitiveTextWithCount(buildClipMarkdown(best.article, {
        slug,
        sourceHref: best.canonicalUrl.href,
        clipped: capturedAt.slice(0, 10),
        content: rewritten.content,
        platform: best.platform,
        captureStatus: status,
        captureMethod: best.acquisition.method,
        captureScope: scope,
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
          ...(rewritten.truncated ? [CONTENT_REWRITE_TRUNCATION_WARNING] : []),
        ], redactedMarkdown.count),
        attempts,
        markdown: redactedMarkdown.text,
        manifest: null,
      };
    }

    const transaction = beginCaptureBundle({ outputRoot: options.outputBase, slug, force: options.force });
    try {
      const imageCookieProvider = assetCookieProvider(options, deps.acquireCookieRecords, best.canonicalUrl);
      const localized = options.media === "none"
        ? {
            ...rewriteContentWithStatus(best.article.content, best.canonicalUrl, new Map()),
            assets: [] as readonly AssetRecord[],
            warnings: [] as readonly string[],
          }
        : await deps.localizeAssets(best.article.content, {
            assetsDirectory: transaction.assetsDirectory,
            baseUrl: best.canonicalUrl,
            userAgent: options.userAgent,
            timeoutMs: options.timeoutMs,
            maxAssetBytes: options.maxAssetBytes,
            maxTotalAssetBytes: options.maxTotalAssetBytes,
            allowPrivateNetwork: options.allowPrivateNetwork,
            ...(imageCookieProvider === undefined ? {} : { cookieHeaderProvider: imageCookieProvider }),
          });
      const combinedWarnings = [
        ...warnings,
        ...localized.warnings,
        ...(localized.truncated ? [CONTENT_REWRITE_TRUNCATION_WARNING] : []),
      ];
      const status = statusAfterContentRewrite(best.status, localized.truncated);
      const manifestAssets: CaptureManifestAsset[] = [...localized.assets];
      let videoContext: VideoContextCaptureResult | null = null;
      let videoContextStatus: CaptureManifestInput["artifacts"]["videoContext"]["status"] = "not-requested";
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
            outputDirectory: join(transaction.assetsDirectory, "video"),
            relativePrefix: "assets/video",
            timeoutMs: options.timeoutMs,
            maxFileBytes: Math.min(options.maxAssetBytes, remainingBytes),
            maxTotalBytes: remainingBytes,
            allowPrivateNetwork: options.allowPrivateNetwork,
            maxFiles: Math.max(3, Math.min(options.maxItems, 12)),
            userAgent: options.userAgent,
            ...cookieMediaOptions(options),
          });
          videoContextStatus = videoContext.status === "captured" && videoContext.warnings.length > 0
            ? "partial"
            : videoContext.status;
          if (videoContext.thumbnail !== null) {
            manifestAssets.push(mediaRecordManifestAsset(videoContext.thumbnail, best.canonicalUrl.href));
          }
          combinedWarnings.push(...videoContext.warnings);
        }
      }
      let mediaRecords: readonly MediaRecord[] = [];
      let mediaStatus: CaptureManifestInput["artifacts"]["media"]["status"] = "not-requested";
      if (options.media === "all") {
        const usedBytes = manifestAssets.reduce((sum, asset) => sum + asset.bytes, 0);
        const remainingBytes = options.maxTotalAssetBytes - usedBytes;
        if (remainingBytes < 1) {
          mediaStatus = "partial";
          combinedWarnings.push("Skipped full media because the configured asset byte budget was exhausted.");
        } else {
          const media = await deps.captureMedia({
            url: best.canonicalUrl,
            outputDirectory: join(transaction.assetsDirectory, "media"),
            relativePrefix: "assets/media",
            timeoutMs: options.timeoutMs,
            maxFileBytes: Math.min(options.maxAssetBytes, remainingBytes),
            maxTotalBytes: remainingBytes,
            allowPrivateNetwork: options.allowPrivateNetwork,
            maxFiles: Math.min(options.maxItems, 100),
            userAgent: options.userAgent,
            ...cookieMediaOptions(options),
          });
          mediaStatus = media.status === "captured" && media.warnings.length > 0 ? "partial" : media.status;
          mediaRecords = media.records;
          manifestAssets.push(...mediaManifestAssets(media, best.canonicalUrl.href));
          combinedWarnings.push(...media.warnings);
        }
      }

      const requestedScreenshot = options.evidence === "screenshot" || options.evidence === "all";
      const selectedScreenshot = browserScreenshots.get(best.acquisition) ?? null;
      const screenshotPath = requestedScreenshot
        ? screenshotIntoBundle(selectedScreenshot, transaction, options.maxAssetBytes)
        : null;
      if (requestedScreenshot && screenshotPath === null) {
        combinedWarnings.push(
          browserScreenshots.size > 0
            ? "A screenshot was captured for a different acquisition candidate, so it was not attached to the selected content."
            : "A screenshot was requested but no valid bounded PNG was captured.",
        );
      }
      const article = articleWithVideoMetadata(best.article, videoContext?.metadata ?? null);
      const contentWithVideo = videoContext === null
        ? localized.content
        : appendVideoContext(localized.content, videoContext);
      const redactedMarkdown = redactSensitiveTextWithCount(buildClipMarkdown(article, {
        slug,
        sourceHref: best.canonicalUrl.href,
        clipped: capturedAt.slice(0, 10),
        content: appendCapturedMedia(contentWithVideo, mediaRecords),
        platform: best.platform,
        captureStatus: status,
        captureMethod: best.acquisition.method,
        captureScope: scope,
      }));
      const wordCount = countWords(redactedMarkdown.text);
      const finalWarnings = finalizedWarnings(combinedWarnings, redactedMarkdown.count);
      const includeSource = options.evidence === "source" || options.evidence === "all";
      const manifestInput: CaptureManifestInput = {
        sourceUrl,
        canonicalUrl: best.canonicalUrl.href,
        capturedAt,
        platform: best.platform,
        status,
        scope,
        acquisition: {
          method: best.acquisition.method,
          finalUrl: best.acquisition.method === "archive-is"
            ? sanitizeArtifactUrl(best.acquisition.finalUrl.href)
            : canonicalizeUrl(best.acquisition.finalUrl, best.platform).href,
          contentType: best.acquisition.contentType,
        },
        extraction: {
          extractor: best.extractor,
          score: best.score,
          wordCount,
          capturedItems: best.capturedItems,
          expectedItems: best.expectedItems,
        },
        attempts,
        assets: manifestAssets,
        artifacts: {
          images: {
            requested: options.media !== "none",
            status: options.media === "none"
              ? "not-requested"
              : localized.truncated || localized.warnings.length > 0 ? "partial" : "captured",
            files: localized.assets.length,
          },
          media: {
            requested: options.media === "all",
            status: mediaStatus,
            files: mediaRecords.length,
          },
          videoContext: {
            requested: videoContextRequested,
            status: videoContextStatus,
            thumbnailPath: videoContext?.thumbnail?.path ?? null,
            transcriptLanguage: videoContext?.transcript?.language ?? null,
            transcriptCueCount: videoContext?.transcript?.cueCount ?? 0,
            transcriptTruncated: videoContext?.transcript?.truncated ?? false,
            metadata: videoContext?.metadata ?? null,
          },
        },
        evidence: {
          requested: options.evidence,
          screenshotPath,
          screenshotStatus: requestedScreenshot ? screenshotPath === null ? "unavailable" : "captured" : "not-requested",
          sourceHtmlStatus: includeSource ? "captured" : "not-requested",
        },
        warnings: finalWarnings,
      };
      const manifest = writeCaptureBundle(transaction, {
        markdown: redactedMarkdown.text,
        manifest: manifestInput,
        ...(includeSource ? { sourceHtml: best.acquisition.sourceEvidence ?? best.acquisition.body } : {}),
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
        markdownPath: join(outputDirectory, `${slug}.md`),
        assetCount: manifestAssets.length,
        warnings: finalWarnings,
        attempts,
        markdown: redactedMarkdown.text,
        manifest,
      };
    } catch (error) {
      abortCaptureBundle(transaction);
      throw error;
    }
  } finally {
    rmSync(browserTemporaryDirectory, { recursive: true, force: true });
  }
}
