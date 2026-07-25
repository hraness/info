import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";

import {
  createPinnedLookup,
  createSafeFetch,
  decodeBytes,
  FetchFailure,
  isPrivateAddress,
  isPrivateHostname,
  requestPinnedNetworkAddress,
  type PinnedNetworkResponse,
  type SafeFetchOptions,
} from "./network.js";

const publicAddress = { address: "1.1.1.1", family: 4 } as const;

function fetchOptions(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    timeoutMs: 1_000,
    maxBytes: 1_024,
    allowPrivateNetwork: false,
    userAgent: "save-url-info-network-test",
    retries: 0,
    maxRedirects: 4,
    ...overrides,
  };
}

function networkResponse(
  status: number,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunks?: readonly Uint8Array[];
    readonly onCancel?: () => void;
  } = {},
): PinnedNetworkResponse {
  const chunks = options.chunks ?? [];
  return {
    status,
    headers: new Headers(options.headers),
    body: Readable.from(chunks),
    cancel: options.onCancel ?? (() => undefined),
  };
}

async function rejectedFetch(promise: Promise<unknown>): Promise<FetchFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchFailure) return error;
    throw error;
  }
  throw new Error("expected fetch to reject");
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected request to reject");
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createDeterministicSafeFetch(
  dependencies: NonNullable<Parameters<typeof createSafeFetch>[0]> = {},
): ReturnType<typeof createSafeFetch> {
  return createSafeFetch({
    getLocalNetworkAddresses: () => [],
    ...dependencies,
  });
}

describe("private-network boundary", () => {
  test.each([
    "0.0.0.0",
    "10.2.3.4",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("rejects %s", (address) => expect(isPrivateAddress(address)).toBeTrue());

  test.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.0",
    "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:808:808",
    "2001:4860:4860::8888",
  ])(
    "accepts public address %s",
    (address) => expect(isPrivateAddress(address)).toBeFalse(),
  );

  test.each(["localhost", "api.localhost", "printer.local", "service.internal", "192.168.0.2", "::1", "[::1]"])(
    "recognizes private hostname %s",
    (hostname) => expect(isPrivateHostname(hostname)).toBeTrue(),
  );

  test.each(["example.com", "public.example", "x.com"])("accepts public-looking hostname %s", (hostname) => {
    expect(isPrivateHostname(hostname)).toBeFalse();
  });
});

