import { describe, expect, test } from "bun:test";

import type { AcquiredPage } from "./acquire.js";

import {
  MAX_RENDERED_PAGE_FALLBACK_BYTES,
  canonicalizeUrl,
  chooseBestExtraction,
  countDefuddleConversationItems,
  countWords,
  detectPlatform,
  defuddleWorkerUrl,
  extractPage,
  retainDefuddleMedia,
  restoreXPostLineBreaks,
  schemaCommentCount,
  type Platform,
} from "./extract.js";

test("resolves the Defuddle worker beside source and compiled entrypoints", () => {
  expect(defuddleWorkerUrl("file:///project/src/clip/extract.ts").href).toBe(
    "file:///project/src/clip/defuddle-worker.ts",
  );
  expect(defuddleWorkerUrl("file:///project/dist/cli.js").href).toBe(
    "file:///project/dist/clip/defuddle-worker.js",
  );
});

describe("platform and canonical URL detection", () => {
  const platformCases: readonly (readonly [string, Platform])[] = [
    ["https://x.com/user/status/1", "x"],
    ["https://publication.substack.com/p/post", "substack"],
    ["https://news.ycombinator.com/item?id=1", "hacker-news"],
    ["https://old.reddit.com/r/test/comments/abc/post", "reddit"],
    ["https://bsky.app/profile/a/post/b", "bluesky"],
    ["https://www.linkedin.com/posts/example", "linkedin"],
    ["https://mobile.twitter.com/user/status/1", "x"],
    ["https://redd.it/abc123", "reddit"],
    ["https://fb.com/story.php?id=1", "facebook"],
    ["https://github.com/hraness/kb/issues/42", "github"],
    ["https://meta.discourse.org/t/a-topic/12345", "discourse"],
    ["https://example.com/article", "generic"],
  ];
  test.each(platformCases)("classifies %s", (url, platform) => expect(detectPlatform(new URL(url))).toBe(platform));

  test("drops tracking state but preserves content query parameters", () => {
    expect(canonicalizeUrl(new URL("https://twitter.com/a/status/1?s=46&t=secret&utm_source=x")).href).toBe(
      "https://x.com/a/status/1",
    );
    expect(canonicalizeUrl(new URL("https://example.com/search?q=term&utm_medium=email#part")).href).toBe(
      "https://example.com/search?q=term",
    );
  });

  test("does not persist credential-shaped query parameters", () => {
    const canonical = canonicalizeUrl(new URL("https://example.com/story?id=4&access_token=secret&X-Amz-Signature=signed"));
    expect(canonical.href).toBe("https://example.com/story?id=4");
  });
});

