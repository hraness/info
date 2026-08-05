import { isPrivateHostname } from "./network.js";

export const MAX_METADATA_SEARCH_RESULTS = 20;
export const MAX_METADATA_SEARCH_ENGINES = 8;
export const MAX_METADATA_SEARCH_QUERY_UTF8_BYTES = 4 * 1_024;
export const MAX_METADATA_SEARCH_TITLE_UTF8_BYTES = 2 * 1_024;
export const MAX_METADATA_SEARCH_SNIPPET_UTF8_BYTES = 8 * 1_024;
export const MAX_URL_INTELLIGENCE_URL_UTF8_BYTES = 16 * 1_024;
export const MAX_METADATA_SEARCH_TEXT_UTF8_BYTES = 512 * 1_024;
/** Fetch adapters should reject a response body above this limit before JSON parsing. */
export const MAX_METADATA_SEARCH_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export const MAX_ARCHIVE_TIMEMAP_UTF8_BYTES = 512 * 1_024;
export const MAX_ARCHIVE_TIMEMAP_ENTRIES = 512;
export const MAX_ARCHIVE_TIMEMAP_PARAMETERS_PER_ENTRY = 16;

export const ARCHIVE_TODAY_HOSTS = Object.freeze([
  "archive.today",
  "archive.is",
  "archive.ph",
  "archive.fo",
  "archive.li",
  "archive.md",
  "archive.vn",
] as const);

export type ArchiveTodayHost = (typeof ARCHIVE_TODAY_HOSTS)[number];
export type MetadataSearchEngineStatus = "complete" | "partial" | "unavailable";

export type MetadataSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string | null;
  readonly engines: readonly string[];
  readonly score: number;
};

export type MetadataSearchResponse = {
  readonly query: string;
  readonly results: readonly MetadataSearchResult[];
  readonly enginesQueried: readonly string[];
  readonly enginesFailed: readonly string[];
  readonly engineStatus: MetadataSearchEngineStatus;
};

export type RankMetadataSearchOptions = {
  readonly targetUrl?: string | URL;
  readonly limit?: number;
};

export type RankedMetadataSearchResult = MetadataSearchResult & {
  readonly rank: number;
  readonly sourceIdentity: string;
  readonly exactTarget: boolean;
};

export type ArchiveTodayMemento = {
  readonly url: string;
  readonly archiveHost: ArchiveTodayHost;
  readonly timestamp: string;
  readonly capturedAt: string;
  readonly originalUrl: string;
};

export type ArchiveTodayTimeMap = {
  readonly originalUrl: string;
  readonly mementos: readonly ArchiveTodayMemento[];
  readonly newest: ArchiveTodayMemento | null;
};

export type ParseArchiveTodayMementoUrlOptions = {
  readonly originalUrl: string | URL;
  readonly now: Date;
};

export type ParseArchiveTodayTimeMapOptions = ParseArchiveTodayMementoUrlOptions;

const archiveTodayHosts = new Set<string>(ARCHIVE_TODAY_HOSTS);
const tokenCharacter = /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/u;
const engineName = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

type TextBudget = { bytes: number };
type ParsedLink = {
  readonly target: string;
  readonly parameters: ReadonlyMap<string, string>;
};

function fail(label: string, message: string): never {
  throw new TypeError(`${label} ${message}`);
}

function isUnsafeControlCodePoint(
  codePoint: number,
  rejectSurrogates = false,
  allowLinkWhitespace = false,
): boolean {
  return (codePoint <= 0x1f
      && !(allowLinkWhitespace && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)))
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || (rejectSurrogates && codePoint >= 0xd800 && codePoint <= 0xdfff);
}