test("decodes common response charsets", () => {
  expect(decodeBytes(new TextEncoder().encode("hello"), "text/html; charset=utf-8")).toBe("hello");
  expect(decodeBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=iso-8859-1")).toBe("café");
});

describe("pinned network transport", () => {
  test("sends one explicit request to the pinned address without DNS lookup or redirect following", async () => {
    let requestCount = 0;
    let observed:
      | {
          readonly method: string | undefined;
          readonly path: string | undefined;
          readonly marker: string | readonly string[] | undefined;
          readonly body: string;
        }
      | undefined;
    const server = createHttpServer((request, response) => {
      requestCount += 1;
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      request.on("end", () => {
        observed = {
          method: request.method,
          path: request.url,
          marker: request.headers["x-network-test"],
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(307, {
          Location: "/must-not-be-followed",
          "X-Network-Response": "preserved",
        });
        response.end("redirect response");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      const response = await requestPinnedNetworkAddress({
        url: new URL(`http://does-not-resolve.invalid:${serverAddress.port}/mutate?view=one`),
        address: { address: "127.0.0.1", family: 4 },
        method: "POST",
        headers: new Headers({ "X-Network-Test": "fixed" }),
        body: new TextEncoder().encode('{"value":1}'),
        signal: new AbortController().signal,
      });
      const responseChunks: Uint8Array[] = [];
      for await (const chunk of response.body ?? []) {
        if (!(chunk instanceof Uint8Array)) throw new Error("fixture returned a non-byte chunk");
        responseChunks.push(chunk);
      }

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/must-not-be-followed");
      expect(response.headers.get("x-network-response")).toBe("preserved");
      expect(new TextDecoder().decode(Buffer.concat(responseChunks))).toBe("redirect response");
      expect(requestCount).toBe(1);
      expect(observed).toEqual({
        method: "POST",
        path: "/mutate?view=one",
        marker: "fixed",
        body: '{"value":1}',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects unsupported protocols and mismatched address families before opening a request", async () => {
    const request = {
      url: new URL("http://example.com/"),
      address: publicAddress,
      method: "GET",
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
    } as const;

    const protocolFailure = await rejectedError(requestPinnedNetworkAddress({
      ...request,
      url: new URL("ftp://example.com/file"),
    }));
    const familyFailure = await rejectedError(requestPinnedNetworkAddress({
      ...request,
      address: { address: "1.1.1.1", family: 6 },
    }));
    expect(protocolFailure.message).toContain("protocol");
    expect(familyFailure.message).toContain("family");
  });

  test("rejects a different IP-literal hostname before opening a socket", async () => {
    let requestCount = 0;
    let connectionCount = 0;
    const server = createHttpServer((_request, response) => {
      requestCount += 1;
      response.end("must not be reached");
    });
    server.on("connection", () => {
      connectionCount += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      const failure = await rejectedError(requestPinnedNetworkAddress({
        url: new URL(`http://127.0.0.1:${serverAddress.port}/must-not-connect`),
        address: { address: "203.0.113.50", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      }));

      expect(failure.message).toContain("does not match");
      expect(requestCount).toBe(0);
      expect(connectionCount).toBe(0);

      const crossFamilyFailure = await rejectedError(requestPinnedNetworkAddress({
        url: new URL("http://[::1]:1/must-not-connect"),
        address: { address: "0.0.0.1", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      }));
      expect(crossFamilyFailure.message).toBe(
        "IP-literal request hostname does not match the pinned address",
      );

      const scopedFailure = await rejectedError(requestPinnedNetworkAddress({
        url: new URL("http://[::1]:1/must-not-connect"),
        address: { address: "::1%definitely-not-an-interface", family: 6 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      }));
      expect(scopedFailure.message).toBe(
        "IP-literal request hostname does not match the pinned address",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects a globally routable literal assigned to a local interface", async () => {
    let transported = false;
    const fetch = createSafeFetch({
      getLocalNetworkAddresses: () => ["1.1.1.1"],
      resolveHostname: () => Promise.reject(new Error("literal targets must not resolve DNS")),
      transport: () => {
        transported = true;
        return Promise.resolve(networkResponse(200));
      },
    });

    const failure = await rejectedFetch(fetch(new URL("http://1.1.1.1/"), fetchOptions()));
    expect(failure.code).toBe("private-network");
    expect(transported).toBeFalse();
  });

  test.each([
    { answer: "1.1.1.1", family: 4 as const, local: "1.1.1.1" },
    {
      answer: "2606:4700:4700::1111",
      family: 6 as const,
      local: "2606:4700:4700:0:0:0:0:1111",
    },
    { answer: "::ffff:8.8.8.8", family: 6 as const, local: "8.8.8.8" },
  ])("rejects assigned local address $answer across equivalent IP syntax", async ({ answer, family, local }) => {
    let transported = false;
    const fetch = createSafeFetch({
      getLocalNetworkAddresses: () => [local],
      resolveHostname: () => Promise.resolve([{ address: answer, family }]),
      transport: () => {
        transported = true;
        return Promise.resolve(networkResponse(200));
      },
    });

    const failure = await rejectedFetch(fetch(new URL("http://assigned.example/"), fetchOptions()));
    expect(failure.code).toBe("private-network");
    expect(transported).toBeFalse();
  });

  test("fails closed when local interface enumeration fails", async () => {
    let resolved = false;
    const fetch = createSafeFetch({
      getLocalNetworkAddresses: () => {
        throw new Error("interface fixture failed");
      },
      resolveHostname: () => {
        resolved = true;
        return Promise.resolve([publicAddress]);
      },
      transport: () => Promise.resolve(networkResponse(200)),
    });

    const failure = await rejectedFetch(fetch(new URL("http://public.example/"), fetchOptions()));
    expect(failure.code).toBe("network");
    expect(resolved).toBeFalse();
  });

  test("snapshots the validated address instead of consulting or observing DNS again during connect", async () => {
    const mutableAnswer: { address: string; family: 4 } = { address: "1.1.1.1", family: 4 };
    const pinnedLookup = createPinnedLookup(mutableAnswer);
    mutableAnswer.address = "127.0.0.1";

    const result = await new Promise<{ readonly address: string; readonly family: number }>((resolve, reject) => {
      pinnedLookup("rebind.example", { all: false }, (error, address, family) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (Array.isArray(address) || family === undefined) {
          reject(new Error("expected one pinned DNS address"));
          return;
        }
        resolve({ address, family });
      });
    });

    expect(result).toEqual(publicAddress);
  });

  test("uses the validated public answer throughout retries even if a later resolution would rebind", async () => {
    let resolverCalls = 0;
    let transportCalls = 0;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => {
        resolverCalls += 1;
        return Promise.resolve(resolverCalls === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }]);
      },
      transport: (request) => {
        transportCalls += 1;
        expect(request.address).toEqual(publicAddress);
        return Promise.resolve(
          transportCalls === 1
            ? networkResponse(503)
            : networkResponse(200, { chunks: [new TextEncoder().encode("safe")] }),
        );
      },
    });

    const result = await fetch(new URL("http://rebind.example/post"), fetchOptions({ retries: 1 }));
    expect(new TextDecoder().decode(result.bytes)).toBe("safe");
    expect(resolverCalls).toBe(1);
    expect(transportCalls).toBe(2);
  });

  test("the Node transport connects through the supplied address without system DNS", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("pinned"),
    });
    let resolverCalls = 0;
    try {
      const fetch = createDeterministicSafeFetch({
        resolveHostname: () => {
          resolverCalls += 1;
          return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
        },
      });
      const result = await fetch(
        new URL(`http://never-resolves.invalid:${server.port}/`),
        fetchOptions({ allowPrivateNetwork: true }),
      );
      expect(new TextDecoder().decode(result.bytes)).toBe("pinned");
      expect(resolverCalls).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a DNS set containing any private answer before transport", async () => {
    let transported = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress, { address: "169.254.169.254", family: 4 }]),
      transport: () => {
        transported = true;
        return Promise.resolve(networkResponse(200));
      },
    });

    const failure = await rejectedFetch(fetch(new URL("http://mixed.example/"), fetchOptions()));
    expect(failure).toBeInstanceOf(FetchFailure);
    expect(failure.code).toBe("private-network");
    expect(transported).toBeFalse();
  });

  test("resolves and validates every redirect target before following it", async () => {
    const resolved: string[] = [];
    let transportCalls = 0;
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: (hostname) => {
        resolved.push(hostname);
        return Promise.resolve(
          hostname === "start.example"
            ? [publicAddress]
            : [publicAddress, { address: "127.0.0.1", family: 4 }],
        );
      },
      transport: () => {
        transportCalls += 1;
        return Promise.resolve(
          networkResponse(302, {
            headers: { Location: "http://redirect.example/private" },
            onCancel: () => {
              cancelled = true;
            },
          }),
        );
      },
    });

    const failure = await rejectedFetch(fetch(new URL("http://start.example/"), fetchOptions()));
    expect(failure.code).toBe("private-network");
    expect(resolved).toEqual(["start.example", "redirect.example"]);
    expect(transportCalls).toBe(1);
    expect(cancelled).toBeTrue();
  });

  test("never forwards a flattened Cookie header across even same-origin redirects", async () => {
    const observed: Array<{ readonly url: string; readonly cookie: string | null }> = [];
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: (request) => {
        observed.push({ url: request.url.href, cookie: request.headers.get("cookie") });
        return Promise.resolve(observed.length === 1
          ? networkResponse(302, { headers: { Location: "/other" } })
          : networkResponse(200, { chunks: [new TextEncoder().encode("ok")] }));
      },
    });

    await fetch(new URL("https://example.com/account"), fetchOptions({ cookieHeader: "session=private" }));
    expect(observed).toEqual([
      { url: "https://example.com/account", cookie: "session=private" },
      { url: "https://example.com/other", cookie: null },
    ]);
  });
});

