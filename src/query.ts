import {
  type Backlink,
  type MetadataObject,
  type MetadataScalar,
  type MetadataValue,
  type Note,
  type NoteConnections,
  type VaultAnalysis,
} from "./graph.js";
import {
  analyzeAuthoredRepositoryScopes,
  validateRepositoryScopeSelection,
} from "./repository-memory.js";

export const MAX_QUERY_FILTERS = 64;
export const MAX_QUERY_ONE_OF_VALUES = 64;
export const MAX_QUERY_FILTER_VALUES = 256;
export const MAX_QUERY_TAGS = 64;
export const MAX_QUERY_METADATA_PATH_UTF8_BYTES = 1_024;
export const MAX_QUERY_METADATA_PATH_SEGMENTS = 32;
export const MAX_QUERY_TEXT_UTF8_BYTES = 16 * 1_024;
export const MAX_QUERY_OPTIONS_UTF8_BYTES = 64 * 1_024;

export type MetadataPath = string | readonly string[];

export type MetadataFilter =
  | {
      readonly kind: "equals";
      readonly path: MetadataPath;
      readonly value: MetadataScalar;
    }
  | {
      readonly kind: "exists";
      readonly path: MetadataPath;
    }
  | {
      readonly kind: "one-of";
      readonly path: MetadataPath;
      readonly values: readonly MetadataScalar[];
    };

export type QuerySort =
  | {
      readonly kind: "builtin";
      readonly field: "title" | "path" | "inbound" | "outbound";
    }
  | {
      readonly kind: "metadata";
      readonly path: MetadataPath;
    };

export type QueryDirection = "asc" | "desc";

export type QueryOptions = {
  /** Repeated filters are combined with AND semantics. */
  readonly filters?: readonly MetadataFilter[];
  /** Repeated tags are combined with AND semantics. */
  readonly tags?: readonly string[];
  /** Match any exact, case-sensitive canonical authored repository scope. */
  readonly repositoryScopes?: readonly string[];
  readonly sort?: QuerySort;
  readonly direction?: QueryDirection;
  readonly limit?: number;
};

export type QueryRow = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly properties: Readonly<Record<string, string>>;
  readonly metadata: MetadataObject;
  readonly summary: string;
  readonly inboundContextualCount: number;
  readonly outboundContextualCount: number;
  readonly backlinks: readonly Backlink[];
};

export type MetadataLookup =
  | { readonly found: true; readonly value: MetadataValue }
  | { readonly found: false };

function isMetadataArray(value: MetadataValue): value is readonly MetadataValue[] {
  return Array.isArray(value);
}

function isMetadataObject(value: MetadataValue): value is MetadataObject {
  return value !== null && typeof value === "object" && !isMetadataArray(value);
}

