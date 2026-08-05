import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExactUrlSearchQuery,
  createRustMetadataSearchProvider as createProductionMetadataSearchProvider,
  type RustMetadataSearchProviderOptions,
  type SearchProviderOutcome,
} from "./metadata-search.js";

const temporaryDirectories: string[] = [];
const testNetworkAddresses = Object.freeze([{ address: "93.184.216.34", family: 4 as const }]);

function createRustMetadataSearchProvider(options: RustMetadataSearchProviderOptions) {
  return createProductionMetadataSearchProvider({
    ...options,
    resolveNetworkTarget: options.resolveNetworkTarget ?? (() => Promise.resolve(testNetworkAddresses)),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executable(source: string): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "metadata-search-provider-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fake-search");
  writeFileSync(path, `#!${process.execPath}\n${source}\n`, { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
  return { directory, path };
}

function expectFailure(
  outcome: SearchProviderOutcome,
  category: Exclude<SearchProviderOutcome, { readonly status: "success" }> ["category"],
): asserts outcome is Extract<SearchProviderOutcome, { readonly status: "failure" }> {
  expect(outcome.status).toBe("failure");
  if (outcome.status !== "failure") throw new Error("Expected a search failure.");
  expect(outcome.category).toBe(category);
}

const SUCCESS_SCRIPT = String.raw`
const request = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({
  query: request.query,
  results: [
    {
      title: "Later",
      url: "https://example.com/later",
      snippet: null,
      engines: ["duckduckgo", "brave"],
      score: 1,
    },
    {
      title: "First",
      url: "https://example.com/first",
      snippet: "Useful metadata",
      engines: ["duckduckgo"],
      score: 4,
    },
  ],
  engines_queried: ["yahoo", "brave", "duckduckgo"],
  engines_failed: ["yahoo"],
}));`;

describe("Rust metadata search provider", () => {
  test("returns deterministic results while retaining partial engine failures", async () => {
    const fixture = executable(SUCCESS_SCRIPT);
    const provider = createRustMetadataSearchProvider({ binaryPath: fixture.path });

    const outcome = await provider({ query: "quoted source", maxResults: 2, timeoutMs: 1_000 });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.response.query).toBe("quoted source");
    expect(outcome.response.engineStatus).toBe("partial");
    expect(outcome.response.enginesFailed).toEqual(["yahoo"]);
    expect(outcome.response.enginesQueried).toEqual(["brave", "duckduckgo", "yahoo"]);
    expect(outcome.response.results.map((result) => result.title)).toEqual(["First", "Later"]);
    expect(outcome.response.results[1]?.engines).toEqual(["brave", "duckduckgo"]);
  });

  test("enforces the overall deadline and aborts an active process", async () => {
    const fixture = executable(String.raw`
process.on("SIGTERM", () => {});
await Bun.stdin.text();
await Bun.sleep(10_000);`);
    const provider = createRustMetadataSearchProvider({
      binaryPath: fixture.path,
      defaultTimeoutMs: 500,
      processGraceMs: 0,
    });

    const timedOut = await provider({ query: "deadline" });
    expectFailure(timedOut, "timeout");

    const controller = new AbortController();
    const pending = provider({ query: "abort", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const aborted = await pending;
    expectFailure(aborted, "aborted");
  });

  test("kills a process whose stdout or stderr exceeds a configured bound", async () => {
    const stdoutFixture = executable(String.raw`
await Bun.stdin.text();
process.stdout.write("x".repeat(16_384));
await Bun.sleep(10_000);`);
    const stdoutProvider = createRustMetadataSearchProvider({
      binaryPath: stdoutFixture.path,
      maxStdoutBytes: 256,
      defaultTimeoutMs: 1_000,
      processGraceMs: 0,
    });
    const stdout = await stdoutProvider({ query: "bounded stdout" });
    expectFailure(stdout, "protocol");

    const stderrFixture = executable(String.raw`
await Bun.stdin.text();
process.stderr.write("y".repeat(16_384));
await Bun.sleep(10_000);`);
    const stderrProvider = createRustMetadataSearchProvider({
      binaryPath: stderrFixture.path,
      maxStderrBytes: 256,
      defaultTimeoutMs: 1_000,
      processGraceMs: 0,
    });
    const stderr = await stderrProvider({ query: "bounded stderr" });
    expectFailure(stderr, "protocol");
  });

  test("categorizes malformed JSON and schema violations as protocol failures", async () => {
    const malformed = executable(String.raw`
await Bun.stdin.text();
process.stdout.write("{not-json");`);
    const malformedOutcome = await createRustMetadataSearchProvider({ binaryPath: malformed.path })({
      query: "malformed",
    });
    expectFailure(malformedOutcome, "protocol");

    const unknownField = executable(String.raw`
const request = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({
  query: request.query,
  results: [],
  engines_queried: [],
  engines_failed: [],
  unexpected: true,
}));`);
    const unknownOutcome = await createRustMetadataSearchProvider({ binaryPath: unknownField.path })({
      query: "unknown field",
    });
    expectFailure(unknownOutcome, "protocol");
  });

  test("categorizes nonzero exit without exposing the query, URL, or raw stderr", async () => {
    const fixture = executable(String.raw`
const request = JSON.parse(await Bun.stdin.text());
process.stderr.write("provider rejected " + request.query + " https://secret.invalid/private");
process.exit(7);`);
    const provider = createRustMetadataSearchProvider({ binaryPath: fixture.path });
    const secret = "token-value https://secret.invalid/source";

    const outcome = await provider({ query: secret });

    expectFailure(outcome, "process");
    if (outcome.status !== "failure") return;
    expect(outcome.message).toBe("Metadata search process failed.");
    expect(outcome.message).not.toContain("token-value");
    expect(outcome.message).not.toContain("secret.invalid");
    expect(outcome).not.toHaveProperty("stderr");
  });

  test("keeps the query off argv, strips ambient state, and removes the private cwd", async () => {
    const fixture = executable(String.raw`
const request = JSON.parse(await Bun.stdin.text());
const suspicious = Object.keys(process.env).filter((key) =>
  /proxy|token|secret|password|credential|auth|node_options|bun_options|brave|aws/i.test(key)
);
process.stdout.write(JSON.stringify({
  query: request.query,
  results: [{
    title: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), executable: process.argv[1], suspicious, engineHosts: request.engine_hosts }),
    url: "https://example.com/observation",
    snippet: null,
    engines: ["fake"],
    score: 1,
  }],
  engines_queried: ["fake"],
  engines_failed: [],
}));`);
    const secretQuery = "https://example.com/private-token-value";
    const provider = createRustMetadataSearchProvider({
      binaryPath: fixture.path,
      environment: {
        PATH: process.env.PATH,
        HTTP_PROXY: "http://proxy.invalid",
        HTTPS_PROXY: "http://proxy.invalid",
        BRAVE_API_KEY: "provider-secret",
        AWS_SESSION_TOKEN: "cloud-secret",
        NODE_OPTIONS: "--require=/tmp/startup.js",
        BUN_OPTIONS: "--preload=/tmp/startup.ts",
      },
    });

    const outcome = await provider({ query: secretQuery });

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    const observation = JSON.parse(outcome.response.results[0]?.title ?? "null") as {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly executable: string;
      readonly suspicious: readonly string[];
      readonly engineHosts: readonly {
        readonly hostname: string;
        readonly addresses: readonly { readonly address: string; readonly family: number }[];
      }[];
    };
    expect(observation.argv).toEqual([]);
    expect(JSON.stringify(observation.argv)).not.toContain(secretQuery);
    expect(observation.suspicious).toEqual([]);
    expect(observation.engineHosts).toEqual([
      "html.duckduckgo.com",
      "search.brave.com",
      "www.startpage.com",
      "search.yahoo.com",
    ].map((hostname) => ({ hostname, addresses: testNetworkAddresses })));
    expect(observation.executable).toStartWith(observation.cwd);
    expect(observation.executable).not.toStartWith(fixture.directory);
    expect(observation.cwd).toStartWith(realpathSync(tmpdir()));
    expect(existsSync(observation.cwd)).toBeFalse();
  });

  test("rejects symbolic, hard-linked, non-owner-executable, and oversized binaries", () => {
    const symbolicTarget = executable(SUCCESS_SCRIPT);
    const symbolicPath = join(symbolicTarget.directory, "symbolic-search");
    symlinkSync(symbolicTarget.path, symbolicPath);
    expect(() => createRustMetadataSearchProvider({ binaryPath: symbolicPath })).toThrow(
      "The metadata search binary is unavailable or untrusted.",
    );

    const hardLinked = executable(SUCCESS_SCRIPT);
    const hardLinkPath = join(hardLinked.directory, "hard-linked-search");
    linkSync(hardLinked.path, hardLinkPath);
    expect(() => createRustMetadataSearchProvider({ binaryPath: hardLinked.path })).toThrow(
      "The metadata search binary is unavailable or untrusted.",
    );

    const nonOwnerExecutable = executable(SUCCESS_SCRIPT);
    chmodSync(nonOwnerExecutable.path, 0o011);
    expect(() => createRustMetadataSearchProvider({ binaryPath: nonOwnerExecutable.path })).toThrow(
      "The metadata search binary is unavailable or untrusted.",
    );

    const oversized = executable(SUCCESS_SCRIPT);
    expect(() => createRustMetadataSearchProvider({
      binaryPath: oversized.path,
      maxBinaryBytes: 32,
    })).toThrow("The metadata search binary is unavailable or untrusted.");
  });

  test("fails closed when the pinned binary identity drifts", async () => {
    const fixture = executable(SUCCESS_SCRIPT);
    const provider = createRustMetadataSearchProvider({ binaryPath: fixture.path });
    writeFileSync(fixture.path, `#!${process.execPath}\nprocess.exit(0);\n`, { encoding: "utf8", mode: 0o700 });
    chmodSync(fixture.path, 0o700);

    const outcome = await provider({ query: "identity drift" });

    expectFailure(outcome, "unavailable");
    if (outcome.status !== "failure") return;
    expect(outcome.message).not.toContain(fixture.path);
  });

  test("validates bounded requests without sending rejected input to a process", async () => {
    const fixture = executable(SUCCESS_SCRIPT);
    const provider = createRustMetadataSearchProvider({ binaryPath: fixture.path });

    const empty = await provider({ query: "  " });
    const large = await provider({ query: "x".repeat(4_097) });
    const resultLimit = await provider({ query: "valid", maxResults: 21 });
    const timeout = await provider({ query: "valid", timeoutMs: 499 });

    for (const outcome of [empty, large, resultLimit, timeout]) {
      expectFailure(outcome, "invalid-request");
    }
  });

  test("fails before process execution when a fixed engine host is not network-safe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "metadata-search-network-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "executed");
    const fixture = executable(`
await Bun.write(${JSON.stringify(marker)}, "executed");
process.exit(0);`);
    const provider = createProductionMetadataSearchProvider({
      binaryPath: fixture.path,
      resolveNetworkTarget: () => Promise.reject(new Error("private DNS answer")),
    });

    const outcome = await provider({ query: "safe query" });

    expectFailure(outcome, "unavailable");
    expect(existsSync(marker)).toBeFalse();
  });
});

describe("exact URL metadata query", () => {
  test("preserves safe identity parameters, strips fragments, and rejects secret-bearing variants", () => {
    expect(createExactUrlSearchQuery("https://example.com/a%20path/")).toBe(
      '"https://example.com/a%20path/"',
    );
    expect(createExactUrlSearchQuery("https://user:pass@example.com/article")).toBeNull();
    expect(createExactUrlSearchQuery("https://news.ycombinator.com/item?id=12345")).toBe(
      '"https://news.ycombinator.com/item?id=12345"',
    );
    expect(createExactUrlSearchQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      '"https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
    );
    expect(createExactUrlSearchQuery("https://example.com/article?token=secret")).toBeNull();
    expect(createExactUrlSearchQuery("https://example.com/article#section")).toBe(
      '"https://example.com/article"',
    );
    expect(createExactUrlSearchQuery("http://127.0.0.1/article")).toBeNull();
    expect(createExactUrlSearchQuery("file:///tmp/article")).toBeNull();
    expect(createExactUrlSearchQuery("not a URL")).toBeNull();
  });
});