describe("bounded requests", () => {
  test("rejects a body that crosses the byte limit and cancels it", async () => {
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => Promise.resolve(
        networkResponse(200, {
          chunks: [new TextEncoder().encode("123"), new TextEncoder().encode("456")],
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    });

    const failure = await rejectedFetch(fetch(new URL("http://large.example/"), fetchOptions({ maxBytes: 5 })));
    expect(failure.code).toBe("too-large");
    expect(cancelled).toBeTrue();
  });

  test("rejects an oversized declared content length before reading", async () => {
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => Promise.resolve(
        networkResponse(200, {
          headers: { "Content-Length": "200" },
          chunks: [new TextEncoder().encode("small")],
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    });

    const failure = await rejectedFetch(
      fetch(new URL("http://declared-large.example/"), fetchOptions({ maxBytes: 10 })),
    );
    expect(failure.code).toBe("too-large");
    expect(cancelled).toBeTrue();
  });

  test("collects one million tiny chunks without retaining the chunk objects", async () => {
    const chunkCount = 1_000_000;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: (async function* tinyChunks(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          for (let index = 0; index < chunkCount; index += 1) {
            yield new Uint8Array([index & 0xff]);
          }
        })(),
        cancel: () => undefined,
      }),
    });

    const result = await fetch(
      new URL("http://tiny-chunks.example/"),
      fetchOptions({ maxBytes: chunkCount, timeoutMs: 5_000 }),
    );
    expect(result.bytes).toHaveLength(chunkCount);
    expect(result.bytes[0]).toBe(0);
    expect(result.bytes[chunkCount - 1]).toBe(63);
  }, 10_000);

  test("aborts a connection at the overall deadline", async () => {
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: (request) => new Promise((_resolve, reject) => {
        const rejectOnAbort = (): void => {
          const reason: unknown = request.signal.reason;
          reject(reason instanceof Error ? reason : new Error("request aborted"));
        };
        if (request.signal.aborted) rejectOnAbort();
        else request.signal.addEventListener("abort", rejectOnAbort, { once: true });
      }),
    });

    const failure = await rejectedFetch(fetch(new URL("http://slow.example/"), fetchOptions({ timeoutMs: 20 })));
    expect(failure.code).toBe("timeout");
  });

  test("the production transport closes its accepted socket when the request deadline wins", async () => {
    const sockets = new Set<Socket>();
    let accepted: (() => void) | null = null;
    let upstreamClosed: (() => void) | null = null;
    const acceptedPromise = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const upstreamClosedPromise = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const server = createHttpServer((request) => {
      accepted?.();
      request.socket.once("close", () => upstreamClosed?.());
      // Intentionally leave the response pending beyond the client deadline.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("fixture did not bind TCP");
      const fetch = createSafeFetch({
        getLocalNetworkAddresses: () => [],
        resolveHostname: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      });
      const requestFailure = rejectedFetch(
        fetch(
          new URL(`http://deadline.invalid:${address.port}/`),
          fetchOptions({ allowPrivateNetwork: true, timeoutMs: 100 }),
        ),
      );
      await within(acceptedPromise, "the production transport fixture to accept a request");
      const failure = await requestFailure;
      expect(failure.code).toBe("timeout");
      await within(upstreamClosedPromise, "the aborted transport socket to close");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
