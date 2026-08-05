import { describe, expect, test } from "bun:test";

import {
  acquireArchiveTodaySnapshot as acquireArchiveTodaySnapshotImplementation,
  ArchiveTodayFailure,
  discoverArchiveTodaySnapshot as discoverArchiveTodaySnapshotImplementation,
  type ArchiveTodayDependencies,
  type ArchiveTodayFetch,
} from "./archive-today.js";
import type { SafeFetchOptions, SafeFetchResult } from "./network.js";

const now = new Date("2026-08-04T12:00:00.000Z");
const timestamp = "20260801072950";
const capturedAt = "2026-08-01T07:29:50.000Z";

function discoverArchiveTodaySnapshot(
  sourceUrl: string | URL,
  dependencies: ArchiveTodayDependencies = {},
) {
  return discoverArchiveTodaySnapshotImplementation(sourceUrl, {
    assertNetworkUrl: async () => {},
    ...dependencies,
  });
}

function acquireArchiveTodaySnapshot(
  sourceUrl: string | URL,
  snapshotUrl: string | URL,
  dependencies: ArchiveTodayDependencies = {},
) {
  return acquireArchiveTodaySnapshotImplementation(sourceUrl, snapshotUrl, {
    assertNetworkUrl: async () => {},
    ...dependencies,
  });
}

type FetchCall = {
  readonly url: URL;
  readonly options: SafeFetchOptions;
};

function fetchResult(
  status: number,
  overrides: Partial<SafeFetchResult> = {},
): SafeFetchResult {
  return {
    bytes: new Uint8Array(),
    finalUrl: new URL("https://archive.ph/"),
    status,
    contentType: null,
    etag: null,
    lastModified: null,
    location: null,
    ...overrides,
  };
}

function recordingFetch(
  result: SafeFetchResult | Error,
): { readonly calls: FetchCall[]; readonly fetch: ArchiveTodayFetch } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: (url, options) => {
      calls.push({ url: new URL(url), options });
      if (result instanceof Error) return Promise.reject(result);
      const finalUrl = result.finalUrl.href === "https://archive.ph/" ? new URL(url) : result.finalUrl;
      return Promise.resolve({ ...result, finalUrl });
    },
  };
}

function sequenceFetch(
  results: readonly SafeFetchResult[],
): { readonly calls: FetchCall[]; readonly fetch: ArchiveTodayFetch } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: (url, options) => {
      calls.push({ url: new URL(url), options });
      const result = results[calls.length - 1];
      return result === undefined
        ? Promise.reject(new Error("unexpected archive fetch"))
        : Promise.resolve(result);
    },
  };
}

async function archiveFailure(promise: Promise<unknown>): Promise<ArchiveTodayFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ArchiveTodayFailure) return error;
    throw error;
  }
  throw new Error("expected ArchiveTodayFailure");
}