describe("Defuddle extraction", () => {
  test("deduplicates separately reported main images and video posters after URL resolution", () => {
    const content = "Post body\n\n![Existing](https://media.example/cover.jpg)\n";
    const retained = retainDefuddleMedia(content, {
      image: "/cover.jpg",
      captureVideoPosters: [
        "https://media.example/cover.jpg",
        "/poster.jpg?width=1200",
        "https://person:secret@media.example/rejected.jpg",
      ],
    }, new URL("https://media.example/post/1"));
    expect(retained.split("https://media.example/cover.jpg")).toHaveLength(2);
    expect(retained.split("https://media.example/poster.jpg?width=1200")).toHaveLength(2);
    expect(retained).toContain("![Video thumbnail]");
    expect(retained).not.toContain("secret");
  });

  test("ignores a Defuddle image candidate that resolves back to the captured page", () => {
    const retained = retainDefuddleMedia([
      "Video body",
      "",
      "![invalid page image](https://www.youtube.com/watch?v=video)",
      "",
      "![legitimate query image](https://www.youtube.com/watch?asset=poster)",
      "",
    ].join("\n"), {
      image: "https://i.ytimg.com/vi/video/hqdefault.jpg",
      captureVideoPosters: ["https://i.ytimg.com/vi/video/hqdefault.jpg"],
    }, new URL("https://www.youtube.com/watch?v=video"));
    expect(retained).not.toContain("![invalid page image]");
    expect(retained).toContain("![legitimate query image](https://www.youtube.com/watch?asset=poster)");
    expect(retained).toContain("https://i.ytimg.com/vi/video/hqdefault.jpg");
  });

  test("runs the X extractor in a Bun worker with DOM Node position constants", async () => {
    const worker = new Worker(defuddleWorkerUrl().href, { type: "module" });
    try {
      const html = `<!doctype html><html><body>
        <main aria-label="Timeline: Conversation">
          <div data-testid="cellInnerDiv"><article data-testid="tweet">
            <div data-testid="User-Name"><a href="/alice">Alice</a><a href="/alice">@alice</a></div>
            <div data-testid="tweetText">Root post</div>
            <a href="/alice/status/123"><time datetime="2026-07-22T12:00:00.000Z"></time></a>
          </article></div>
          <div data-testid="cellInnerDiv"><article data-testid="tweet">
            <div data-testid="User-Name"><a href="/bob">Bob</a><a href="/bob">@bob</a></div>
            <div data-testid="tweetText">Direct reply</div>
            <a href="/bob/status/124"><time datetime="2026-07-22T12:01:00.000Z"></time></a>
          </article></div>
        </main>
      </body></html>`;
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Defuddle worker fixture timed out")), 5_000);
        worker.onmessage = (event: MessageEvent<unknown>): void => {
          clearTimeout(timeout);
          if (typeof event.data !== "object" || event.data === null || !("ok" in event.data) || event.data.ok !== true
            || !("value" in event.data) || typeof event.data.value !== "object" || event.data.value === null) {
            reject(new Error("Defuddle worker fixture failed"));
            return;
          }
          resolve(event.data.value as Record<string, unknown>);
        };
        worker.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Defuddle worker fixture crashed"));
        };
        worker.postMessage({
          html,
          url: "https://x.com/alice/status/123",
          includeReplies: true,
        });
      });
      expect(result.extractorType).toBe("twitter");
      expect(result.content).toContain("Root post");
      expect(result.content).toContain("Direct reply");
    } finally {
      worker.terminate();
    }
  });

  test("restores deliberate X post line breaks from the extractor description", () => {
    const flattened = "Header\n\nagent-browser supports this natively agent-browser network har start # browse agent-browser network har stop\n\nQuote";
    const description = "agent-browser supports this natively\n\nagent-browser network har start\n# browse\nagent-browser network har stop";
    expect(restoreXPostLineBreaks(flattened, description)).toBe(
      "Header\n\nagent-browser supports this natively\n\nagent-browser network har start\n\\# browse\nagent-browser network har stop\n\nQuote",
    );
    expect(restoreXPostLineBreaks("unrelated content", description)).toBe("unrelated content");
  });

  test("restores the target X text as literal prose rather than injected Markdown blocks", () => {
    const description = "agent-browser supports this natively\n# agent browses, clicks around\n> quoted\n- item\n![image](javascript:alert(1))";
    const result = restoreXPostLineBreaks(description.replace(/\s+/g, " "), description);
    expect(result).toContain("\n\\# agent browses, clicks around\n&gt; quoted\n\\- item\n!\\[image\\](javascript:alert(1))");
    expect(result).not.toContain("\n# agent browses");
    expect(result).not.toContain("\n> quoted");
    expect(result).not.toContain("\n- item");
    expect(result).not.toContain("![image](javascript:");
  });

  test("counts fixed Defuddle reply markers without treating article rules or headings as comments", () => {
    const twitterHtml = `<article>
      <div class="twitter post"><div class="post-content">root<hr>self reply<hr>self reply</div></div>
      <hr><div class="twitter comments"><h2>Comments</h2>
        <div class="comment"><div class="comment-content">one</div></div>
        <div class="comment"><div class="comment-content">two</div></div>
      </div></article>`;
    expect(countDefuddleConversationItems({ content: twitterHtml, extractorType: "twitter" }, "x")).toBe(4);
    expect(countDefuddleConversationItems({
      content: '<article><div class="linkedin comments"><div class="comment">one</div></div></article>',
      extractorType: "linkedin",
    }, "linkedin")).toBe(1);
    expect(countDefuddleConversationItems({
      content: '<article><div class="github comments"><div class="comment">one</div><div class="comment">two</div></div></article>',
      extractorType: "github",
    }, "github")).toBe(2);
    expect(countDefuddleConversationItems({
      content: '<article><div class="discourse comments"><div class="comment">one</div></div></article>',
      extractorType: "discourse",
    }, "discourse")).toBe(1);
    expect(countDefuddleConversationItems({
      content: "<article><h2>Comments</h2><hr><p>ordinary prose</p></article>",
      extractorType: "generic",
    }, "generic")).toBeNull();
  });

  test("counts a large Defuddle item tree exactly without a global match array", () => {
    const item = '<div class="comment"><div class="comment-content">reply</div></div>';
    expect(countDefuddleConversationItems({
      content: item.repeat(100_000),
      extractorType: "linkedin",
    }, "linkedin")).toBe(100_000);
  });

  test("scans malformed nested Defuddle tags in bounded linear work", () => {
    const malformed = `${"<div ".repeat(30_000)}>`;
    expect(countDefuddleConversationItems({
      content: malformed,
      extractorType: "linkedin",
    }, "linkedin")).toBe(0);
  });

  test("bounds schema.org traversal across deep, cyclic, and high-cardinality values", () => {
    let deep: Record<string, unknown> = { commentCount: "42" };
    for (let depth = 0; depth < 20_000; depth += 1) deep = { child: deep };
    expect(schemaCommentCount(deep)).toBe(42);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(schemaCommentCount(cyclic)).toBeNull();

    const beyondBudget: unknown[] = Array.from({ length: 55_000 }, () => null);
    beyondBudget.push({ commentCount: 99 });
    expect(schemaCommentCount(beyondBudget)).toBeNull();
    beyondBudget[100] = { commentCount: 7 };
    expect(schemaCommentCount(beyondBudget)).toBe(7);
  });

  test("counts large Unicode-whitespace text without materializing word tokens", () => {
    const words = 300_000;
    expect(countWords("word\u2003".repeat(words))).toBe(words);
    expect(countWords(" alpha\u00a0beta\u2028gamma\ufeffdelta ")).toBe(4);
  });

  test("preserves separate rendered conversation text when an article extractor drops the item tree", async () => {
    const acquired: AcquiredPage = {
      body: "<html><main><h1>Post</h1><p>This is a sufficiently detailed Substack article body for extraction.</p></main></html>",
      contentType: "text/html",
      finalUrl: new URL("https://publication.substack.com/p/post"),
      method: "browser-profile",
      warnings: [],
      renderedText: "Post\n\nThis is the article body.\n\nComments\n\nAlice: A visible reader response.",
    };
    const result = await extractPage(acquired, "comments", 30_000);
    expect(result?.status).toBe("partial");
    expect(result?.extractor).toContain("+rendered-context");
    expect(result?.article.content).toContain("Alice: A visible reader response.");
    expect(result?.warnings.some((warning) => warning.includes("no trustworthy item tree"))).toBeTrue();
  }, 30_000);

  test("does not append an X reply access gate or reward browser provenance", async () => {
    const body = "<html><head><title>A useful post</title></head><body><main><article><p>This is the clean post body with enough substantive words to extract reliably from either acquisition.</p></article></main></body></html>";
    const http = await extractPage({
      body,
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "http",
      warnings: [],
    }, "thread", 30_000);
    const browser = await extractPage({
      body,
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "browser-profile",
      warnings: [],
      renderedText: [
        "This is the clean post body with enough substantive words to extract reliably from either acquisition.",
        "Join X now to read replies",
        "Log in",
        "Sign up",
        "Terms Privacy Cookie Policy Accessibility Ads info More".repeat(40),
      ].join("\n\n"),
    }, "thread", 30_000);
    expect(http).not.toBeNull();
    expect(browser).not.toBeNull();
    expect(browser?.article.content).not.toContain("Join X now");
    expect(browser?.extractor).not.toContain("+rendered-context");
    expect(browser?.warnings.some((warning) => warning.includes("exposed an access gate"))).toBeTrue();
    expect(browser?.score).toBe(http?.score);
    expect(chooseBestExtraction([http!, browser!])?.acquisition.method).toBe("http");
  }, 60_000);

  test("recognizes the concatenated account shell emitted by the live X DOM", async () => {
    const browser = await extractPage({
      body: "<html><head><title>A useful post</title></head><body><main><article><p>This is a clean post body with enough substantive words for deterministic extraction.</p></article></main></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "browser-profile",
      warnings: [],
      renderedText: [
        "This is a clean post body with enough substantive words for deterministic extraction.",
        "Log inSign up",
        "## New to X?",
        "Sign up now to get your own personalized timeline!",
        "Terms of Service Privacy Policy Cookie Policy Accessibility Ads info More",
      ].join("\n\n"),
    }, "thread", 30_000);
    expect(browser?.extractor).not.toContain("+rendered-context");
    expect(browser?.article.content).not.toContain("New to X?");
    expect(browser?.warnings.some((warning) => warning.includes("exposed an access gate"))).toBeTrue();
  }, 30_000);

  test("extracts an article from acquired HTML", async () => {
    const result = await extractPage({
      body: "<!doctype html><html><head><title>A title</title><meta name=\"author\" content=\"A writer\"></head><body><article><p>This is a sufficiently substantive article body with several words for extraction.</p></article></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://example.com/post?utm_source=test"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      status: "complete",
      platform: "generic",
      extractor: "defuddle",
      article: { title: "A title", author: "A writer" },
    });
    expect(result?.canonicalUrl.href).toBe("https://example.com/post");
    expect(result?.article.content).toContain("sufficiently substantive article body");
  }, 30_000);

  test("retains a generic Defuddle main image and a video poster as localizable Markdown", async () => {
    const result = await extractPage({
      body: `<!doctype html><html><head>
        <title>Video article</title>
        <meta property="og:image" content="/images/cover.jpg">
      </head><body><article>
        <p>This article has enough substantive prose to remain the primary extracted body while media sidecars are retained.</p>
        <video src="/media/video.mp4" poster="/images/poster.jpg"></video>
      </article></body></html>`,
      contentType: "text/html",
      finalUrl: new URL("https://example.com/posts/video"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.article.content).toContain("https://example.com/images/cover.jpg");
    expect(result?.article.content).toContain("https://example.com/images/poster.jpg");
    expect(result?.article.content).toContain("![Cover image]");
    expect(result?.article.content).toContain("![Video thumbnail]");
  }, 30_000);

  test("retains both X post images and video posters", async () => {
    const result = await extractPage({
      body: `<!doctype html><html><head><title>X post</title></head><body>
        <article data-testid="tweet">
          <div data-testid="User-Name"><a>Alice</a><a>@alice</a></div>
          <div data-testid="tweetText">A substantive X post explains why preserving both diagrams and video thumbnails matters for later retrieval.</div>
          <div data-testid="tweetPhoto"><img alt="diagram" src="https://pbs.twimg.com/media/diagram.jpg?format=jpg&amp;name=small"></div>
          <video src="https://video.twimg.com/tweet.mp4" poster="https://pbs.twimg.com/amplify_video_thumb/poster.jpg?format=jpg&amp;name=large"></video>
        </article>
      </body></html>`,
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/123"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.article.content).toContain("https://pbs.twimg.com/media/diagram.jpg?format=jpg&name=large");
    expect(result?.article.content).toContain(
      "https://pbs.twimg.com/amplify_video_thumb/poster.jpg?format=jpg&name=large",
    );
  }, 30_000);

  test("does not duplicate the LinkedIn extractor's existing video poster", async () => {
    const poster = "https://media.licdn.com/dms/image/poster.jpg";
    const result = await extractPage({
      body: `<!doctype html><html><head><title>LinkedIn post</title></head><body>
        <article role="article" class="feed-shared-update-v2" data-urn="urn:li:activity:1">
          <div class="update-components-actor__title">Alice Example</div>
          <div class="update-components-text update-components-update-v2__commentary">
            This substantive LinkedIn post preserves its media context for agent retrieval.
          </div>
          <div class="update-components-image"><img alt="slide" src="https://media.licdn.com/dms/image/slide.jpg"></div>
          <div class="update-components-linkedin-video"><video src="https://media.licdn.com/video.mp4" poster="${poster}"></video></div>
        </article>
      </body></html>`,
      contentType: "text/html",
      finalUrl: new URL("https://www.linkedin.com/posts/example_activity-1"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.article.content).toContain("https://media.licdn.com/dms/image/slide.jpg");
    expect(result?.article.content.split(poster)).toHaveLength(2);
  }, 30_000);

  test("uses bounded rendered page text when an authenticated feed shell has no usable article body", async () => {
    const result = await extractPage({
      body: "<!doctype html><html><head><title>Signed-in workspace</title></head><body><main>Loading</main></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL("https://app.example.test/feed"),
      method: "browser-fresh",
      warnings: [],
      browserTitle: "Signed-in workspace",
      renderedText: [
        "# Signed-in workspace",
        "Home  Projects  Activity  Profile",
        "A visible feed card contains bounded, useful text from the authenticated page without requiring another navigation.",
        "A second visible card confirms this is substantive rendered content rather than an empty application shell.",
      ].join("\n\n"),
    }, "page");

    expect(result).toMatchObject({
      status: "partial",
      platform: "generic",
      capturedItems: 1,
      expectedItems: null,
      article: { title: "Signed-in workspace" },
    });
    expect(result?.extractor).toEndWith("rendered-page");
    expect(result?.article.content).toContain("A visible feed card");
    expect(result?.article.content).not.toContain("<main>");
    expect(result?.warnings.some((warning) => warning.includes("cannot prove feed completeness"))).toBeTrue();
  }, 30_000);

  test("keeps a usable article ahead of surrounding rendered account and feed text", async () => {
    const result = await extractPage({
      body: "<!doctype html><html><head><title>Focused article</title></head><body><article><p>This focused article body contains enough substantive prose for the platform-specific article extractor to retain it.</p></article></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL("https://example.com/articles/focused"),
      method: "browser-fresh",
      warnings: [],
      browserTitle: "Focused article",
      renderedText: "Home Projects Notifications Profile\n\nA much larger surrounding feed preview. ".repeat(200),
    }, "page");

    expect(result).toMatchObject({ status: "complete", extractor: "defuddle" });
    expect(result?.article.content).toContain("focused article body");
    expect(result?.article.content).not.toContain("surrounding feed preview");
    expect(result?.warnings.some((warning) => warning.includes("rendered-page text"))).toBeFalse();
  }, 30_000);

  test("does not use rendered background text to bypass an authentication gate", async () => {
    const result = await extractPage({
      body: "<html><head><title>Members only</title></head><body><main><p>Sign in to continue reading.</p></main></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL("https://example.com/private"),
      method: "browser-fresh",
      warnings: [],
      renderedText: "Home Profile\n\nBackground preview text must not turn this access gate into a successful capture. ".repeat(20),
    }, "page");

    expect(result?.status).toBe("auth-required");
    expect(result?.extractor).toBe("defuddle");
    expect(result?.article.content).not.toContain("Background preview");
  }, 30_000);

  test("caps rendered page fallback text by UTF-8 bytes and records both browser and local truncation", async () => {
    const result = await extractPage({
      body: "<html><head><title>Large feed</title></head><body><main>Loading</main></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL("https://app.example.test/large-feed"),
      method: "browser-fresh",
      warnings: [],
      browserTitle: "Large feed",
      renderedText: `A useful rendered feed begins here with enough substantive words for capture.\n\n${"🙂".repeat(100_000)}`,
      renderedTextTruncated: true,
    }, "page");

    expect(result?.status).toBe("partial");
    expect(new TextEncoder().encode(result?.article.content ?? "").byteLength).toBeLessThanOrEqual(
      MAX_RENDERED_PAGE_FALLBACK_BYTES,
    );
    expect(result?.article.content).toContain("[Rendered page text truncated at the bounded fallback limit.]");
    expect(result?.warnings.some((warning) => warning.includes(`${MAX_RENDERED_PAGE_FALLBACK_BYTES}-byte`))).toBeTrue();
  }, 30_000);

  test("honors a stricter acquisition byte limit for rendered page fallback text", async () => {
    const result = await extractPage({
      body: "<html><head><title>Bounded feed</title></head><body><main>Loading</main></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: new URL("https://app.example.test/bounded-feed"),
      method: "browser-fresh",
      warnings: [],
      browserTitle: "Bounded feed",
      renderedText: "A useful bounded feed card with substantive visible text. ".repeat(100),
      renderedTextByteLimit: 128,
    }, "page");

    expect(result?.status).toBe("partial");
    expect(new TextEncoder().encode(result?.article.content ?? "").byteLength).toBeLessThanOrEqual(128);
    expect(result?.warnings.some((warning) => warning.includes("128-byte fallback limit"))).toBeTrue();
  }, 30_000);

  test("marks access gates honestly", async () => {
    const result = await extractPage({
      body: "<html><head><title>Members only</title></head><body><main><p>Sign in to continue reading.</p></main></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://example.com/private"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.status).toBe("auth-required");
  }, 30_000);

  test("distinguishes compact block shells from prose discussing block messages", async () => {
    const blocked = await extractPage({
      body: "Access Denied\n\nYour request has been blocked. Please verify that you are a human before proceeding.",
      contentType: "text/plain",
      finalUrl: new URL("https://example.com/private"),
      method: "http",
      warnings: [],
      browserTitle: "Access Denied",
    }, "page");
    expect(blocked?.status).toBe("blocked");

    const troubleshooting = await extractPage({
      body: [
        "# Proxy troubleshooting notes",
        "A careful incident review should inspect request identifiers, response headers, deployment changes, and origin logs before changing infrastructure. ".repeat(20),
        "Support documentation often quotes CAPTCHA, unusual traffic, Cloudflare Ray ID, request blocked, and verify you are human so readers can recognize each symptom. ",
        "The final section explains why users sometimes see Access Denied and how to preserve enough context for an administrator to reproduce the issue safely.",
      ].join("\n\n"),
      contentType: "text/markdown",
      finalUrl: new URL("https://example.com/troubleshooting"),
      method: "http",
      warnings: [],
    }, "page");
    expect(troubleshooting?.wordCount).toBeGreaterThan(160);
    expect(troubleshooting?.status).toBe("complete");

    const shortGuide = await extractPage({
      body: "# How to troubleshoot Access Denied\n\nThis guide explains why an administrator may see Access Denied, how to compare a request identifier with origin logs, and how to test the narrowest safe configuration change.",
      contentType: "text/markdown",
      finalUrl: new URL("https://example.com/access-denied-guide"),
      method: "http",
      warnings: [],
    }, "page");
    expect(shortGuide?.status).toBe("complete");
  });

  test("does not mistake ordinary prose about signing in for an access gate", async () => {
    const result = await extractPage({
      body: "<html><head><title>How to sign in to AWS</title></head><body><main><p>This guide explains how to sign in to AWS safely, configure a hardware key, and verify that the expected account is active before making a change.</p></main></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://example.com/sign-in-guide"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.status).toBe("complete");
  }, 30_000);

  test("uses stable platform provenance instead of an ambiguous Defuddle site field", async () => {
    const result = await extractPage({
      body: "<html><head><title>Post</title><meta name=author content='Forward Tester'></head><body><main><p>A sufficiently substantive social post body for deterministic extraction provenance.</p></main></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.extractor).toBe("defuddle:x");
  }, 30_000);

  test("terminates HTML extraction at its CPU deadline", async () => {
    const started = performance.now();
    const pending = extractPage({
      body: "<html><body><article><p>Bounded extraction content.</p></article></body></html>",
      contentType: "text/html",
      finalUrl: new URL("https://example.com/bounded"),
      method: "http",
      warnings: [],
    }, "page", 1);
    let message = "";
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("deadline");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("passes through Markdown responses", async () => {
    const result = await extractPage({
      body: "# Native Markdown\n\nBody text from a negotiated Markdown response.",
      contentType: "text/markdown; charset=utf-8",
      finalUrl: new URL("https://example.com/native.md"),
      method: "http",
      warnings: [],
    }, "page");
    expect(result?.article.content).toStartWith("# Native Markdown");
  });

  test("bounds multi-megabyte browser titles and Markdown headings before retaining metadata", async () => {
    const hugeBrowserTitle = ` ${"B".repeat(2 * 1024 * 1024)} `;
    const browser = await extractPage({
      body: "A rendered page with enough useful prose to produce a valid bounded capture.",
      contentType: "text/plain",
      finalUrl: new URL("https://example.com/browser-title"),
      method: "browser-profile",
      warnings: [],
      browserTitle: hugeBrowserTitle,
    }, "page");
    expect(browser?.article.title?.length).toBe(2_048);
    expect(browser?.article.title).toEndWith("…");

    const hugeHeading = "H".repeat(2 * 1024 * 1024);
    const heading = await extractPage({
      body: `# ${hugeHeading}\n\nA plain Markdown body with enough useful prose to produce a valid capture.`,
      contentType: "text/markdown",
      finalUrl: new URL("https://example.com/heading"),
      method: "http",
      warnings: [],
    }, "page");
    expect(heading?.article.title?.length).toBe(2_048);
    expect(heading?.article.title).toEndWith("…");
  });

  test("bounds multi-megabyte Defuddle metadata before X line-break restoration", async () => {
    const hugeTitle = "T".repeat(1024 * 1024);
    const hugeDescription = `First line&#10;${"D".repeat(1024 * 1024)}`;
    const result = await extractPage({
      body: `<!doctype html><html><head><title>${hugeTitle}</title><meta name="description" content="${hugeDescription}"></head><body><article><p>A substantive post body that remains independent of its hostile metadata fields.</p></article></body></html>`,
      contentType: "text/html",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "http",
      warnings: [],
    }, "page", 30_000);
    expect(result?.article.title?.length).toBe(2_048);
    expect(result?.article.description?.length).toBe(8_192);
    expect(result?.article.title).toEndWith("…");
    expect(result?.article.description).toEndWith("…");
  }, 30_000);

  test("saturates quality marker scans on large Markdown input", async () => {
    const marker = "![alt](https://example.com/image)";
    const saturated = await extractPage({
      body: marker.repeat(2_000),
      contentType: "text/plain",
      finalUrl: new URL("https://example.com/saturated.md"),
      method: "http",
      warnings: [],
    }, "page");
    const veryLarge = await extractPage({
      body: marker.repeat(100_000),
      contentType: "text/plain",
      finalUrl: new URL("https://example.com/very-large.md"),
      method: "http",
      warnings: [],
    }, "page");
    expect(saturated?.score).toBe(67_555);
    expect(veryLarge?.score).toBe(saturated?.score);
  });

  test.each([
    ["https://www.instagram.com/p/ABC/", "instagram"],
    ["https://www.linkedin.com/posts/person_activity-123", "linkedin"],
    ["https://www.facebook.com/story.php?story_fbid=123&id=4", "facebook"],
    ["https://www.tiktok.com/@alice/video/123", "tiktok"],
    ["https://writer.substack.com/p/member-post", "substack"],
  ] as const)("accepts a bounded rendered-text fallback for %s", async (url, platform) => {
    const result = await extractPage({
      body: "A rendered, user-visible post body with enough substantive words to preserve as a best-effort page capture.",
      contentType: "text/plain; charset=utf-8",
      finalUrl: new URL(url),
      method: "browser-profile",
      warnings: [],
      browserTitle: "Rendered post",
    }, "page");
    expect(result).toMatchObject({ status: "partial", platform, extractor: "plain-text" });
  });

  test("marks rendered X text partial when its visible reply count was not loaded", async () => {
    const extracted = await extractPage({
      body: "## Post\n\nUseful post content that is long enough to capture.\n\nRead 20 replies",
      contentType: "text/plain; charset=utf-8",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "browser-fresh",
      warnings: [],
    }, "thread");
    expect(extracted?.expectedItems).toBe(20);
    expect(extracted?.capturedItems).toBe(0);
    expect(extracted?.status).toBe("partial");
  });

  test("does not claim an unverified conversational capture is complete", async () => {
    const extracted = await extractPage({
      body: "## Post\n\nUseful post content that is long enough to capture but exposes no authoritative thread total.",
      contentType: "text/plain; charset=utf-8",
      finalUrl: new URL("https://x.com/alice/status/1"),
      method: "browser-profile",
      warnings: [],
    }, "thread");
    expect(extracted).toMatchObject({ status: "partial", expectedItems: null, capturedItems: 0 });
  });

  test("never calls a truncated rendered page complete", async () => {
    const extracted = await extractPage({
      body: "A rendered page with enough useful prose to extract, but whose browser output stopped at a configured boundary.",
      contentType: "text/plain; charset=utf-8",
      finalUrl: new URL("https://example.com/large"),
      method: "browser-fresh",
      warnings: [],
      contentTruncated: true,
    }, "page");
    expect(extracted?.status).toBe("partial");
  });
});

test("chooses the highest-quality extraction deterministically", async () => {
  const short = await extractPage({
    body: "A short but usable plain text response with enough characters.",
    contentType: "text/plain",
    finalUrl: new URL("https://example.com/post"),
    method: "http",
    warnings: [],
  }, "page");
  const long = await extractPage({
    body: "A much longer plain response ".repeat(30),
    contentType: "text/plain",
    finalUrl: new URL("https://example.com/post"),
    method: "cookie-http",
    warnings: [],
  }, "page");
  expect(short).not.toBeNull();
  expect(long).not.toBeNull();
  expect(chooseBestExtraction([short!, long!])?.acquisition.method).toBe("cookie-http");
});

test("a complete candidate always outranks a much longer partial preview", async () => {
  const complete = await extractPage({
    body: "A compact complete article body with enough substantive content.",
    contentType: "text/plain",
    finalUrl: new URL("https://example.com/post"),
    method: "http",
    warnings: [],
  }, "page");
  const partial = await extractPage({
    body: "A very long rendered fallback preview. ".repeat(5_000),
    contentType: "text/plain",
    finalUrl: new URL("https://example.com/post"),
    method: "browser-profile",
    warnings: [],
  }, "page");
  expect(complete?.status).toBe("complete");
  expect(partial?.status).toBe("partial");
  expect(chooseBestExtraction([partial!, complete!])).toBe(complete);
});
