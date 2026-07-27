import { describe, expect, test } from "bun:test";

import {
  classifyPlatformUrl,
  parseBirdCapture,
  parseBlueskyCapture,
  parseHackerNewsCapture,
  parseRedditCapture,
  parseStructuredCapture,
  renderCapturedDocument,
  type CaptureResult,
  type CapturedDocument,
  type CapturedEntry,
} from "./platforms.js";

const documentFrom = (result: CaptureResult): CapturedDocument => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.document;
};

const descendants = (entry: CapturedEntry): CapturedEntry[] => {
  switch (entry.kind) {
    case "boundary":
    case "more":
      return [entry];
    case "unavailable":
      return [entry, ...entry.replies.flatMap(descendants)];
    case "content":
      return [entry, ...entry.quotes.flatMap(descendants), ...entry.replies.flatMap(descendants)];
  }
};

describe("platform URL classification", () => {
  test.each([
    ["https://x.com/ctatedev/status/2078889282404569267?s=46", "x"],
    ["https://mobile.twitter.com/user/status/123", "x"],
    ["https://news.ycombinator.com/item?id=42", "hacker-news"],
    ["https://old.reddit.com/r/typescript/comments/abc123/a_post/def456/", "reddit"],
    ["https://redd.it/abc123", "reddit"],
    ["https://bsky.app/profile/alice.example/post/3kxyz", "bluesky"],
    ["https://writer.substack.com/p/a-post", "substack"],
    ["https://www.instagram.com/reel/ABC_123/", "instagram"],
    ["https://www.linkedin.com/posts/person_activity-123", "linkedin"],
    ["https://www.facebook.com/story.php?story_fbid=123&id=4", "facebook"],
    ["https://www.tiktok.com/@alice/video/123", "tiktok"],
    ["https://www.threads.com/@alice/post/ABC123", "threads"],
    ["https://web.whatsapp.com/", "whatsapp"],
    ["https://www.youtube.com/watch?v=abc123", "youtube"],
    ["https://youtu.be/abc123?t=10", "youtube"],
    ["https://github.com/hraness/kb/issues/42#issuecomment-1", "github"],
    ["https://github.com/hraness/kb/pull/43/files", "github"],
    ["https://github.com/hraness/kb/discussions/44", "github"],
    ["https://meta.discourse.org/t/a-topic/12345/2", "discourse"],
    ["https://discuss.example.com/t/12345", "discourse"],
    ["https://example.com/t/a-product/12345", "generic"],
    ["https://example.com/post", "generic"],
  ] as const)("classifies %s as %s", (url, platform) => {
    expect(classifyPlatformUrl(url)?.platform).toBe(platform);
  });

  test("extracts stable platform identifiers and rejects impostors", () => {
    expect(classifyPlatformUrl("https://x.com/alice/status/123?utm_source=nope")).toEqual({
      platform: "x",
      href: "https://x.com/alice/status/123",
      handle: "alice",
      postId: "123",
    });
    expect(classifyPlatformUrl("https://news.ycombinator.com/item?id=900")?.platform).toBe("hacker-news");
    expect(classifyPlatformUrl("https://www.youtube.com/watch?v=abc123")).toMatchObject({
      platform: "youtube",
      contentId: "abc123",
    });
    expect(classifyPlatformUrl("https://www.threads.net/@alice/post/ABC123")).toMatchObject({
      platform: "threads",
      contentId: "ABC123",
    });
    expect(classifyPlatformUrl("https://github.com/hraness/kb/pull/43/files")).toMatchObject({
      platform: "github",
      owner: "hraness",
      repository: "kb",
      contentKind: "pull-request",
      contentId: "43",
    });
    expect(classifyPlatformUrl("https://meta.discourse.org/t/a-topic/12345/2")).toMatchObject({
      platform: "discourse",
      topicId: "12345",
    });
    expect(classifyPlatformUrl("https://x.com.evil.example/alice/status/123")?.platform).toBe("generic");
    expect(classifyPlatformUrl("https://github.com.evil.example/hraness/kb/issues/42")?.platform).toBe("generic");
    expect(classifyPlatformUrl("https://example.com/t/a-topic/12345")?.platform).toBe("generic");
    expect(classifyPlatformUrl("https://example.com/topics/a-topic/12345")?.platform).toBe("generic");
    expect(classifyPlatformUrl("javascript:alert(1)")).toBeNull();
    expect(classifyPlatformUrl("not a url")).toBeNull();
  });
});

