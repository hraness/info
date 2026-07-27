import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_COOKIE_RECORDS = 4_096;
export const MAX_COOKIE_BYTES = 2 * 1024 * 1024;

export type StrictCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "Strict" | "Lax" | "None" | null;
  readonly expires: number;
};

export type FilteredCookies = {
  readonly cookies: readonly StrictCookie[];
  readonly rejected: number;
};

export type CookieFileResult =
  | ({
      readonly ok: true;
      readonly format: "json" | "base64-json" | "netscape" | "cookie-header" | "curl";
      /** Whether every accepted source record carried its own domain or URL scope. */
      readonly scopeProvenance: "explicit" | "target-inferred";
    } & FilteredCookies)
  | { readonly ok: false; readonly reason: "unavailable" | "unsafe-permissions" | "too-large" | "invalid" | "empty" };

export type CookieProviderResult = FilteredCookies & {
  readonly validShape: boolean;
  readonly providerWarningCount: number;
};

type CandidateCookie = Readonly<Record<string, unknown>>;

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValuePattern = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const quotedCookieValuePattern = /^"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"$/;
const cookieDomainPattern = /^[a-z0-9.-]+$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253 || trimmed.includes("..") || !cookieDomainPattern.test(trimmed)) {
    return null;
  }
  try {
    const hostname = new URL(`http://${trimmed}/`).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "" || hostname.length > 253 ? null : hostname;
  } catch {
    return null;
  }
}

function domainMatches(hostname: string, domain: string, hostOnly: boolean): boolean {
  return hostname === domain || (!hostOnly && hostname.endsWith(`.${domain}`));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function safeCookiePath(value: unknown): string | null {
  const path = value === undefined ? "/" : value;
  if (
    typeof path !== "string"
    || !path.startsWith("/")
    || path.length > 4_096
    || hasControlCharacter(path)
  ) return null;
  return path;
}

function cookieExpiry(value: CandidateCookie, nowSeconds: number): number | null {
  const raw = value.expires ?? value.expirationDate;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw === 0) return 0;
  if (raw <= nowSeconds || raw > 253_402_300_799) return null;
  return Math.trunc(raw);
}

function cookieSameSite(value: CandidateCookie): StrictCookie["sameSite"] | undefined {
  if (value.sameSite === undefined || value.sameSite === null) return null;
  if (typeof value.sameSite !== "string") return undefined;
  switch (value.sameSite.toLowerCase()) {
    case "strict": return "Strict";
    case "lax": return "Lax";
    case "none":
    case "no_restriction": return "None";
    case "unspecified": return null;
    default: return undefined;
  }
}

function candidateDomain(
  value: CandidateCookie,
  target: URL,
): { readonly domain: string; readonly hostOnly: boolean } | null {
  const targetHostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  let rawDomain: string | undefined;
  if (typeof value.domain === "string") rawDomain = value.domain;
  else if (value.domain !== undefined) return null;

  let urlHostname: string | undefined;
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || value.url.length > 8_192) return null;
    try {
      const url = new URL(value.url);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:")
        || url.username !== ""
        || url.password !== ""
      ) return null;
      urlHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    } catch {
      return null;
    }
  }

  if (rawDomain === undefined && urlHostname === undefined) {
    return { domain: targetHostname, hostOnly: true };
  }
  const hadLeadingDot = rawDomain?.trim().startsWith(".") === true;
  const domain = canonicalHostname(rawDomain ?? urlHostname ?? "");
  if (domain === null) return null;
  const explicitHostOnly = value.hostOnly;
  if (explicitHostOnly !== undefined && typeof explicitHostOnly !== "boolean") return null;
  const hostOnly = typeof explicitHostOnly === "boolean"
    ? explicitHostOnly
    : !hadLeadingDot;
  if (!domainMatches(targetHostname, domain, hostOnly)) return null;
  if (urlHostname !== undefined && !domainMatches(urlHostname, domain, hostOnly)) return null;
  return { domain, hostOnly };
}

