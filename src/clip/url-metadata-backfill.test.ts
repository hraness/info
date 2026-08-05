import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArchiveTodayDiscovery } from "./archive-today.js";
import type { SearchProvider, SearchProviderOutcome } from "./metadata-search.js";
import type { MetadataSearchResult } from "./url-intelligence.js";
import {
  backfillSavedUrlMetadata,
  type UrlMetadataBackfillDependencies,
} from "./url-metadata-backfill.js";
import {
  createUrlMetadataDocument,
  discoverSavedUrlRecords,
  readUrlMetadataDocument,
  writeUrlMetadataDocument,
  type SavedUrlRecord,
  type UrlMetadataDocument,
} from "./url-metadata.js";

const fixedNow = new Date("2026-08-04T12:00:00.000Z");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createVault(records: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kb-url-metadata-backfill-"));
  temporaryPaths.push(root);
  mkdirSync(join(root, "articles"));
  for (const [articleId, source] of Object.entries(records)) {
    const directory = join(root, "articles", articleId);
    mkdirSync(directory);
    writeFileSync(join(directory, `${articleId}.md`), `---\ntitle: ${articleId}\nsource: ${source}\n---\n\nBody.\n`);
  }
  return root;
}

function sourceFromQuery(query: string): string {
  return JSON.parse(query) as string;
}

function successfulSearch(
  query: string,
  results: readonly MetadataSearchResult[],
  options: {
    readonly enginesQueried?: readonly string[];
    readonly enginesFailed?: readonly string[];
  } = {},
): SearchProviderOutcome {
  const enginesQueried = options.enginesQueried ?? ["duckduckgo"];
  const enginesFailed = options.enginesFailed ?? [];
  return Object.freeze({
    status: "success",
    response: Object.freeze({
      query,
      results,
      enginesQueried,
      enginesFailed,
      engineStatus: enginesFailed.length === 0
        ? "complete"
        : enginesFailed.length === enginesQueried.length ? "unavailable" : "partial",
    }),
  });
}

function directResult(source: string, title = "Exact title", score = 1) {
  return Object.freeze({
    title,
    url: source,
    snippet: `Description for ${title}`,
    engines: Object.freeze(["duckduckgo"]),
    score,
  });
}

function safeDependencies(searchProvider: SearchProvider): UrlMetadataBackfillDependencies {
  return {
    searchProvider,
    assertNetworkUrl: async () => {},
    now: () => fixedNow,
  };
}