function hasUnsafeControls(
  value: string,
  rejectSurrogates = false,
  allowLinkWhitespace = false,
): boolean {
  return Array.from(value).some((character) =>
    isUnsafeControlCodePoint(character.codePointAt(0) as number, rejectSurrogates, allowLinkWhitespace));
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(label, "must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function strictKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key)).toSorted();
  if (unknown.length > 0) fail(label, `has unknown fields: ${unknown.join(", ")}.`);
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  budget?: TextBudget,
): string {
  if (typeof value !== "string") return fail(label, "must be a string.");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) fail(label, `must be at most ${maximumBytes} UTF-8 bytes.`);
  if (budget !== undefined) {
    budget.bytes += bytes;
    if (budget.bytes > MAX_METADATA_SEARCH_TEXT_UTF8_BYTES) {
      fail("Metadata search response", `may contain at most ${MAX_METADATA_SEARCH_TEXT_UTF8_BYTES} UTF-8 bytes of text.`);
    }
  }
  return value;
}

function cleanDisplayText(value: unknown, label: string, maximumBytes: number, budget: TextBudget): string {
  const text = boundedString(value, label, maximumBytes, budget);
  return Array.from(text, (character) =>
    isUnsafeControlCodePoint(character.codePointAt(0) as number) ? " " : character)
    .join("")
    .replace(/ +/gu, " ")
    .trim();
}

function checkedEngine(value: unknown, label: string, budget: TextBudget): string {
  const engine = boundedString(value, label, 128, budget);
  if (!engineName.test(engine)) fail(label, "must be a lowercase engine identifier.");
  return engine;
}

function uniqueEngineArray(value: unknown, label: string, budget: TextBudget, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_METADATA_SEARCH_ENGINES || (!allowEmpty && value.length === 0)) {
    return fail(label, `must be ${allowEmpty ? "an" : "a non-empty"} array with at most ${MAX_METADATA_SEARCH_ENGINES} entries.`);
  }
  const engines = value.map((entry, index) => checkedEngine(entry, `${label}[${index}]`, budget));
  if (new Set(engines).size !== engines.length) fail(label, "must not contain duplicates.");
  return Object.freeze(engines);
}

function publicHttpUrl(value: string | URL): URL | null {
  const raw = value instanceof URL ? value.href : value;
  if (
    typeof raw !== "string"
    || raw === ""
    || raw !== raw.trim()
    || hasUnsafeControls(raw)
    || Buffer.byteLength(raw, "utf8") > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES
  ) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hostname === ""
    || isPrivateHostname(parsed.hostname)
  ) return null;
  return parsed;
}

/**
 * Produce a conservative source identity. Only URL syntax semantics are normalized:
 * scheme and host casing, default ports, and fragments. Path case, non-root trailing
 * slashes, and the complete query sequence remain significant.
 */
export function normalizeSourceUrlIdentity(value: string | URL): string | null {
  const parsed = publicHttpUrl(value);
  if (parsed === null) return null;
  parsed.hash = "";
  return parsed.href;
}

/** Match only URLs with the same conservative source identity. */
export function isExactSourceTarget(candidate: string | URL, target: string | URL): boolean {
  const candidateIdentity = normalizeSourceUrlIdentity(candidate);
  const targetIdentity = normalizeSourceUrlIdentity(target);
  return candidateIdentity !== null && targetIdentity !== null && candidateIdentity === targetIdentity;
}