function hasSafeUnpartitionedProvenance(value: CandidateCookie): boolean {
  for (const field of ["partitionKey", "topFrameSiteKey", "top_frame_site_key", "originAttributes"] as const) {
    const provenance = value[field];
    if (provenance === undefined || provenance === null) continue;
    if (typeof provenance !== "string" || provenance.trim() !== "") return false;
  }
  for (const field of ["partitioned"] as const) {
    const flag = value[field];
    if (flag === undefined || flag === null) continue;
    if (typeof flag !== "boolean" || flag) return false;
  }
  for (const field of ["isPartitionedAttributeSet", "hasCrossSiteAncestor", "has_cross_site_ancestor"] as const) {
    const flag = value[field];
    if (flag === undefined || flag === null) continue;
    if (flag !== false && flag !== 0 && flag !== "0") return false;
  }
  return true;
}

function validatedCookie(
  value: unknown,
  target: URL,
  nowSeconds: number,
): StrictCookie | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.name !== "string"
    || value.name.length > 1_024
    || !cookieNamePattern.test(value.name)
  ) return null;
  if (
    typeof value.value !== "string"
    || value.value.length > 64 * 1024
    || (!cookieValuePattern.test(value.value) && !quotedCookieValuePattern.test(value.value))
  ) return null;
  if (!hasSafeUnpartitionedProvenance(value)) return null;
  const domain = candidateDomain(value, target);
  const path = safeCookiePath(value.path);
  const expires = cookieExpiry(value, nowSeconds);
  const sameSite = cookieSameSite(value);
  if (domain === null || path === null || expires === null || sameSite === undefined) return null;
  if (!pathMatches(target.pathname || "/", path)) return null;
  if (value.secure !== undefined && typeof value.secure !== "boolean") return null;
  if (value.httpOnly !== undefined && typeof value.httpOnly !== "boolean") return null;
  const secure = value.secure === true;
  if (secure && target.protocol !== "https:") return null;
  if (sameSite === "None" && !secure) return null;
  return {
    name: value.name,
    value: value.value,
    domain: domain.domain,
    hostOnly: domain.hostOnly,
    path,
    secure,
    httpOnly: value.httpOnly === true,
    sameSite,
    expires,
  };
}

function cookieBytes(cookie: StrictCookie): number {
  return Buffer.byteLength(
    `${cookie.domain}\t${cookie.path}\t${cookie.name}\t${cookie.value}\n`,
    "utf8",
  );
}

/** Apply browser-like domain, path, Secure, expiry, syntax, count, and byte bounds. */
export function filterCookies(
  values: readonly unknown[],
  target: URL,
  nowSeconds = Math.floor(Date.now() / 1_000),
): FilteredCookies {
  const bounded = values.slice(0, MAX_COOKIE_RECORDS);
  let rejected = Math.max(0, values.length - bounded.length);
  let totalBytes = 0;
  const cookies = new Map<string, StrictCookie>();
  for (const value of bounded) {
    const cookie = validatedCookie(value, target, nowSeconds);
    if (cookie === null) {
      rejected += 1;
      continue;
    }
    const key = `${cookie.domain}\0${cookie.hostOnly ? "host" : "domain"}\0${cookie.path}\0${cookie.name}`;
    const previous = cookies.get(key);
    const nextBytes = totalBytes - (previous === undefined ? 0 : cookieBytes(previous)) + cookieBytes(cookie);
    if (nextBytes > MAX_COOKIE_BYTES) {
      rejected += 1;
      continue;
    }
    cookies.set(key, cookie);
    totalBytes = nextBytes;
  }
  return {
    cookies: [...cookies.values()].sort((left, right) =>
      right.path.length - left.path.length
      || left.name.localeCompare(right.name)
      || left.domain.localeCompare(right.domain)),
    rejected,
  };
}

function jsonCookieArray(value: unknown): readonly unknown[] | null {
  if (isUnknownArray(value)) return value;
  return isRecord(value) && isUnknownArray(value.cookies) ? value.cookies : null;
}

function parseJson(input: string): readonly unknown[] | null {
  try {
    return jsonCookieArray(JSON.parse(input) as unknown);
  } catch {
    return null;
  }
}