describe("Bird JSON", () => {
  const quoted = {
    id: "9",
    text: "Quoted thought",
    author: { username: "bob", name: "Bob" },
    createdAt: "Tue Jul 21 12:00:00 +0000 2026",
    likeCount: 4,
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/quote.jpg", width: 800, height: 600 }],
  };
  const root = {
    id: "1",
    text: "Root of the thread",
    author: { username: "alice", name: "Alice" },
    createdAt: "2026-07-21T10:00:00Z",
    replyCount: 1,
    retweetCount: 2,
    likeCount: 3,
    quoteCount: 4,
    quotedTweet: quoted,
    media: [
      {
        type: "video",
        url: "https://pbs.twimg.com/media/preview.jpg",
        videoUrl: "https://video.twimg.com/video.mp4",
        previewUrl: "https://pbs.twimg.com/media/small.jpg",
      },
    ],
    article: { title: "A long-form title", previewText: "Preview" },
  };
  const reply = {
    id: "2",
    text: "A self-reply",
    author: { username: "alice", name: "Alice" },
    createdAt: "2026-07-21T10:05:00Z",
    inReplyToStatusId: "1",
  };

  test("normalizes read/thread wrappers, quotes, media, metrics, and reply relationships", () => {
    const document = documentFrom(
      parseBirdCapture({ tweets: [root, reply], nextCursor: "ignored" }, "https://x.com/alice/status/2"),
    );
    expect(document.title).toBe("A self-reply");
    expect(document.roots).toHaveLength(1);
    const first = document.roots[0];
    expect(first.kind).toBe("content");
    if (first.kind !== "content") throw new Error("expected content root");
    expect(first.id).toBe("1");
    expect(first.metrics).toEqual({ score: null, replies: 1, likes: 3, reposts: 2, quotes: 4 });
    expect(first.media[0]?.url).toBe("https://video.twimg.com/video.mp4");
    expect(first.quotes[0]?.kind).toBe("content");
    expect(first.replies[0]?.kind).toBe("content");

    const markdown = renderCapturedDocument(document);
    expect(markdown).toContain("**Alice (@alice)** · 2026-07-21T10:00:00.000Z");
    expect(markdown).toContain("[Video](<https://video.twimg.com/video.mp4>)");
    expect(markdown).toContain("Quoted thought");
    expect(markdown).toContain("A self-reply");
  });

  test("accepts a single read object and the generic dispatcher", () => {
    const document = documentFrom(parseStructuredCapture("x", root, "https://twitter.com/alice/status/1"));
    expect(document.platform).toBe("x");
    expect(document.title).toBe("A long-form title");
  });

  test("rejects malformed values without asserting them into owned types", () => {
    expect(parseBirdCapture(null, "https://x.com/a/status/1").ok).toBeFalse();
    expect(parseBirdCapture({ id: "1", text: 7, author: {} }, "https://x.com/a/status/1").ok).toBeFalse();
    expect(parseBirdCapture(root, "file:///tmp/post").ok).toBeFalse();
  });

  test("stops cyclic quotes and oversized arrays deterministically", () => {
    const cyclic: Record<string, unknown> = {
      id: "cycle",
      text: "Cycle",
      author: { username: "loop", name: "Loop" },
    };
    cyclic.quotedTweet = cyclic;
    const cycleDocument = documentFrom(parseBirdCapture(cyclic, "https://x.com/loop/status/1"));
    expect(descendants(cycleDocument.roots[0]).some((entry) => entry.kind === "boundary")).toBeTrue();
    expect(cycleDocument.warnings.join(" ")).toContain("cycle");

    const many = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 1),
      text: `Post ${index + 1}`,
      author: { username: "many", name: "Many" },
    }));
    const limited = documentFrom(
      parseBirdCapture(many, "https://x.com/many/status/1", { limits: { maxItems: 3 } }),
    );
    expect(descendants(limited.roots[0]).filter((entry) => entry.kind === "content").length).toBeLessThanOrEqual(3);
    expect(limited.warnings.join(" ")).toContain("truncated");
  });
});

