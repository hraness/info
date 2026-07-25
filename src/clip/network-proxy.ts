import {
  createServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { BoundedByteBuffer } from "./bounded-byte-buffer.js";
import {
  createPinnedLookup,
  FetchFailure,
  resolveSafeNetworkTarget,
  type NetworkResolver,
  type ResolvedNetworkAddress,
} from "./network.js";

export type NetworkProxyOptions = {
  readonly allowPrivateNetwork: boolean;
  readonly timeoutMs?: number;
  readonly maxHeaderBytes?: number;
  readonly maxConnections?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxTransferredBytes?: number;
  /** Test seams. Production callers must leave these unset. */
  readonly resolveHostname?: NetworkResolver;
  readonly connectAddress?: (address: ResolvedNetworkAddress, port: number) => Socket;
};

export type LocalNetworkProxy = {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
};

const defaultTimeoutMs = 30_000;
const defaultMaxHeaderBytes = 32 * 1024;
const defaultMaxConnections = 64;
const defaultMaxRequestBodyBytes = 16 * 1024 * 1024;
const defaultMaxTransferredBytes = 1024 * 1024 * 1024;
const maxConnectAddresses = 16;

type HttpUpstream = {
  readonly request: ClientRequest;
  readonly detachDownstream: () => void;
  response: IncomingMessage | null;
  socket: Socket | null;
  settled: boolean;
};

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class ProxyRequestTooLarge extends Error {
  constructor() {
    super("proxy request body exceeded its limit");
    this.name = "ProxyRequestTooLarge";
  }
}

function positiveBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("network proxy limits must be positive integers");
  return Math.min(value, maximum);
}

function connectionNamedHeaders(headers: IncomingHttpHeaders): ReadonlySet<string> {
  const names = new Set<string>();
  const connection: unknown = headers["connection"];
  const values: readonly unknown[] = Array.isArray(connection)
    ? connection
    : connection === undefined
      ? []
      : [connection];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const name of value.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized !== "") names.add(normalized);
    }
  }
  return names;
}

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = connectionNamedHeaders(headers);
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (hopByHopHeaders.has(normalized) || named.has(normalized) || normalized === "host") continue;
    if (value !== undefined) forwarded[normalized] = value;
  }
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = connectionNamedHeaders(headers);
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (hopByHopHeaders.has(normalized) || named.has(normalized)) continue;
    if (value !== undefined) forwarded[normalized] = value;
  }
  return forwarded;
}

function proxyStatusFor(error: unknown): number {
  if (error instanceof ProxyRequestTooLarge) return 413;
  if (error instanceof FetchFailure && (error.code === "private-network" || error.code === "invalid-url")) return 403;
  if (error instanceof FetchFailure && error.code === "timeout") return 504;
  return 502;
}

function readRequestBody(incoming: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bytes = new BoundedByteBuffer(maxBytes);
    let settled = false;
    const cleanup = (): void => {
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
      incoming.off("aborted", onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (value: unknown): void => {
      const chunk = Buffer.isBuffer(value)
        ? value
        : typeof value === "string"
          ? Buffer.from(value)
          : value instanceof Uint8Array
            ? Buffer.from(value)
            : null;
      if (chunk === null) {
        fail(new Error("proxy request yielded a non-byte chunk"));
        return;
      }
      if (!bytes.append(chunk)) {
        fail(new ProxyRequestTooLarge());
        return;
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const body = bytes.toUint8Array();
      resolve(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new Error("proxy request was aborted"));
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
    incoming.once("aborted", onAborted);
  });
}

function finishSocket(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const reason = status === 403 ? "Forbidden" : status === 504 ? "Gateway Timeout" : "Bad Gateway";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function finishResponse(response: ServerResponse, status: number): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": "0",
  });
  response.end();
}

