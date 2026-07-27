import { describe, expect, test } from "bun:test";

import type { CaptureArguments } from "./args.js";
import type { CapturedDocument } from "./platforms.js";
import { acquirePublicStructured, structuredCaptureFromDocument, type JsonFetcher } from "./structured.js";

const options = (url: string, overrides: Partial<CaptureArguments> = {}): CaptureArguments => ({
  command: "inspect",
  url: new URL(url),
  currentTab: false,
  slug: undefined,
  mode: "auto",
  scope: "comments",
  media: "none",
  evidence: "none",
  htmlFile: undefined,
  outputBase: "kb/articles",
  force: false,
  stdout: true,
  json: false,
  quiet: true,
  browserProfile: undefined,
  browserLive: false,
  cdp: undefined,
  cookieSources: [],
  cookieProfile: undefined,
  cookiesFile: undefined,
  timeoutMs: 1_000,
  maxItems: 20,
  maxDepth: 8,
  maxHtmlBytes: 1024 * 1024,
  maxAssetBytes: 1024,
  maxTotalAssetBytes: 1024,
  allowPrivateNetwork: false,
  userAgent: "test",
  ...overrides,
});

describe("public structured adapters", () => {
  test("recursively fetches Hacker News comments in stable child order", async () => {
    const fixtures = new Map([
      ["1", { id: 1, title: "Root", by: "alice", descendants: 2, kids: [2], time: 1 }],
      ["2", { id: 2, by: "bob", text: "First", kids: [3], time: 2 }],
      ["3", { id: 3, by: "cara", text: "Nested", time: 3 }],
    ]);
    const fetchJson: JsonFetcher = (url) => {
      const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1];
      return Promise.resolve(id === undefined ? null : fixtures.get(id));
    };
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1"), { fetchJson });
    expect(capture?.extraction.extractor).toBe("hacker-news-public-api");
    expect(capture?.extraction.status).toBe("complete");
    expect(capture?.extraction.capturedItems).toBe(2);
    expect(capture?.extraction.expectedItems).toBe(2);
    expect(capture?.extraction.article.content).toContain("Nested");
    expect(capture?.evidence).not.toContain("undefined");
  });

  test("marks a bounded Hacker News tree partial", async () => {
    const fetchJson: JsonFetcher = (url) => {
      const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1];
      return Promise.resolve(id === "1"
        ? { id: 1, title: "Root", descendants: 3, kids: [2, 3, 4] }
        : { id: Number(id), text: id });
    };
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1", { maxItems: 2 }), { fetchJson });
    expect(capture?.extraction.status).toBe("partial");
    expect(capture?.extraction.warnings.join(" ")).toContain("limit");
  });

  test("normalizes a stale declared comment count to the larger observed tree", async () => {
    const fixtures = new Map([
      ["1", { id: 1, title: "Root", descendants: 1, kids: [2, 3] }],
      ["2", { id: 2, text: "First" }],
      ["3", { id: 3, deleted: true }],
    ]);
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1"), {
      fetchJson: (url) => {
        const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1];
        return Promise.resolve(id === undefined ? null : fixtures.get(id));
      },
    });
    expect(capture?.extraction).toMatchObject({ status: "complete", capturedItems: 2, expectedItems: 2 });
    expect(capture?.extraction.warnings.join(" ")).toContain("declared 1");
  });

  test("resolves a Bluesky handle and parses its thread", async () => {
    const requests: URL[] = [];
    const fetchJson: JsonFetcher = (url) => {
      requests.push(url);
      if (url.pathname.endsWith("resolveHandle")) return Promise.resolve({ did: "did:plc:alice" });
      return Promise.resolve({
        thread: {
          post: {
            uri: "at://did:plc:alice/app.bsky.feed.post/abc",
            author: { handle: "alice.example", displayName: "Alice" },
            record: { text: "Hello", createdAt: "2026-07-21T00:00:00Z" },
            replyCount: 1,
          },
          replies: [{
            post: {
              uri: "at://did:plc:bob/app.bsky.feed.post/reply",
              author: { handle: "bob.example" },
              record: { text: "Hi", createdAt: "2026-07-21T00:01:00Z" },
            },
          }],
        },
      });
    };
    const capture = await acquirePublicStructured(options("https://bsky.app/profile/alice.example/post/abc"), { fetchJson });
    expect(capture?.extraction.status).toBe("complete");
    expect(capture?.extraction.article.content).toContain("Hello");
    expect(capture?.extraction.article.content).toContain("Hi");
    expect(requests[1]?.searchParams.get("uri")).toBe("at://did:plc:alice/app.bsky.feed.post/abc");
  });

  test("does not label an unavailable Bluesky page root complete", async () => {
    const capture = await acquirePublicStructured(options("https://bsky.app/profile/did:plc:alice/post/missing", {
      scope: "page",
    }), {
      fetchJson: () => Promise.resolve({
        thread: {
          $type: "app.bsky.feed.defs#notFoundPost",
          uri: "at://did:plc:alice/app.bsky.feed.post/missing",
          notFound: true,
        },
      }),
    });
    expect(capture?.extraction).toMatchObject({ status: "partial", capturedItems: 0, expectedItems: null });
  });

  test("captures Reddit's unofficial listing JSON with bounded comment parameters", async () => {
    const requests: URL[] = [];
    const capture = await acquirePublicStructured(options("https://www.reddit.com/r/test/comments/abc/a_post/", {
      maxItems: 5,
      maxDepth: 3,
    }), {
      fetchJson: (url) => {
        requests.push(url);
        return Promise.resolve([
          { kind: "Listing", data: { children: [{ kind: "t3", data: {
            id: "abc",
            title: "A post",
            author: "alice",
            selftext: "Root body",
            permalink: "/r/test/comments/abc/a_post/",
            num_comments: 1,
          } }] } },
          { kind: "Listing", data: { children: [{ kind: "t1", data: {
            id: "reply",
            author: "bob",
            body: "A useful reply",
            permalink: "/r/test/comments/abc/a_post/reply/",
            replies: "",
          } }], after: null } },
        ]);
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.href).toContain("/comments/abc.json");
    expect(requests[0]?.searchParams.get("limit")).toBe("4");
    expect(requests[0]?.searchParams.get("depth")).toBe("3");
    expect(capture?.extraction).toMatchObject({
      acquisition: { method: "reddit-json" },
      extractor: "reddit-json",
      status: "complete",
      capturedItems: 1,
      expectedItems: 1,
    });
    expect(capture?.extraction.article.content).toContain("A useful reply");
  });

  test("keeps Reddit page scope root-only and marks remaining pagination partial for comments", async () => {
    const fixture = [
      { kind: "Listing", data: { children: [{ kind: "t3", data: {
        id: "abc",
        title: "A post",
        selftext: "Root only",
        num_comments: 20,
      } }] } },
      { kind: "Listing", data: { after: "cursor-secret", children: [{ kind: "t1", data: {
        id: "reply",
        body: "Must not render in page scope",
        replies: "",
      } }] } },
    ];
    const page = await acquirePublicStructured(options("https://redd.it/abc", { scope: "page" }), {
      fetchJson: () => Promise.resolve(fixture),
    });
    expect(page?.extraction).toMatchObject({ status: "complete", capturedItems: 1, expectedItems: null });
    expect(page?.extraction.article.content).not.toContain("Must not render");
    expect(page?.evidence).not.toContain("Must not render");

    const comments = await acquirePublicStructured(options("https://redd.it/abc", { scope: "comments" }), {
      fetchJson: () => Promise.resolve(fixture),
    });
    expect(comments?.extraction.status).toBe("partial");
    expect(comments?.extraction.warnings.join(" ")).toContain("pagination cursor");
  });

  test("bounds Hacker News item allocations under one aggregate response budget", async () => {
    const allocations: number[] = [];
    const fetchJson: JsonFetcher = (url, maxBytes) => {
      allocations.push(maxBytes);
      const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1] ?? "1";
      const value = id === "1"
        ? { id: 1, title: "Root", descendants: 8, kids: [2, 3, 4, 5, 6, 7, 8, 9] }
        : { id: Number(id), text: "x".repeat(200) };
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
        return Promise.reject(new Error("bounded fixture response exceeded allocation"));
      }
      return Promise.resolve(value);
    };
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1", {
      maxHtmlBytes: 512,
      maxItems: 20,
    }), { fetchJson });
    expect(capture?.extraction.status).toBe("partial");
    expect(allocations[0]).toBe(512);
    expect(allocations.slice(1).every((allocation) => allocation <= 56)).toBeTrue();
    expect(capture?.extraction.warnings.join(" ")).toContain("exceeded allocation");
  });

  test("deduplicates adversarial Hacker News child lists before queueing", async () => {
    const requested: string[] = [];
    const duplicateKids = [...Array.from({ length: 100_000 }, () => 2), ...Array.from({ length: 18 }, (_, index) => index + 3)];
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1"), {
      fetchJson: (url) => {
        const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1] ?? "1";
        requested.push(id);
        return Promise.resolve(id === "1" ? { id: 1, title: "Root", kids: duplicateKids } : { id: Number(id) });
      },
    });
    expect(requested).toHaveLength(20);
    expect(new Set(requested).size).toBe(requested.length);
    expect(capture?.extraction.capturedItems).toBe(19);
    expect(capture?.extraction.warnings.join(" ")).toContain("duplicate or cyclic");
  });

  test("caps a default-size Hacker News queue at the remaining item budget", async () => {
    const requested: string[] = [];
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1", {
      maxItems: 500,
      maxHtmlBytes: 1024 * 1024,
    }), {
      fetchJson: (url) => {
        const id = /\/item\/(\d+)\.json$/.exec(url.pathname)?.[1] ?? "1";
        requested.push(id);
        return Promise.resolve(id === "1"
          ? { id: 1, title: "Root", kids: Array.from({ length: 120_000 }, (_, index) => index + 2) }
          : { id: Number(id) });
      },
    });
    expect(requested).toHaveLength(500);
    expect(capture?.extraction.capturedItems).toBe(499);
    expect(capture?.extraction.status).toBe("partial");
    expect(capture?.extraction.warnings.join(" ")).toContain("limit");
  });

  test("keeps Hacker News page scope root-only", async () => {
    const requests: string[] = [];
    const capture = await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1", {
      scope: "page",
    }), {
      fetchJson: (url) => {
        requests.push(url.pathname);
        return Promise.resolve({ id: 1, title: "Root", descendants: 2, kids: [2, 3] });
      },
    });
    expect(requests).toEqual(["/v0/item/1.json"]);
    expect(capture?.extraction).toMatchObject({ status: "complete", capturedItems: 1, expectedItems: null });
    expect(capture?.extraction.article.content).not.toContain("Reply");
  });

  test("passes Hacker News aggregate deadline slices to the JSON fetcher", async () => {
    const observedTimeouts: number[] = [];
    const fetchJson: JsonFetcher = (_url, _maxBytes, timeoutMs) => {
      if (timeoutMs !== undefined) observedTimeouts.push(timeoutMs);
      return Promise.resolve({ id: 1, title: "Root" });
    };
    await acquirePublicStructured(options("https://news.ycombinator.com/item?id=1", { scope: "page" }), { fetchJson });
    expect(observedTimeouts).toHaveLength(1);
    expect(observedTimeouts[0]).toBeGreaterThan(0);
    expect(observedTimeouts[0]).toBeLessThanOrEqual(1_000);
  });

  test("counts a large structured capture without materializing word tokens", () => {
    const bodyWords = 250_000;
    const document: CapturedDocument = {
      platform: "bluesky",
      sourceUrl: "https://bsky.app/profile/alice.example/post/large",
      title: "Large post",
      ancestors: [],
      roots: [{
        kind: "content",
        role: "post",
        id: "large",
        author: null,
        createdAt: null,
        sourceUrl: null,
        text: "word\u2003".repeat(bodyWords),
        media: [],
        metrics: { score: null, replies: null, likes: null, reposts: null, quotes: null },
        quotes: [],
        replies: [],
      }],
      warnings: [],
    };
    const capture = structuredCaptureFromDocument(
      options(document.sourceUrl, { scope: "page" }),
      document,
      {},
      "bluesky-api",
      [],
    );
    expect(capture.extraction.wordCount).toBe(bodyWords + 8);
  });

  test("does not claim public structured support for a private-API platform", async () => {
    const capture = await acquirePublicStructured(options("https://x.com/alice/status/1"), {
      fetchJson: () => Promise.reject(new Error("must not run")),
    });
    expect(capture).toBeNull();
  });
});
