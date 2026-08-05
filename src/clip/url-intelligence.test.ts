import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  ARCHIVE_TODAY_HOSTS,
  MAX_ARCHIVE_TIMEMAP_ENTRIES,
  MAX_ARCHIVE_TIMEMAP_UTF8_BYTES,
  MAX_METADATA_SEARCH_RESULTS,
  isExactSourceTarget,
  normalizeSourceUrlIdentity,
  parseArchiveTodayMementoUrl,
  parseArchiveTodayTimeMap,
  parseMetadataSearchResponse,
  rankMetadataSearchResults,
  type MetadataSearchResult,
} from "./url-intelligence.js";

const originalUrl = "https://example.com/Path/?b=two&a=one";
const now = new Date("2026-08-04T12:00:00.000Z");

function searchResult(
  url: string,
  score: number,
  title = url,
): MetadataSearchResult {
  return Object.freeze({
    title,
    url,
    snippet: null,
    engines: Object.freeze(["duckduckgo"]),
    score,
  });
}

function mementoLink(
  timestamp: string,
  datetime: string,
  host = "archive.ph",
  protocol = "https",
): string {
  return `<${protocol}://${host}/${timestamp}/${originalUrl}>; rel="memento"; datetime="${datetime}"`;
}

function timeMap(...mementos: readonly string[]): string {
  return [`<${originalUrl}>; rel="original"`, ...mementos].join(",\n");
}

describe("metadata-search-engine-rs response boundary", () => {
  test("parses the exact closed response and preserves a categorical partial engine failure", () => {
    const response = parseMetadataSearchResponse({
      query: "exact target",
      results: [{
        title: "A\nresult",
        url: "HTTPS://EXAMPLE.COM:443/Path/?b=two&a=one#result",
        snippet: "one\tline\u001b[31m",
        engines: ["duckduckgo"],
        score: 1 / 61,
      }],
      engines_queried: ["duckduckgo", "brave"],
      engines_failed: ["brave"],
    });

    expect(response).toEqual({
      query: "exact target",
      results: [{
        title: "A result",
        url: originalUrl,
        snippet: "one line [31m",
        engines: ["duckduckgo"],
        score: 1 / 61,
      }],
      enginesQueried: ["duckduckgo", "brave"],
      enginesFailed: ["brave"],
      engineStatus: "partial",
    });
    expect(Object.isFrozen(response)).toBeTrue();
    expect(Object.isFrozen(response.results)).toBeTrue();
  });

  test("rejects unknown fields, engine contradictions, credentials, private URLs, and controls", () => {
    const base = {
      query: "target",
      results: [],
      engines_queried: ["duckduckgo"],
      engines_failed: [],
    };
    expect(() => parseMetadataSearchResponse({ ...base, extra: true })).toThrow("unknown fields");
    expect(() => parseMetadataSearchResponse({ ...base, engines_failed: ["brave"] })).toThrow("unqueried engine");
    expect(parseMetadataSearchResponse({ ...base, engines_failed: ["duckduckgo"] }).engineStatus).toBe("unavailable");
    expect(() => parseMetadataSearchResponse({ ...base, results: [{
      title: "bad", url: "https://user:secret@example.com/", snippet: null, engines: ["duckduckgo"], score: 1,
    }] })).toThrow("without credentials");
    expect(() => parseMetadataSearchResponse({ ...base, results: [{
      title: "bad", url: "http://127.0.0.1/", snippet: null, engines: ["duckduckgo"], score: 1,
    }] })).toThrow("public HTTP");
    expect(() => parseMetadataSearchResponse({ ...base, query: "bad\u0000query" })).toThrow("free of controls");
  });

  test("enforces result cardinality before allocating parsed results", () => {
    const result = { title: "x", url: "https://example.com/", snippet: null, engines: ["duckduckgo"], score: 1 };
    expect(() => parseMetadataSearchResponse({
      query: "target",
      results: Array.from({ length: MAX_METADATA_SEARCH_RESULTS + 1 }, () => result),
      engines_queried: ["duckduckgo"],
      engines_failed: [],
    })).toThrow(`${MAX_METADATA_SEARCH_RESULTS}`);
  });
});