describe("Archive.today discovery", () => {
  test("uses the fixed newest route once and accepts an exact timestamped memento", async () => {
    const source = "https://example.com/article?edition=morning#section";
    const request = recordingFetch(fetchResult(302, {
      location: `https://archive.ph/${timestamp}/https://example.com/article?edition=morning`,
    }));

    const outcome = await discoverArchiveTodaySnapshot(source, {
      fetch: request.fetch,
      now: () => now,
      monotonicNow: () => 0,
      timeoutMs: 1_234,
      userAgent: "archive-adapter-test",
    });

    expect(outcome).toEqual({
      status: "found",
      sourceUrl: "https://example.com/article?edition=morning",
      snapshot: {
        url: `https://archive.ph/${timestamp}/https://example.com/article?edition=morning`,
        capturedAt,
        sourceUrl: "https://example.com/article?edition=morning",
        discovery: "newest",
      },
    });
    expect(request.calls).toHaveLength(1);
    expect(request.calls[0]?.url.href).toBe(
      "https://archive.ph/newest/https://example.com/article?edition=morning",
    );
    expect(request.calls[0]?.url.pathname).not.toContain("submit");
    expect(request.calls[0]?.options).toMatchObject({
      timeoutMs: 1_234,
      maxBytes: 256 * 1024,
      allowPrivateNetwork: false,
      retries: 0,
      maxRedirects: 0,
      redirect: "manual",
      acceptStatuses: [403, 404, 429],
      userAgent: "archive-adapter-test",
    });
    expect(request.calls[0]?.options.cookieHeader).toBeUndefined();
    expect(request.calls[0]?.options.referer).toBeUndefined();
  });

  test("accepts root-relative redirects and known aliases, upgrading snapshot transport to HTTPS", async () => {
    const relative = recordingFetch(fetchResult(302, {
      location: `/${timestamp}/https://example.com/article`,
    }));
    const aliased = recordingFetch(fetchResult(302, {
      location: `http://archive.is/${timestamp}/https://example.com/article`,
    }));

    const [relativeOutcome, aliasOutcome] = await Promise.all([
      discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch: relative.fetch,
        now: () => now,
      }),
      discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch: aliased.fetch,
        now: () => now,
      }),
    ]);

    expect(relativeOutcome.status).toBe("found");
    expect(relativeOutcome.status === "found" ? relativeOutcome.snapshot.url : null).toBe(
      `https://archive.ph/${timestamp}/https://example.com/article`,
    );
    expect(aliasOutcome.status).toBe("found");
    expect(aliasOutcome.status === "found" ? aliasOutcome.snapshot.url : null).toBe(
      `https://archive.is/${timestamp}/https://example.com/article`,
    );
  });

  test("rejects malicious, lookalike, credentialed, and nonstandard-port Locations", async () => {
    const locations = [
      `https://attacker.example/${timestamp}/https://example.com/article`,
      `https://archive.ph.attacker.example/${timestamp}/https://example.com/article`,
      `https://archive.ph:444/${timestamp}/https://example.com/article`,
      `https://user@archive.ph/${timestamp}/https://example.com/article`,
      `//attacker.example/${timestamp}/https://example.com/article`,
      ` https://archive.ph/${timestamp}/https://example.com/article`,
      `https://archive.ph/${timestamp}/https://example.com/article\n`,
    ];

    for (const location of locations) {
      const request = recordingFetch(fetchResult(302, { location }));
      const outcome = await discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch: request.fetch,
        now: () => now,
      });
      expect(outcome).toEqual({
        status: "unavailable",
        sourceUrl: "https://example.com/article",
        reason: "invalid-snapshot",
      });
      expect(request.calls).toHaveLength(1);
    }
  });

  test("rejects a snapshot for another source and a future-dated snapshot", async () => {
    const mismatch = recordingFetch(fetchResult(302, {
      location: `https://archive.ph/${timestamp}/https://other.example/article`,
    }));
    const future = recordingFetch(fetchResult(302, {
      location: "https://archive.ph/20260805120000/https://example.com/article",
    }));

    expect(await discoverArchiveTodaySnapshot("https://example.com/article", {
      fetch: mismatch.fetch,
      now: () => now,
    })).toEqual({
      status: "unavailable",
      sourceUrl: "https://example.com/article",
      reason: "invalid-snapshot",
    });
    expect(await discoverArchiveTodaySnapshot("https://example.com/article", {
      fetch: future.fetch,
      now: () => now,
    })).toEqual({
      status: "unavailable",
      sourceUrl: "https://example.com/article",
      reason: "invalid-snapshot",
    });
  });

  test("classifies 404, 403, 429, provider failures, missing redirects, and unexpected pages", async () => {
    const notFound = recordingFetch(fetchResult(404, {
      bytes: new TextEncoder().encode("provider page body must stay private"),
    }));
    const throttled = recordingFetch(fetchResult(429, {
      bytes: new TextEncoder().encode("captcha body must stay private"),
    }));
    const forbidden = recordingFetch(fetchResult(403, {
      bytes: new TextEncoder().encode("captcha body must stay private"),
    }));
    const failed = recordingFetch(new Error("remote body: provider secret"));
    const missingLocation = recordingFetch(fetchResult(302));
    const unexpected = recordingFetch(fetchResult(200, {
      bytes: new TextEncoder().encode("captcha body must stay private"),
    }));

    const outcomes = await Promise.all([
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: notFound.fetch, now: () => now }),
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: throttled.fetch, now: () => now }),
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: forbidden.fetch, now: () => now }),
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: failed.fetch, now: () => now }),
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: missingLocation.fetch, now: () => now }),
      discoverArchiveTodaySnapshot("https://example.com/article", { fetch: unexpected.fetch, now: () => now }),
    ]);

    expect(outcomes).toEqual([
      { status: "not-found", sourceUrl: "https://example.com/article" },
      { status: "throttled", sourceUrl: "https://example.com/article" },
      { status: "throttled", sourceUrl: "https://example.com/article" },
      { status: "unavailable", sourceUrl: "https://example.com/article", reason: "request-failed" },
      { status: "unavailable", sourceUrl: "https://example.com/article", reason: "invalid-snapshot" },
      { status: "unavailable", sourceUrl: "https://example.com/article", reason: "unexpected-response" },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain("provider secret");
    expect(JSON.stringify(outcomes)).not.toContain("captcha body");
  });

  test("shares one deadline across source validation and discovery", async () => {
    let clock = 1_000;
    const request = recordingFetch(fetchResult(404));
    const outcome = await discoverArchiveTodaySnapshotImplementation("https://example.com/article", {
      assertNetworkUrl: (_url, _allowPrivate, timeoutMs) => {
        expect(timeoutMs).toBe(250);
        clock += 200;
        return Promise.resolve();
      },
      fetch: request.fetch,
      monotonicNow: () => clock,
      now: () => now,
      timeoutMs: 250,
    });
    expect(outcome.status).toBe("not-found");
    expect(request.calls[0]?.options.timeoutMs).toBe(50);
  });

  test("does not disclose invalid local or credentialed sources to the provider", async () => {
    let calls = 0;
    const fetch: ArchiveTodayFetch = () => {
      calls += 1;
      return Promise.resolve(fetchResult(404));
    };

    for (const source of [
      "http://127.0.0.1/private",
      "http://localhost/private",
      "https://user:secret@example.com/private",
      "https://example.com/private?access_token=secret",
      "https://example.com/private?X-Amz-Signature=secret&keep=1",
      "file:///private/path",
    ]) {
      const failure = await archiveFailure(discoverArchiveTodaySnapshot(source, { fetch, now: () => now }));
      expect(failure.code).toBe("invalid-source-url");
    }
    expect(calls).toBe(0);
  });

  test("does not disclose a public-looking source that resolves to a private address", async () => {
    let fetchCalls = 0;
    let assertionCalls = 0;
    const outcome = await discoverArchiveTodaySnapshot("https://rebind.example/private", {
      fetch: () => {
        fetchCalls += 1;
        return Promise.resolve(fetchResult(404));
      },
      assertNetworkUrl: () => {
        assertionCalls += 1;
        return Promise.reject(new Error("private DNS answer"));
      },
      now: () => now,
    });

    expect(outcome).toEqual({
      status: "unavailable",
      sourceUrl: "https://rebind.example/private",
      reason: "request-failed",
    });
    expect(assertionCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  test("never probes another alias when archive.ph is unavailable", async () => {
    const request = recordingFetch(new Error("offline"));
    const outcome = await discoverArchiveTodaySnapshot("https://example.com/article", {
      fetch: request.fetch,
      now: () => now,
    });

    expect(outcome.status).toBe("unavailable");
    expect(request.calls.map((call) => call.url.origin)).toEqual(["https://archive.ph"]);
  });

  test("rejects an invalid clock and unsafe adapter options before fetching", async () => {
    let calls = 0;
    const fetch: ArchiveTodayFetch = () => {
      calls += 1;
      return Promise.resolve(fetchResult(404));
    };
    const failures = await Promise.all([
      archiveFailure(discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch,
        now: () => new Date(Number.NaN),
      })),
      archiveFailure(discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch,
        now: () => {
          throw new Error("clock internals");
        },
      })),
      archiveFailure(discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch,
        now: () => now,
        userAgent: "unsafe\r\nheader",
      })),
      archiveFailure(discoverArchiveTodaySnapshot("https://example.com/article", {
        fetch,
        now: () => now,
        timeoutMs: 0,
      })),
    ]);
    expect(failures.map((failure) => failure.code)).toEqual([
      "invalid-clock",
      "invalid-clock",
      "invalid-options",
      "invalid-options",
    ]);
    expect(calls).toBe(0);
  });

  test("requires a matching source-network assertion with a custom discovery transport", async () => {
    let calls = 0;
    const failure = await archiveFailure(discoverArchiveTodaySnapshotImplementation(
      "https://example.com/article",
      {
        fetch: () => {
          calls += 1;
          return Promise.resolve(fetchResult(404));
        },
        now: () => now,
      },
    ));
    expect(failure.code).toBe("invalid-options");
    expect(calls).toBe(0);
  });
});

