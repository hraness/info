import { lookup } from "node:dns/promises";
import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";

import { BoundedByteBuffer } from "./bounded-byte-buffer.js";

export type FetchFailureCode =
  | "invalid-url"
  | "private-network"
  | "dns"
  | "timeout"
  | "http"
  | "redirect"
  | "too-large"
  | "network";

export class FetchFailure extends Error {
  readonly code: FetchFailureCode;

  constructor(code: FetchFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FetchFailure";
    this.code = code;
  }
}

export type SafeFetchOptions = {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly allowPrivateNetwork: boolean;
  readonly userAgent: string;
  readonly referer?: string;
  readonly cookieHeader?: string;
  readonly accept?: string;
  readonly retries?: number;
  readonly maxRedirects?: number;
};

export type SafeFetchResult = {
  readonly bytes: Uint8Array;
  readonly finalUrl: URL;
  readonly status: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
};

export type ResolvedNetworkAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

export type NetworkResolver = (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>;

export type LocalNetworkAddressProvider = () => readonly string[];

export type PinnedNetworkRequest = {
  readonly url: URL;
  readonly address: ResolvedNetworkAddress;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | null;
  readonly signal: AbortSignal;
};

export type PinnedNetworkResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<unknown> | null;
  readonly cancel: () => void;
};

export type NetworkTransport = (request: PinnedNetworkRequest) => Promise<PinnedNetworkResponse>;

export type SafeFetchDependencies = {
  readonly resolveHostname: NetworkResolver;
  readonly transport: NetworkTransport;
  /** Test seam. Production callers must use the system interface snapshot. */
  readonly getLocalNetworkAddresses: LocalNetworkAddressProvider;
};

export type SafeNetworkTargetOptions = {
  readonly allowPrivateNetwork: boolean;
  readonly timeoutMs?: number;
  readonly resolveHostname?: NetworkResolver;
  /** Test seam. Production callers must leave this unset. */
  readonly getLocalNetworkAddresses?: LocalNetworkAddressProvider;
};

const privateHostnameSuffixes = [".localhost", ".local", ".internal", ".home", ".lan"];

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function parseIpv4(address: string): readonly number[] | null {
  const pieces = address.split(".");
  if (pieces.length !== 4) return null;
  const numbers = pieces.map((piece) => Number(piece));
  return numbers.every((piece) => Number.isInteger(piece) && piece >= 0 && piece <= 255)
    ? numbers
    : null;
}

function parseIpv6(address: string): readonly number[] | null {
  let value = address;
  const ipv4Separator = value.lastIndexOf(":");
  const ipv4Tail = ipv4Separator >= 0 ? value.slice(ipv4Separator + 1) : value;
  if (ipv4Tail.includes(".")) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null || ipv4Separator < 0) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    value = `${value.slice(0, ipv4Separator)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const compression = value.indexOf("::");
  if (compression !== -1 && compression !== value.lastIndexOf("::")) return null;
  const leftText = compression === -1 ? value : value.slice(0, compression);
  const rightText = compression === -1 ? "" : value.slice(compression + 2);
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((compression === -1 && missing !== 0) || (compression !== -1 && missing < 1)) return null;
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: Math.max(0, missing) }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return groups.length === 8 ? groups : null;
}

function addressWithoutScope(address: string): string {
  const normalized = normalizeHostname(address);
  const scope = normalized.indexOf("%");
  return scope === -1 ? normalized : normalized.slice(0, scope);
}

/**
 * Return syntax-independent comparison keys for one IP literal. IPv4-mapped and deprecated
 * IPv4-compatible IPv6 forms also receive their IPv4 key because either form can reach the same
 * local IPv4 interface on platforms that enable mapped sockets.
 */
function comparableAddressKeys(address: string): readonly string[] {
  const normalized = addressWithoutScope(address);
  const version = isIP(normalized);
  if (version === 4) {
    const pieces = parseIpv4(normalized);
    return pieces === null ? [] : [`4:${pieces.join(".")}`];
  }
  if (version !== 6) return [];
  const groups = parseIpv6(normalized);
  if (groups === null) return [];
  const keys = [`6:${groups.map((group) => group.toString(16).padStart(4, "0")).join(":")}`];
  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (ipv4Compatible || ipv4Mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    keys.push(`4:${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  return keys;
}