describe("conservative URL identity and ranking", () => {
  test("normalizes only scheme, host, default port, and fragment semantics", () => {
    expect(normalizeSourceUrlIdentity("HTTPS://EXAMPLE.COM:443/Path/?b=2&a=%2f#section"))
      .toBe("https://example.com/Path/?b=2&a=%2f");
    expect(isExactSourceTarget("https://EXAMPLE.com:443/Path?b=2&a=1#x", "https://example.com/Path?b=2&a=1"))
      .toBeTrue();
    expect(isExactSourceTarget("https://example.com/Path", "https://example.com/path")).toBeFalse();
    expect(isExactSourceTarget("https://example.com/Path", "https://example.com/Path/")).toBeFalse();
    expect(isExactSourceTarget("https://example.com/?a=1&b=2", "https://example.com/?b=2&a=1")).toBeFalse();
    expect(isExactSourceTarget("https://example.com/?a=1&a=2", "https://example.com/?a=2&a=1")).toBeFalse();
  });

  test("ranks an exact target first and stably deduplicates by conservative identity", () => {
    const ranked = rankMetadataSearchResults([
      searchResult("https://example.com/other", 0.9, "first tie"),
      searchResult("https://EXAMPLE.com:443/Path/?b=two&a=one#one", 0.1, "lower exact"),
      searchResult("https://example.com/other#duplicate", 0.95, "better duplicate"),
      searchResult("https://example.net/", 0.9, "second tie"),
    ], { targetUrl: originalUrl });

    expect(ranked.map(({ title, rank, exactTarget }) => ({ title, rank, exactTarget }))).toEqual([
      { title: "lower exact", rank: 1, exactTarget: true },
      { title: "better duplicate", rank: 2, exactTarget: false },
      { title: "second tie", rank: 3, exactTarget: false },
    ]);
    expect(rankMetadataSearchResults([searchResult("https://example.com/", 1)], { limit: 0 })).toEqual([]);
  });

  test("score ranking and dedupe obey a stable reference model", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 80 }),
      (scores) => {
        const results = scores.map((score, index) =>
          searchResult(`https://example.com/item/${index % 12}`, score, `${index}`));
        const actual = rankMetadataSearchResults(results).map(({ title }) => Number(title));
        const seen = new Set<string>();
        const expected = scores
          .map((score, index) => ({ score, index, identity: `https://example.com/item/${index % 12}` }))
          .toSorted((left, right) => right.score - left.score || left.index - right.index)
          .filter(({ identity }) => {
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
          })
          .map(({ index }) => index);
        expect(actual).toEqual(expected);
      },
    ));
  });

  test("path and query strings survive identity normalization", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,20}$/u),
      fc.array(fc.tuple(
        fc.stringMatching(/^[a-z]{1,8}$/u),
        fc.stringMatching(/^[A-Za-z0-9_-]{0,12}$/u),
      ), { maxLength: 12 }),
      (path, pairs) => {
        const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
        const raw = `HTTPS://EXAMPLE.COM:443/${path}/${query === "" ? "" : `?${query}`}#fragment`;
        expect(normalizeSourceUrlIdentity(raw)).toBe(
          `https://example.com/${path}/${query === "" ? "" : `?${query}`}`,
        );
      },
    ));
  });
});