describe("Archive.today acquisition", () => {
  test("does not fetch a snapshot when the source fails public-network validation", async () => {
    let assertions = 0;
    let fetches = 0;
    const failure = await archiveFailure(acquireArchiveTodaySnapshotImplementation(
      "https://public-looking.example/article",
      `https://archive.ph/${timestamp}/https://public-looking.example/article`,
      {
        assertNetworkUrl: () => {
          assertions += 1;
          return Promise.reject(new Error("private DNS answer"));
        },
        fetch: () => {
          fetches += 1;
          return Promise.resolve(fetchResult(200));
        },
        now: () => now,
      },
    ));
    expect(failure.code).toBe("request-failed");
    expect(assertions).toBe(1);
    expect(fetches).toBe(0);
  });

  test("fetches a validated snapshot with bounded archive-only redirects", async () => {
    const source = "https://example.com/article";
    const requestedUrl = `http://archive.is/${timestamp}/${source}`;
    const finalUrl = `https://archive.ph/${timestamp}/${source}`;
    const body = "<!doctype html><html><body>archived article</body></html>";
    const request = sequenceFetch([
      fetchResult(302, {
        finalUrl: new URL(`https://archive.is/${timestamp}/${source}`),
        location: finalUrl,
      }),
      fetchResult(200, {
        bytes: new TextEncoder().encode(body),
        finalUrl: new URL(finalUrl),
        contentType: "text/html; charset=utf-8",
      }),
    ]);

    const page = await acquireArchiveTodaySnapshot(source, requestedUrl, {
      fetch: request.fetch,
      now: () => now,
      maxBytes: 12_345,
    });

    expect(page).toEqual({
      body,
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL(finalUrl),
      method: "archive-is",
      warnings: ["Captured from a validated Archive.today snapshot."],
    });
    expect(request.calls).toHaveLength(2);
    expect(request.calls[0]?.url.href).toBe(
      `https://archive.is/${timestamp}/${source}`,
    );
    expect(request.calls[0]?.options).toMatchObject({
      maxBytes: 12_345,
      allowPrivateNetwork: false,
      retries: 0,
      maxRedirects: 0,
      redirect: "manual",
      acceptStatuses: [403, 404, 429],
    });
    expect(request.calls[1]?.url.href).toBe(finalUrl);
    expect(request.calls[0]?.options.allowedRedirectOrigins).toBeUndefined();
  });

  test("refuses non-snapshot and mismatched-timestamp redirects before requesting them", async () => {
    const source = "https://example.com/article";
    const snapshot = `https://archive.ph/${timestamp}/${source}`;
    for (const location of [
      `https://archive.ph/submit/?url=${encodeURIComponent(source)}`,
      `https://archive.is/20260701000000/${source}`,
      `https://archive.is/${timestamp}/https://other.example/article`,
    ]) {
      const request = recordingFetch(fetchResult(302, { location }));
      const failure = await archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, {
        fetch: request.fetch,
        now: () => now,
      }));
      expect(failure.code).toBe("invalid-snapshot");
      expect(request.calls).toHaveLength(1);
      expect(request.calls[0]?.url.href).toBe(snapshot);
    }
  });

  test("revalidates the final URL after redirects", async () => {
    const source = "https://example.com/article";
    const snapshot = `https://archive.ph/${timestamp}/${source}`;
    const mismatch = recordingFetch(fetchResult(200, {
      bytes: new TextEncoder().encode("<html>wrong source</html>"),
      contentType: "text/html",
      finalUrl: new URL(`https://archive.is/${timestamp}/https://other.example/article`),
    }));
    const future = recordingFetch(fetchResult(200, {
      bytes: new TextEncoder().encode("<html>future</html>"),
      contentType: "text/html",
      finalUrl: new URL("https://archive.is/20260805120000/https://example.com/article"),
    }));

    const mismatchFailure = await archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, {
      fetch: mismatch.fetch,
      now: () => now,
    }));
    const futureFailure = await archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, {
      fetch: future.fetch,
      now: () => now,
    }));
    expect(mismatchFailure.code).toBe("invalid-snapshot");
    expect(futureFailure.code).toBe("invalid-snapshot");
  });

  test("classifies throttling and refuses empty or non-HTML bodies without leaking them", async () => {
    const source = "https://example.com/article";
    const snapshot = `https://archive.ph/${timestamp}/${source}`;
    const throttled = recordingFetch(fetchResult(429, {
      bytes: new TextEncoder().encode("secret captcha body"),
    }));
    const nonHtml = recordingFetch(fetchResult(200, {
      bytes: new TextEncoder().encode("secret binary body"),
      contentType: "application/octet-stream",
      finalUrl: new URL(snapshot),
    }));
    const empty = recordingFetch(fetchResult(200, {
      bytes: new TextEncoder().encode("  \n"),
      contentType: "text/html",
      finalUrl: new URL(snapshot),
    }));

    const failures = await Promise.all([
      archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, { fetch: throttled.fetch, now: () => now })),
      archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, { fetch: nonHtml.fetch, now: () => now })),
      archiveFailure(acquireArchiveTodaySnapshot(source, snapshot, { fetch: empty.fetch, now: () => now })),
    ]);
    expect(failures.map((failure) => failure.code)).toEqual([
      "throttled",
      "unsupported-content",
      "unsupported-content",
    ]);
    expect(failures.map((failure) => failure.message).join(" ")).not.toContain("secret");
  });

  test("rejects an unbound requested snapshot before making a network request", async () => {
    let calls = 0;
    const fetch: ArchiveTodayFetch = () => {
      calls += 1;
      return Promise.resolve(fetchResult(200));
    };
    const failure = await archiveFailure(acquireArchiveTodaySnapshot(
      "https://example.com/article",
      `https://attacker.example/${timestamp}/https://example.com/article`,
      { fetch, now: () => now },
    ));
    expect(failure.code).toBe("invalid-snapshot");
    expect(calls).toBe(0);
  });
});