function parseBase64Json(input: string): readonly unknown[] | null {
  const compact = input.replace(/\s+/g, "");
  if (compact === "" || compact.length > MAX_COOKIE_BYTES * 2 || !/^[a-z0-9+/]+=*$/i.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact, "base64");
    return decoded.byteLength > MAX_COOKIE_BYTES ? null : parseJson(decoded.toString("utf8"));
  } catch {
    return null;
  }
}

function hasExplicitCookieScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (typeof value.domain === "string" && value.domain.trim() !== "")
    || (typeof value.url === "string" && value.url.trim() !== "");
}

function parseNetscape(input: string): readonly unknown[] | null {
  const cookies: unknown[] = [];
  let looksLikeNetscape = /^# Netscape HTTP Cookie File/im.test(input);
  let cursor = 0;
  while (cursor <= input.length && cookies.length <= MAX_COOKIE_RECORDS) {
    const newline = input.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? input.length : newline;
    const rawLine = input.slice(cursor, lineEnd).replace(/\r$/, "");
    cursor = newline === -1 ? input.length + 1 : newline + 1;
    const line = rawLine.trim();
    if (line === "" || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    if (line.length > 80 * 1024) continue;
    const columns = line.split("\t", 8);
    if (columns.length < 7) continue;
    looksLikeNetscape = true;
    const rawDomain = columns[0];
    const includeSubdomains = columns[1];
    const path = columns[2];
    const secure = columns[3];
    const rawExpires = columns[4];
    const name = columns[5];
    const value = columns.slice(6).join("\t");
    if (
      rawDomain === undefined
      || includeSubdomains === undefined
      || path === undefined
      || secure === undefined
      || rawExpires === undefined
      || name === undefined
    ) continue;
    const httpOnly = rawDomain.startsWith("#HttpOnly_");
    const domain = httpOnly ? rawDomain.slice("#HttpOnly_".length) : rawDomain;
    const expires = Number(rawExpires);
    cookies.push({
      name,
      value,
      domain,
      hostOnly: includeSubdomains.toUpperCase() !== "TRUE",
      path,
      secure: secure.toUpperCase() === "TRUE",
      httpOnly,
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
    });
  }
  return looksLikeNetscape ? cookies : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  return (first === "'" || first === '"') && trimmed.at(-1) === first
    ? trimmed.slice(1, -1)
    : trimmed;
}

function parseCookieHeaderValue(value: string, target: URL): readonly unknown[] {
  const cookies: unknown[] = [];
  const restrictivePath = target.pathname === "" ? "/" : target.pathname;
  let cursor = 0;
  while (cursor <= value.length && cookies.length <= MAX_COOKIE_RECORDS) {
    const delimiter = value.indexOf(";", cursor);
    const pairEnd = delimiter === -1 ? value.length : delimiter;
    const pair = value.slice(cursor, pairEnd);
    cursor = delimiter === -1 ? value.length + 1 : delimiter + 1;
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    cookies.push({
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1).trim(),
      domain: target.hostname,
      hostOnly: true,
      path: restrictivePath,
      secure: target.protocol === "https:",
      httpOnly: true,
      sameSite: "Strict",
    });
  }
  return cookies;
}

