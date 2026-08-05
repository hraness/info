import {
  acquireArchiveTodaySnapshot as acquireArchiveTodaySnapshotImplementation,
  discoverArchiveTodaySnapshot as discoverArchiveTodaySnapshotImplementation,
  ArchiveTodayFailure,
} from "./clip/archive-today.js";
import {
  createExactUrlSearchQuery as createExactUrlSearchQueryImplementation,
  createRustMetadataSearchProvider as createRustMetadataSearchProviderImplementation,
  isolatedMetadataSearchEnvironment as isolatedMetadataSearchEnvironmentImplementation,
} from "./clip/metadata-search.js";
import {
  ARCHIVE_TODAY_HOSTS,
  isExactSourceTarget as isExactSourceTargetImplementation,
  normalizeSourceUrlIdentity as normalizeSourceUrlIdentityImplementation,
  parseArchiveTodayMementoUrl as parseArchiveTodayMementoUrlImplementation,
  parseArchiveTodayTimeMap as parseArchiveTodayTimeMapImplementation,
  parseMetadataSearchResponse as parseMetadataSearchResponseImplementation,
  rankMetadataSearchResults as rankMetadataSearchResultsImplementation,
  selectNewestArchiveTodayMemento as selectNewestArchiveTodayMementoImplementation,
} from "./clip/url-intelligence.js";
import {
  createUrlMetadataDocument as createUrlMetadataDocumentImplementation,
  discoverSavedUrlRecords as discoverSavedUrlRecordsImplementation,
  parseUrlMetadataDocument as parseUrlMetadataDocumentImplementation,
  readUrlMetadataDocument as readUrlMetadataDocumentImplementation,
  renderUrlMetadataDocument as renderUrlMetadataDocumentImplementation,
  writeUrlMetadataDocument as writeUrlMetadataDocumentImplementation,
} from "./clip/url-metadata.js";
import { backfillSavedUrlMetadata as backfillSavedUrlMetadataImplementation } from "./clip/url-metadata-backfill.js";

// Explicit assignments preserve runtime bindings through Bun's re-export bundler.
export { ARCHIVE_TODAY_HOSTS, ArchiveTodayFailure };
export const acquireArchiveTodaySnapshot: typeof acquireArchiveTodaySnapshotImplementation = (...arguments_) =>
  acquireArchiveTodaySnapshotImplementation(...arguments_);
export const discoverArchiveTodaySnapshot: typeof discoverArchiveTodaySnapshotImplementation = (...arguments_) =>
  discoverArchiveTodaySnapshotImplementation(...arguments_);
export const createExactUrlSearchQuery: typeof createExactUrlSearchQueryImplementation = (...arguments_) =>
  createExactUrlSearchQueryImplementation(...arguments_);
export const createRustMetadataSearchProvider: typeof createRustMetadataSearchProviderImplementation = (...arguments_) =>
  createRustMetadataSearchProviderImplementation(...arguments_);
export const isolatedMetadataSearchEnvironment: typeof isolatedMetadataSearchEnvironmentImplementation = (...arguments_) =>
  isolatedMetadataSearchEnvironmentImplementation(...arguments_);
export const isExactSourceTarget: typeof isExactSourceTargetImplementation = (...arguments_) =>
  isExactSourceTargetImplementation(...arguments_);
export const normalizeSourceUrlIdentity: typeof normalizeSourceUrlIdentityImplementation = (...arguments_) =>
  normalizeSourceUrlIdentityImplementation(...arguments_);
export const parseArchiveTodayMementoUrl: typeof parseArchiveTodayMementoUrlImplementation = (...arguments_) =>
  parseArchiveTodayMementoUrlImplementation(...arguments_);
export const parseArchiveTodayTimeMap: typeof parseArchiveTodayTimeMapImplementation = (...arguments_) =>
  parseArchiveTodayTimeMapImplementation(...arguments_);
export const parseMetadataSearchResponse: typeof parseMetadataSearchResponseImplementation = (...arguments_) =>
  parseMetadataSearchResponseImplementation(...arguments_);
export const rankMetadataSearchResults: typeof rankMetadataSearchResultsImplementation = (...arguments_) =>
  rankMetadataSearchResultsImplementation(...arguments_);
export const selectNewestArchiveTodayMemento: typeof selectNewestArchiveTodayMementoImplementation = (...arguments_) =>
  selectNewestArchiveTodayMementoImplementation(...arguments_);
export const createUrlMetadataDocument: typeof createUrlMetadataDocumentImplementation = (...arguments_) =>
  createUrlMetadataDocumentImplementation(...arguments_);
export const discoverSavedUrlRecords: typeof discoverSavedUrlRecordsImplementation = (...arguments_) =>
  discoverSavedUrlRecordsImplementation(...arguments_);
export const parseUrlMetadataDocument: typeof parseUrlMetadataDocumentImplementation = (...arguments_) =>
  parseUrlMetadataDocumentImplementation(...arguments_);
export const readUrlMetadataDocument: typeof readUrlMetadataDocumentImplementation = (...arguments_) =>
  readUrlMetadataDocumentImplementation(...arguments_);
export const renderUrlMetadataDocument: typeof renderUrlMetadataDocumentImplementation = (...arguments_) =>
  renderUrlMetadataDocumentImplementation(...arguments_);
export const writeUrlMetadataDocument: typeof writeUrlMetadataDocumentImplementation = (...arguments_) =>
  writeUrlMetadataDocumentImplementation(...arguments_);
export const backfillSavedUrlMetadata: typeof backfillSavedUrlMetadataImplementation = (...arguments_) =>
  backfillSavedUrlMetadataImplementation(...arguments_);

export type {
  ArchiveTodayDependencies,
  ArchiveTodayDiscovery,
  ArchiveTodayFetch,
  ArchiveTodaySnapshot,
} from "./clip/archive-today.js";
export type {
  MetadataSearchNetworkResolver,
  RustMetadataSearchProviderOptions,
  SearchProvider,
  SearchProviderOutcome,
  SearchProviderRequest,
} from "./clip/metadata-search.js";
export type {
  ArchiveTodayMemento,
  ArchiveTodayTimeMap,
  MetadataSearchResponse,
  MetadataSearchResult,
  RankedMetadataSearchResult,
} from "./clip/url-intelligence.js";
export type {
  SavedUrlRecord,
  UrlMetadataArchive,
  UrlMetadataAttempt,
  UrlMetadataCandidate,
  UrlMetadataDocument,
} from "./clip/url-metadata.js";
export type {
  UrlMetadataBackfillDependencies,
  UrlMetadataBackfillItem,
  UrlMetadataBackfillOptions,
  UrlMetadataBackfillReport,
} from "./clip/url-metadata-backfill.js";