describe("URL metadata backfill", () => {
  test("inventories every record, queries Hacker News exactly, and runs requests serially", async () => {
    const hackerNews = "https://news.ycombinator.com/item?id=41754949";
    const example = "https://example.com/zeta";
    const vault = createVault({ zeta: example, alpha: hackerNews });
    const queries: string[] = [];
    const sleeps: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const provider: SearchProvider = async ({ query }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      queries.push(query);
      await Promise.resolve();
      active -= 1;
      const source = sourceFromQuery(query);
      return successfulSearch(query, Object.freeze([directResult(source, `Title for ${source}`)]));
    };

    const result = await backfillSavedUrlMetadata({
      vaultRoot: vault,
      interRequestDelayMs: 17,
    }, {
      ...safeDependencies(provider),
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(result).toMatchObject({
      generatedAt: fixedNow.toISOString(),
      totalRecords: 2,
      processedRecords: 2,
      skippedRecords: 0,
      writtenRecords: 2,
      unchangedRecords: 0,
      remainingRecords: 0,
      aborted: false,
      statusCounts: { matched: 2, notFound: 0, partial: 0, unavailable: 0 },
    });
    expect(result.items.map(({ articleId }) => articleId)).toEqual(["alpha", "zeta"]);
    expect(queries).toEqual([`"${hackerNews}"`, `"${example}"`]);
    expect(sleeps).toEqual([17]);
    expect(maximumActive).toBe(1);
    for (const saved of discoverSavedUrlRecords(vault)) {
      expect(readUrlMetadataDocument(saved).selected.title?.sourceUrl).toBe(saved.subjectUrl);
    }
  });

  test("skips compatible sidecars by default and refreshes them explicitly", async () => {
    const source = "https://example.com/article";
    const vault = createVault({ article: source });
    let calls = 0;
    const firstProvider: SearchProvider = ({ query }) => {
      calls += 1;
      return Promise.resolve(successfulSearch(query, Object.freeze([directResult(source, "First title")])));
    };
    const first = await backfillSavedUrlMetadata({ vaultRoot: vault }, safeDependencies(firstProvider));
    expect(first.writtenRecords).toBe(1);

    const skipped = await backfillSavedUrlMetadata({ vaultRoot: vault }, safeDependencies(() =>
      Promise.reject(new Error("a skipped record must not call its provider"))));
    expect(skipped).toMatchObject({ processedRecords: 0, skippedRecords: 1, writtenRecords: 0 });
    expect(skipped.items[0]?.action).toBe("skipped");

    const refreshed = await backfillSavedUrlMetadata({ vaultRoot: vault, refresh: true }, safeDependencies(({ query }) => {
      calls += 1;
      return Promise.resolve(successfulSearch(query, Object.freeze([directResult(source, "Refreshed title")])));
    }));
    expect(refreshed).toMatchObject({ processedRecords: 1, skippedRecords: 0, writtenRecords: 1 });
    expect(calls).toBe(2);
    expect(readUrlMetadataDocument(discoverSavedUrlRecords(vault)[0]!).selected.title?.value).toBe("Refreshed title");
  });

  test("records partial and failed providers without abandoning later records", async () => {
    const vault = createVault({
      partial: "https://example.com/partial",
      timeout: "https://example.com/timeout",
      thrown: "https://example.com/thrown",
    });
    const provider: SearchProvider = ({ query }) => {
      const source = sourceFromQuery(query);
      if (source.endsWith("/partial")) {
        return Promise.resolve(successfulSearch(query, Object.freeze([directResult(source)]), {
          enginesQueried: ["duckduckgo", "brave"],
          enginesFailed: ["brave"],
        }));
      }
      if (source.endsWith("/timeout")) {
        return Promise.resolve(Object.freeze({ status: "failure", category: "timeout", message: "remote detail is ignored" }));
      }
      return Promise.reject(new Error("provider implementation failure"));
    };

    let archiveCalls = 0;
    const result = await backfillSavedUrlMetadata({ vaultRoot: vault, discoverArchives: true }, {
      ...safeDependencies(provider),
      discoverArchive: (source) => {
        archiveCalls += 1;
        if (source.toString().endsWith("/thrown")) return Promise.reject(new Error("archive implementation failure"));
        return Promise.resolve(Object.freeze({
          status: "unavailable",
          sourceUrl: source.toString(),
          reason: "request-failed",
        }));
      },
    });
    expect(result).toMatchObject({
      totalRecords: 3,
      processedRecords: 3,
      writtenRecords: 3,
      remainingRecords: 0,
      statusCounts: { matched: 0, notFound: 0, partial: 1, unavailable: 2 },
    });
    const documents = new Map(discoverSavedUrlRecords(vault).map((saved) => [
      saved.articleId,
      readUrlMetadataDocument(saved),
    ]));
    expect(documents.get("partial")?.attempts[0]).toMatchObject({ outcome: "partial" });
    expect(documents.get("partial")?.provider.enginesFailed).toEqual(["brave"]);
    expect(documents.get("timeout")?.attempts[0]).toEqual({
      provider: "metadata-search-engine-rs",
      outcome: "failed",
      message: "Metadata search failed (timeout).",
    });
    expect(documents.get("thrown")?.attempts[0]?.message).toBe("Metadata search failed (provider-threw).");
    expect(documents.get("partial")?.attempts[1]?.message).toBe(
      "Archive.today snapshot discovery was unavailable (request-failed).",
    );
    expect(documents.get("thrown")?.attempts[1]?.message).toBe("Archive.today discovery failed.");
    expect(archiveCalls).toBe(3);
  });

  test("records an all-engine failure as failed and unavailable", async () => {
    const source = "https://example.com/all-engines-failed";
    const vault = createVault({ article: source });
    await backfillSavedUrlMetadata({ vaultRoot: vault }, safeDependencies(({ query }) =>
      Promise.resolve(successfulSearch(query, Object.freeze([]), {
        enginesQueried: ["brave", "duckduckgo"],
        enginesFailed: ["brave", "duckduckgo"],
      }))));

    const document = readUrlMetadataDocument(discoverSavedUrlRecords(vault)[0]!);
    expect(document.status).toBe("unavailable");
    expect(document.attempts[0]).toEqual({
      provider: "metadata-search-engine-rs",
      outcome: "failed",
      message: "Metadata search failed because all queried engines were unavailable.",
    });
  });

  test("keeps only exact direct metadata and deduplicates bound archive search and newest hits", async () => {
    const source = "https://example.com/article?edition=morning";
    const timestamp = "20260801072950";
    const searchedArchive = `https://archive.is/${timestamp}/${source}`;
    const newestArchive = `https://archive.ph/${timestamp}/${source}`;
    const vault = createVault({ article: source });
    const calls: string[] = [];
    const provider: SearchProvider = ({ query }) => {
      calls.push("search");
      return Promise.resolve(successfulSearch(query, Object.freeze([
        directResult(source, "Direct metadata", 4),
        { ...directResult(searchedArchive, "Archived result", 3), url: searchedArchive },
        directResult("https://unrelated.example/story", "Unrelated", 2),
      ])));
    };
    const archiveDiscovery = (): Promise<ArchiveTodayDiscovery> => {
      calls.push("archive");
      return Promise.resolve(Object.freeze({
        status: "found",
        sourceUrl: source,
        snapshot: Object.freeze({
          url: newestArchive,
          capturedAt: "2026-08-01T07:29:50.000Z",
          sourceUrl: source,
          discovery: "newest",
        }),
      }));
    };
    const sleeps: number[] = [];

    await backfillSavedUrlMetadata({
      vaultRoot: vault,
      discoverArchives: true,
      interRequestDelayMs: 25,
    }, {
      ...safeDependencies(provider),
      discoverArchive: archiveDiscovery,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    const document = readUrlMetadataDocument(discoverSavedUrlRecords(vault)[0]!);
    expect(calls).toEqual(["search", "archive"]);
    expect(sleeps).toEqual([25]);
    expect(document.candidates.map(({ url }) => url)).toEqual([source]);
    expect(document.selected.title?.value).toBe("Direct metadata");
    expect(document.archives).toEqual([{
      url: newestArchive,
      capturedAt: "2026-08-01T07:29:50.000Z",
      discovery: "newest",
    }]);
    expect(document.warnings).toEqual(["Discarded 1 search result without an exact source binding."]);
    expect(document.attempts.map(({ provider, outcome }) => ({ provider, outcome }))).toEqual([
      { provider: "metadata-search-engine-rs", outcome: "succeeded" },
      { provider: "archive-today", outcome: "succeeded" },
    ]);
  });

  test("does not disclose a URL that fails network-safety validation", async () => {
    const source = "https://rebind.example/article";
    const vault = createVault({ unsafe: source });
    let searchCalls = 0;
    let archiveCalls = 0;
    const assertions: Array<{ readonly url: string; readonly allowPrivate: boolean; readonly timeout: number | undefined }> = [];
    const result = await backfillSavedUrlMetadata({
      vaultRoot: vault,
      discoverArchives: true,
      networkValidationTimeoutMs: 777,
    }, {
      searchProvider: () => {
        searchCalls += 1;
        return Promise.reject(new Error("must not run"));
      },
      discoverArchive: () => {
        archiveCalls += 1;
        return Promise.reject(new Error("must not run"));
      },
      assertNetworkUrl: (url, allowPrivate, timeout) => {
        assertions.push({ url: url.href, allowPrivate, timeout });
        return Promise.reject(new Error("private DNS answer"));
      },
      now: () => fixedNow,
    });

    expect(assertions).toEqual([{ url: source, allowPrivate: false, timeout: 777 }]);
    expect(searchCalls).toBe(0);
    expect(archiveCalls).toBe(0);
    expect(result.statusCounts.unavailable).toBe(1);
    const document = readUrlMetadataDocument(discoverSavedUrlRecords(vault)[0]!);
    expect(document.attempts).toEqual([
      {
        provider: "metadata-search-engine-rs",
        outcome: "skipped",
        message: "Metadata search was skipped because the source failed network-safety validation.",
      },
      {
        provider: "archive-today",
        outcome: "skipped",
        message: "Archive.today discovery was skipped because the source failed network-safety validation.",
      },
    ]);
  });

  test("rejects a credential-shaped saved URL before disclosure or sidecar creation", async () => {
    const source = "https://example.com/article?token=secret";
    const vault = createVault({ secret: source });
    let searchCalls = 0;
    let archiveCalls = 0;
    let assertions = 0;
    let rejection: unknown;
    try {
      await backfillSavedUrlMetadata({ vaultRoot: vault, discoverArchives: true }, {
        searchProvider: () => {
          searchCalls += 1;
          return Promise.reject(new Error("must not run"));
        },
        discoverArchive: () => {
          archiveCalls += 1;
          return Promise.reject(new Error("must not run"));
        },
        assertNetworkUrl: () => {
          assertions += 1;
          return Promise.resolve();
        },
        now: () => fixedNow,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("credential-shaped");

    expect(assertions).toBe(0);
    expect(searchCalls).toBe(0);
    expect(archiveCalls).toBe(0);
    expect(() => discoverSavedUrlRecords(vault)).toThrow("credential-shaped");
    expect(() => readFileSync(join(vault, "articles", "secret", "url-metadata.json"))).toThrow();
  });

  test("aborts between records after preserving a completed record", async () => {
    const vault = createVault({
      alpha: "https://example.com/alpha",
      beta: "https://example.com/beta",
    });
    const controller = new AbortController();
    let providerCalls = 0;
    let writes = 0;
    const result = await backfillSavedUrlMetadata({
      vaultRoot: vault,
      signal: controller.signal,
    }, {
      ...safeDependencies(({ query }) => {
        providerCalls += 1;
        return Promise.resolve(successfulSearch(query, Object.freeze([directResult(sourceFromQuery(query))])));
      }),
      writeMetadata: (saved, document) => {
        const outcome = writeUrlMetadataDocument(saved, document);
        writes += 1;
        controller.abort(new Error("stop after the first completed record"));
        return outcome;
      },
    });

    expect(result).toMatchObject({
      totalRecords: 2,
      processedRecords: 1,
      writtenRecords: 1,
      remainingRecords: 1,
      aborted: true,
    });
    expect(result.items.map(({ articleId }) => articleId)).toEqual(["alpha"]);
    expect(providerCalls).toBe(1);
    expect(writes).toBe(1);
  });

  test("fails closed on malformed sidecars even when refresh is requested", () => {
    const vault = createVault({ article: "https://example.com/article" });
    const saved = discoverSavedUrlRecords(vault)[0]!;
    writeFileSync(saved.sidecarPath, "{not-json\n");
    let providerCalls = 0;

    expect(backfillSavedUrlMetadata({ vaultRoot: vault, refresh: true }, safeDependencies(() => {
      providerCalls += 1;
      return Promise.resolve(Object.freeze({ status: "failure", category: "unavailable", message: "unavailable" }));
    }))).rejects.toThrow("Refusing to replace malformed URL metadata sidecar");
    expect(providerCalls).toBe(0);
    expect(readFileSync(saved.sidecarPath, "utf8")).toBe("{not-json\n");
  });

  test("produces the same report and documents for unordered injected inventories", async () => {
    const fakeRecords: readonly SavedUrlRecord[] = Object.freeze([
      Object.freeze({
        articleId: "beta",
        directory: "/vault/articles/beta",
        markdownPath: "/vault/articles/beta/beta.md",
        sidecarPath: "/vault/articles/beta/url-metadata.json",
        subjectUrl: "https://example.com/beta",
      }),
      Object.freeze({
        articleId: "alpha",
        directory: "/vault/articles/alpha",
        markdownPath: "/vault/articles/alpha/alpha.md",
        sidecarPath: "/vault/articles/alpha/url-metadata.json",
        subjectUrl: "https://example.com/alpha",
      }),
    ]);

    const execute = async (records: readonly SavedUrlRecord[], reverseResults: boolean) => {
      const documents = new Map<string, UrlMetadataDocument>();
      const missingReader = ((saved: SavedUrlRecord): UrlMetadataDocument => {
        const existing = documents.get(saved.sidecarPath);
        if (existing !== undefined) return existing;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }) as typeof readUrlMetadataDocument;
      const writer = ((saved: SavedUrlRecord, document: UrlMetadataDocument) => {
        documents.set(saved.sidecarPath, document);
        return { changed: true, path: saved.sidecarPath };
      }) as typeof writeUrlMetadataDocument;
      const report = await backfillSavedUrlMetadata({ vaultRoot: "/vault" }, {
        searchProvider: ({ query }) => {
          const source = sourceFromQuery(query);
          const results = [directResult(source, "Lower", 1), directResult(source, "Higher", 2)];
          return Promise.resolve(successfulSearch(query, Object.freeze(reverseResults ? results.reverse() : results)));
        },
        discoverRecords: () => records,
        readMetadata: missingReader,
        writeMetadata: writer,
        assertNetworkUrl: () => Promise.resolve(),
        now: () => fixedNow,
      });
      return { report, documents: [...documents.entries()] };
    };

    const forward = await execute(fakeRecords, false);
    const reverse = await execute([...fakeRecords].reverse(), true);
    expect(reverse).toEqual(forward);
    expect(forward.report.items.map(({ articleId }) => articleId)).toEqual(["alpha", "beta"]);
    expect(forward.documents.map(([, document]) => document.selected.title?.value)).toEqual(["Higher", "Higher"]);
  });

  test("validates option bounds before inventory or provider work", () => {
    let inventoried = false;
    expect(backfillSavedUrlMetadata({
      vaultRoot: "/vault",
      interRequestDelayMs: 60_001,
    }, {
      searchProvider: () => Promise.resolve(Object.freeze({ status: "failure", category: "unavailable", message: "x" })),
      discoverRecords: (() => {
        inventoried = true;
        return [];
      }),
    })).rejects.toThrow("inter-request delay");
    expect(inventoried).toBe(false);
  });

  test("a compatible unchanged refresh is reported without rewriting content", async () => {
    const source = "https://example.com/article";
    const vault = createVault({ article: source });
    const saved = discoverSavedUrlRecords(vault)[0]!;
    const seed = createUrlMetadataDocument({
      subjectUrl: source,
      generatedAt: fixedNow.toISOString(),
      enginesQueried: ["duckduckgo"],
      enginesFailed: [],
      attempts: [{ provider: "metadata-search-engine-rs", outcome: "succeeded", message: "Metadata search returned 1 exact source match and 0 bound archive matches." }],
      candidates: [{
        title: "Exact title",
        url: source,
        snippet: "Description for Exact title",
        engines: ["duckduckgo"],
        score: 1,
      }],
    });
    writeUrlMetadataDocument(saved, seed);

    const result = await backfillSavedUrlMetadata({ vaultRoot: vault, refresh: true }, safeDependencies(({ query }) =>
      Promise.resolve(successfulSearch(query, Object.freeze([directResult(source)])))));
    expect(result).toMatchObject({ writtenRecords: 0, unchangedRecords: 1, processedRecords: 1 });
    expect(result.items[0]?.action).toBe("unchanged");
  });
});