describe("Hacker News Firebase items", () => {
  const root = {
    id: 100,
    type: "story",
    by: "alice",
    time: 1_700_000_000,
    title: "An interesting launch",
    text: "Intro<p>Read <a href=\"https://example.com/details\">the details</a>.",
    url: "https://example.com/launch",
    score: 42,
    descendants: 5,
    kids: [101, 102, 103, 999],
  };
  const descendantsInput = [
    { id: 101, type: "comment", by: "bob", time: 1_700_000_100, text: "First<p><i>nice</i>", kids: [104] },
    { id: 102, type: "comment", deleted: true, kids: [] },
    { id: 103, type: "comment", dead: true, kids: [] },
    { id: 104, type: "comment", by: "carol", text: "Cycle child", kids: [101] },
  ];

  test("preserves nested comments plus deleted, dead, missing, and cyclic states", () => {
    const document = documentFrom(
      parseHackerNewsCapture(
        { root, descendants: descendantsInput },
        "https://news.ycombinator.com/item?id=100",
      ),
    );
    const all = descendants(document.roots[0]);
    expect(all.some((entry) => entry.kind === "unavailable" && entry.reason === "deleted")).toBeTrue();
    expect(all.some((entry) => entry.kind === "unavailable" && entry.reason === "dead")).toBeTrue();
    expect(all.some((entry) => entry.kind === "unavailable" && entry.reason === "not-found")).toBeTrue();
    expect(all.some((entry) => entry.kind === "boundary" && entry.reason === "cycle")).toBeTrue();
    const markdown = renderCapturedDocument(document);
    expect(markdown).toContain("[the details](<https://example.com/details>)");
    expect(markdown).toContain("[Linked article](<https://example.com/launch>)");
    expect(markdown).toContain("deleted comment 102");
  });

  test("accepts an array envelope and rejects missing roots", () => {
    expect(parseHackerNewsCapture([], "https://news.ycombinator.com/item?id=1").ok).toBeFalse();
    expect(parseHackerNewsCapture({ root: { title: "No id" } }, "https://news.ycombinator.com/item?id=1").ok).toBeFalse();
    expect(
      parseHackerNewsCapture([root, ...descendantsInput], "https://news.ycombinator.com/item?id=100").ok,
    ).toBeTrue();
  });

  test("bounds depth, item count, and very long text", () => {
    const document = documentFrom(
      parseHackerNewsCapture(
        { root, descendants: descendantsInput },
        "https://news.ycombinator.com/item?id=100",
        { limits: { maxDepth: 2, maxItems: 3, maxTextLength: 8 } },
      ),
    );
    const all = descendants(document.roots[0]);
    expect(all.length).toBeLessThanOrEqual(6);
    expect(all.some((entry) => entry.kind === "boundary")).toBeTrue();
    expect(document.warnings.join(" ")).toContain("truncated");
  });

  test.each([100_000, 1_000_000])(
    "converts %i unmatched opening brackets in linear time",
    (length) => {
      const text = "<".repeat(length);
      const document = documentFrom(
        parseHackerNewsCapture(
          { root: { id: 1, title: "Malformed", text }, descendants: [] },
          "https://news.ycombinator.com/item?id=1",
          { limits: { maxTextLength: length } },
        ),
      );
      const entry = document.roots[0];
      expect(entry.kind).toBe("content");
      if (entry.kind === "content") expect(entry.text).toBe(text);
    },
  );

  test("preserves the supported Hacker News formatting conversions", () => {
    const document = documentFrom(
      parseHackerNewsCapture({
        root: {
          id: 1,
          title: "Formatting",
          text: "One<p>Two<br><b>bold</b> <em>soft</em><pre><code>x &amp; y</code></pre>",
        },
        descendants: [],
      }, "https://news.ycombinator.com/item?id=1"),
    );
    const entry = document.roots[0];
    expect(entry.kind).toBe("content");
    if (entry.kind === "content") {
      expect(entry.text).toBe("One\n\nTwo\n**bold** *soft*\n\n```\nx & y\n```");
    }
  });

  test("keeps entity-escaped active HTML inert after conversion", () => {
    const parsed = parseHackerNewsCapture({
      root: { id: 1, title: "Root", text: "&lt;img src=x onerror=alert(1)&gt; safe" },
      descendants: [],
    }, "https://news.ycombinator.com/item?id=1");
    const document = documentFrom(parsed);
    const rendered = renderCapturedDocument(document);
    expect(rendered).toContain("&lt;img&gt; safe");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("onerror=");
  });
});

