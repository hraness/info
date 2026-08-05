import {
  discoverArchiveTodaySnapshot,
  type ArchiveTodayDependencies,
  type ArchiveTodayDiscovery,
} from "./archive-today.js";
import {
  createExactUrlSearchQuery,
  type SearchProvider,
} from "./metadata-search.js";
import { assertSafeNetworkUrl } from "./network.js";
import {
  parseArchiveTodayMementoUrl,
  rankMetadataSearchResults,
  type ArchiveTodayMemento,
  type MetadataSearchResponse,
} from "./url-intelligence.js";
import {
  createUrlMetadataDocument,
  discoverSavedUrlRecords,
  readUrlMetadataDocument,
  writeUrlMetadataDocument,
  type SavedUrlRecord,
  type UrlMetadataArchive,
  type UrlMetadataAttempt,
  type UrlMetadataCandidate,
  type UrlMetadataDocument,
} from "./url-metadata.js";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_INTER_REQUEST_DELAY_MS = 60_000;

export type UrlMetadataBackfillOptions = {
  readonly vaultRoot: string;
  /** Re-run compatible existing sidecars. The default is a resumable skip. */
  readonly refresh?: boolean;
  /** Also ask Archive.today for its newest existing snapshot. This never creates a snapshot. */
  readonly discoverArchives?: boolean;
  readonly interRequestDelayMs?: number;
  readonly maxResults?: number;
  readonly searchTimeoutMs?: number;
  readonly networkValidationTimeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type UrlMetadataNetworkAssertion = (
  url: URL,
  allowPrivateNetwork: boolean,
  timeoutMs?: number,
) => Promise<void>;

export type ArchiveTodayDiscoveryProvider = (
  sourceUrl: string | URL,
  dependencies?: ArchiveTodayDependencies,
) => Promise<ArchiveTodayDiscovery>;

export type UrlMetadataBackfillDependencies = {
  readonly searchProvider: SearchProvider;
  readonly discoverRecords?: typeof discoverSavedUrlRecords;
  readonly readMetadata?: typeof readUrlMetadataDocument;
  readonly writeMetadata?: typeof writeUrlMetadataDocument;
  readonly assertNetworkUrl?: UrlMetadataNetworkAssertion;
  readonly discoverArchive?: ArchiveTodayDiscoveryProvider;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type UrlMetadataBackfillAction = "skipped" | "written" | "unchanged";

export type UrlMetadataBackfillItem = {
  readonly articleId: string;
  readonly subjectUrl: string;
  readonly sidecarPath: string;
  readonly action: UrlMetadataBackfillAction;
  readonly status: UrlMetadataDocument["status"];
};

export type UrlMetadataBackfillStatusCounts = {
  readonly matched: number;
  readonly notFound: number;
  readonly partial: number;
  readonly unavailable: number;
};

export type UrlMetadataBackfillReport = {
  readonly generatedAt: string;
  readonly totalRecords: number;
  readonly processedRecords: number;
  readonly skippedRecords: number;
  readonly writtenRecords: number;
  readonly unchangedRecords: number;
  readonly remainingRecords: number;
  readonly aborted: boolean;
  readonly statusCounts: UrlMetadataBackfillStatusCounts;
  readonly items: readonly UrlMetadataBackfillItem[];
};

type ResolvedOptions = {
  readonly vaultRoot: string;
  readonly refresh: boolean;
  readonly discoverArchives: boolean;
  readonly interRequestDelayMs: number;
  readonly maxResults: number;
  readonly searchTimeoutMs: number;
  readonly networkValidationTimeoutMs: number;
  readonly signal?: AbortSignal;
};

type ResolvedDependencies = {
  readonly searchProvider: SearchProvider;
  readonly discoverRecords: typeof discoverSavedUrlRecords;
  readonly readMetadata: typeof readUrlMetadataDocument;
  readonly writeMetadata: typeof writeUrlMetadataDocument;
  readonly assertNetworkUrl: UrlMetadataNetworkAssertion;
  readonly discoverArchive: ArchiveTodayDiscoveryProvider;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

type RecordMetadata = {
  readonly attempts: UrlMetadataAttempt[];
  readonly candidates: UrlMetadataCandidate[];
  readonly archives: Map<string, UrlMetadataArchive>;
  readonly warnings: string[];
  enginesQueried: readonly string[];
  enginesFailed: readonly string[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function resolveOptions(options: UrlMetadataBackfillOptions): ResolvedOptions {
  if (typeof options.vaultRoot !== "string" || options.vaultRoot.trim() === "") {
    throw new TypeError("The URL metadata backfill vault root must be a non-empty path.");
  }
  return Object.freeze({
    vaultRoot: options.vaultRoot,
    refresh: options.refresh ?? false,
    discoverArchives: options.discoverArchives ?? false,
    interRequestDelayMs: boundedInteger(
      options.interRequestDelayMs,
      0,
      0,
      MAX_INTER_REQUEST_DELAY_MS,
      "URL metadata backfill inter-request delay",
    ),
    maxResults: boundedInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, 20, "URL metadata backfill result limit"),
    searchTimeoutMs: boundedInteger(
      options.searchTimeoutMs,
      DEFAULT_SEARCH_TIMEOUT_MS,
      500,
      15_000,
      "URL metadata backfill search timeout",
    ),
    networkValidationTimeoutMs: boundedInteger(
      options.networkValidationTimeoutMs,
      DEFAULT_NETWORK_VALIDATION_TIMEOUT_MS,
      250,
      60_000,
      "URL metadata backfill network validation timeout",
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function abortAwareSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  const abortError = (): Error => signal?.reason instanceof Error
    ? signal.reason
    : new Error("URL metadata backfill aborted.");
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const abort = (): void => finish(abortError());
    function finish(error?: Error): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function resolveDependencies(dependencies: UrlMetadataBackfillDependencies): ResolvedDependencies {
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
    now: dependencies.now ?? (() => new Date()),
    sleep: dependencies.sleep ?? abortAwareSleep,
  });
}

function canonicalNow(now: () => Date): Date {
  let value: Date;
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

function sortedInventory(records: readonly SavedUrlRecord[]): readonly SavedUrlRecord[] {
  const sorted = [...records].sort((left, right) =>
    compareText(left.articleId, right.articleId)
    || compareText(left.subjectUrl, right.subjectUrl)
    || compareText(left.markdownPath, right.markdownPath));
  const sidecars = new Set<string>();
  for (const record of sorted) {
    if (sidecars.has(record.sidecarPath)) {
      throw new Error(`URL metadata inventory repeats a sidecar path: ${record.sidecarPath}`);
    }
    sidecars.add(record.sidecarPath);
  }
  return Object.freeze(sorted);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function readExisting(
  saved: SavedUrlRecord,
  readMetadata: typeof readUrlMetadataDocument,
): UrlMetadataDocument | null {
  try {
    return readMetadata(saved);
  } catch (error) {
    if (isMissingFile(error)) return null;
    // A malformed, mismatched, linked, or otherwise unsafe sidecar is never
    // treated as absent, even during an explicit refresh.
    throw error;
  }
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(compareText));
}

function addArchive(
  archives: Map<string, UrlMetadataArchive>,
  memento: ArchiveTodayMemento,
  discovery: UrlMetadataArchive["discovery"],
): void {
  // A timestamp is Archive.today's capture identity for one already-bound
  // original. This also deduplicates aliases for the same snapshot.
  const candidate: UrlMetadataArchive = Object.freeze({
    url: memento.url,
    capturedAt: memento.capturedAt,
    discovery,
  });
  const previous = archives.get(memento.timestamp);
  if (
    previous === undefined
    || (previous.discovery === "metadata-search" && discovery === "newest")
    || (previous.discovery === discovery && compareText(candidate.url, previous.url) < 0)
  ) archives.set(memento.timestamp, candidate);
}

function collectSuccessfulSearch(
  subjectUrl: string,
  query: string,
  response: MetadataSearchResponse,
  now: Date,
  metadata: RecordMetadata,
  resultLimit: number,
): void {
  if (response.query !== query) {
    metadata.attempts.push(Object.freeze({
      provider: "metadata-search-engine-rs",
      outcome: "failed",
      message: "Metadata search returned a response for a different query.",
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
        score: result.score,
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
  const unavailable = response.engineStatus === "unavailable"
    || response.enginesFailed.length === response.enginesQueried.length;
  const partial = !unavailable && (response.engineStatus === "partial" || response.enginesFailed.length > 0);
  const usefulMatches = metadata.candidates.length + archiveMatches;
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: unavailable ? "failed" : partial ? "partial" : usefulMatches > 0 ? "succeeded" : "not-found",
    message: unavailable
      ? "Metadata search failed because all queried engines were unavailable."
      : partial
      ? `Metadata search completed with ${response.enginesFailed.length} failed engine${response.enginesFailed.length === 1 ? "" : "s"}.`
      : usefulMatches > 0
        ? `Metadata search returned ${metadata.candidates.length} exact source match${metadata.candidates.length === 1 ? "" : "es"} and ${archiveMatches} bound archive match${archiveMatches === 1 ? "" : "es"}.`
        : "Metadata search returned no exact source or bound archive matches.",
  }));
}

function addSearchFailure(metadata: RecordMetadata, category: string): void {
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: "failed",
    message: `Metadata search failed (${category}).`,
  }));
}

async function runArchiveDiscovery(
  saved: SavedUrlRecord,
  now: Date,
  discoverArchive: ArchiveTodayDiscoveryProvider,
  metadata: RecordMetadata,
): Promise<void> {
  let outcome: ArchiveTodayDiscovery;
  try {
    outcome = await discoverArchive(saved.subjectUrl, { now: () => new Date(now.getTime()) });
  } catch {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "failed",
      message: "Archive.today discovery failed.",
    }));
    return;
  }
  if (outcome.status === "found") {
    try {
      const memento = parseArchiveTodayMementoUrl(outcome.snapshot.url, {
        originalUrl: saved.subjectUrl,
        now,
      });
      addArchive(metadata.archives, memento, "newest");
      metadata.attempts.push(Object.freeze({
        provider: "archive-today",
        outcome: "succeeded",
        message: "Archive.today returned a validated newest snapshot.",
      }));
    } catch {
      metadata.attempts.push(Object.freeze({
        provider: "archive-today",
        outcome: "failed",
        message: "Archive.today returned an invalid newest snapshot.",
      }));
    }
    return;
  }
  if (outcome.status === "not-found") {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "not-found",
      message: "Archive.today has no discoverable snapshot for this source.",
    }));
    return;
  }
  if (outcome.status === "throttled") {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "failed",
      message: "Archive.today throttled snapshot discovery.",
    }));
    return;
  }
  metadata.attempts.push(Object.freeze({
    provider: "archive-today",
    outcome: "failed",
    message: `Archive.today snapshot discovery was unavailable (${outcome.reason}).`,
  }));
}