function curlCookieValue(input: string): { readonly value: string; readonly curl: boolean } | null {
  const patterns = [
    /(?:^|\s)(?:-b|--cookie)(?:=|\s+)(('[^']*')|("[^"]*")|[^\s]+)/i,
    /(?:^|\s)(?:-H|--header)(?:=|\s+)(('Cookie:\s*[^']*')|("Cookie:\s*[^"]*"))/i,
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(input)?.[1];
    if (raw === undefined) continue;
    return { value: unquote(raw).replace(/^Cookie:\s*/i, ""), curl: true };
  }
  const header = /^Cookie:\s*([^\r\n]*)$/im.exec(input)?.[1];
  if (header !== undefined) return { value: header, curl: false };
  const trimmed = input.trim();
  return !trimmed.includes("\n") && trimmed.includes("=")
    ? { value: trimmed, curl: false }
    : null;
}

/** Parse supported explicit cookie payloads, then apply the same strict request filter used for browsers. */
export function parseCookiePayload(
  input: string,
  target: URL,
  nowSeconds = Math.floor(Date.now() / 1_000),
): CookieFileResult {
  if (Buffer.byteLength(input, "utf8") > MAX_COOKIE_BYTES) return { ok: false, reason: "too-large" };
  if (input.trim() === "") return { ok: false, reason: "empty" };
  let values = parseJson(input);
  let format: Extract<CookieFileResult, { readonly ok: true }>["format"] = "json";
  if (values === null) {
    values = parseBase64Json(input);
    format = "base64-json";
  }
  if (values === null) {
    values = parseNetscape(input);
    format = "netscape";
  }
  if (values === null) {
    const header = curlCookieValue(input);
    if (header !== null) {
      values = parseCookieHeaderValue(header.value, target);
      format = header.curl ? "curl" : "cookie-header";
    }
  }
  if (values === null) return { ok: false, reason: "invalid" };
  const scopeProvenance = format === "netscape"
    || ((format === "json" || format === "base64-json") && values.every(hasExplicitCookieScope))
    ? "explicit"
    : "target-inferred";
  const filtered = filterCookies(values, target, nowSeconds);
  return filtered.cookies.length === 0
    ? { ok: false, reason: "empty" }
    : { ok: true, format, scopeProvenance, ...filtered };
}

/** Read only one explicit bounded regular file. It never falls back to browser providers. */
export function readCookieFile(
  path: string,
  target: URL,
  options: {
    /** Test seam. Production callers must leave this unset. */
    readonly afterOpen?: () => void;
    /** Authenticated API callers require a current-user-owned mode-0600-style file. */
    readonly requirePrivate?: boolean;
  } = {},
): CookieFileResult {
  let descriptor: number;
  try {
    const absolute = resolve(path);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    descriptor = openSync(absolute, constants.O_RDONLY | noFollow | nonBlocking);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  try {
    options.afterOpen?.();
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { ok: false, reason: "unavailable" };
    if (
      options.requirePrivate === true
      && ((stats.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && stats.uid !== process.getuid()))
    ) return { ok: false, reason: "unsafe-permissions" };
    if (stats.size > MAX_COOKIE_BYTES) return { ok: false, reason: "too-large" };
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_COOKIE_BYTES) return { ok: false, reason: "too-large" };
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return { ok: false, reason: "invalid" };
    }
    return parseCookiePayload(text, target);
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    closeSync(descriptor);
  }
}

/** Parse a foreign Sweet Cookie result without retaining its warning strings or leaking provider errors. */
export function filterCookieProviderResult(value: unknown, target: URL): CookieProviderResult {
  if (!isRecord(value) || !Array.isArray(value.cookies)) {
    return { validShape: false, cookies: [], rejected: 0, providerWarningCount: 0 };
  }
  // Browser databases distinguish host-only, Domain, partitioned, and container
  // cookies. A provider that drops that provenance cannot be replayed safely.
  // Require the hostOnly field retained by the pinned provider fork; this also
  // makes an install with an incompatible provider fail closed.
  const provenancePreserving = value.cookies.filter((cookie) =>
    isRecord(cookie) && typeof cookie.hostOnly === "boolean");
  const missingProvenance = value.cookies.length - provenancePreserving.length;
  const filtered = filterCookies(provenancePreserving, target, Math.floor(Date.now() / 1_000));
  return {
    validShape: true,
    ...filtered,
    rejected: filtered.rejected + missingProvenance,
    providerWarningCount: Array.isArray(value.warnings) ? value.warnings.length : 0,
  };
}

/** Render a browser-ordered Cookie header from already filtered records. */
export function renderCookieHeader(cookies: readonly StrictCookie[]): string {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

/** Render a host-pinned private Netscape jar for yt-dlp. */
export function renderNetscapeCookieJar(cookies: readonly StrictCookie[], target: URL): string {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return [
    "# Netscape HTTP Cookie File",
    "# Created temporarily by kb clip; deleted after media capture.",
    ...cookies.map((cookie) => {
      const domain = `${cookie.httpOnly ? "#HttpOnly_" : ""}${hostname}`;
      return `${domain}\tFALSE\t${cookie.path}\t${cookie.secure ? "TRUE" : "FALSE"}\t${cookie.expires}\t${cookie.name}\t${cookie.value}`;
    }),
    "",
  ].join("\n");
}