describe("Reddit listing JSON", () => {
  const listing = (children: readonly unknown[]): Record<string, unknown> => ({
    kind: "Listing",
    data: { children },
  });
  const post = {
    kind: "t3",
    data: {
      id: "abc",
      title: "Ask Reddit something",
      author: "alice",
      created_utc: 1_700_000_000,
      selftext: "Post body",
      url: "https://example.com/reference",
      permalink: "/r/test/comments/abc/ask_reddit_something/",
      score: 10,
      num_comments: 4,
    },
  };
  const child = {
    kind: "t1",
    data: {
      id: "child",
      author: "carol",
      body: "Nested reply",
      permalink: "/r/test/comments/abc/post/child/",
      replies: "",
      score: -2,
    },
  };
  const comment = {
    kind: "t1",
    data: {
      id: "comment",
      author: "bob",
      body: "Top comment",
      created_utc: 1_700_000_100,
      permalink: "/r/test/comments/abc/post/comment/",
      replies: listing([child]),
      score: 3,
    },
  };
  const deleted = {
    kind: "t1",
    data: { id: "deleted", author: "[deleted]", body: "[deleted]", replies: "" },
  };
  const more = { kind: "more", data: { id: "more", count: 2, children: ["later1", "later2"] } };

  test("normalizes posts, nested comments, deletion markers, and more placeholders", () => {
    const document = documentFrom(
      parseRedditCapture(
        [listing([post]), listing([comment, deleted, more])],
        "https://www.reddit.com/r/test/comments/abc/ask_reddit_something/",
      ),
    );
    const all = descendants(document.roots[0]);
    expect(all.some((entry) => entry.kind === "content" && entry.id === "child")).toBeTrue();
    const nested = all.find((entry) => entry.kind === "content" && entry.id === "child");
    expect(nested?.kind === "content" ? nested.metrics.score : null).toBe(-2);
    expect(all.some((entry) => entry.kind === "unavailable" && entry.reason === "deleted")).toBeTrue();
    expect(all.some((entry) => entry.kind === "more" && entry.childIds.length === 2)).toBeTrue();
    const markdown = renderCapturedDocument(document);
    expect(markdown).toContain("[Linked page](<https://example.com/reference>)");
    expect(markdown).toContain("2 more comments (later1, later2)");
    expect(markdown).toContain("Nested reply");
  });

  test("rejects malformed listings and stops object cycles", () => {
    expect(parseRedditCapture({}, "https://reddit.com/r/a/comments/x/y").ok).toBeFalse();
    expect(
      parseRedditCapture([listing([{ kind: "t1", data: {} }])], "https://reddit.com/r/a/comments/x/y").ok,
    ).toBeFalse();

    const cyclicData: Record<string, unknown> = { id: "loop", author: "loop", body: "Again" };
    const cyclicThing: Record<string, unknown> = { kind: "t1", data: cyclicData };
    cyclicData.replies = listing([cyclicThing]);
    const document = documentFrom(
      parseRedditCapture(
        [listing([post]), listing([cyclicThing])],
        "https://reddit.com/r/test/comments/abc/post",
      ),
    );
    expect(descendants(document.roots[0]).some((entry) => entry.kind === "boundary")).toBeTrue();
  });

  test("caps oversized comment listings", () => {
    const comments = Array.from({ length: 50 }, (_, index) => ({
      kind: "t1",
      data: { id: `c${index}`, author: "bulk", body: "Body", replies: "" },
    }));
    const document = documentFrom(
      parseRedditCapture(
        [listing([post]), listing(comments)],
        "https://reddit.com/r/test/comments/abc/post",
        { limits: { maxItems: 4 } },
      ),
    );
    expect(descendants(document.roots[0]).filter((entry) => entry.kind === "content")).toHaveLength(4);
    expect(document.warnings.join(" ")).toContain("stopped");
  });
});

