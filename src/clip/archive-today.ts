import type { AcquiredPage } from "./acquire.js";
import {
  assertSafeNetworkUrl,
  decodeBytes,
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./network.js";
import {
  MAX_URL_INTELLIGENCE_URL_UTF8_BYTES,
  normalizeSourceUrlIdentity,
  parseArchiveTodayMementoUrl,
  type ArchiveTodayMemento,
} from "./url-intelligence.js";
import { sanitizeArtifactUrl } from "./persist.js";

const archiveTodayDiscoveryOrigin = "https://archive.ph";
const archiveTodayDiscoveryPrefix = `${archiveTodayDiscoveryOrigin}/newest/`;
const defaultUserAgent = "@hraness/kb archive-today fallback";
const defaultTimeoutMs = 10_000;
const defaultMaximumBytes = 8 * 1024 * 1024;
const discoveryMaximumBytes = 256 * 1024;
const maximumSourceUrlBytes = 16 * 1024;
const maximumUserAgentBytes = 512;

export type ArchiveTodayFetch = (
  url: URL,
  options: SafeFetchOptions,
) => Promise<SafeFetchResult>;

export type ArchiveTodayDependencies = {
  /** Test and composition seam. Discovery requires `assertNetworkUrl` with a custom transport. */
  readonly fetch?: ArchiveTodayFetch;
  /** Test seam used to reject future-dated mementos deterministically. */
  readonly now?: () => Date;
  /** Test seam for enforcing one deadline across validation and provider requests. */
  readonly monotonicNow?: () => number;
  /** Composition seam for validating the source before disclosing it to Archive.today. */
  readonly assertNetworkUrl?: typeof assertSafeNetworkUrl;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly userAgent?: string;
};

export type ArchiveTodaySnapshot = {
  readonly url: string;
  readonly capturedAt: string;
  readonly sourceUrl: string;
  readonly discovery: "newest";
};

export type ArchiveTodayUnavailableReason =
  | "request-failed"
  | "unexpected-response"
  | "invalid-snapshot";

export type ArchiveTodayDiscovery =
  | {
      readonly status: "found";
      readonly sourceUrl: string;
      readonly snapshot: ArchiveTodaySnapshot;
    }
  | {
      readonly status: "not-found";
      readonly sourceUrl: string;
    }
  | {
      readonly status: "throttled";
      readonly sourceUrl: string;
    }
  | {
      readonly status: "unavailable";
      readonly sourceUrl: string;
      readonly reason: ArchiveTodayUnavailableReason;
    };

export type ArchiveTodayFailureCode =
  | "invalid-source-url"
  | "invalid-snapshot"
  | "invalid-clock"
  | "invalid-options"
  | "request-failed"
  | "not-found"
  | "throttled"
  | "unexpected-response"
  | "unsupported-content";

const failureMessages: Readonly<Record<ArchiveTodayFailureCode, string>> = Object.freeze({
  "invalid-source-url": "Archive.today requires a bounded public HTTP(S) source URL.",
  "invalid-snapshot": "Archive.today returned a snapshot that could not be bound to the source URL.",
  "invalid-clock": "Archive.today validation requires a valid current time.",
  "invalid-options": "Archive.today adapter options are outside their supported bounds.",
  "request-failed": "Archive.today could not be reached.",
  "not-found": "The validated Archive.today snapshot is no longer available.",
  "throttled": "Archive.today throttled the request.",
  "unexpected-response": "Archive.today returned an unexpected response.",
  "unsupported-content": "Archive.today did not return a non-empty HTML document.",
});

/** A categorical provider failure that never includes response bodies or remote error text. */
export class ArchiveTodayFailure extends Error {
  readonly code: ArchiveTodayFailureCode;

  constructor(code: ArchiveTodayFailureCode) {
    super(failureMessages[code]);
    this.name = "ArchiveTodayFailure";
    this.code = code;
  }
}

type ResolvedDependencies = {
  readonly fetch: ArchiveTodayFetch;
  readonly now: Date;
  readonly monotonicNow: () => number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  readonly assertNetworkUrl: typeof assertSafeNetworkUrl;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function containsUnsafeLocationControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x061c
      || codePoint === 0x200e
      || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) return true;
  }
  return false;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new ArchiveTodayFailure("invalid-options");
  }
  return selected;
}

