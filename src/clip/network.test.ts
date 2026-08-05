import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  createPinnedNetworkConnectionPool,
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

function generateTlsFixture(root: string): {
  readonly certificateAuthority: string;
  readonly certificate: string;
  readonly key: string;
} {
  const openssl = Bun.which("openssl");
  if (openssl === null) {
    throw new Error("the real TLS integration fixture requires OpenSSL");
  }
  const configurationPath = join(root, "openssl.cnf");
  const authorityCertificatePath = join(root, "authority.pem");
  const authorityKeyPath = join(root, "authority-key.pem");
  const certificatePath = join(root, "certificate.pem");
  const keyPath = join(root, "key.pem");
  const requestPath = join(root, "certificate-request.pem");
  writeFileSync(configurationPath, `[req]
distinguished_name = ignored

[ignored]

[authority]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @names

[names]
DNS.1 = pinned.test
DNS.2 = alias.pinned.test
`, { mode: 0o600 });
  const runOpenSsl = (arguments_: readonly string[]): void => {
    const generated = Bun.spawnSync([openssl, ...arguments_], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (generated.exitCode !== 0) {
      throw new Error(
        `OpenSSL could not generate the TLS fixture: ${new TextDecoder().decode(generated.stderr).trim()}`,
      );
    }
  };
  runOpenSsl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-days", "2", "-subj", "/CN=Wrench Test Root CA",
    "-keyout", authorityKeyPath, "-out", authorityCertificatePath,
    "-config", configurationPath, "-extensions", "authority",
  ]);
  runOpenSsl([
    "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-subj", "/CN=pinned.test", "-keyout", keyPath, "-out", requestPath,
  ]);
  runOpenSsl([
    "x509", "-req", "-in", requestPath,
    "-CA", authorityCertificatePath, "-CAkey", authorityKeyPath,
    "-CAcreateserial", "-days", "2", "-sha256",
    "-extfile", configurationPath, "-extensions", "server",
    "-out", certificatePath,
  ]);
  chmodSync(authorityKeyPath, 0o600);
  chmodSync(authorityCertificatePath, 0o600);
  chmodSync(keyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  return {
    certificateAuthority: readFileSync(authorityCertificatePath, "utf8"),
    certificate: readFileSync(certificatePath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
  };
}

function fetchOptions(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    timeoutMs: 1_000,
    maxBytes: 1_024,
    allowPrivateNetwork: false,
    userAgent: "save-url-kb-network-test",
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

async function readNetworkResponse(response: PinnedNetworkResponse): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body ?? []) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("fixture returned a non-byte chunk");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  test("reuses isolated Node agents and safely disables pooling under Bun", async () => {
    const requestTotal = 16;
    let connectionCount = 0;
    const observedAuthorization: Array<string | undefined> = [];
    const sockets = new Set<Socket>();
    const server = createHttpServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      response.end(request.url);
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const pool = createPinnedNetworkConnectionPool();
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      for (let index = 0; index < requestTotal; index += 1) {
        const result = await pool.request({
          url: new URL(`http://portable.invalid:${serverAddress.port}/request/${index}`),
          address: { address: "127.0.0.1", family: 4 },
          method: "GET",
          headers: new Headers({ authorization: `Bearer request-${index}` }),
          body: null,
          signal: new AbortController().signal,
        });
        expect(await readNetworkResponse(result)).toBe(`/request/${index}`);
      }

      expect(connectionCount).toBe(
        process.versions.bun === undefined ? 1 : requestTotal,
      );
      expect(observedAuthorization).toEqual(
        Array.from({ length: requestTotal }, (_value, index) => `Bearer request-${index}`),
      );
    } finally {
      pool.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("isolates pooled sockets and authentication by exact origin", async () => {
    let connectionCount = 0;
    const observed: Array<{
      readonly authorization: string | undefined;
      readonly host: string | undefined;
    }> = [];
    const sockets = new Set<Socket>();
    const server = createHttpServer((request, response) => {
      observed.push({
        authorization: request.headers.authorization,
        host: request.headers.host,
      });
      response.end("ok");
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const pool = createPinnedNetworkConnectionPool();
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      const originOne = `http://one.invalid:${serverAddress.port}`;
      const originTwo = `http://two.invalid:${serverAddress.port}`;
      const send = async (url: string, authorization?: string): Promise<void> => {
        const result = await pool.request({
          url: new URL(url),
          address: { address: "127.0.0.1", family: 4 },
          method: "GET",
          headers: new Headers(
            authorization === undefined ? {} : { authorization },
          ),
          body: null,
          signal: new AbortController().signal,
        });
        expect(await readNetworkResponse(result)).toBe("ok");
      };

      await send(`${originOne}/first`, "Bearer origin-one");
      await send(`${originTwo}/second`);
      await send(`${originOne}/third`, "Bearer origin-one-updated");

      expect(connectionCount).toBe(
        process.versions.bun === undefined ? 2 : 3,
      );
      expect(observed).toEqual([
        {
          authorization: "Bearer origin-one",
          host: `one.invalid:${serverAddress.port}`,
        },
        {
          authorization: undefined,
          host: `two.invalid:${serverAddress.port}`,
        },
        {
          authorization: "Bearer origin-one-updated",
          host: `one.invalid:${serverAddress.port}`,
        },
      ]);
    } finally {
      pool.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("closing a pool destroys its idle socket and rejects later requests", async () => {
    const sockets = new Set<Socket>();
    let closedSocket: (() => void) | undefined;
    const closedSocketPromise = new Promise<void>((resolve) => {
      closedSocket = resolve;
    });
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      let requestBytes = "";
      let responded = false;
      socket.on("data", (chunk: Uint8Array) => {
        requestBytes += Buffer.from(chunk).toString("latin1");
        if (!responded && requestBytes.includes("\r\n\r\n")) {
          responded = true;
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
          );
        }
      });
      socket.once("close", () => {
        sockets.delete(socket);
        closedSocket?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const pool = createPinnedNetworkConnectionPool();
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      const request = {
        url: new URL(`http://portable.invalid:${serverAddress.port}/`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      } as const;
      expect(await readNetworkResponse(await pool.request(request))).toBe("ok");

      pool.close();
      pool.close();
      await within(closedSocketPromise, "the pooled idle socket to close");
      const failure = await rejectedError(pool.request(request));
      expect(failure.message).toContain("pool is closed");
    } finally {
      pool.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("an aborted pooled request closes its socket before a later request connects", async () => {
    let connectionCount = 0;
    const sockets = new Set<Socket>();
    let acceptedSlowRequest: (() => void) | undefined;
    let closedSlowSocket: (() => void) | undefined;
    const acceptedSlowRequestPromise = new Promise<void>((resolve) => {
      acceptedSlowRequest = resolve;
    });
    const closedSlowSocketPromise = new Promise<void>((resolve) => {
      closedSlowSocket = resolve;
    });
    const server = createHttpServer((request, response) => {
      if (request.url === "/slow") {
        acceptedSlowRequest?.();
        request.socket.once("close", () => closedSlowSocket?.());
        return;
      }
      response.end("recovered");
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const pool = createPinnedNetworkConnectionPool();
    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === "string") {
        throw new Error("fixture did not bind TCP");
      }
      const origin = `http://portable.invalid:${serverAddress.port}`;
      const controller = new AbortController();
      const pending = pool.request({
        url: new URL(`${origin}/slow`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: controller.signal,
      });
      await within(acceptedSlowRequestPromise, "the pooled slow request");
      controller.abort(new Error("fixture abort"));
      await rejectedError(pending);
      await within(closedSlowSocketPromise, "the aborted pooled socket to close");

      const recovered = await pool.request({
        url: new URL(`${origin}/after-abort`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      });
      expect(await readNetworkResponse(recovered)).toBe("recovered");
      expect(connectionCount).toBe(2);
    } finally {
      pool.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("verifies TLS SNI and certificates while pooling by exact origin and pinned IP", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "wrench-real-tls-"));
    chmodSync(fixtureRoot, 0o700);
    const eventsPath = join(fixtureRoot, "events.jsonl");
    const nodeExecutable = Bun.which("node");
    if (nodeExecutable === null) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      throw new Error("the real TLS integration fixture requires Node");
    }
    const tls = generateTlsFixture(fixtureRoot);
    const serverScript = `
const { appendFileSync } = require("node:fs");
const { createServer } = require("node:https");
const { createSecureContext } = require("node:tls");
const eventsPath = process.env.KB_TLS_FIXTURE_EVENTS;
const key = Buffer.from(process.env.KB_TLS_FIXTURE_KEY, "base64");
const cert = Buffer.from(process.env.KB_TLS_FIXTURE_CERT, "base64");
const context = createSecureContext({ key, cert });
const rawSockets = new Map();
const secureSocketIds = new WeakMap();
let nextSocketId = 1;
const emit = (event) => appendFileSync(
  eventsPath,
  JSON.stringify(event) + "\\n",
  { mode: 0o600 },
);
const socketId = (socket) => {
  const existing = secureSocketIds.get(socket);
  if (existing !== undefined) return existing;
  const created = nextSocketId++;
  secureSocketIds.set(socket, created);
  return created;
};
const server = createServer({
  key,
  cert,
  SNICallback(servername, callback) {
    emit({ type: "sni", servername });
    callback(null, context);
  },
}, (request, response) => {
  const id = socketId(request.socket);
  emit({
    type: "request",
    id,
    servername: request.socket.servername ?? null,
    host: request.headers.host ?? null,
    path: request.url ?? null,
  });
  if (request.url === "/active") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("still-active");
    emit({ type: "active", id });
    return;
  }
  response.end((request.headers.host ?? "") + (request.url ?? ""));
});
server.on("connection", (socket) => {
  const id = socketId(socket);
  rawSockets.set(id, socket);
  emit({ type: "raw-open", id });
  socket.once("close", () => {
    rawSockets.delete(id);
    emit({ type: "raw-close", id });
  });
});
server.on("tlsClientError", (error, socket) => {
  emit({
    type: "tls-error",
    code: typeof error.code === "string" ? error.code : null,
    servername: socket.servername ?? null,
  });
});
server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  emit({ type: "listening", port: address.port });
});
const close = () => {
  for (const socket of rawSockets.values()) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1000).unref();
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
`;
    const server = Bun.spawn([nodeExecutable, "-e", serverScript], {
      env: {
        ...process.env,
        KB_TLS_FIXTURE_EVENTS: eventsPath,
        KB_TLS_FIXTURE_KEY: Buffer.from(tls.key).toString("base64"),
        KB_TLS_FIXTURE_CERT:
          Buffer.from(tls.certificate).toString("base64"),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let observedServerExit: number | null = null;
    let fixtureStarted = false;
    let poolForCleanup:
      | ReturnType<typeof createPinnedNetworkConnectionPool>
      | undefined;
    let untrustedPoolForCleanup:
      | ReturnType<typeof createPinnedNetworkConnectionPool>
      | undefined;
    try {
      void server.exited.then((exitCode) => {
        observedServerExit = exitCode;
      });
    type TlsFixtureEvent = Readonly<Record<string, unknown>> & {
      readonly type: string;
    };
    const events = (): readonly TlsFixtureEvent[] => {
      if (!existsSync(eventsPath)) return [];
      return readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as TlsFixtureEvent);
    };
    const waitForEvents = async (
      predicate: (values: readonly TlsFixtureEvent[]) => boolean,
      label: string,
    ): Promise<readonly TlsFixtureEvent[]> => await within(
      (async () => {
        for (;;) {
          const values = events();
          if (predicate(values)) return values;
          await Bun.sleep(10);
        }
      })(),
      label,
      3_000,
    );
    const listeningEvents = await waitForEvents(
      (values) => values.some((event) => event.type === "listening"),
      "the real TLS fixture to listen",
    );
    const port = listeningEvents.find(
      (event) => event.type === "listening",
    )?.port;
    if (typeof port !== "number") {
      throw new Error("real TLS fixture omitted its bound port");
    }
    fixtureStarted = true;
    const pool = createPinnedNetworkConnectionPool({
      certificateAuthorities: tls.certificateAuthority,
    });
    poolForCleanup = pool;
    const untrustedPool = createPinnedNetworkConnectionPool();
    untrustedPoolForCleanup = untrustedPool;
      const request = async (
        hostname: string,
        address: "127.0.0.1" | "::ffff:127.0.0.1",
        path: string,
      ): Promise<PinnedNetworkResponse> =>
        await pool.request({
          url: new URL(`https://${hostname}:${port}${path}`),
          address: {
            address,
            family: address.includes(":") ? 6 : 4,
          },
          method: "GET",
          headers: new Headers(),
          body: null,
          signal: new AbortController().signal,
        });

      expect(
        await readNetworkResponse(
          await request("pinned.test", "127.0.0.1", "/first"),
        ),
      ).toBe(`pinned.test:${port}/first`);
      expect(
        await readNetworkResponse(
          await request("pinned.test", "127.0.0.1", "/second"),
        ),
      ).toBe(`pinned.test:${port}/second`);
      expect(
        await readNetworkResponse(
          await request("alias.pinned.test", "127.0.0.1", "/alias"),
        ),
      ).toBe(`alias.pinned.test:${port}/alias`);
      expect(
        await readNetworkResponse(
          await request(
            "pinned.test",
            "::ffff:127.0.0.1",
            "/second-ip",
          ),
        ),
      ).toBe(`pinned.test:${port}/second-ip`);
      expect(
        await readNetworkResponse(
          await request("pinned.test", "127.0.0.1", "/reused"),
        ),
      ).toBe(`pinned.test:${port}/reused`);

      const successfulEvents = events();
      const requestEvents = successfulEvents.filter(
        (event) => event.type === "request",
      );
      expect(new Set(requestEvents.map((event) => event.id)).size).toBe(
        process.versions.bun === undefined ? 3 : 5,
      );
      expect(successfulEvents.filter(
        (event) => event.type === "sni",
      ).slice(0, 3).map((event) => event.servername)).toEqual([
        "pinned.test",
        ...(process.versions.bun === undefined
          ? ["alias.pinned.test", "pinned.test"]
          : ["pinned.test", "alias.pinned.test"]),
      ]);

      const requestsBeforeWrongHostname = requestEvents.length;
      const wrongHostname = await rejectedError(
        request("wrong.test", "127.0.0.1", "/must-not-run"),
      );
      expect((wrongHostname as NodeJS.ErrnoException).code)
        .toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      const afterWrongHostname = await waitForEvents(
        (values) => values.some(
          (event) =>
            event.type === "sni" && event.servername === "wrong.test",
        ),
        "the rejected hostname SNI",
      );
      expect(afterWrongHostname.filter(
        (event) => event.type === "request",
      )).toHaveLength(requestsBeforeWrongHostname);

      const beforeUntrusted = events();
      const sniBeforeUntrusted = beforeUntrusted.filter(
        (event) => event.type === "sni",
      ).length;
      const requestsBeforeUntrusted = beforeUntrusted.filter(
        (event) => event.type === "request",
      ).length;
      const untrusted = await rejectedError(untrustedPool.request({
        url: new URL(
          `https://pinned.test:${port}/must-not-run`,
        ),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      }));
      expect(untrusted).toBeInstanceOf(Error);
      const afterUntrusted = await waitForEvents(
        (values) =>
          values.filter((event) => event.type === "sni").length
          > sniBeforeUntrusted,
        "the untrusted TLS handshake",
      );
      expect(afterUntrusted.filter(
        (event) => event.type === "request",
      )).toHaveLength(requestsBeforeUntrusted);
      untrustedPool.close();

      let active: PinnedNetworkResponse;
      try {
        active = await request(
          "pinned.test",
          "127.0.0.1",
          "/active",
        );
      } catch (error) {
        throw new Error(
          `active TLS request failed with fixture exit ${observedServerExit}; target ${port}; events ${JSON.stringify(events())}`,
          { cause: error },
        );
      }
      const activeEvents = await waitForEvents(
        (values) => values.some((event) => event.type === "active"),
        "the active verified TLS response",
      );
      const opened = new Set(
        activeEvents
          .filter((event) => event.type === "raw-open")
          .map((event) => event.id),
      );
      expect(opened.size).toBeGreaterThanOrEqual(3);

      pool.close();
      const closedEvents = await waitForEvents(
        (values) => {
          const closed = new Set(
            values
              .filter((event) => event.type === "raw-close")
              .map((event) => event.id),
          );
          return [...opened].every((id) => closed.has(id));
        },
        "all active and idle verified TLS sockets to close",
      );
      active.cancel();
      const closed = new Set(
        closedEvents
          .filter((event) => event.type === "raw-close")
          .map((event) => event.id),
      );
      expect([...opened].every((id) => closed.has(id))).toBeTrue();
    } finally {
      poolForCleanup?.close();
      untrustedPoolForCleanup?.close();
      let exitCode: number | undefined;
      let stderr = "";
      let shutdownFailure: unknown;
      try {
        if (observedServerExit === null) {
          try {
            server.kill("SIGTERM");
          } catch (error) {
            shutdownFailure = error;
          }
        }
        try {
          exitCode = await within(
            server.exited,
            "the real TLS fixture to stop",
            3_000,
          );
        } catch (error) {
          shutdownFailure ??= error;
          if (observedServerExit === null) server.kill("SIGKILL");
          exitCode = await server.exited;
        }
        stderr = await new Response(server.stderr).text();
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
      if (fixtureStarted) {
        expect(shutdownFailure).toBeUndefined();
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
      }
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

  test("returns a bounded manual redirect without resolving or requesting its target", async () => {
    const resolved: string[] = [];
    let transportCalls = 0;
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: (hostname) => {
        resolved.push(hostname);
        return Promise.resolve([publicAddress]);
      },
      transport: () => {
        transportCalls += 1;
        return Promise.resolve(networkResponse(302, {
          headers: { Location: "https://archive.ph/20260801000000/https://example.com/" },
          onCancel: () => {
            cancelled = true;
          },
        }));
      },
    });

    const result = await fetch(
      new URL("https://archive.ph/newest/https://example.com/"),
      fetchOptions({ redirect: "manual" }),
    );
    expect(result.status).toBe(302);
    expect(result.location).toBe("https://archive.ph/20260801000000/https://example.com/");
    expect(result.bytes).toHaveLength(0);
    expect(resolved).toEqual(["archive.ph"]);
    expect(transportCalls).toBe(1);
    expect(cancelled).toBeTrue();
  });

  test("returns a missing manual Location for provider-specific classification", async () => {
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => Promise.resolve(networkResponse(302, {
        onCancel: () => {
          cancelled = true;
        },
      })),
    });

    const result = await fetch(
      new URL("https://archive.ph/newest/https://example.com/"),
      fetchOptions({ redirect: "manual" }),
    );
    expect(result.status).toBe(302);
    expect(result.location).toBeNull();
    expect(result.bytes).toHaveLength(0);
    expect(cancelled).toBeTrue();
  });

  test("returns an explicitly accepted bounded 404 for provider-specific interpretation", async () => {
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => Promise.resolve(networkResponse(404, {
        headers: { "Content-Type": "text/plain" },
        chunks: [new TextEncoder().encode("not archived")],
      })),
    });

    const result = await fetch(
      new URL("https://archive.ph/newest/https://example.com/missing"),
      fetchOptions({ acceptStatuses: [404] }),
    );
    expect(result.status).toBe(404);
    expect(new TextDecoder().decode(result.bytes)).toBe("not archived");
  });

  test("rejects followed redirects outside an exact caller allowlist before DNS", async () => {
    const resolved: string[] = [];
    let cancelled = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: (hostname) => {
        resolved.push(hostname);
        return Promise.resolve([publicAddress]);
      },
      transport: () => Promise.resolve(networkResponse(302, {
        headers: { Location: "https://attacker.example/archive" },
        onCancel: () => {
          cancelled = true;
        },
      })),
    });

    const failure = await rejectedFetch(fetch(
      new URL("https://archive.ph/snapshot"),
      fetchOptions({ allowedRedirectOrigins: ["https://archive.ph/"] }),
    ));
    expect(failure.code).toBe("redirect");
    expect(resolved).toEqual(["archive.ph"]);
    expect(cancelled).toBeTrue();
  });

  test("rejects malformed accepted statuses and redirect origins before transport", async () => {
    let transported = false;
    const fetch = createDeterministicSafeFetch({
      resolveHostname: () => Promise.resolve([publicAddress]),
      transport: () => {
        transported = true;
        return Promise.resolve(networkResponse(200));
      },
    });

    const statusFailure = await rejectedFetch(fetch(
      new URL("https://archive.ph/"),
      fetchOptions({ acceptStatuses: [302] }),
    ));
    const originFailure = await rejectedFetch(fetch(
      new URL("https://archive.ph/"),
      fetchOptions({ allowedRedirectOrigins: ["https://archive.ph/path"] }),
    ));
    expect(statusFailure.code).toBe("invalid-url");
    expect(originFailure.code).toBe("invalid-url");
    expect(transported).toBeFalse();
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