function systemLocalNetworkAddresses(): readonly string[] {
  let interfaces: ReturnType<typeof networkInterfaces>;
  try {
    interfaces = networkInterfaces();
  } catch (error) {
    throw new FetchFailure("network", "could not inspect local network interfaces", { cause: error });
  }
  const addresses: string[] = [];
  for (const records of Object.values(interfaces)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (typeof record?.address === "string") addresses.push(record.address);
    }
  }
  return addresses;
}

function localAddressKeys(provider: LocalNetworkAddressProvider): Set<string> {
  let addresses: readonly string[];
  try {
    addresses = provider();
  } catch (error) {
    if (error instanceof FetchFailure) throw error;
    throw new FetchFailure("network", "could not inspect local network interfaces", { cause: error });
  }
  const keys = new Set<string>();
  for (const address of addresses) {
    for (const key of comparableAddressKeys(address)) keys.add(key);
  }
  return keys;
}

function isAssignedLocalAddress(address: string, localKeys: ReadonlySet<string>): boolean {
  return comparableAddressKeys(address).some((key) => localKeys.has(key));
}

/** Return true for loopback, link-local, private, reserved, multicast, and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const normalized = addressWithoutScope(address);
  const version = isIP(normalized);
  if (version === 4) {
    const pieces = parseIpv4(normalized);
    if (pieces === null) return true;
    const a = pieces[0] ?? 0;
    const b = pieces[1] ?? 0;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 192 && b === 0 && (pieces[2] ?? 0) === 2)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && (pieces[2] ?? 0) === 100)
      || (a === 203 && b === 0 && (pieces[2] ?? 0) === 113)
      || a >= 224;
  }
  if (version === 6) {
    const groups = parseIpv6(normalized);
    if (groups === null) return true;
    const first = groups[0] ?? 0;
    const second = groups[1] ?? 0;
    const firstSixAreZero = groups.slice(0, 6).every((group) => group === 0);
    const ipv4Compatible = firstSixAreZero;
    const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (ipv4Compatible || ipv4Mapped) {
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      return isPrivateAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
    }
    return (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xffc0) === 0xfec0
      || (first & 0xff00) === 0xff00
      || first === 0x0064
      || first === 0x0100
      || (first === 0x2001 && !Number.isNaN(second) && second <= 0x01ff)
      || (first === 0x2001 && second === 0x0db8)
      || first === 0x2002
      || first === 0x3ffe
      || (first === 0x3fff && !Number.isNaN(second) && (second & 0xf000) === 0)
      || first === 0x5f00;
  }
  return true;
}

export function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "localhost.localdomain") return true;
  if (privateHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))) return true;
  return isIP(normalized) !== 0 && isPrivateAddress(normalized);
}

async function systemResolveHostname(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6 ? [{ address: answer.address, family: answer.family }] : [],
  );
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, timeoutMessage: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new FetchFailure("timeout", timeoutMessage);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FetchFailure("timeout", timeoutMessage)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function resolveNetworkTarget(
  url: URL,
  allowPrivateNetwork: boolean,
  resolveHostname: NetworkResolver,
  getLocalNetworkAddresses: LocalNetworkAddressProvider,
  deadline: number,
  timeoutMs: number,
): Promise<readonly ResolvedNetworkAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchFailure("invalid-url", `unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new FetchFailure("invalid-url", "credential-bearing URLs are not accepted; use a local cookie file or browser session");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!allowPrivateNetwork && isPrivateHostname(hostname)) {
    throw new FetchFailure("private-network", `private-network URL requires --allow-private-network: ${url.origin}`);
  }
  const assignedLocalAddresses = allowPrivateNetwork
    ? new Set<string>()
    : localAddressKeys(getLocalNetworkAddresses);

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isAssignedLocalAddress(hostname, assignedLocalAddresses)) {
      throw new FetchFailure(
        "private-network",
        `address ${hostname} is assigned to a local interface; use --allow-private-network only when intended`,
      );
    }
    return [{ address: hostname, family: literalFamily }];
  }

  let answers: readonly ResolvedNetworkAddress[];
  try {
    answers = await beforeDeadline(
      resolveHostname(hostname),
      deadline,
      `request timed out after ${timeoutMs}ms while resolving ${hostname}`,
    );
  } catch (error) {
    if (error instanceof FetchFailure) throw error;
    throw new FetchFailure("dns", `could not resolve ${hostname}`, { cause: error });
  }
  if (answers.length === 0) throw new FetchFailure("dns", `could not resolve ${hostname}`);
  if (!allowPrivateNetwork) {
    // DNS can consume most of the request deadline. Merge a second snapshot so an interface that
    // appeared while resolution was in flight cannot turn a public-looking answer into a local hop.
    for (const key of localAddressKeys(getLocalNetworkAddresses)) assignedLocalAddresses.add(key);
  }

  const unique = new Map<string, ResolvedNetworkAddress>();
  for (const answer of answers) {
    const address = normalizeHostname(answer.address);
    const actualFamily = isIP(address);
    if ((actualFamily !== 4 && actualFamily !== 6) || actualFamily !== answer.family) {
      throw new FetchFailure("dns", `${hostname} returned an invalid DNS answer`);
    }
    if (!allowPrivateNetwork && isPrivateAddress(address)) {
      throw new FetchFailure(
        "private-network",
        `${hostname} resolves to private or reserved address ${address}; use --allow-private-network only when intended`,
      );
    }
    if (!allowPrivateNetwork && isAssignedLocalAddress(address, assignedLocalAddresses)) {
      throw new FetchFailure(
        "private-network",
        `${hostname} resolves to an address assigned to a local interface; use --allow-private-network only when intended`,
      );
    }
    unique.set(`${answer.family}:${address}`, { address, family: answer.family });
  }
  return [...unique.values()];
}

/** Resolve one URL into validated connection candidates that are safe to pin at the transport boundary. */
export async function resolveSafeNetworkTarget(
  url: URL,
  options: SafeNetworkTargetOptions,
): Promise<readonly ResolvedNetworkAddress[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return await resolveNetworkTarget(
    url,
    options.allowPrivateNetwork,
    options.resolveHostname ?? systemResolveHostname,
    options.getLocalNetworkAddresses ?? systemLocalNetworkAddresses,
    Date.now() + timeoutMs,
    timeoutMs,
  );
}