describe("archive.today Memento TimeMap boundary", () => {
  test("uses a real link-format state machine for commas in quoted datetimes and selects newest deterministically", () => {
    const parsed = parseArchiveTodayTimeMap(timeMap(
      mementoLink("20240229123000", "Thu, 29 Feb 2024 12:30:00 GMT", "archive.is", "http"),
      mementoLink("20250701103000", "Tue, 01 Jul 2025 10:30:00 GMT"),
    ), { originalUrl, now });

    expect(parsed.mementos.map(({ timestamp }) => timestamp)).toEqual(["20250701103000", "20240229123000"]);
    expect(parsed.newest?.timestamp).toBe("20250701103000");
    expect(parsed.mementos[1]?.url.startsWith("https://archive.is/")).toBeTrue();
    expect(parsed.originalUrl).toBe(originalUrl);
  });

  test("validates a direct timestamped snapshot and upgrades HTTP only after alias validation", () => {
    const parsed = parseArchiveTodayMementoUrl(
      `http://archive.vn/20240229123000/${originalUrl}`,
      { originalUrl, now },
    );
    expect(parsed).toMatchObject({
      archiveHost: "archive.vn",
      timestamp: "20240229123000",
      capturedAt: "2024-02-29T12:30:00.000Z",
      originalUrl,
    });
    expect(parsed.url.startsWith("https://archive.vn/")).toBeTrue();
  });

  test("rejects hostile link-format quoting, duplicate relation parameters, and controls", () => {
    expect(() => parseArchiveTodayTimeMap(
      `<${originalUrl}>; rel="original", <https://archive.ph/20240229123000/${originalUrl}>; rel="memento"; datetime="Thu, 29 Feb 2024 12:30:00 GMT`,
      { originalUrl, now },
    )).toThrow("unterminated quoted value");
    expect(() => parseArchiveTodayTimeMap(
      `<${originalUrl}>; rel="original"; rel="memento"`,
      { originalUrl, now },
    )).toThrow("repeats parameter rel");
    expect(() => parseArchiveTodayTimeMap(`${timeMap()}\u0000`, { originalUrl, now })).toThrow("forbidden controls");
  });

  test("enforces TimeMap byte and entry bounds", () => {
    expect(() => parseArchiveTodayTimeMap("x".repeat(MAX_ARCHIVE_TIMEMAP_UTF8_BYTES + 1), {
      originalUrl,
      now,
    })).toThrow(`${MAX_ARCHIVE_TIMEMAP_UTF8_BYTES}`);
    const excessiveEntries = Array.from(
      { length: MAX_ARCHIVE_TIMEMAP_ENTRIES + 1 },
      () => `<https://example.com/>; rel="self"`,
    ).join(",");
    expect(() => parseArchiveTodayTimeMap(excessiveEntries, { originalUrl, now }))
      .toThrow(`${MAX_ARCHIVE_TIMEMAP_ENTRIES}`);
  });

  test("rejects an original mismatch, path-case mismatch, and changed query sequence", () => {
    expect(() => parseArchiveTodayTimeMap(
      `<https://example.com/path/?b=two&a=one>; rel="original"`,
      { originalUrl, now },
    )).toThrow("exactly match");
    expect(() => parseArchiveTodayTimeMap(timeMap(
      `<https://archive.ph/20240229123000/https://example.com/Path/?a=one&b=two>; rel="memento"; datetime="Thu, 29 Feb 2024 12:30:00 GMT"`,
    ), { originalUrl, now })).toThrow("exact bound original");
  });

  test("rejects future snapshots and mismatched URL timestamps", () => {
    expect(() => parseArchiveTodayTimeMap(timeMap(
      mementoLink("20270101000000", "Fri, 01 Jan 2027 00:00:00 GMT"),
    ), { originalUrl, now })).toThrow("future");
    expect(() => parseArchiveTodayTimeMap(timeMap(
      mementoLink("20240229123001", "Thu, 29 Feb 2024 12:30:00 GMT"),
    ), { originalUrl, now })).toThrow("equal its Memento datetime");
  });

  test("accepts only fixed aliases and timestamped read-only snapshot routes", () => {
    for (const host of ARCHIVE_TODAY_HOSTS) {
      expect(parseArchiveTodayMementoUrl(
        `https://${host}/20240229123000/${originalUrl}`,
        { originalUrl, now },
      ).archiveHost).toBe(host);
    }
    expect(() => parseArchiveTodayMementoUrl(
      `https://archive.ph.evil.example/20240229123000/${originalUrl}`,
      { originalUrl, now },
    )).toThrow("allowlisted archive host");
    expect(() => parseArchiveTodayMementoUrl(
      `https://archive.ph/submit/?url=${encodeURIComponent(originalUrl)}`,
      { originalUrl, now },
    )).toThrow("timestamped read-only snapshot path");
    expect(() => parseArchiveTodayMementoUrl(
      `http://evil.example/20240229123000/${originalUrl}`,
      { originalUrl, now },
    )).toThrow("allowlisted archive host");
  });
});
