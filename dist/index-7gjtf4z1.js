// @bun
import {
  FetchFailure,
  createPinnedLookup,
  resolveSafeNetworkTarget
} from "./index-b0b0vy11.js";
import {
  BoundedByteBuffer
} from "./index-gh719d91.js";

// src/clip/network-proxy.ts
import {
  createServer,
  request as requestHttp
} from "http";
import { connect as connectTcp, Socket } from "net";
var defaultTimeoutMs = 30000;
var defaultMaxHeaderBytes = 32 * 1024;
var defaultMaxConnections = 64;
var defaultMaxRequestBodyBytes = 16 * 1024 * 1024;
var defaultMaxTransferredBytes = 1024 * 1024 * 1024;
var maxConnectAddresses = 16;
var hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

class ProxyRequestTooLarge extends Error {
  constructor() {
    super("proxy request body exceeded its limit");
    this.name = "ProxyRequestTooLarge";
  }
}
function positiveBoundedInteger(value, fallback, maximum) {
  if (value === undefined)
    return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("network proxy limits must be positive integers");
  return Math.min(value, maximum);
}
function connectionNamedHeaders(headers) {
  const names = new Set;
  const connection = headers["connection"];
  const values = Array.isArray(connection) ? connection : connection === undefined ? [] : [connection];
  for (const value of values) {
    if (typeof value !== "string")
      continue;
    for (const name of value.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized !== "")
        names.add(normalized);
    }
  }
  return names;
}
function forwardedHeaders(headers) {
  const named = connectionNamedHeaders(headers);
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (hopByHopHeaders.has(normalized) || named.has(normalized) || normalized === "host")
      continue;
    if (value !== undefined)
      forwarded[normalized] = value;
  }
  return forwarded;
}
function responseHeaders(headers) {
  const named = connectionNamedHeaders(headers);
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (hopByHopHeaders.has(normalized) || named.has(normalized))
      continue;
    if (value !== undefined)
      forwarded[normalized] = value;
  }
  return forwarded;
}
function proxyStatusFor(error) {
  if (error instanceof ProxyRequestTooLarge)
    return 413;
  if (error instanceof FetchFailure && (error.code === "private-network" || error.code === "invalid-url"))
    return 403;
  if (error instanceof FetchFailure && error.code === "timeout")
    return 504;
  return 502;
}
function readRequestBody(incoming, maxBytes) {
  return new Promise((resolve, reject) => {
    const bytes = new BoundedByteBuffer(maxBytes);
    let settled = false;
    const cleanup = () => {
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
      incoming.off("aborted", onAborted);
    };
    const fail = (error) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (value) => {
      const chunk = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
      if (chunk === null) {
        fail(new Error("proxy request yielded a non-byte chunk"));
        return;
      }
      if (!bytes.append(chunk)) {
        fail(new ProxyRequestTooLarge);
        return;
      }
    };
    const onEnd = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      const body = bytes.toUint8Array();
      resolve(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new Error("proxy request was aborted"));
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
    incoming.once("aborted", onAborted);
  });
}
function finishSocket(socket, status) {
  if (socket.destroyed)
    return;
  const reason = status === 403 ? "Forbidden" : status === 504 ? "Gateway Timeout" : "Bad Gateway";
  socket.end(`HTTP/1.1 ${status} ${reason}\r
Connection: close\r
Content-Length: 0\r
\r
`);
}
function finishResponse(response, status) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": "0"
  });
  response.end();
}
function connectAuthority(authority) {
  if (authority === "" || authority.length > 1024 || /[\s\\/?#@]/.test(authority)) {
    throw new FetchFailure("invalid-url", "invalid CONNECT authority");
  }
  let target;
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
function targetPort(target) {
  const raw = target.port;
  const fallback = target.protocol === "https:" ? 443 : 80;
  const port = raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new FetchFailure("invalid-url", "destination port is invalid");
  }
  return port;
}
function trackSocket(socket, sockets, timeoutMs) {
  sockets.add(socket);
  if (socket instanceof Socket)
    socket.setTimeout(timeoutMs, () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
}
async function connectPinned(addresses, port, timeoutMs, sockets, connectAddress, isClosing) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (const address of addresses.slice(0, maxConnectAddresses)) {
    if (isClosing())
      throw new FetchFailure("network", "proxy is closing");
    try {
      const socket = await new Promise((resolve, reject) => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          reject(new FetchFailure("timeout", "proxy connection timed out"));
          return;
        }
        const candidate = connectAddress(address, port);
        trackSocket(candidate, sockets, timeoutMs);
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled)
            return;
          settled = true;
          candidate.destroy();
          reject(new FetchFailure("timeout", "proxy connection timed out"));
        }, remainingMs);
        candidate.once("connect", () => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timeout);
          resolve(candidate);
        });
        candidate.once("error", (error) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timeout);
          candidate.destroy();
          reject(error);
        });
        candidate.once("close", () => {
          if (settled)
            return;
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
      if (isClosing())
        throw new FetchFailure("network", "proxy is closing", { cause: error });
      if (error instanceof FetchFailure && error.code === "timeout")
        throw error;
      lastError = error;
    }
  }
  if (Date.now() >= deadline) {
    throw new FetchFailure("timeout", "proxy connection timed out", { cause: lastError });
  }
  throw new FetchFailure("network", "could not connect to validated destination", { cause: lastError });
}
function parseAbsoluteHttpTarget(raw) {
  if (raw === undefined || raw.length > 16 * 1024) {
    throw new FetchFailure("invalid-url", "invalid proxy request target");
  }
  let target;
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
async function startNetworkProxy(options) {
  const timeoutMs = positiveBoundedInteger(options.timeoutMs, defaultTimeoutMs, 10 * 60000);
  const maxHeaderBytes = positiveBoundedInteger(options.maxHeaderBytes, defaultMaxHeaderBytes, 1024 * 1024);
  const maxConnections = positiveBoundedInteger(options.maxConnections, defaultMaxConnections, 1024);
  const maxRequestBodyBytes = positiveBoundedInteger(options.maxRequestBodyBytes, defaultMaxRequestBodyBytes, 1024 * 1024 * 1024);
  const maxTransferredBytes = positiveBoundedInteger(options.maxTransferredBytes, defaultMaxTransferredBytes, Number.MAX_SAFE_INTEGER);
  const sockets = new Set;
  const httpUpstreams = new Set;
  let activeRequests = 0;
  let transferredBytes = 0;
  let closing = false;
  const reserveRequest = () => {
    if (closing || activeRequests >= maxConnections)
      return false;
    activeRequests += 1;
    return true;
  };
  const releaseRequest = () => {
    activeRequests = Math.max(0, activeRequests - 1);
  };
  const accountTransfer = (bytes) => {
    transferredBytes += bytes;
    return transferredBytes <= maxTransferredBytes;
  };
  const forgetHttpUpstream = (upstream) => {
    if (upstream.settled)
      return;
    upstream.settled = true;
    httpUpstreams.delete(upstream);
    upstream.detachDownstream();
  };
  const destroyHttpUpstream = (upstream) => {
    if (upstream.settled)
      return;
    upstream.settled = true;
    httpUpstreams.delete(upstream);
    upstream.detachDownstream();
    upstream.response?.destroy();
    upstream.request.destroy();
    upstream.socket?.destroy();
  };
  const resolveTarget = (target) => resolveSafeNetworkTarget(target, {
    allowPrivateNetwork: options.allowPrivateNetwork,
    timeoutMs,
    ...options.resolveHostname === undefined ? {} : { resolveHostname: options.resolveHostname }
  });
  const connectAddress = options.connectAddress ?? ((address2, port) => connectTcp({ host: address2.address, port, family: address2.family }));
  const server = createServer({
    maxHeaderSize: maxHeaderBytes,
    headersTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    keepAliveTimeout: Math.min(timeoutMs, 5000)
  });
  server.maxConnections = maxConnections;
  server.on("request", (incoming, outgoing) => {
    if (!reserveRequest()) {
      finishResponse(outgoing, 503);
      return;
    }
    let released = false;
    const release = () => {
      if (released)
        return;
      released = true;
      releaseRequest();
    };
    let httpUpstream = null;
    let downstreamClosed = false;
    let detachDownstream = () => {
      return;
    };
    const closeHttpUpstream = () => {
      downstreamClosed = true;
      if (httpUpstream === null) {
        detachDownstream();
        return;
      }
      destroyHttpUpstream(httpUpstream);
    };
    const closeIncompleteIncoming = () => {
      if (incoming.aborted || !incoming.complete)
        closeHttpUpstream();
    };
    detachDownstream = () => {
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
    (async () => {
      let target;
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
        const address2 = addresses[0];
        if (address2 === undefined)
          throw new FetchFailure("dns", "destination had no validated address");
        if (downstreamClosed || incoming.aborted || outgoing.destroyed || closing)
          return;
        const hostname = target.hostname.startsWith("[") && target.hostname.endsWith("]") ? target.hostname.slice(1, -1) : target.hostname;
        const headers = forwardedHeaders(incoming.headers);
        headers.host = target.host;
        const requestOptions = {
          protocol: "http:",
          hostname,
          port: targetPort(target),
          method: incoming.method ?? "GET",
          path: `${target.pathname}${target.search}`,
          headers,
          lookup: createPinnedLookup(address2),
          family: address2.family,
          agent: false,
          maxHeaderSize: maxHeaderBytes
        };
        const upstream = requestHttp(requestOptions, (response) => {
          const tracked2 = httpUpstream;
          if (tracked2 === null || tracked2.settled) {
            response.destroy();
            return;
          }
          tracked2.response = response;
          response.once("close", () => forgetHttpUpstream(tracked2));
          if (outgoing.destroyed || closing) {
            destroyHttpUpstream(tracked2);
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders(response.headers));
          response.on("data", (chunk) => {
            const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : 0;
            if (!accountTransfer(size)) {
              response.destroy(new Error("proxy transfer limit exceeded"));
              outgoing.destroy();
            }
          });
          response.once("error", () => {
            destroyHttpUpstream(tracked2);
            outgoing.destroy();
          });
          response.pipe(outgoing);
        });
        httpUpstream = {
          request: upstream,
          detachDownstream,
          response: null,
          socket: null,
          settled: false
        };
        httpUpstreams.add(httpUpstream);
        const tracked = httpUpstream;
        upstream.once("socket", (socket) => {
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
          if (tracked.response === null)
            forgetHttpUpstream(tracked);
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
    const release = () => {
      if (released)
        return;
      released = true;
      releaseRequest();
    };
    client.once("close", release);
    trackSocket(client, sockets, timeoutMs);
    (async () => {
      try {
        const target = connectAuthority(request.url ?? "");
        const addresses = await resolveTarget(target);
        if (client.destroyed)
          return;
        const upstream = await connectPinned(addresses, targetPort(target), timeoutMs, sockets, connectAddress, () => closing);
        if (client.destroyed || closing) {
          upstream.destroy();
          return;
        }
        client.write(`HTTP/1.1 200 Connection Established\r
Proxy-Agent: hraness-kb\r
\r
`);
        if (head.byteLength > 0) {
          if (!accountTransfer(head.byteLength)) {
            client.destroy();
            upstream.destroy();
            return;
          }
          upstream.write(head);
        }
        client.on("data", (chunk) => {
          if (!accountTransfer(chunk.byteLength)) {
            client.destroy();
            upstream.destroy();
          }
        });
        upstream.on("data", (chunk) => {
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
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
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
  let closePromise = null;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => {
      if (closePromise !== null)
        return closePromise;
      closing = true;
      for (const upstream of [...httpUpstreams])
        destroyHttpUpstream(upstream);
      for (const socket of sockets)
        socket.destroy();
      closePromise = new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      });
      return closePromise;
    }
  };
}

export { startNetworkProxy };