/** Refuse private, reserved, or host-assigned network targets unless explicitly enabled. */
export async function assertSafeNetworkUrl(
  url: URL,
  allowPrivateNetwork: boolean,
  timeoutMs = 30_000,
): Promise<void> {
  await resolveSafeNetworkTarget(url, { allowPrivateNetwork, timeoutMs });
}

/** A Node lookup callback that can return only a previously validated address. */
export function createPinnedLookup(pinned: ResolvedNetworkAddress): LookupFunction {
  const address = pinned.address;
  const family = pinned.family;
  return (_hostname, options, callback) => {
    queueMicrotask(() => {
      if (options.all === true) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    });
  };
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.append(name, value);
    else if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    }
  }
  return result;
}

function requestHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

/**
 * Send exactly one HTTP(S) request through one previously validated address.
 *
 * This is a raw transport boundary: it does not resolve DNS, follow redirects, retry failures,
 * interpret statuses, or accumulate the response body. Callers retain those higher-level policies.
 */
export function requestPinnedNetworkAddress(request: PinnedNetworkRequest): Promise<PinnedNetworkResponse> {
  const hostname = normalizeHostname(request.url.hostname);
  if (request.url.protocol !== "http:" && request.url.protocol !== "https:") {
    return Promise.reject(new Error(`unsupported pinned request protocol: ${request.url.protocol}`));
  }
  if (isIP(request.address.address) !== request.address.family) {
    return Promise.reject(new Error("pinned request address does not match its declared family"));
  }
  const hostnameFamily = isIP(hostname);
  if (hostnameFamily !== 0) {
    const hostnameKey = comparableAddressKeys(hostname)[0];
    const pinnedKey = comparableAddressKeys(request.address.address)[0];
    const pinnedAddressHasScope =
      normalizeHostname(request.address.address)
      !== addressWithoutScope(request.address.address);
    if (
      hostnameFamily !== request.address.family
      || pinnedAddressHasScope
      || hostnameKey === undefined
      || hostnameKey !== pinnedKey
    ) {
      return Promise.reject(
        new Error("IP-literal request hostname does not match the pinned address"),
      );
    }
  }
  const requestOptions: RequestOptions = {
    protocol: request.url.protocol,
    hostname,
    method: request.method,
    path: `${request.url.pathname}${request.url.search}`,
    headers: requestHeaders(request.headers),
    lookup: createPinnedLookup(request.address),
    family: request.address.family,
    agent: false,
    signal: request.signal,
    ...(request.url.port === "" ? {} : { port: request.url.port }),
  };

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage): void => {
      if (response.statusCode === undefined) {
        response.destroy();
        reject(new Error("HTTP response omitted a status code"));
        return;
      }
      resolve({
        status: response.statusCode,
        headers: responseHeaders(response.headers),
        body: response,
        cancel: () => response.destroy(),
      });
    };
    const clientRequest = request.url.protocol === "https:"
      ? requestHttps(
          {
            ...requestOptions,
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          },
          onResponse,
        )
      : requestHttp(requestOptions, onResponse);
    clientRequest.once("error", reject);
    clientRequest.end(request.body ?? undefined);
  });
}