function resolveDependencies(dependencies: ArchiveTodayDependencies): ResolvedDependencies {
  let now: Date;
  try {
    now = dependencies.now?.() ?? new Date();
  } catch {
    throw new ArchiveTodayFailure("invalid-clock");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ArchiveTodayFailure("invalid-clock");
  }
  const userAgent = dependencies.userAgent ?? defaultUserAgent;
  if (
    userAgent.trim() === ""
    || utf8Length(userAgent) > maximumUserAgentBytes
    || containsUnsafeLocationControl(userAgent)
  ) {
    throw new ArchiveTodayFailure("invalid-options");
  }
  return Object.freeze({
    fetch: dependencies.fetch ?? safeFetch,
    assertNetworkUrl: dependencies.assertNetworkUrl ?? assertSafeNetworkUrl,
    now: new Date(now.getTime()),
    monotonicNow: dependencies.monotonicNow ?? Date.now,
    timeoutMs: boundedInteger(dependencies.timeoutMs, defaultTimeoutMs, 250, 60_000),
    maxBytes: boundedInteger(dependencies.maxBytes, defaultMaximumBytes, 1, 64 * 1024 * 1024),
    userAgent,
  });
}

function monotonicTime(resolved: ResolvedDependencies): number {
  let value: number;
  try {
    value = resolved.monotonicNow();
  } catch {
    throw new ArchiveTodayFailure("invalid-clock");
  }
  if (!Number.isFinite(value)) throw new ArchiveTodayFailure("invalid-clock");
  return value;
}

function remainingTimeout(deadline: number, resolved: ResolvedDependencies): number {
  return Math.floor(deadline - monotonicTime(resolved));
}

function normalizeSourceUrl(value: string | URL): URL {
  const identity = normalizeSourceUrlIdentity(value);
  if (identity === null || utf8Length(identity) > maximumSourceUrlBytes) {
    throw new ArchiveTodayFailure("invalid-source-url");
  }
  // The lookup discloses the complete URL to Archive.today. Reject URLs whose
  // credential-shaped query data would be removed from a durable artifact.
  if (sanitizeArtifactUrl(identity) !== identity) {
    throw new ArchiveTodayFailure("invalid-source-url");
  }
  return new URL(identity);
}

function parseMemento(
  value: string | URL,
  source: URL,
  now: Date,
): ArchiveTodayMemento {
  try {
    return parseArchiveTodayMementoUrl(value, { originalUrl: source, now });
  } catch {
    throw new ArchiveTodayFailure("invalid-snapshot");
  }
}

function snapshotFromMemento(memento: ArchiveTodayMemento): ArchiveTodaySnapshot {
  return Object.freeze({
    url: memento.url,
    capturedAt: memento.capturedAt,
    sourceUrl: memento.originalUrl,
    discovery: "newest",
  });
}

function unavailable(
  sourceUrl: string,
  reason: ArchiveTodayUnavailableReason,
): ArchiveTodayDiscovery {
  return Object.freeze({ status: "unavailable", sourceUrl, reason });
}

/**
 * Find Archive.today's newest existing snapshot without creating one.
 *
 * This performs one manual-redirect request against the fixed `archive.ph`
 * lookup route. It never calls Archive.today's submission endpoint, never
 * retries, and never probes alternate aliases when the provider refuses the
 * request.
 */
export async function discoverArchiveTodaySnapshot(
  sourceUrl: string | URL,
  dependencies: ArchiveTodayDependencies = {},
): Promise<ArchiveTodayDiscovery> {
  if (dependencies.fetch !== undefined && dependencies.assertNetworkUrl === undefined) {
    throw new ArchiveTodayFailure("invalid-options");
  }
  const source = normalizeSourceUrl(sourceUrl);
  const resolved = resolveDependencies(dependencies);
  const deadline = monotonicTime(resolved) + resolved.timeoutMs;
  try {
    await resolved.assertNetworkUrl(source, false, resolved.timeoutMs);
  } catch {
    return unavailable(source.href, "request-failed");
  }
  const remaining = remainingTimeout(deadline, resolved);
  if (remaining <= 0) return unavailable(source.href, "request-failed");
  const lookupUrl = new URL(`${archiveTodayDiscoveryPrefix}${source.href}`);
  let response: SafeFetchResult;
  try {
    response = await resolved.fetch(lookupUrl, {
      timeoutMs: remaining,
      maxBytes: discoveryMaximumBytes,
      allowPrivateNetwork: false,
      userAgent: resolved.userAgent,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      retries: 0,
      maxRedirects: 0,
      redirect: "manual",
      acceptStatuses: [403, 404, 429],
    });
  } catch {
    return unavailable(source.href, "request-failed");
  }

  if (response.status === 404) {
    return Object.freeze({ status: "not-found", sourceUrl: source.href });
  }
  if (response.status === 403 || response.status === 429) {
    return Object.freeze({ status: "throttled", sourceUrl: source.href });
  }
  if (response.status < 300 || response.status >= 400) {
    return unavailable(source.href, "unexpected-response");
  }
  if (typeof response.location !== "string" || response.location.trim() === "") {
    return unavailable(source.href, "invalid-snapshot");
  }

  try {
    if (
      response.location !== response.location.trim()
      || containsUnsafeLocationControl(response.location)
      || utf8Length(response.location) > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES
    ) throw new ArchiveTodayFailure("invalid-snapshot");
    const location = new URL(response.location, lookupUrl);
    const memento = parseMemento(location, source, resolved.now);
    return Object.freeze({
      status: "found",
      sourceUrl: source.href,
      snapshot: snapshotFromMemento(memento),
    });
  } catch {
    return unavailable(source.href, "invalid-snapshot");
  }
}

function isHtmlContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/** Fetch one already validated snapshot, preserving the original URL binding across redirects. */
export async function acquireArchiveTodaySnapshot(
  sourceUrl: string | URL,
  snapshotUrl: string | URL,
  dependencies: ArchiveTodayDependencies = {},
): Promise<AcquiredPage> {
  if (dependencies.fetch !== undefined && dependencies.assertNetworkUrl === undefined) {
    throw new ArchiveTodayFailure("invalid-options");
  }
  const source = normalizeSourceUrl(sourceUrl);
  const resolved = resolveDependencies(dependencies);
  const requested = parseMemento(snapshotUrl, source, resolved.now);
  let current = new URL(requested.url);
  let response: SafeFetchResult | null = null;
  const deadline = monotonicTime(resolved) + resolved.timeoutMs;
  try {
    await resolved.assertNetworkUrl(source, false, resolved.timeoutMs);
  } catch {
    throw new ArchiveTodayFailure("request-failed");
  }
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const remaining = remainingTimeout(deadline, resolved);
    if (remaining <= 0) throw new ArchiveTodayFailure("request-failed");
    try {
      response = await resolved.fetch(current, {
        timeoutMs: remaining,
        maxBytes: resolved.maxBytes,
        allowPrivateNetwork: false,
        userAgent: resolved.userAgent,
        accept: "text/html,application/xhtml+xml;q=0.9",
        retries: 0,
        maxRedirects: 0,
        redirect: "manual",
        acceptStatuses: [403, 404, 429],
      });
    } catch {
      throw new ArchiveTodayFailure("request-failed");
    }
    if (response.finalUrl.href !== current.href) throw new ArchiveTodayFailure("invalid-snapshot");
    if (response.status < 300 || response.status >= 400) break;
    if (redirects === 4 || typeof response.location !== "string") {
      throw new ArchiveTodayFailure("invalid-snapshot");
    }
    if (
      response.location !== response.location.trim()
      || containsUnsafeLocationControl(response.location)
      || utf8Length(response.location) > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES
    ) throw new ArchiveTodayFailure("invalid-snapshot");
    let next: URL;
    try {
      next = new URL(response.location, current);
    } catch {
      throw new ArchiveTodayFailure("invalid-snapshot");
    }
    const redirected = parseMemento(next, source, resolved.now);
    if (redirected.timestamp !== requested.timestamp) throw new ArchiveTodayFailure("invalid-snapshot");
    current = new URL(redirected.url);
  }
  if (response === null) throw new ArchiveTodayFailure("request-failed");

  if (response.status === 403 || response.status === 429) {
    throw new ArchiveTodayFailure("throttled");
  }
  if (response.status === 404) throw new ArchiveTodayFailure("not-found");
  if (response.status < 200 || response.status >= 300) {
    throw new ArchiveTodayFailure("unexpected-response");
  }

  const finalMemento = parseMemento(current, source, resolved.now);
  if (finalMemento.timestamp !== requested.timestamp) throw new ArchiveTodayFailure("invalid-snapshot");
  if (!isHtmlContentType(response.contentType)) {
    throw new ArchiveTodayFailure("unsupported-content");
  }
  const body = decodeBytes(response.bytes, response.contentType);
  if (body.trim() === "") throw new ArchiveTodayFailure("unsupported-content");

  return Object.freeze({
    body,
    contentType: response.contentType,
    finalUrl: new URL(finalMemento.url),
    method: "archive-is",
    warnings: Object.freeze(["Captured from a validated Archive.today snapshot."]),
  });
}