function connectAuthority(authority: string): URL {
  if (
    authority === ""
    || authority.length > 1_024
    || /[\s\\/?#@]/.test(authority)
  ) {
    throw new FetchFailure("invalid-url", "invalid CONNECT authority");
  }
  let target: URL;
  try {
    target = new URL(`https://${authority}/`);
  } catch (error) {
    throw new FetchFailure("invalid-url", "invalid CONNECT authority", { cause: error });
  }
  if (target.hostname === "" || target.username !== "" || target.password !== "") {
    throw new FetchFailure("invalid-url", "invalid CONNECT authority");
  }
  return target;
}

function targetPort(target: URL): number {
  const raw = target.port;
  const fallback = target.protocol === "https:" ? 443 : 80;
  const port = raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new FetchFailure("invalid-url", "destination port is invalid");
  }
  return port;
}

function trackSocket(socket: Duplex, sockets: Set<Duplex>, timeoutMs: number): void {
  sockets.add(socket);
  if (socket instanceof Socket) socket.setTimeout(timeoutMs, () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
}

async function connectPinned(
  addresses: readonly ResolvedNetworkAddress[],
  port: number,
  timeoutMs: number,
  sockets: Set<Duplex>,
  connectAddress: (address: ResolvedNetworkAddress, port: number) => Socket,
  isClosing: () => boolean,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (const address of addresses.slice(0, maxConnectAddresses)) {
    if (isClosing()) throw new FetchFailure("network", "proxy is closing");
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          reject(new FetchFailure("timeout", "proxy connection timed out"));
          return;
        }
        const candidate = connectAddress(address, port);
        trackSocket(candidate, sockets, timeoutMs);
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          candidate.destroy();
          reject(new FetchFailure("timeout", "proxy connection timed out"));
        }, remainingMs);
        candidate.once("connect", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(candidate);
        });
        candidate.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          candidate.destroy();
          reject(error);
        });
        candidate.once("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new FetchFailure("network", "proxy connection closed before it was established"));
        });
      });
      if (isClosing()) {
        socket.destroy();
        throw new FetchFailure("network", "proxy is closing");
      }
      return socket;
    } catch (error) {
      if (isClosing()) throw new FetchFailure("network", "proxy is closing", { cause: error });
      if (error instanceof FetchFailure && error.code === "timeout") throw error;
      lastError = error;
    }
  }
  if (Date.now() >= deadline) {
    throw new FetchFailure("timeout", "proxy connection timed out", { cause: lastError });
  }
  throw new FetchFailure("network", "could not connect to validated destination", { cause: lastError });
}