function retryDelay(response: PinnedNetworkResponse | null, attempt: number): number {
  const header = response?.headers.get("retry-after")?.trim();
  if (header !== undefined && header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 5_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

async function readBounded(response: PinnedNetworkResponse, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      response.cancel();
      throw new FetchFailure("too-large", `response declares ${length} bytes; limit is ${maxBytes}`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const bytes = new BoundedByteBuffer(maxBytes);
  for await (const value of response.body) {
    if (!(value instanceof Uint8Array)) {
      response.cancel();
      throw new FetchFailure("network", "response body yielded a non-byte chunk");
    }
    if (!bytes.append(value)) {
      response.cancel();
      throw new FetchFailure("too-large", `response exceeded ${maxBytes} bytes`);
    }
  }
  return bytes.toUint8Array();
}

function buildHeaders(current: URL, originalUrl: URL, options: SafeFetchOptions): Headers {
  const headers = new Headers({
    Accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Encoding": "identity",
    "User-Agent": options.userAgent,
  });
  if (options.referer !== undefined) {
    try {
      const referer = new URL(options.referer);
      headers.set("Referer", referer.origin === current.origin ? referer.href : `${referer.origin}/`);
    } catch {
      // Ignore an invalid optional referrer instead of forwarding arbitrary text.
    }
  }
  if (options.cookieHeader !== undefined && current.href === originalUrl.href) {
    headers.set("Cookie", options.cookieHeader);
  }
  return headers;
}

/** Build a bounded fetcher around an explicitly pinned transport and resolver. */
export function createSafeFetch(
  dependencies: Partial<SafeFetchDependencies> = {},
): (url: URL, options: SafeFetchOptions) => Promise<SafeFetchResult> {
  const resolveHostname = dependencies.resolveHostname ?? systemResolveHostname;
  const transport = dependencies.transport ?? requestPinnedNetworkAddress;
  const getLocalNetworkAddresses = dependencies.getLocalNetworkAddresses ?? systemLocalNetworkAddresses;

  return async (url, options) => {
    const maxRedirects = options.maxRedirects ?? 8;
    const retries = options.retries ?? 2;
    const deadline = Date.now() + options.timeoutMs;
    const originalUrl = new URL(url);
    let current = new URL(url);

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const addresses = await resolveNetworkTarget(
        current,
        options.allowPrivateNetwork,
        resolveHostname,
        getLocalNetworkAddresses,
        deadline,
        options.timeoutMs,
      );
      let response: PinnedNetworkResponse | null = null;
      let lastError: unknown;
      let finalController: AbortController | null = null;
      let finalTimeout: ReturnType<typeof setTimeout> | null = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new FetchFailure("timeout", `request timed out after ${options.timeoutMs}ms: ${current.href}`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        try {
          const address = addresses[attempt % addresses.length];
          if (address === undefined) throw new FetchFailure("dns", `could not resolve ${current.hostname}`);
          response = await beforeDeadline(
            transport({
              url: new URL(current),
              address,
              method: "GET",
              headers: buildHeaders(current, originalUrl, options),
              body: null,
              signal: controller.signal,
            }),
            deadline,
            `request timed out after ${options.timeoutMs}ms: ${current.href}`,
          );
          if (!retryableStatuses.has(response.status) || attempt === retries) {
            finalController = controller;
            finalTimeout = timeout;
            break;
          }
          controller.abort();
          response.cancel();
          clearTimeout(timeout);
        } catch (error) {
          lastError = error;
          // `beforeDeadline` and the abort timer share a deadline but are separate callbacks.
          // Abort first when either one wins so a still-pending transport cannot retain its socket.
          controller.abort();
          clearTimeout(timeout);
          if (error instanceof FetchFailure && error.code === "timeout") throw error;
          if (attempt === retries) {
            if (controller.signal.aborted) {
              throw new FetchFailure("timeout", `request timed out after ${options.timeoutMs}ms: ${current.href}`, {
                cause: error,
              });
            }
            if (error instanceof FetchFailure) throw error;
            throw new FetchFailure("network", `request failed: ${current.href}`, { cause: error });
          }
        }
        const delay = Math.min(retryDelay(response, attempt), Math.max(0, deadline - Date.now()));
        if (delay > 0) await Bun.sleep(delay);
      }
      if (response === null) {
        throw new FetchFailure("network", `request failed: ${current.href}`, { cause: lastError });
      }

      if (response.status >= 300 && response.status < 400) {
        try {
          const location = response.headers.get("location");
          if (location === null) throw new FetchFailure("redirect", `HTTP ${response.status} omitted Location`);
          if (redirects === maxRedirects) throw new FetchFailure("redirect", `more than ${maxRedirects} redirects`);
          try {
            current = new URL(location, current);
          } catch (error) {
            throw new FetchFailure("redirect", `invalid redirect target: ${location}`, { cause: error });
          }
          finalController?.abort();
          response.cancel();
          continue;
        } finally {
          if (finalTimeout !== null) clearTimeout(finalTimeout);
        }
      }

      if (response.status < 200 || response.status >= 300) {
        if (finalTimeout !== null) clearTimeout(finalTimeout);
        finalController?.abort();
        response.cancel();
        throw new FetchFailure("http", `HTTP ${response.status} for ${current.href}`);
      }
      try {
        const bytes = await beforeDeadline(
          readBounded(response, options.maxBytes),
          deadline,
          `response body timed out after ${options.timeoutMs}ms: ${current.href}`,
        );
        return {
          bytes,
          finalUrl: current,
          status: response.status,
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      } catch (error) {
        if (finalController?.signal.aborted === true || (error instanceof FetchFailure && error.code === "timeout")) {
          response.cancel();
          throw new FetchFailure("timeout", `response body timed out after ${options.timeoutMs}ms: ${current.href}`, {
            cause: error,
          });
        }
        if (error instanceof FetchFailure) throw error;
        throw new FetchFailure("network", `response body failed: ${current.href}`, { cause: error });
      } finally {
        if (finalTimeout !== null) clearTimeout(finalTimeout);
      }
    }
    throw new FetchFailure("redirect", `more than ${maxRedirects} redirects`);
  };
}

/** Fetch one bounded resource with checked redirects and no cookie forwarding after the initial URL. */
export async function safeFetch(url: URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
  return await createSafeFetch()(url, options);
}

export function decodeBytes(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  const supported = charset === "iso-8859-1" || charset === "windows-1252" ? "windows-1252" : "utf-8";
  return new TextDecoder(supported, { fatal: false }).decode(bytes);
}