function newRecordMetadata(): RecordMetadata {
  return {
    attempts: [],
    candidates: [],
    archives: new Map(),
    warnings: [],
    enginesQueried: Object.freeze([]),
    enginesFailed: Object.freeze([]),
  };
}

function skipUnsafeProviders(metadata: RecordMetadata, includeArchive: boolean, reason: "network" | "query"): void {
  const explanation = reason === "network"
    ? "the source failed network-safety validation"
    : "the source could not form a disclosure-safe exact query";
  metadata.attempts.push(Object.freeze({
    provider: "metadata-search-engine-rs",
    outcome: "skipped",
    message: `Metadata search was skipped because ${explanation}.`,
  }));
  if (includeArchive) {
    metadata.attempts.push(Object.freeze({
      provider: "archive-today",
      outcome: "skipped",
      message: `Archive.today discovery was skipped because ${explanation}.`,
    }));
  }
  metadata.warnings.push(`No URL was disclosed because ${explanation}.`);
}

function item(saved: SavedUrlRecord, action: UrlMetadataBackfillAction, document: UrlMetadataDocument): UrlMetadataBackfillItem {
  return Object.freeze({
    articleId: saved.articleId,
    subjectUrl: saved.subjectUrl,
    sidecarPath: saved.sidecarPath,
    action,
    status: document.status,
  });
}