function parseMetadataResult(
  value: unknown,
  index: number,
  queried: ReadonlySet<string>,
  failed: ReadonlySet<string>,
  budget: TextBudget,
): MetadataSearchResult {
  const label = `Metadata search response.results[${index}]`;
  const input = record(value, label);
  strictKeys(input, ["title", "url", "snippet", "engines", "score"], label);
  const title = cleanDisplayText(input.title, `${label}.title`, MAX_METADATA_SEARCH_TITLE_UTF8_BYTES, budget);
  if (title === "") fail(`${label}.title`, "must contain visible text.");
  const rawUrl = boundedString(input.url, `${label}.url`, MAX_URL_INTELLIGENCE_URL_UTF8_BYTES, budget);
  const url = normalizeSourceUrlIdentity(rawUrl);
  if (url === null) fail(`${label}.url`, "must be a public HTTP or HTTPS URL without credentials or controls.");
  const cleanedSnippet = input.snippet === null
    ? null
    : cleanDisplayText(input.snippet, `${label}.snippet`, MAX_METADATA_SEARCH_SNIPPET_UTF8_BYTES, budget);
  const snippet = cleanedSnippet === "" ? null : cleanedSnippet;
  const engines = uniqueEngineArray(input.engines, `${label}.engines`, budget, false);
  for (const engine of engines) {
    if (!queried.has(engine)) fail(`${label}.engines`, `contains unqueried engine ${engine}.`);
    if (failed.has(engine)) fail(`${label}.engines`, `contains failed engine ${engine}.`);
  }
  if (typeof input.score !== "number" || !Number.isFinite(input.score) || input.score <= 0) {
    fail(`${label}.score`, "must be a positive finite number.");
  }
  return Object.freeze({ title, url, snippet, engines, score: input.score });
}

/** Strictly parse one successful metadata-search-engine-rs `GET /search` body. */
export function parseMetadataSearchResponse(value: unknown): MetadataSearchResponse {
  const input = record(value, "Metadata search response");
  strictKeys(input, ["query", "results", "engines_queried", "engines_failed"], "Metadata search response");
  const budget: TextBudget = { bytes: 0 };
  const query = boundedString(input.query, "Metadata search response.query", MAX_METADATA_SEARCH_QUERY_UTF8_BYTES, budget);
  if (query === "" || query !== query.trim() || hasUnsafeControls(query)) {
    fail("Metadata search response.query", "must be non-empty, trimmed, and free of controls.");
  }
  const enginesQueried = uniqueEngineArray(input.engines_queried, "Metadata search response.engines_queried", budget, false);
  const enginesFailed = uniqueEngineArray(input.engines_failed, "Metadata search response.engines_failed", budget, true);
  const queried = new Set(enginesQueried);
  for (const engine of enginesFailed) {
    if (!queried.has(engine)) fail("Metadata search response.engines_failed", `contains unqueried engine ${engine}.`);
  }
  if (!Array.isArray(input.results) || input.results.length > MAX_METADATA_SEARCH_RESULTS) {
    fail("Metadata search response.results", `must be an array with at most ${MAX_METADATA_SEARCH_RESULTS} entries.`);
  }
  const failed = new Set(enginesFailed);
  const results = Object.freeze(input.results.map((result, index) =>
    parseMetadataResult(result, index, queried, failed, budget)));
  return Object.freeze({
    query,
    results,
    enginesQueried,
    enginesFailed,
    engineStatus: enginesFailed.length === 0
      ? "complete"
      : enginesFailed.length === enginesQueried.length ? "unavailable" : "partial",
  });
}