function parseAbsoluteHttpTarget(raw: string | undefined): URL {
  if (raw === undefined || raw.length > 16 * 1024) {
    throw new FetchFailure("invalid-url", "invalid proxy request target");
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch (error) {
    throw new FetchFailure("invalid-url", "proxy requests require an absolute HTTP URL", { cause: error });
  }
  if (target.protocol !== "http:" || target.hash !== "") {
    throw new FetchFailure("invalid-url", "absolute proxy requests must use HTTP");
  }
  return target;
}

/**
 * Start a loopback-only forward proxy that validates DNS and pins one approved address for every
 * HTTP request and TLS CONNECT tunnel. It is intended to be short-lived and owned by one capture.
 */
export async function startNetworkProxy(options: NetworkProxyOptions): Promise<LocalNetworkProxy> {
  const timeoutMs = positiveBoundedInteger(options.timeoutMs, defaultTimeoutMs, 10 * 60_000);
  const maxHeaderBytes = positiveBoundedInteger(options.maxHeaderBytes, defaultMaxHeaderBytes, 1024 * 1024);
  const maxConnections = positiveBoundedInteger(options.maxConnections, defaultMaxConnections, 1_024);
  const maxRequestBodyBytes = positiveBoundedInteger(
    options.maxRequestBodyBytes,
    defaultMaxRequestBodyBytes,
    1024 * 1024 * 1024,
  );
  const maxTransferredBytes = positiveBoundedInteger(
    options.maxTransferredBytes,
    defaultMaxTransferredBytes,
    Number.MAX_SAFE_INTEGER,
  );
  const sockets = new Set<Duplex>();
  const httpUpstreams = new Set<HttpUpstream>();
  let activeRequests = 0;
  let transferredBytes = 0;
  let closing = false;

  const reserveRequest = (): boolean => {
    if (closing || activeRequests >= maxConnections) return false;
    activeRequests += 1;
    return true;
  };
  const releaseRequest = (): void => {
    activeRequests = Math.max(0, activeRequests - 1);
  };
  const accountTransfer = (bytes: number): boolean => {
    transferredBytes += bytes;
    return transferredBytes <= maxTransferredBytes;
  };
  const forgetHttpUpstream = (upstream: HttpUpstream): void => {
    if (upstream.settled) return;
    upstream.settled = true;
    httpUpstreams.delete(upstream);
    upstream.detachDownstream();
  };
  const destroyHttpUpstream = (upstream: HttpUpstream): void => {
    if (upstream.settled) return;
    upstream.settled = true;
    httpUpstreams.delete(upstream);
    upstream.detachDownstream();
    upstream.response?.destroy();
    upstream.request.destroy();
    upstream.socket?.destroy();
  };
  const resolveTarget = (target: URL): Promise<readonly ResolvedNetworkAddress[]> =>
    resolveSafeNetworkTarget(target, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      timeoutMs,
      ...(options.resolveHostname === undefined ? {} : { resolveHostname: options.resolveHostname }),
    });
  const connectAddress = options.connectAddress
    ?? ((address: ResolvedNetworkAddress, port: number): Socket =>
      connectTcp({ host: address.address, port, family: address.family }));

  const server: HttpServer = createServer({
    maxHeaderSize: maxHeaderBytes,
    headersTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    keepAliveTimeout: Math.min(timeoutMs, 5_000),
  });
  server.maxConnections = maxConnections;

  server.on("request", (incoming, outgoing) => {
    if (!reserveRequest()) {
      finishResponse(outgoing, 503);
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseRequest();
    };
    let httpUpstream: HttpUpstream | null = null;
    let downstreamClosed = false;
    let detachDownstream = (): void => undefined;
    const closeHttpUpstream = (): void => {
      downstreamClosed = true;
      if (httpUpstream === null) {
        detachDownstream();
        return;
      }
      destroyHttpUpstream(httpUpstream);
    };
    const closeIncompleteIncoming = (): void => {
      if (incoming.aborted || !incoming.complete) closeHttpUpstream();
    };
    detachDownstream = (): void => {
      incoming.off("aborted", closeHttpUpstream);
      incoming.off("error", closeHttpUpstream);
      incoming.off("close", closeIncompleteIncoming);
      incoming.socket.off("error", closeHttpUpstream);
      incoming.socket.off("close", closeHttpUpstream);
      outgoing.off("error", closeHttpUpstream);
    };
    incoming.once("aborted", closeHttpUpstream);
    incoming.once("error", closeHttpUpstream);
    incoming.once("close", closeIncompleteIncoming);
    incoming.socket.once("error", closeHttpUpstream);
    incoming.socket.once("close", closeHttpUpstream);
    outgoing.once("error", closeHttpUpstream);
    outgoing.once("close", () => {
      release();
      closeHttpUpstream();
    });
    outgoing.once("finish", release);

    void (async () => {
      let target: URL;
      try {
        target = parseAbsoluteHttpTarget(incoming.url);
        const declared = incoming.headers["content-length"];
        if (typeof declared === "string") {
          const length = Number(declared);
          if (!Number.isSafeInteger(length) || length < 0 || length > maxRequestBodyBytes) {
            finishResponse(outgoing, 413);
            incoming.destroy();
            return;
          }
        }
        const bodyPromise = readRequestBody(incoming, maxRequestBodyBytes);
        const [addresses, body] = await Promise.all([resolveTarget(target), bodyPromise]);
        const address = addresses[0];
        if (address === undefined) throw new FetchFailure("dns", "destination had no validated address");
        if (downstreamClosed || incoming.aborted || outgoing.destroyed || closing) return;

        const hostname = target.hostname.startsWith("[") && target.hostname.endsWith("]")
          ? target.hostname.slice(1, -1)
          : target.hostname;
        const headers = forwardedHeaders(incoming.headers);
        headers.host = target.host;
        const requestOptions: RequestOptions = {
          protocol: "http:",
          hostname,
          port: targetPort(target),
          method: incoming.method ?? "GET",
          path: `${target.pathname}${target.search}`,
          headers,
          lookup: createPinnedLookup(address),
          family: address.family,
          agent: false,
          maxHeaderSize: maxHeaderBytes,
        };
        const upstream = requestHttp(requestOptions, (response: IncomingMessage) => {
          const tracked = httpUpstream;
          if (tracked === null || tracked.settled) {
            response.destroy();
            return;
          }
          tracked.response = response;
          response.once("close", () => forgetHttpUpstream(tracked));
          if (outgoing.destroyed || closing) {
            destroyHttpUpstream(tracked);
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response.headers));
          response.on("data", (chunk: unknown) => {
            const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : 0;
            if (!accountTransfer(size)) {
              response.destroy(new Error("proxy transfer limit exceeded"));
              outgoing.destroy();
            }
          });
          response.once("error", () => {
            destroyHttpUpstream(tracked);
            outgoing.destroy();
          });
          response.pipe(outgoing);
        });
        httpUpstream = {
          request: upstream,
          detachDownstream,
          response: null,
          socket: null,
          settled: false,
        };
        httpUpstreams.add(httpUpstream);
        const tracked = httpUpstream;
        upstream.once("socket", (socket: Socket) => {
          if (tracked.settled || closing) {
            socket.destroy();
            return;
          }
          tracked.socket = socket;
          trackSocket(socket, sockets, timeoutMs);
        });
        upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("proxy request timed out")));
        upstream.once("error", () => {
          destroyHttpUpstream(tracked);
          finishResponse(outgoing, 502);
        });
        upstream.once("close", () => {
          if (tracked.response === null) forgetHttpUpstream(tracked);
        });
        if (downstreamClosed || outgoing.destroyed || closing) {
          destroyHttpUpstream(tracked);
          return;
        }
        if (!accountTransfer(body.byteLength)) {
          upstream.destroy(new Error("proxy transfer limit exceeded"));
          finishResponse(outgoing, 413);
          return;
        }
        upstream.end(body);
      } catch (error) {
        finishResponse(outgoing, proxyStatusFor(error));
      }
    })();
  });

  server.on("connect", (request, client, head) => {
    if (!reserveRequest()) {
      finishSocket(client, 503);
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseRequest();
    };
    client.once("close", release);
    trackSocket(client, sockets, timeoutMs);

    void (async () => {
      try {
        const target = connectAuthority(request.url ?? "");
        const addresses = await resolveTarget(target);
        if (client.destroyed) return;
        const upstream = await connectPinned(
          addresses,
          targetPort(target),
          timeoutMs,
          sockets,
          connectAddress,
          () => closing,
        );
        if (client.destroyed || closing) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: hraness-oh\r\n\r\n");
        if (head.byteLength > 0) {
          if (!accountTransfer(head.byteLength)) {
            client.destroy();
            upstream.destroy();
            return;
          }
          upstream.write(head);
        }
        client.on("data", (chunk: Buffer) => {
          if (!accountTransfer(chunk.byteLength)) {
            client.destroy();
            upstream.destroy();
          }
        });
        upstream.on("data", (chunk: Buffer) => {
          if (!accountTransfer(chunk.byteLength)) {
            client.destroy();
            upstream.destroy();
          }
        });
        client.once("error", () => upstream.destroy());
        upstream.once("error", () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      } catch (error) {
        finishSocket(client, proxyStatusFor(error));
      }
    })();
  });

  server.on("upgrade", (_request, socket) => finishSocket(socket, 501));
  server.on("clientError", (_error, socket) => finishSocket(socket, 400));
  server.on("connection", (socket) => trackSocket(socket, sockets, timeoutMs));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("network proxy did not bind a TCP port");
  }

  let closePromise: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => {
      if (closePromise !== null) return closePromise;
      closing = true;
      for (const upstream of [...httpUpstreams]) destroyHttpUpstream(upstream);
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  };
}
