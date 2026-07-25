// @bun
import {
  BoundedByteBuffer
} from "./index-gh719d91.js";

// src/clip/network.ts
import { lookup } from "dns/promises";
import {
  request as requestHttp
} from "http";
import { request as requestHttps } from "https";
import { isIP } from "net";
import { networkInterfaces } from "os";
class FetchFailure extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "FetchFailure";
    this.code = code;
  }
}
var privateHostnameSuffixes = [".localhost", ".local", ".internal", ".home", ".lan"];
function normalizeHostname(hostname) {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}
function parseIpv4(address) {
  const pieces = address.split(".");
  if (pieces.length !== 4)
    return null;
  const numbers = pieces.map((piece) => Number(piece));
  return numbers.every((piece) => Number.isInteger(piece) && piece >= 0 && piece <= 255) ? numbers : null;
}
function parseIpv6(address) {
  let value = address;
  const ipv4Separator = value.lastIndexOf(":");
  const ipv4Tail = ipv4Separator >= 0 ? value.slice(ipv4Separator + 1) : value;
  if (ipv4Tail.includes(".")) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null || ipv4Separator < 0)
      return null;
    const high = (ipv4[0] ?? 0) << 8 | (ipv4[1] ?? 0);
    const low = (ipv4[2] ?? 0) << 8 | (ipv4[3] ?? 0);
    value = `${value.slice(0, ipv4Separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const compression = value.indexOf("::");
  if (compression !== -1 && compression !== value.lastIndexOf("::"))
    return null;
  const leftText = compression === -1 ? value : value.slice(0, compression);
  const rightText = compression === -1 ? "" : value.slice(compression + 2);
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part)))
    return null;
  const missing = 8 - left.length - right.length;
  if (compression === -1 && missing !== 0 || compression !== -1 && missing < 1)
    return null;
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: Math.max(0, missing) }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16))
  ];
  return groups.length === 8 ? groups : null;
}
function addressWithoutScope(address) {
  const normalized = normalizeHostname(address);
  const scope = normalized.indexOf("%");
  return scope === -1 ? normalized : normalized.slice(0, scope);
}
function comparableAddressKeys(address) {
  const normalized = addressWithoutScope(address);
  const version = isIP(normalized);
  if (version === 4) {
    const pieces = parseIpv4(normalized);
    return pieces === null ? [] : [`4:${pieces.join(".")}`];
  }
  if (version !== 6)
    return [];
  const groups = parseIpv6(normalized);
  if (groups === null)
    return [];
  const keys = [`6:${groups.map((group) => group.toString(16).padStart(4, "0")).join(":")}`];
  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
  if (ipv4Compatible || ipv4Mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    keys.push(`4:${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  return keys;
}
function systemLocalNetworkAddresses() {
  let interfaces;
  try {
    interfaces = networkInterfaces();
  } catch (error) {
    throw new FetchFailure("network", "could not inspect local network interfaces", { cause: error });
  }
  const addresses = [];
  for (const records of Object.values(interfaces)) {
    if (!Array.isArray(records))
      continue;
    for (const record of records) {
      if (typeof record?.address === "string")
        addresses.push(record.address);
    }
  }
  return addresses;
}
function localAddressKeys(provider) {
  let addresses;
  try {
    addresses = provider();
  } catch (error) {
    if (error instanceof FetchFailure)
      throw error;
    throw new FetchFailure("network", "could not inspect local network interfaces", { cause: error });
  }
  const keys = new Set;
  for (const address of addresses) {
    for (const key of comparableAddressKeys(address))
      keys.add(key);
  }
  return keys;
}
function isAssignedLocalAddress(address, localKeys) {
  return comparableAddressKeys(address).some((key) => localKeys.has(key));
}
function isPrivateAddress(address) {
  const normalized = addressWithoutScope(address);
  const version = isIP(normalized);
  if (version === 4) {
    const pieces = parseIpv4(normalized);
    if (pieces === null)
      return true;
    const a = pieces[0] ?? 0;
    const b = pieces[1] ?? 0;
    return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 192 && b === 0 && (pieces[2] ?? 0) === 2 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && (pieces[2] ?? 0) === 100 || a === 203 && b === 0 && (pieces[2] ?? 0) === 113 || a >= 224;
  }
  if (version === 6) {
    const groups = parseIpv6(normalized);
    if (groups === null)
      return true;
    const first = groups[0] ?? 0;
    const second = groups[1] ?? 0;
    const firstSixAreZero = groups.slice(0, 6).every((group) => group === 0);
    const ipv4Compatible = firstSixAreZero;
    const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
    if (ipv4Compatible || ipv4Mapped) {
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      return isPrivateAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }
    return (first & 65024) === 64512 || (first & 65472) === 65152 || (first & 65472) === 65216 || (first & 65280) === 65280 || first === 100 || first === 256 || first === 8193 && !Number.isNaN(second) && second <= 511 || first === 8193 && second === 3512 || first === 8194 || first === 16382 || first === 16383 && !Number.isNaN(second) && (second & 61440) === 0 || first === 24320;
  }
  return true;
}
function isPrivateHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "localhost.localdomain")
    return true;
  if (privateHostnameSuffixes.some((suffix) => normalized.endsWith(suffix)))
    return true;
  return isIP(normalized) !== 0 && isPrivateAddress(normalized);
}
async function systemResolveHostname(hostname) {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) => answer.family === 4 || answer.family === 6 ? [{ address: answer.address, family: answer.family }] : []);
}
async function beforeDeadline(promise, deadline, timeoutMessage) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0)
    throw new FetchFailure("timeout", timeoutMessage);
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FetchFailure("timeout", timeoutMessage)), remainingMs);
      })
    ]);
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
  }
}
async function resolveNetworkTarget(url, allowPrivateNetwork, resolveHostname, getLocalNetworkAddresses, deadline, timeoutMs) {
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
  const assignedLocalAddresses = allowPrivateNetwork ? new Set : localAddressKeys(getLocalNetworkAddresses);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isAssignedLocalAddress(hostname, assignedLocalAddresses)) {
      throw new FetchFailure("private-network", `address ${hostname} is assigned to a local interface; use --allow-private-network only when intended`);
    }
    return [{ address: hostname, family: literalFamily }];
  }
  let answers;
  try {
    answers = await beforeDeadline(resolveHostname(hostname), deadline, `request timed out after ${timeoutMs}ms while resolving ${hostname}`);
  } catch (error) {
    if (error instanceof FetchFailure)
      throw error;
    throw new FetchFailure("dns", `could not resolve ${hostname}`, { cause: error });
  }
  if (answers.length === 0)
    throw new FetchFailure("dns", `could not resolve ${hostname}`);
  if (!allowPrivateNetwork) {
    for (const key of localAddressKeys(getLocalNetworkAddresses))
      assignedLocalAddresses.add(key);
  }
  const unique = new Map;
  for (const answer of answers) {
    const address = normalizeHostname(answer.address);
    const actualFamily = isIP(address);
    if (actualFamily !== 4 && actualFamily !== 6 || actualFamily !== answer.family) {
      throw new FetchFailure("dns", `${hostname} returned an invalid DNS answer`);
    }
    if (!allowPrivateNetwork && isPrivateAddress(address)) {
      throw new FetchFailure("private-network", `${hostname} resolves to private or reserved address ${address}; use --allow-private-network only when intended`);
    }
    if (!allowPrivateNetwork && isAssignedLocalAddress(address, assignedLocalAddresses)) {
      throw new FetchFailure("private-network", `${hostname} resolves to an address assigned to a local interface; use --allow-private-network only when intended`);
    }
    unique.set(`${answer.family}:${address}`, { address, family: answer.family });
  }
  return [...unique.values()];
}
async function resolveSafeNetworkTarget(url, options) {
  const timeoutMs = options.timeoutMs ?? 30000;
  return await resolveNetworkTarget(url, options.allowPrivateNetwork, options.resolveHostname ?? systemResolveHostname, options.getLocalNetworkAddresses ?? systemLocalNetworkAddresses, Date.now() + timeoutMs, timeoutMs);
}
async function assertSafeNetworkUrl(url, allowPrivateNetwork, timeoutMs = 30000) {
  await resolveSafeNetworkTarget(url, { allowPrivateNetwork, timeoutMs });
}
function createPinnedLookup(pinned) {
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
function responseHeaders(headers) {
  const result = new Headers;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string")
      result.append(name, value);
    else if (Array.isArray(value)) {
      for (const item of value)
        result.append(name, item);
    }
  }
  return result;
}
function requestHeaders(headers) {
  const result = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}
