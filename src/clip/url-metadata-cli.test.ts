import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { SearchProvider } from "./metadata-search.js";
import type { UrlMetadataBackfillReport } from "./url-metadata-backfill.js";
import { main, metadataSearchBinaryPath, parseUrlMetadataArguments, urlMetadataUsage } from "./url-metadata-cli.js";

const report = (overrides: Partial<UrlMetadataBackfillReport> = {}): UrlMetadataBackfillReport => ({
  generatedAt: "2026-08-04T12:00:00.000Z",
  totalRecords: 2,
  processedRecords: 2,
  skippedRecords: 0,
  writtenRecords: 2,
  unchangedRecords: 0,
  remainingRecords: 0,
  aborted: false,
  statusCounts: { matched: 1, notFound: 0, partial: 1, unavailable: 0 },
  items: [],
  ...overrides,
});

describe("URL metadata CLI", () => {
  test("resolves the helper from the package root in source and built layouts", () => {
    expect(metadataSearchBinaryPath("/public/kb", "linux")).toBe(
      "/public/kb/src/clip/metadata-search-tool/target/release/kb-url-metadata-search",
    );
    expect(metadataSearchBinaryPath("C:\\public\\kb", "win32")).toEndWith(
      "src/clip/metadata-search-tool/target/release/kb-url-metadata-search.exe",
    );
    expect(urlMetadataUsage).toContain("bun run url-metadata:tool:build");
    expect(urlMetadataUsage).not.toContain("cargo build");
    expect(urlMetadataUsage).not.toContain("packages/kb/src");
  });

  test("parses a strict bounded backfill command with archive discovery on by default", () => {
    const parsed = parseUrlMetadataArguments([
      "backfill",
      "--root", "vault",
      "--search-binary", "./search-helper",
      "--refresh",
      "--delay-ms", "250",
      "--max-results", "12",
      "--timeout", "7000",
      "--json",
    ], {});
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok || parsed.value.kind === "help") return;
    expect(parsed.value).toMatchObject({
      root: "vault",
      binaryPath: resolve("./search-helper"),
      refresh: true,
      discoverArchives: true,
      delayMs: 250,
      maxResults: 12,
      timeoutMs: 7_000,
      json: true,
    });
  });

  test("rejects unknown, missing, and out-of-range options without invoking work", () => {
    expect(parseUrlMetadataArguments(["other"], {}).ok).toBeFalse();
    expect(parseUrlMetadataArguments(["backfill", "--root"], {}).ok).toBeFalse();
    expect(parseUrlMetadataArguments(["backfill", "--max-results", "21"], {}).ok).toBeFalse();
    expect(parseUrlMetadataArguments(["backfill", "--timeout", "499"], {}).ok).toBeFalse();
    expect(parseUrlMetadataArguments(["backfill", "--unknown"], {}).ok).toBeFalse();
  });

  test("delegates one configured provider and renders a deterministic human report", async () => {
    let binaryPath = "";
    let observedOptions: unknown;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const provider: SearchProvider = () => Promise.resolve({
      status: "failure",
      category: "unavailable",
      message: "unused",
    });
    const code = await main([
      "backfill", "--root", "vault", "--search-binary", "/safe/search", "--no-archive", "--delay-ms", "0",
    ], {}, {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }, {
      createSearchProvider: (path) => {
        binaryPath = path;
        return provider;
      },
      backfill: (options, dependencies) => {
        observedOptions = options;
        expect(dependencies.searchProvider).toBe(provider);
        return Promise.resolve(report());
      },
    });
    expect(code).toBe(0);
    expect(binaryPath).toBe("/safe/search");
    expect(observedOptions).toMatchObject({
      vaultRoot: "vault",
      refresh: false,
      discoverArchives: false,
      interRequestDelayMs: 0,
      searchTimeoutMs: 15_000,
    });
    expect(stdout.join("")).toContain("2 processed");
    expect(stderr).toEqual([]);
  });

  test("returns a degraded exit for unavailable records and JSON for runtime failures", async () => {
    const provider: SearchProvider = () => Promise.resolve({ status: "failure", category: "unavailable", message: "unused" });
    const degraded = await main(["backfill", "--search-binary", "/safe/search"], {}, {
      stdout: () => undefined,
      stderr: () => undefined,
    }, {
      createSearchProvider: () => provider,
      backfill: () => Promise.resolve(report({
        statusCounts: { matched: 0, notFound: 0, partial: 0, unavailable: 2 },
      })),
    });
    expect(degraded).toBe(3);

    const output: string[] = [];
    const failed = await main(["backfill", "--search-binary", "/safe/search", "--json"], {}, {
      stdout: (value) => output.push(value),
      stderr: () => undefined,
    }, {
      createSearchProvider: () => {
        throw new Error("binary unavailable");
      },
    });
    expect(failed).toBe(1);
    expect(JSON.parse(output.join(""))).toEqual({ ok: false, error: "binary unavailable" });
  });
});