function report(
  generatedAt: string,
  totalRecords: number,
  items: readonly UrlMetadataBackfillItem[],
  interrupted: boolean,
): UrlMetadataBackfillReport {
  const skippedRecords = items.filter(({ action }) => action === "skipped").length;
  const writtenRecords = items.filter(({ action }) => action === "written").length;
  const unchangedRecords = items.filter(({ action }) => action === "unchanged").length;
  const counts: UrlMetadataBackfillStatusCounts = Object.freeze({
    matched: items.filter(({ status }) => status === "matched").length,
    notFound: items.filter(({ status }) => status === "not-found").length,
    partial: items.filter(({ status }) => status === "partial").length,
    unavailable: items.filter(({ status }) => status === "unavailable").length,
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
    items: Object.freeze([...items]),
  });
}

/**
 * Backfill tool-owned URL metadata sidecars one record and one outbound request
 * at a time. Provider failures are recorded; filesystem-integrity failures are
 * deliberately allowed to stop the run.
 */
export async function backfillSavedUrlMetadata(
  options: UrlMetadataBackfillOptions,
  dependencies: UrlMetadataBackfillDependencies,
): Promise<UrlMetadataBackfillReport> {
  const resolvedOptions = resolveOptions(options);
  const resolved = resolveDependencies(dependencies);
  const now = canonicalNow(resolved.now);
  const generatedAt = now.toISOString();
  const records = sortedInventory(resolved.discoverRecords(resolvedOptions.vaultRoot));
  const items: UrlMetadataBackfillItem[] = [];
  let interrupted = isAborted(resolvedOptions.signal);
  let outboundRequestStarted = false;

  const waitForRequestSlot = async (): Promise<boolean> => {
    if (isAborted(resolvedOptions.signal)) return false;
    if (outboundRequestStarted && resolvedOptions.interRequestDelayMs > 0) {
      try {
        await resolved.sleep(resolvedOptions.interRequestDelayMs, resolvedOptions.signal);
      } catch (error) {
        if (isAborted(resolvedOptions.signal)) return false;
        throw error;
      }
      if (isAborted(resolvedOptions.signal)) return false;
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
      await resolved.assertNetworkUrl(
        new URL(saved.subjectUrl),
        false,
        resolvedOptions.networkValidationTimeoutMs,
      );
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
          ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
        });
        if (isAborted(resolvedOptions.signal)) {
          interrupted = true;
          break;
        }
        if (outcome.status === "failure") addSearchFailure(metadata, outcome.category);
        else collectSuccessfulSearch(
          saved.subjectUrl,
          query,
          outcome.response,
          now,
          metadata,
          resolvedOptions.maxResults,
        );
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
      warnings: metadata.warnings,
    });
    const write = resolved.writeMetadata(saved, document);
    items.push(item(saved, write.changed ? "written" : "unchanged", document));
  }

  return report(generatedAt, records.length, items, interrupted);
}