function requestPinnedNetworkAddress(request) {
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
    const pinnedAddressHasScope = normalizeHostname(request.address.address) !== addressWithoutScope(request.address.address);
    if (hostnameFamily !== request.address.family || pinnedAddressHasScope || hostnameKey === undefined || hostnameKey !== pinnedKey) {
      return Promise.reject(new Error("IP-literal request hostname does not match the pinned address"));
    }
  }
  const requestOptions = {
    protocol: request.url.protocol,
    hostname,
    method: request.method,
    path: `${request.url.pathname}${request.url.search}`,
    headers: requestHeaders(request.headers),
    lookup: createPinnedLookup(request.address),
    family: request.address.family,
    agent: false,
    signal: request.signal,
    ...request.url.port === "" ? {} : { port: request.url.port }
  };
  return new Promise((resolve, reject) => {
    const onResponse = (response) => {
      if (response.statusCode === undefined) {
        response.destroy();
        reject(new Error("HTTP response omitted a status code"));
        return;
      }
      resolve({
        status: response.statusCode,
        headers: responseHeaders(response.headers),
        body: response,
        cancel: () => response.destroy()
      });
    };
    const clientRequest = request.url.protocol === "https:" ? requestHttps({
      ...requestOptions,
      ...isIP(hostname) === 0 ? { servername: hostname } : {}
    }, onResponse) : requestHttp(requestOptions, onResponse);
    clientRequest.once("error", reject);
    clientRequest.end(request.body ?? undefined);
  });
}
function retryDelay(response, attempt) {
  const header = response?.headers.get("retry-after")?.trim();
  if (header !== undefined && header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, 5000);
    const date = Date.parse(header);
    if (!Number.isNaN(date))
      return Math.min(Math.max(date - Date.now(), 0), 5000);
  }
  return Math.min(250 * 2 ** attempt, 2000);
}
var retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
async function readBounded(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      response.cancel();
      throw new FetchFailure("too-large", `response declares ${length} bytes; limit is ${maxBytes}`);
    }
  }
  if (response.body === null)
    return new Uint8Array;
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
function buildHeaders(current, originalUrl, options) {
  const headers = new Headers({
    Accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Encoding": "identity",
    "User-Agent": options.userAgent
  });
  if (options.referer !== undefined) {
    try {
      const referer = new URL(options.referer);
      headers.set("Referer", referer.origin === current.origin ? referer.href : `${referer.origin}/`);
    } catch {}
  }
  if (options.cookieHeader !== undefined && current.href === originalUrl.href) {
    headers.set("Cookie", options.cookieHeader);
  }
  return headers;
}
function createSafeFetch(dependencies = {}) {
  const resolveHostname = dependencies.resolveHostname ?? systemResolveHostname;
  const transport = dependencies.transport ?? requestPinnedNetworkAddress;
  const getLocalNetworkAddresses = dependencies.getLocalNetworkAddresses ?? systemLocalNetworkAddresses;
  return async (url, options) => {
    const maxRedirects = options.maxRedirects ?? 8;
    const retries = options.retries ?? 2;
    const deadline = Date.now() + options.timeoutMs;
    const originalUrl = new URL(url);
    let current = new URL(url);
    for (let redirects = 0;redirects <= maxRedirects; redirects += 1) {
      const addresses = await resolveNetworkTarget(current, options.allowPrivateNetwork, resolveHostname, getLocalNetworkAddresses, deadline, options.timeoutMs);
      let response = null;
      let lastError;
      let finalController = null;
      let finalTimeout = null;
      for (let attempt = 0;attempt <= retries; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new FetchFailure("timeout", `request timed out after ${options.timeoutMs}ms: ${current.href}`);
        }
        const controller = new AbortController;
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        try {
          const address = addresses[attempt % addresses.length];
          if (address === undefined)
            throw new FetchFailure("dns", `could not resolve ${current.hostname}`);
          response = await beforeDeadline(transport({
            url: new URL(current),
            address,
            method: "GET",
            headers: buildHeaders(current, originalUrl, options),
            body: null,
            signal: controller.signal
          }), deadline, `request timed out after ${options.timeoutMs}ms: ${current.href}`);
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
          controller.abort();
          clearTimeout(timeout);
          if (error instanceof FetchFailure && error.code === "timeout")
            throw error;
          if (attempt === retries) {
            if (controller.signal.aborted) {
              throw new FetchFailure("timeout", `request timed out after ${options.timeoutMs}ms: ${current.href}`, {
                cause: error
              });
            }
            if (error instanceof FetchFailure)
              throw error;
            throw new FetchFailure("network", `request failed: ${current.href}`, { cause: error });
          }
        }
        const delay = Math.min(retryDelay(response, attempt), Math.max(0, deadline - Date.now()));
        if (delay > 0)
          await Bun.sleep(delay);
      }
      if (response === null) {
        throw new FetchFailure("network", `request failed: ${current.href}`, { cause: lastError });
      }
      if (response.status >= 300 && response.status < 400) {
        try {
          const location = response.headers.get("location");
          if (location === null)
            throw new FetchFailure("redirect", `HTTP ${response.status} omitted Location`);
          if (redirects === maxRedirects)
            throw new FetchFailure("redirect", `more than ${maxRedirects} redirects`);
          try {
            current = new URL(location, current);
          } catch (error) {
            throw new FetchFailure("redirect", `invalid redirect target: ${location}`, { cause: error });
          }
          finalController?.abort();
          response.cancel();
          continue;
        } finally {
          if (finalTimeout !== null)
            clearTimeout(finalTimeout);
        }
      }
      if (response.status < 200 || response.status >= 300) {
        if (finalTimeout !== null)
          clearTimeout(finalTimeout);
        finalController?.abort();
        response.cancel();
        throw new FetchFailure("http", `HTTP ${response.status} for ${current.href}`);
      }
      try {
        const bytes = await beforeDeadline(readBounded(response, options.maxBytes), deadline, `response body timed out after ${options.timeoutMs}ms: ${current.href}`);
        return {
          bytes,
          finalUrl: current,
          status: response.status,
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified")
        };
      } catch (error) {
        if (finalController?.signal.aborted === true || error instanceof FetchFailure && error.code === "timeout") {
          response.cancel();
          throw new FetchFailure("timeout", `response body timed out after ${options.timeoutMs}ms: ${current.href}`, {
            cause: error
          });
        }
        if (error instanceof FetchFailure)
          throw error;
        throw new FetchFailure("network", `response body failed: ${current.href}`, { cause: error });
      } finally {
        if (finalTimeout !== null)
          clearTimeout(finalTimeout);
      }
    }
    throw new FetchFailure("redirect", `more than ${maxRedirects} redirects`);
  };
}
async function safeFetch(url, options) {
  return await createSafeFetch()(url, options);
}
function decodeBytes(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  const supported = charset === "iso-8859-1" || charset === "windows-1252" ? "windows-1252" : "utf-8";
  return new TextDecoder(supported, { fatal: false }).decode(bytes);
}

export { FetchFailure, isPrivateAddress, isPrivateHostname, resolveSafeNetworkTarget, assertSafeNetworkUrl, createPinnedLookup, requestPinnedNetworkAddress, createSafeFetch, safeFetch, decodeBytes };