function normalizedString(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizedTag(value: string): string {
  return normalizedString(value.trim().replace(/^#+/u, ""));
}

type QueryTextBudget = { bytes: number; filterValues: number };

type PreparedMetadataSegment = {
  readonly exact: string;
  readonly normalized: string;
  readonly arrayIndex: number | null;
};

type PreparedMetadataPath = {
  readonly segments: readonly PreparedMetadataSegment[];
  readonly valid: boolean;
};

type MetadataKeyCache = WeakMap<MetadataObject, ReadonlyMap<string, string | null>>;

function formattedBytes(value: number): string {
  return value.toLocaleString("en-US");
}

function boundedTextBytes(value: string, maximum: number, label: string): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum) {
    throw new RangeError(
      `${label} must be at most ${formattedBytes(maximum)} UTF-8 bytes.`,
    );
  }
  return bytes;
}

function addQueryText(
  budget: QueryTextBudget,
  bytes: number,
): void {
  budget.bytes += bytes;
  if (budget.bytes > MAX_QUERY_OPTIONS_UTF8_BYTES) {
    throw new RangeError(
      `Query options may contain at most ${formattedBytes(MAX_QUERY_OPTIONS_UTF8_BYTES)} UTF-8 bytes of text.`,
    );
  }
}

function prepareMetadataPath(
  path: MetadataPath,
  label: string,
  budget?: QueryTextBudget,
): PreparedMetadataPath {
  let rawSegments: readonly string[];
  let pathBytes = 0;
  if (typeof path === "string") {
    pathBytes = boundedTextBytes(path, MAX_QUERY_METADATA_PATH_UTF8_BYTES, label);
    rawSegments = path.split(".");
  } else {
    if (!Array.isArray(path)) throw new TypeError(`${label} must be a string or string array.`);
    if (path.length > MAX_QUERY_METADATA_PATH_SEGMENTS) {
      throw new RangeError(
        `${label} may contain at most ${MAX_QUERY_METADATA_PATH_SEGMENTS} segments.`,
      );
    }
    const segments: string[] = [];
    for (const [index, segment] of path.entries()) {
      if (typeof segment !== "string") {
        throw new TypeError(`${label} segment ${index + 1} must be a string.`);
      }
      pathBytes += Buffer.byteLength(segment, "utf8") + (index === 0 ? 0 : 1);
      if (pathBytes > MAX_QUERY_METADATA_PATH_UTF8_BYTES) {
        throw new RangeError(
          `${label} must be at most ${formattedBytes(MAX_QUERY_METADATA_PATH_UTF8_BYTES)} UTF-8 bytes.`,
        );
      }
      segments.push(segment);
    }
    rawSegments = segments;
  }
  if (rawSegments.length > MAX_QUERY_METADATA_PATH_SEGMENTS) {
    throw new RangeError(
      `${label} may contain at most ${MAX_QUERY_METADATA_PATH_SEGMENTS} segments.`,
    );
  }
  if (budget !== undefined) addQueryText(budget, pathBytes);

  const segments = rawSegments.map((raw): PreparedMetadataSegment => {
    const exact = raw.trim();
    return {
      exact,
      normalized: normalizedString(exact),
      arrayIndex: /^(?:0|[1-9]\d*)$/u.test(exact) ? Number(exact) : null,
    };
  });
  return {
    segments,
    valid: segments.length > 0 && segments.every(({ exact }) => exact !== ""),
  };
}

function normalizedObjectKeys(
  value: MetadataObject,
  cache: MetadataKeyCache,
): ReadonlyMap<string, string | null> {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const indexed = new Map<string, string | null>();
  for (const key of Object.keys(value)) {
    const normalized = normalizedString(key);
    indexed.set(normalized, indexed.has(normalized) ? null : key);
  }
  cache.set(value, indexed);
  return indexed;
}

function objectValue(
  value: MetadataObject,
  segment: PreparedMetadataSegment,
  cache: MetadataKeyCache,
): MetadataLookup {
  if (Object.hasOwn(value, segment.exact)) {
    const candidate = value[segment.exact];
    return candidate === undefined ? { found: false } : { found: true, value: candidate };
  }
  const matchedKey = normalizedObjectKeys(value, cache).get(segment.normalized);
  if (matchedKey === undefined || matchedKey === null) return { found: false };
  const candidate = value[matchedKey];
  return candidate === undefined ? { found: false } : { found: true, value: candidate };
}

function metadataAtPreparedPath(
  metadata: MetadataObject,
  path: PreparedMetadataPath,
  cache: MetadataKeyCache,
): MetadataLookup {
  if (!path.valid) return { found: false };

  let current: MetadataValue = metadata;
  for (const segment of path.segments) {
    if (isMetadataArray(current)) {
      if (segment.arrayIndex === null) return { found: false };
      const candidate: MetadataValue | undefined = current[segment.arrayIndex];
      if (candidate === undefined) return { found: false };
      current = candidate;
      continue;
    }
    if (!isMetadataObject(current)) return { found: false };
    const lookup = objectValue(current, segment, cache);
    if (!lookup.found) return lookup;
    current = lookup.value;
  }
  return { found: true, value: current };
}

/** Resolve an exact nested field, with unambiguous case-insensitive object keys. */
export function metadataAtPath(
  metadata: MetadataObject,
  path: MetadataPath,
): MetadataLookup {
  return metadataAtPreparedPath(
    metadata,
    prepareMetadataPath(path, "Metadata path"),
    new WeakMap(),
  );
}

type PreparedEqualsFilter = {
  readonly kind: "equals";
  readonly path: PreparedMetadataPath;
  readonly value: MetadataScalar;
  readonly normalizedValue?: string;
};

type PreparedMetadataFilter =
  | PreparedEqualsFilter
  | {
      readonly kind: "exists";
      readonly path: PreparedMetadataPath;
    }
  | {
      readonly kind: "one-of";
      readonly path: PreparedMetadataPath;
      readonly values: readonly PreparedEqualsFilter[];
    };

function equalsScalar(
  value: MetadataValue,
  filter: PreparedEqualsFilter,
  stringCache: Map<string, string>,
): boolean {
  if (isMetadataArray(value)) {
    return value.some((candidate) => equalsScalar(candidate, filter, stringCache));
  }
  if (isMetadataObject(value)) return false;
  if (typeof value === "string" && filter.normalizedValue !== undefined) {
    let normalized = stringCache.get(value);
    if (normalized === undefined) {
      normalized = normalizedString(value);
      stringCache.set(value, normalized);
    }
    return normalized === filter.normalizedValue;
  }
  return Object.is(value, filter.value);
}

type QueryableMetadata = Pick<Note, "metadata" | "tags">;

function matchesFilter(
  note: QueryableMetadata,
  filter: PreparedMetadataFilter,
  keyCache: MetadataKeyCache,
  stringCache: Map<string, string>,
): boolean {
  const lookup = metadataAtPreparedPath(note.metadata, filter.path, keyCache);
  if (filter.kind === "exists") return lookup.found;
  if (!lookup.found) return false;
  if (filter.kind === "one-of") {
    return filter.values.some((candidate) =>
      equalsScalar(lookup.value, candidate, stringCache));
  }
  return equalsScalar(lookup.value, filter, stringCache);
}

function matchesTags(note: QueryableMetadata, tags: ReadonlySet<string>): boolean {
  const noteTags = new Set(note.tags.map(normalizedTag));
  for (const tag of tags) {
    if (tag === "" || !noteTags.has(tag)) return false;
  }
  return true;
}

type PreparedQuerySort =
  | {
      readonly kind: "builtin";
      readonly field: "title" | "path" | "inbound" | "outbound";
    }
  | {
      readonly kind: "metadata";
      readonly path: PreparedMetadataPath;
    };

type PreparedQueryOptions = {
  readonly filters: readonly PreparedMetadataFilter[];
  readonly tags: ReadonlySet<string>;
  readonly repositoryScopes: ReadonlySet<string>;
  readonly sort: PreparedQuerySort;
  readonly direction: QueryDirection;
  readonly limit?: number;
};

function isMetadataScalar(value: unknown): value is MetadataScalar {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function prepareFilter(
  value: unknown,
  index: number,
  budget: QueryTextBudget,
): PreparedMetadataFilter {
  const label = `Query filter ${index + 1}`;
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an equals, exists, or one-of filter.`);
  }
  const filter = value as Readonly<Record<string, unknown>>;
  const path = prepareMetadataPath(
    filter.path as MetadataPath,
    `${label} metadata path`,
    budget,
  );
  if (filter.kind === "exists") return { kind: "exists", path };
  if (filter.kind === "one-of") {
    if (!Array.isArray(filter.values)) {
      throw new TypeError(`${label} one-of values must be an array.`);
    }
    if (filter.values.length === 0 || filter.values.length > MAX_QUERY_ONE_OF_VALUES) {
      throw new RangeError(
        `${label} one-of values must contain from 1 through ${MAX_QUERY_ONE_OF_VALUES} entries.`,
      );
    }
    budget.filterValues += filter.values.length;
    if (budget.filterValues > MAX_QUERY_FILTER_VALUES) {
      throw new RangeError(
        `Query filters may contain at most ${MAX_QUERY_FILTER_VALUES} scalar values.`,
      );
    }
    return {
      kind: "one-of",
      path,
      values: filter.values.map((candidate, valueIndex) =>
        prepareEqualsValue(candidate, `${label} one-of value ${valueIndex + 1}`, budget, path)),
    };
  }
  if (filter.kind !== "equals") {
    throw new TypeError(`${label} must be an equals, exists, or one-of filter.`);
  }
  budget.filterValues += 1;
  if (budget.filterValues > MAX_QUERY_FILTER_VALUES) {
    throw new RangeError(
      `Query filters may contain at most ${MAX_QUERY_FILTER_VALUES} scalar values.`,
    );
  }
  return prepareEqualsValue(filter.value, `${label} value`, budget, path);
}

function prepareEqualsValue(
  value: unknown,
  label: string,
  budget: QueryTextBudget,
  path: PreparedMetadataPath,
): PreparedEqualsFilter {
  if (!isMetadataScalar(value)) {
    throw new TypeError(`${label} must be a metadata scalar.`);
  }
  if (typeof value === "string") {
    const bytes = boundedTextBytes(
      value,
      MAX_QUERY_TEXT_UTF8_BYTES,
      label,
    );
    addQueryText(budget, bytes);
    return {
      kind: "equals",
      path,
      value,
      normalizedValue: normalizedString(value),
    };
  }
  return { kind: "equals", path, value };
}

function prepareSort(
  value: QuerySort | undefined,
  budget: QueryTextBudget,
): PreparedQuerySort {
  if (value === undefined) return { kind: "builtin", field: "path" };
  if (value.kind === "metadata") {
    return {
      kind: "metadata",
      path: prepareMetadataPath(value.path, "Query sort metadata path", budget),
    };
  }
  if (
    value.kind !== "builtin"
    || !["title", "path", "inbound", "outbound"].includes(value.field)
  ) {
    throw new TypeError("Query sort must name a supported built-in field or metadata path.");
  }
  return value;
}

function prepareQueryOptions(options: QueryOptions): PreparedQueryOptions {
  const rawFilters: unknown = options.filters ?? [];
  if (!Array.isArray(rawFilters)) throw new TypeError("Query filters must be an array.");
  if (rawFilters.length > MAX_QUERY_FILTERS) {
    throw new RangeError(`Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`);
  }
  const rawTags: unknown = options.tags ?? [];
  if (!Array.isArray(rawTags)) throw new TypeError("Query tags must be an array.");
  if (rawTags.length > MAX_QUERY_TAGS) {
    throw new RangeError(`Query tags may contain at most ${MAX_QUERY_TAGS} entries.`);
  }
  if (options.direction !== undefined && options.direction !== "asc" && options.direction !== "desc") {
    throw new TypeError("Query direction must be asc or desc.");
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new RangeError("Query limit must be a non-negative safe integer.");
  }

  const budget: QueryTextBudget = { bytes: 0, filterValues: 0 };
  const filters = rawFilters.map((filter, index) => prepareFilter(filter, index, budget));
  const tags = new Set<string>();
  for (const [index, value] of rawTags.entries()) {
    if (typeof value !== "string") throw new TypeError(`Query tag ${index + 1} must be a string.`);
    const bytes = boundedTextBytes(
      value,
      MAX_QUERY_TEXT_UTF8_BYTES,
      `Query tag ${index + 1}`,
    );
    addQueryText(budget, bytes);
    tags.add(normalizedTag(value));
  }
  const repositoryScopes = validateRepositoryScopeSelection(options.repositoryScopes ?? []);
  for (const scope of repositoryScopes) {
    addQueryText(budget, Buffer.byteLength(scope, "utf8"));
  }
  const sort = prepareSort(options.sort, budget);
  return {
    filters,
    tags,
    repositoryScopes: new Set(repositoryScopes),
    sort,
    direction: options.direction ?? "asc",
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
}

/** Validate all metadata-query work bounds without scanning a vault. */
export function validateQueryOptions(options: QueryOptions = {}): void {
  prepareQueryOptions(options);
}

function compareNormalizedText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareText(left: string, right: string): number {
  return compareNormalizedText(normalizedString(left), normalizedString(right));
}

function canonicalMetadata(value: MetadataValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (isMetadataArray(value)) return `[${value.map(canonicalMetadata).join(",")}]`;
  return `{${Object.keys(value)
    .toSorted(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalMetadata(value[key] ?? null)}`)
    .join(",")}}`;
}

type SortKey =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly rank: number;
      readonly number?: number;
      readonly text?: string;
    };

function metadataSortKey(value: MetadataValue): SortKey {
  if (value === null) return { found: true, rank: 0 };
  if (typeof value === "boolean") {
    return { found: true, rank: 1, number: Number(value) };
  }
  if (typeof value === "number") return { found: true, rank: 2, number: value };
  if (typeof value === "string") {
    return { found: true, rank: 3, text: normalizedString(value) };
  }
  return {
    found: true,
    rank: isMetadataArray(value) ? 4 : 5,
    text: normalizedString(canonicalMetadata(value)),
  };
}

function rowSortKey(
  row: QueryRow,
  sort: PreparedQuerySort,
  keyCache: MetadataKeyCache,
): SortKey {
  if (sort.kind === "metadata") {
    const lookup = metadataAtPreparedPath(row.metadata, sort.path, keyCache);
    return lookup.found ? metadataSortKey(lookup.value) : { found: false };
  }
  switch (sort.field) {
    case "title":
      return { found: true, rank: 3, text: normalizedString(row.title) };
    case "path":
      return { found: true, rank: 3, text: normalizedString(row.path) };
    case "inbound":
      return { found: true, rank: 2, number: row.inboundContextualCount };
    case "outbound":
      return { found: true, rank: 2, number: row.outboundContextualCount };
  }
}

function compareSortKeys(
  left: SortKey,
  right: SortKey,
  direction: QueryDirection,
): number {
  if (!left.found && !right.found) return 0;
  if (!left.found) return 1;
  if (!right.found) return -1;
  const rank = left.rank - right.rank;
  const compared = rank !== 0
    ? rank
    : left.number !== undefined && right.number !== undefined
      ? left.number - right.number
      : compareNormalizedText(left.text ?? "", right.text ?? "");
  return direction === "desc" ? -compared : compared;
}

function queryRow(note: Note, connection: NoteConnections | undefined): QueryRow | null {
  if (connection === undefined) return null;
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    aliases: note.aliases,
    tags: note.tags,
    properties: note.properties,
    metadata: note.metadata,
    summary: note.summary,
    inboundContextualCount: connection.inboundContextualCount,
    outboundContextualCount: connection.outboundContextualCount,
    backlinks: connection.backlinks,
  };
}

function matchesRepositoryScopes(
  note: QueryableMetadata,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const authored = analyzeAuthoredRepositoryScopes(note.metadata);
  return authored.present
    && authored.valid
    && authored.scopes.some((scope) => selected.has(scope));
}

/** Query content notes while enriching every result with the deterministic graph view. */
export function queryVault(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  options: QueryOptions = {},
): readonly QueryRow[] {
  const prepared = prepareQueryOptions(options);
  const keyCache: MetadataKeyCache = new WeakMap();

  const connections = new Map(
    analysis.noteConnections.map((connection) => [connection.id, connection]),
  );
  const indexed = notes
    .map((note, index) => ({ index, row: queryRow(note, connections.get(note.id)) }))
    .filter((candidate): candidate is { readonly index: number; readonly row: QueryRow } =>
      candidate.row !== null)
    .filter(({ row }) => {
      const stringCache = new Map<string, string>();
      return prepared.filters.every((filter) =>
        matchesFilter(row, filter, keyCache, stringCache))
        && matchesTags(row, prepared.tags)
        && matchesRepositoryScopes(row, prepared.repositoryScopes);
    })
    .map((candidate) => ({
      ...candidate,
      pathKey: normalizedString(candidate.row.path),
      sortKey: rowSortKey(candidate.row, prepared.sort, keyCache),
    }));

  const sorted = indexed.toSorted((left, right) =>
    compareSortKeys(left.sortKey, right.sortKey, prepared.direction)
    || compareNormalizedText(left.pathKey, right.pathKey)
    || left.index - right.index);
  const rows = sorted.map(({ row }) => row);
  return prepared.limit === undefined ? rows : rows.slice(0, prepared.limit);
}