describe("Bluesky thread JSON", () => {
  const author = { did: "did:plc:alice", handle: "alice.example", displayName: "Alice" };
  const parent = {
    post: {
      uri: "at://did:plc:alice/app.bsky.feed.post/parent",
      author,
      record: { text: "Parent context", createdAt: "2026-07-21T09:00:00Z" },
    },
  };
  const quote = {
    uri: "at://did:plc:bob/app.bsky.feed.post/quote",
    author: { did: "did:plc:bob", handle: "bob.example", displayName: "Bob" },
    value: { text: "Quoted Bluesky post", createdAt: "2026-07-21T08:00:00Z" },
  };
  const main = {
    uri: "at://did:plc:alice/app.bsky.feed.post/main",
    author,
    record: {
      text: "Main Bluesky post",
      createdAt: "2026-07-21T10:00:00Z",
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: "https://example.com/bluesky-link",
          title: "Linked context",
          description: "Useful context",
        },
      },
    },
    replyCount: 2,
    repostCount: 3,
    likeCount: 4,
    quoteCount: 5,
    embed: {
      $type: "app.bsky.embed.recordWithMedia#view",
      media: {
        $type: "app.bsky.embed.images#view",
        images: [
          {
            fullsize: "https://cdn.bsky.app/img/full.jpg",
            thumb: "https://cdn.bsky.app/img/thumb.jpg",
            alt: "A useful diagram",
            aspectRatio: { width: 1200, height: 800 },
          },
        ],
      },
      record: { record: quote },
    },
  };
  const reply = {
    post: {
      uri: "at://did:plc:carol/app.bsky.feed.post/reply",
      author: { did: "did:plc:carol", handle: "carol.example", displayName: "Carol" },
      record: { text: "A reply", createdAt: "2026-07-21T11:00:00Z" },
    },
    replies: [],
  };

  test("retains parent context, replies, blocked nodes, quotes, images, and metrics", () => {
    const document = documentFrom(
      parseBlueskyCapture(
        {
          thread: {
            post: main,
            parent,
            replies: [reply, { $type: "app.bsky.feed.defs#blockedPost", uri: "at://blocked", blocked: true }],
          },
        },
        "https://bsky.app/profile/alice.example/post/main",
      ),
    );
    expect(document.ancestors).toHaveLength(1);
    const all = descendants(document.roots[0]);
    expect(all.some((entry) => entry.kind === "content" && entry.role === "quote")).toBeTrue();
    expect(all.some((entry) => entry.kind === "content" && entry.id.endsWith("/reply"))).toBeTrue();
    expect(all.some((entry) => entry.kind === "unavailable" && entry.reason === "blocked")).toBeTrue();
    const root = document.roots[0];
    if (root.kind !== "content") throw new Error("expected content root");
    expect(root.media[0]).toEqual({
      kind: "image",
      url: "https://cdn.bsky.app/img/full.jpg",
      previewUrl: "https://cdn.bsky.app/img/thumb.jpg",
      alt: "A useful diagram",
      title: null,
      dimensions: { width: 1200, height: 800 },
    });
    expect(root.media[1]?.kind).toBe("link");
    expect(root.media[1]?.url).toBe("https://example.com/bluesky-link");
    expect(root.metrics).toEqual({ score: null, replies: 2, likes: 4, reposts: 3, quotes: 5 });
    const markdown = renderCapturedDocument(document);
    expect(markdown).toContain("## Parent context");
    expect(markdown).toContain("Quoted Bluesky post");
    expect(markdown).toContain("![A useful diagram](https://cdn.bsky.app/img/full.jpg)");
  });

  test("rejects malformed roots and bounds cyclic/oversized replies", () => {
    expect(parseBlueskyCapture({}, "https://bsky.app/profile/a/post/b").ok).toBeFalse();
    expect(
      parseBlueskyCapture({ thread: { post: { uri: "at://bad", author } } }, "https://bsky.app/profile/a/post/b").ok,
    ).toBeFalse();

    const cyclicThread: Record<string, unknown> = { post: main };
    cyclicThread.replies = [cyclicThread];
    const cycleDocument = documentFrom(
      parseBlueskyCapture({ thread: cyclicThread }, "https://bsky.app/profile/alice.example/post/main"),
    );
    expect(descendants(cycleDocument.roots[0]).some((entry) => entry.kind === "boundary")).toBeTrue();

    const manyReplies = Array.from({ length: 40 }, (_, index) => ({
      post: {
        uri: `at://did:plc:user/app.bsky.feed.post/${index}`,
        author,
        record: { text: `Reply ${index}`, createdAt: "2026-07-21T11:00:00Z" },
      },
    }));
    const limited = documentFrom(
      parseBlueskyCapture(
        { thread: { post: main, replies: manyReplies } },
        "https://bsky.app/profile/alice.example/post/main",
        { limits: { maxItems: 3 } },
      ),
    );
    expect(descendants(limited.roots[0]).filter((entry) => entry.kind === "content").length).toBeLessThanOrEqual(3);
    expect(limited.warnings.join(" ")).toContain("stopped");
  });

  test("captures video playlists and thumbnails", () => {
    const videoPost = {
      ...main,
      embed: {
        $type: "app.bsky.embed.video#view",
        playlist: "https://video.bsky.app/watch/playlist.m3u8",
        thumbnail: "https://video.bsky.app/watch/poster.jpg",
        alt: "Demo video",
      },
    };
    const document = documentFrom(
      parseBlueskyCapture(
        { thread: { post: videoPost, replies: [] } },
        "https://bsky.app/profile/alice.example/post/main",
      ),
    );
    const root = document.roots[0];
    if (root.kind !== "content") throw new Error("expected content root");
    expect(root.media.some((item) => item.kind === "video" && item.previewUrl?.endsWith("poster.jpg"))).toBeTrue();
  });
});

test("Markdown rendering is deterministic and always includes source attribution", () => {
  const input = {
    id: "1",
    text: "Stable body",
    author: { username: "stable", name: "Stable" },
    createdAt: "2026-07-21T10:00:00Z",
  };
  const document = documentFrom(parseBirdCapture(input, "https://x.com/stable/status/1"));
  const first = renderCapturedDocument(document);
  expect(renderCapturedDocument(document)).toBe(first);
  expect(first).toStartWith("# Stable body\n\nSource:");
  expect(first).toEndWith("\n");
});

test("Markdown rendering exposes structured images to the asset localizer", () => {
  const document = documentFrom(parseBirdCapture({
    id: "1",
    text: "Post with image",
    author: { username: "alice" },
    media: [{ type: "photo", url: "https://images.example/photo.jpg", altText: "A useful diagram" }],
  }, "https://x.com/alice/status/1"));
  expect(renderCapturedDocument(document)).toContain("![A useful diagram](https://images.example/photo.jpg)");
});