/** Rank exact targets first, then upstream score, with input order as the stable tie-breaker. */
export function rankMetadataSearchResults(
  results: readonly MetadataSearchResult[],
  options: RankMetadataSearchOptions = {},
): readonly RankedMetadataSearchResult[] {
  const limit = options.limit ?? MAX_METADATA_SEARCH_RESULTS;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_METADATA_SEARCH_RESULTS) {
    throw new RangeError(`Metadata search rank limit must be from 0 through ${MAX_METADATA_SEARCH_RESULTS}.`);
  }
  if (limit === 0) return Object.freeze([]);
  const targetIdentity = options.targetUrl === undefined
    ? null
    : normalizeSourceUrlIdentity(options.targetUrl);
  const decorated = results.flatMap((result, index) => {
    const sourceIdentity = normalizeSourceUrlIdentity(result.url);
    return sourceIdentity === null ? [] : [{ result, index, sourceIdentity, exactTarget: sourceIdentity === targetIdentity }];
  }).toSorted((left, right) =>
    Number(right.exactTarget) - Number(left.exactTarget)
    || right.result.score - left.result.score
    || left.index - right.index);
  const seen = new Set<string>();
  const ranked: RankedMetadataSearchResult[] = [];
  for (const item of decorated) {
    if (seen.has(item.sourceIdentity)) continue;
    seen.add(item.sourceIdentity);
    ranked.push(Object.freeze({
      ...item.result,
      rank: ranked.length + 1,
      sourceIdentity: item.sourceIdentity,
      exactTarget: item.exactTarget,
    }));
    if (ranked.length === limit) break;
  }
  return Object.freeze(ranked);
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function parseLinkFormat(source: string): readonly ParsedLink[] {
  let cursor = 0;
  const links: ParsedLink[] = [];
  const skipWhitespace = (): void => {
    while (isWhitespace(source[cursor])) cursor += 1;
  };
  const syntax = (message: string): never => fail("Archive.today TimeMap", `${message} at offset ${cursor}.`);

  skipWhitespace();
  while (cursor < source.length) {
    if (links.length >= MAX_ARCHIVE_TIMEMAP_ENTRIES) {
      fail("Archive.today TimeMap", `may contain at most ${MAX_ARCHIVE_TIMEMAP_ENTRIES} entries.`);
    }
    if (source[cursor] !== "<") syntax("must start each link with '<'");
    cursor += 1;
    const targetStart = cursor;
    while (cursor < source.length && source[cursor] !== ">") {
      const character = source[cursor];
      if (character === "<" || character === '"' || character === "\\" || isWhitespace(character)) {
        syntax("contains an invalid target character");
      }
      cursor += 1;
    }
    if (cursor >= source.length) syntax("has an unterminated target");
    const target = source.slice(targetStart, cursor);
    cursor += 1;
    if (target === "" || Buffer.byteLength(target, "utf8") > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES) {
      syntax("has an empty or oversized target");
    }

    const parameters = new Map<string, string>();
    skipWhitespace();
    while (source[cursor] === ";") {
      if (parameters.size >= MAX_ARCHIVE_TIMEMAP_PARAMETERS_PER_ENTRY) {
        fail("Archive.today TimeMap", `entries may contain at most ${MAX_ARCHIVE_TIMEMAP_PARAMETERS_PER_ENTRY} parameters.`);
      }
      cursor += 1;
      skipWhitespace();
      const nameStart = cursor;
      while (tokenCharacter.test(source[cursor] ?? "")) cursor += 1;
      if (cursor === nameStart) syntax("has an invalid parameter name");
      const name = source.slice(nameStart, cursor).toLowerCase();
      skipWhitespace();
      if (source[cursor] !== "=") syntax("requires '=' after a parameter name");
      cursor += 1;
      skipWhitespace();
      let parameterValue = "";
      if (source[cursor] === '"') {
        cursor += 1;
        let terminated = false;
        while (cursor < source.length) {
          const character = source[cursor] ?? "";
          cursor += 1;
          if (character === '"') {
            terminated = true;
            break;
          }
          if (character === "\\") {
            if (cursor >= source.length) syntax("has an unterminated quoted escape");
            const escaped = source[cursor] ?? "";
            if (hasUnsafeControls(escaped)) syntax("has a control in a quoted escape");
            parameterValue += escaped;
            cursor += 1;
          } else {
            if (hasUnsafeControls(character)) syntax("has a control in a quoted value");
            parameterValue += character;
          }
        }
        if (!terminated) syntax("has an unterminated quoted value");
      } else {
        const valueStart = cursor;
        while (tokenCharacter.test(source[cursor] ?? "")) cursor += 1;
        if (cursor === valueStart) syntax("has an invalid parameter value");
        parameterValue = source.slice(valueStart, cursor);
      }
      if (Buffer.byteLength(parameterValue, "utf8") > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES) {
        syntax("has an oversized parameter value");
      }
      if (parameters.has(name)) syntax(`repeats parameter ${name}`);
      parameters.set(name, parameterValue);
      skipWhitespace();
    }
    links.push(Object.freeze({ target, parameters }));
    if (cursor === source.length) break;
    if (source[cursor] !== ",") syntax("must separate links with ','");
    cursor += 1;
    skipWhitespace();
    if (cursor === source.length) syntax("must not end with ','");
  }
  return Object.freeze(links);
}

