// @bun
// src/query.ts
var MAX_QUERY_FILTERS = 64;
var MAX_QUERY_TAGS = 64;
var MAX_QUERY_METADATA_PATH_UTF8_BYTES = 1024;
var MAX_QUERY_METADATA_PATH_SEGMENTS = 32;
var MAX_QUERY_TEXT_UTF8_BYTES = 16 * 1024;
var MAX_QUERY_OPTIONS_UTF8_BYTES = 64 * 1024;
function isMetadataArray(value) {
  return Array.isArray(value);
}
function isMetadataObject(value) {
  return value !== null && typeof value === "object" && !isMetadataArray(value);
}
function normalizedString(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
function normalizedTag(value) {
  return normalizedString(value.trim().replace(/^#+/u, ""));
}
function formattedBytes(value) {
  return value.toLocaleString("en-US");
}
function boundedTextBytes(value, maximum, label) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum) {
    throw new RangeError(`${label} must be at most ${formattedBytes(maximum)} UTF-8 bytes.`);
  }
  return bytes;
}
function addQueryText(budget, bytes) {
  budget.bytes += bytes;
  if (budget.bytes > MAX_QUERY_OPTIONS_UTF8_BYTES) {
    throw new RangeError(`Query options may contain at most ${formattedBytes(MAX_QUERY_OPTIONS_UTF8_BYTES)} UTF-8 bytes of text.`);
  }
}
function prepareMetadataPath(path, label, budget) {
  let rawSegments;
  let pathBytes = 0;
  if (typeof path === "string") {
    pathBytes = boundedTextBytes(path, MAX_QUERY_METADATA_PATH_UTF8_BYTES, label);
    rawSegments = path.split(".");
  } else {
    if (!Array.isArray(path))
      throw new TypeError(`${label} must be a string or string array.`);
    if (path.length > MAX_QUERY_METADATA_PATH_SEGMENTS) {
      throw new RangeError(`${label} may contain at most ${MAX_QUERY_METADATA_PATH_SEGMENTS} segments.`);
    }
    const segments2 = [];
    for (const [index, segment] of path.entries()) {
      if (typeof segment !== "string") {
        throw new TypeError(`${label} segment ${index + 1} must be a string.`);
      }
      pathBytes += Buffer.byteLength(segment, "utf8") + (index === 0 ? 0 : 1);
      if (pathBytes > MAX_QUERY_METADATA_PATH_UTF8_BYTES) {
        throw new RangeError(`${label} must be at most ${formattedBytes(MAX_QUERY_METADATA_PATH_UTF8_BYTES)} UTF-8 bytes.`);
      }
      segments2.push(segment);
    }
    rawSegments = segments2;
  }
  if (rawSegments.length > MAX_QUERY_METADATA_PATH_SEGMENTS) {
    throw new RangeError(`${label} may contain at most ${MAX_QUERY_METADATA_PATH_SEGMENTS} segments.`);
  }
  if (budget !== undefined)
    addQueryText(budget, pathBytes);
  const segments = rawSegments.map((raw) => {
    const exact = raw.trim();
    return {
      exact,
      normalized: normalizedString(exact),
      arrayIndex: /^(?:0|[1-9]\d*)$/u.test(exact) ? Number(exact) : null
    };
  });
  return {
    segments,
    valid: segments.length > 0 && segments.every(({ exact }) => exact !== "")
  };
}
function normalizedObjectKeys(value, cache) {
  const cached = cache.get(value);
  if (cached !== undefined)
    return cached;
  const indexed = new Map;
  for (const key of Object.keys(value)) {
    const normalized = normalizedString(key);
    indexed.set(normalized, indexed.has(normalized) ? null : key);
  }
  cache.set(value, indexed);
  return indexed;
}
function objectValue(value, segment, cache) {
  if (Object.hasOwn(value, segment.exact)) {
    const candidate2 = value[segment.exact];
    return candidate2 === undefined ? { found: false } : { found: true, value: candidate2 };
  }
  const matchedKey = normalizedObjectKeys(value, cache).get(segment.normalized);
  if (matchedKey === undefined || matchedKey === null)
    return { found: false };
  const candidate = value[matchedKey];
  return candidate === undefined ? { found: false } : { found: true, value: candidate };
}
function metadataAtPreparedPath(metadata, path, cache) {
  if (!path.valid)
    return { found: false };
  let current = metadata;
  for (const segment of path.segments) {
    if (isMetadataArray(current)) {
      if (segment.arrayIndex === null)
        return { found: false };
      const candidate = current[segment.arrayIndex];
      if (candidate === undefined)
        return { found: false };
      current = candidate;
      continue;
    }
    if (!isMetadataObject(current))
      return { found: false };
    const lookup = objectValue(current, segment, cache);
    if (!lookup.found)
      return lookup;
    current = lookup.value;
  }
  return { found: true, value: current };
}
function metadataAtPath(metadata, path) {
  return metadataAtPreparedPath(metadata, prepareMetadataPath(path, "Metadata path"), new WeakMap);
}
function equalsScalar(value, filter, stringCache) {
  if (isMetadataArray(value)) {
    return value.some((candidate) => equalsScalar(candidate, filter, stringCache));
  }
  if (isMetadataObject(value))
    return false;
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
function matchesFilter(note, filter, keyCache, stringCache) {
  const lookup = metadataAtPreparedPath(note.metadata, filter.path, keyCache);
  if (filter.kind === "exists")
    return lookup.found;
  return lookup.found && equalsScalar(lookup.value, filter, stringCache);
}
function matchesTags(note, tags) {
  const noteTags = new Set(note.tags.map(normalizedTag));
  for (const tag of tags) {
    if (tag === "" || !noteTags.has(tag))
      return false;
  }
  return true;
}
function isMetadataScalar(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function prepareFilter(value, index, budget) {
  const label = `Query filter ${index + 1}`;
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an equals or exists filter.`);
  }
  const filter = value;
  const path = prepareMetadataPath(filter.path, `${label} metadata path`, budget);
  if (filter.kind === "exists")
    return { kind: "exists", path };
  if (filter.kind !== "equals") {
    throw new TypeError(`${label} must be an equals or exists filter.`);
  }
  if (!isMetadataScalar(filter.value)) {
    throw new TypeError(`${label} value must be a metadata scalar.`);
  }
  if (typeof filter.value === "string") {
    const bytes = boundedTextBytes(filter.value, MAX_QUERY_TEXT_UTF8_BYTES, `${label} string value`);
    addQueryText(budget, bytes);
    return {
      kind: "equals",
      path,
      value: filter.value,
      normalizedValue: normalizedString(filter.value)
    };
  }
  return { kind: "equals", path, value: filter.value };
}
function prepareSort(value, budget) {
  if (value === undefined)
    return { kind: "builtin", field: "path" };
  if (value.kind === "metadata") {
    return {
      kind: "metadata",
      path: prepareMetadataPath(value.path, "Query sort metadata path", budget)
    };
  }
  if (value.kind !== "builtin" || !["title", "path", "inbound", "outbound"].includes(value.field)) {
    throw new TypeError("Query sort must name a supported built-in field or metadata path.");
  }
  return value;
}
function prepareQueryOptions(options) {
  const rawFilters = options.filters ?? [];
  if (!Array.isArray(rawFilters))
    throw new TypeError("Query filters must be an array.");
  if (rawFilters.length > MAX_QUERY_FILTERS) {
    throw new RangeError(`Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`);
  }
  const rawTags = options.tags ?? [];
  if (!Array.isArray(rawTags))
    throw new TypeError("Query tags must be an array.");
  if (rawTags.length > MAX_QUERY_TAGS) {
    throw new RangeError(`Query tags may contain at most ${MAX_QUERY_TAGS} entries.`);
  }
  if (options.direction !== undefined && options.direction !== "asc" && options.direction !== "desc") {
    throw new TypeError("Query direction must be asc or desc.");
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new RangeError("Query limit must be a non-negative safe integer.");
  }
  const budget = { bytes: 0 };
  const filters = rawFilters.map((filter, index) => prepareFilter(filter, index, budget));
  const tags = new Set;
  for (const [index, value] of rawTags.entries()) {
    if (typeof value !== "string")
      throw new TypeError(`Query tag ${index + 1} must be a string.`);
    const bytes = boundedTextBytes(value, MAX_QUERY_TEXT_UTF8_BYTES, `Query tag ${index + 1}`);
    addQueryText(budget, bytes);
    tags.add(normalizedTag(value));
  }
  const sort = prepareSort(options.sort, budget);
  return {
    filters,
    tags,
    sort,
    direction: options.direction ?? "asc",
    ...options.limit === undefined ? {} : { limit: options.limit }
  };
}
function validateQueryOptions(options = {}) {
  prepareQueryOptions(options);
}
function compareNormalizedText(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}
function compareText(left, right) {
  return compareNormalizedText(normalizedString(left), normalizedString(right));
}
function canonicalMetadata(value) {
  if (value === null)
    return "null";
  if (typeof value === "boolean")
    return value ? "true" : "false";
  if (typeof value === "number")
    return String(value);
  if (typeof value === "string")
    return JSON.stringify(value);
  if (isMetadataArray(value))
    return `[${value.map(canonicalMetadata).join(",")}]`;
  return `{${Object.keys(value).toSorted(compareText).map((key) => `${JSON.stringify(key)}:${canonicalMetadata(value[key] ?? null)}`).join(",")}}`;
}
function metadataSortKey(value) {
  if (value === null)
    return { found: true, rank: 0 };
  if (typeof value === "boolean") {
    return { found: true, rank: 1, number: Number(value) };
  }
  if (typeof value === "number")
    return { found: true, rank: 2, number: value };
  if (typeof value === "string") {
    return { found: true, rank: 3, text: normalizedString(value) };
  }
  return {
    found: true,
    rank: isMetadataArray(value) ? 4 : 5,
    text: normalizedString(canonicalMetadata(value))
  };
}
function rowSortKey(row, sort, keyCache) {
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
function compareSortKeys(left, right, direction) {
  if (!left.found && !right.found)
    return 0;
  if (!left.found)
    return 1;
  if (!right.found)
    return -1;
  const rank = left.rank - right.rank;
  const compared = rank !== 0 ? rank : left.number !== undefined && right.number !== undefined ? left.number - right.number : compareNormalizedText(left.text ?? "", right.text ?? "");
  return direction === "desc" ? -compared : compared;
}
function queryRow(note, connection) {
  if (connection === undefined)
    return null;
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
    backlinks: connection.backlinks
  };
}
function queryVault(notes, analysis, options = {}) {
  const prepared = prepareQueryOptions(options);
  const keyCache = new WeakMap;
  const connections = new Map(analysis.noteConnections.map((connection) => [connection.id, connection]));
  const indexed = notes.map((note, index) => ({ index, row: queryRow(note, connections.get(note.id)) })).filter((candidate) => candidate.row !== null).filter(({ row }) => {
    const stringCache = new Map;
    return prepared.filters.every((filter) => matchesFilter(row, filter, keyCache, stringCache)) && matchesTags(row, prepared.tags);
  }).map((candidate) => ({
    ...candidate,
    pathKey: normalizedString(candidate.row.path),
    sortKey: rowSortKey(candidate.row, prepared.sort, keyCache)
  }));
  const sorted = indexed.toSorted((left, right) => compareSortKeys(left.sortKey, right.sortKey, prepared.direction) || compareNormalizedText(left.pathKey, right.pathKey) || left.index - right.index);
  const rows = sorted.map(({ row }) => row);
  return prepared.limit === undefined ? rows : rows.slice(0, prepared.limit);
}

export { MAX_QUERY_FILTERS, MAX_QUERY_TAGS, MAX_QUERY_METADATA_PATH_UTF8_BYTES, MAX_QUERY_METADATA_PATH_SEGMENTS, MAX_QUERY_TEXT_UTF8_BYTES, MAX_QUERY_OPTIONS_UTF8_BYTES, metadataAtPath, validateQueryOptions, queryVault };