const months: ReadonlyMap<string, number> = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
] as const);
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function epochFromTimestamp(timestamp: string, label: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u.exec(timestamp);
  if (match === null) return fail(label, "must contain a 14-digit UTC timestamp.");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(epoch);
  if (
    year < 1900
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return fail(label, "contains an invalid UTC timestamp.");
  return epoch;
}

function epochFromHttpDate(value: string, label: string): number {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(value);
  if (match === null) return fail(label, "must be an RFC 1123 date in GMT.");
  const month = months.get(match[3] ?? "");
  if (month === undefined) return fail(label, "has an invalid month.");
  const year = Number(match[4]);
  const day = Number(match[2]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  const epoch = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epoch);
  if (
    year < 1900
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || weekdays[date.getUTCDay()] !== match[1]
  ) return fail(label, "contains an invalid RFC 1123 date.");
  return epoch;
}

function checkedNow(now: Date): number {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return fail("Archive.today now", "must be a valid injected Date.");
  }
  return now.getTime();
}

function parsedArchiveTodayMementoUrl(
  value: string | URL,
  originalIdentity: string,
  nowEpoch: number,
  expectedEpoch?: number,
): ArchiveTodayMemento {
  const raw = value instanceof URL ? value.href : value;
  if (typeof raw !== "string" || raw !== raw.trim() || hasUnsafeControls(raw)
    || Buffer.byteLength(raw, "utf8") > MAX_URL_INTELLIGENCE_URL_UTF8_BYTES) {
    return fail("Archive.today memento URL", "must be a bounded control-free URL.");
  }
  let archiveUrl: URL;
  try {
    archiveUrl = new URL(raw);
  } catch {
    return fail("Archive.today memento URL", "must be a valid URL.");
  }
  if (
    (archiveUrl.protocol !== "http:" && archiveUrl.protocol !== "https:")
    || archiveUrl.username !== ""
    || archiveUrl.password !== ""
    || archiveUrl.port !== ""
    || archiveUrl.hash !== ""
    || !archiveTodayHosts.has(archiveUrl.hostname)
  ) return fail("Archive.today memento URL", "must use an allowlisted archive host without credentials, a port, or a fragment.");
  const path = /^\/(\d{14})\/(https?:\/\/.*)$/u.exec(archiveUrl.pathname);
  if (path === null || path[1] === undefined || path[2] === undefined) {
    return fail("Archive.today memento URL", "must use a timestamped read-only snapshot path.");
  }
  const timestamp = path[1];
  const capturedEpoch = epochFromTimestamp(timestamp, "Archive.today memento URL timestamp");
  if (capturedEpoch > nowEpoch) fail("Archive.today memento URL timestamp", "must not be in the future.");
  if (expectedEpoch !== undefined && capturedEpoch !== expectedEpoch) {
    fail("Archive.today memento URL timestamp", "must equal its Memento datetime.");
  }
  const embeddedIdentity = normalizeSourceUrlIdentity(`${path[2]}${archiveUrl.search}`);
  if (embeddedIdentity === null || embeddedIdentity !== originalIdentity) {
    fail("Archive.today memento URL", "must embed the exact bound original URL.");
  }
  const archiveHost = archiveUrl.hostname as ArchiveTodayHost;
  // Upgrade only after the alias, timestamped path, and embedded source all validate.
  archiveUrl.protocol = "https:";
  return Object.freeze({
    url: archiveUrl.href,
    archiveHost,
    timestamp,
    capturedAt: new Date(capturedEpoch).toISOString(),
    originalUrl: originalIdentity,
  });
}

/** Validate one read-only timestamped archive.today-family snapshot URL. */
export function parseArchiveTodayMementoUrl(
  value: string | URL,
  options: ParseArchiveTodayMementoUrlOptions,
): ArchiveTodayMemento {
  const originalIdentity = normalizeSourceUrlIdentity(options.originalUrl);
  if (originalIdentity === null) fail("Archive.today original URL", "must be a public HTTP or HTTPS URL without credentials.");
  return parsedArchiveTodayMementoUrl(value, originalIdentity, checkedNow(options.now));
}

/** Deterministically select the newest snapshot, breaking timestamp ties by URL. */
export function selectNewestArchiveTodayMemento(
  mementos: readonly ArchiveTodayMemento[],
): ArchiveTodayMemento | null {
  return mementos.toSorted((left, right) =>
    right.timestamp.localeCompare(left.timestamp) || left.url.localeCompare(right.url))[0] ?? null;
}

/** Parse and bind an archive.today-family Memento `application/link-format` TimeMap. */
export function parseArchiveTodayTimeMap(
  value: unknown,
  options: ParseArchiveTodayTimeMapOptions,
): ArchiveTodayTimeMap {
  if (typeof value !== "string") fail("Archive.today TimeMap", "must be text.");
  if (Buffer.byteLength(value, "utf8") > MAX_ARCHIVE_TIMEMAP_UTF8_BYTES) {
    fail("Archive.today TimeMap", `must be at most ${MAX_ARCHIVE_TIMEMAP_UTF8_BYTES} UTF-8 bytes.`);
  }
  if (hasUnsafeControls(value, true, true)) {
    fail("Archive.today TimeMap", "contains forbidden controls.");
  }
  const originalIdentity = normalizeSourceUrlIdentity(options.originalUrl);
  if (originalIdentity === null) fail("Archive.today original URL", "must be a public HTTP or HTTPS URL without credentials.");
  const nowEpoch = checkedNow(options.now);
  const links = parseLinkFormat(value);
  const originals = links.filter((link) => link.parameters.get("rel")?.toLowerCase() === "original");
  if (originals.length !== 1) fail("Archive.today TimeMap", "must contain exactly one rel=original link.");
  const declaredOriginal = normalizeSourceUrlIdentity(originals[0]?.target ?? "");
  if (declaredOriginal === null || declaredOriginal !== originalIdentity) {
    fail("Archive.today TimeMap rel=original", "must exactly match the requested original URL.");
  }

  const mementos: ArchiveTodayMemento[] = [];
  const seen = new Set<string>();
  for (const [index, link] of links.entries()) {
    const relations = (link.parameters.get("rel") ?? "").trim().toLowerCase().split(/[ \t]+/u).filter(Boolean);
    if (!relations.includes("memento")) continue;
    if (relations.includes("original")) fail(`Archive.today TimeMap entry ${index}`, "cannot be both original and memento.");
    const datetime = link.parameters.get("datetime");
    if (datetime === undefined) fail(`Archive.today TimeMap entry ${index}`, "requires a datetime parameter.");
    const expectedEpoch = epochFromHttpDate(datetime, `Archive.today TimeMap entry ${index} datetime`);
    if (expectedEpoch > nowEpoch) fail(`Archive.today TimeMap entry ${index} datetime`, "must not be in the future.");
    const memento = parsedArchiveTodayMementoUrl(link.target, originalIdentity, nowEpoch, expectedEpoch);
    if (!seen.has(memento.url)) {
      seen.add(memento.url);
      mementos.push(memento);
    }
  }
  const sorted = Object.freeze(mementos.toSorted((left, right) =>
    right.timestamp.localeCompare(left.timestamp) || left.url.localeCompare(right.url)));
  return Object.freeze({
    originalUrl: originalIdentity,
    mementos: sorted,
    newest: selectNewestArchiveTodayMemento(sorted),
  });
}
