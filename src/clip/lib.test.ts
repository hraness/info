import { describe, expect, test } from "bun:test";

import {
  buildClipMarkdown,
  articleMetadataLimits,
  collectImageSources,
  CONTENT_REWRITE_TRUNCATION_WARNING,
  parseArticle,
  pickAssetName,
  resolveRemote,
  rewriteContent,
  rewriteContentWithStatus,
  scanImageSources,
  slugify,
  yamlString,
} from "./lib.js";
import { hasUnsafeTerminalCharacters } from "./terminal.js";

describe("article boundary", () => {
  test("accepts Defuddle Markdown and narrows optional metadata", () => {
    expect(parseArticle({
      content: "Body",
      title: "Title",
      author: "Author",
      published: "2026-07-17",
      description: "Description",
      contentMarkdown: "must not win",
    })).toEqual({
      content: "Body",
      title: "Title",
      author: "Author",
      published: "2026-07-17",
      description: "Description",
    });
  });

  test("rejects non-records and empty content", () => {
    expect(parseArticle(null)).toBeNull();
    expect(parseArticle({ content: "  " })).toBeNull();
  });

  test("bounds multi-megabyte foreign metadata with a visible truncation marker", () => {
    const huge = "A".repeat(10 * 1024 * 1024);
    const article = parseArticle({
      content: "Body",
      title: huge,
      author: huge,
      published: huge,
      description: huge,
    });
    expect(article?.title).toHaveLength(articleMetadataLimits.title);
    expect(article?.author).toHaveLength(articleMetadataLimits.author);
    expect(article?.published).toHaveLength(articleMetadataLimits.published);
    expect(article?.description).toHaveLength(articleMetadataLimits.description);
    expect(article?.title).toEndWith("…");

    const document = buildClipMarkdown({
      content: "ignored",
      title: huge,
      author: huge,
      published: huge,
      description: huge,
    }, {
      slug: "bounded",
      sourceHref: "https://example.com/",
      clipped: "2026-07-21",
      content: "Body",
    });
    expect(document.length).toBeLessThan(25_000);
    expect(document).toContain("…");
  });
});

describe("path and metadata hygiene", () => {
  test("turns an arbitrary title into one safe path segment", () => {
    expect(slugify(" ../A Writer’s Guide: Part 1 ")).toBe("a-writers-guide-part-1");
    expect(slugify("///...")).toBe("");
    expect(slugify("x".repeat(120))).toHaveLength(80);
    expect(slugify("日本語の記事")).toBe("日本語の記事");
    expect(slugify("A".repeat(10 * 1024 * 1024))).toBe("a".repeat(80));
  });

  test("keeps YAML metadata on one escaped line", () => {
    expect(yamlString('one "quote"\nand a \\ path')).toBe('"one \\"quote\\"\\nand a \\\\ path"');
    expect(yamlString("nul\0 bell\u0007 nel\u0085 bidi\u202e end separator\u2028next")).toBe(
      '"nul bell nel bidi end separator\\nnext"',
    );
    expect(yamlString("safe \u001b]52;c;c3RlYWw=\u0007 end")).toBe('"safe  end"');
    const giantScalar = yamlString("B".repeat(10 * 1024 * 1024));
    expect(giantScalar).toHaveLength(16_386);
    expect(giantScalar).toEndWith('…"');
  });

  test("sanitizes image names, infers extensions, and resolves collisions", () => {
    const taken = new Set<string>();
    const url = new URL("https://example.com/media/hero%20image");
    expect(pickAssetName(url, "image/webp; charset=binary", taken)).toBe("hero-image.webp");
    expect(pickAssetName(url, "image/webp", taken)).toBe("hero-image-2.webp");
    expect(pickAssetName(new URL("https://example.com/%zz.png"), "image/jpeg", taken)).toBe("zz.jpg");
  });
});

describe("Markdown rewriting", () => {
  const base = new URL("https://example.com/posts/one/");

  test("collects Markdown and HTML image targets without treating links as images", () => {
    const sources = collectImageSources([
      "![one](../one.png)",
      '![two](<two image.jpg> "title")',
      '<img alt="three" src="/three.svg">',
      "![four][asset]",
      "[asset]: /four.webp",
      "`![inline-code](/ignored-inline.png)`",
      "```markdown\n![fenced](/ignored-fenced.png)\n```",
      "[ordinary](/page)",
    ].join("\n"));
    expect([...sources]).toEqual(["../one.png", "two image.jpg", "/three.svg", "/four.webp"]);
  });

  test("caps multi-megabyte unique image fanout before materializing the candidate set", () => {
    const dense = Array.from(
      { length: 120_000 },
      (_, index) => `![image ${index}](https://images.example/${index}.png)`,
    ).join("\n");
    expect(dense.length).toBeGreaterThan(5 * 1024 * 1024);

    const scan = scanImageSources(dense, 32);
    expect(scan.truncated).toBeTrue();
    expect(scan.cardinalityExceeded).toBeTrue();
    expect(scan.requiresInertFallback).toBeTrue();
    expect(scan.sources.size).toBe(32);
    expect([...scan.sources].at(-1)).toBe("https://images.example/31.png");
  });

  test("maps only referenced definitions across dense high-cardinality reference Markdown", () => {
    const definitions = Array.from(
      { length: 100_000 },
      (_, index) => `[unused-${index}]: https://images.example/${index}.png`,
    ).join("\n");
    const input = `![wanted][asset]\n${definitions}\n[asset]: /wanted.png`;
    expect(input.length).toBeGreaterThan(4 * 1024 * 1024);

    const scan = scanImageSources(input, 4);
    expect(scan).toEqual({
      sources: new Set(["/wanted.png"]),
      truncated: false,
      cardinalityExceeded: false,
      requiresInertFallback: false,
    });
    const output = rewriteContent(input, base, new Map());
    expect(output).toStartWith("[remote image: wanted](https://example.com/wanted.png)");
    expect(output).toContain("[unused-99999]: https://images.example/99999.png");
  });

  test("fails closed on over-limit image sources and reference labels", () => {
    const longSource = `https://images.example/${"s".repeat(8_192)}`;
    const sourceScan = scanImageSources(`![oversized](${longSource})`, 4);
    expect(sourceScan).toEqual({
      sources: new Set(),
      truncated: true,
      cardinalityExceeded: false,
      requiresInertFallback: false,
    });
    const sourceOutput = rewriteContent(`![oversized](${longSource})`, base, new Map());
    expect(sourceOutput).toBe("*[omitted over-limit image: oversized]*");
    expect(sourceOutput).not.toContain("images.example");

    const longLabel = "l".repeat(1_025);
    const reference = `![oversized][${longLabel}]\n[${longLabel}]: /secret.png`;
    const referenceScan = scanImageSources(reference, 4);
    expect(referenceScan).toEqual({
      sources: new Set(),
      truncated: true,
      cardinalityExceeded: false,
      requiresInertFallback: false,
    });
    const referenceOutput = rewriteContent(reference, base, new Map());
    expect(referenceOutput).toContain("capture safety limits were exceeded");
    expect(referenceOutput).toContain("omitted over-limit image reference");
    expect(referenceOutput).not.toContain("https://example.com/secret.png");
  });

  test("localizes downloaded images and absolutizes remaining relative targets", () => {
    const input = [
      "![local](../one.png)",
      "![remote](/two.png)",
      "[page](../about)",
      '<img src="/three.svg">',
      "[mail](mailto:person@example.com)",
    ].join("\n");
    const output = rewriteContent(input, base, new Map([["../one.png", "assets/one.png"]]));
    expect(output).toContain("![local](assets/one.png)");
    expect(output).toContain("[remote image: remote](https://example.com/two.png)");
    expect(output).toContain("[page](https://example.com/posts/about)");
    expect(output).toContain("[remote image](https://example.com/three.svg)");
    expect(output).toContain("[mail](mailto:person@example.com)");
  });

  test("does not rewrite examples inside fenced code", () => {
    const input = "```markdown\n![example](/literal.png)\n```\n\n`![inline](/inline.png)`\n\n![real](/real.png)";
    const output = rewriteContent(input, base, new Map());
    expect(output).toContain("![example](/literal.png)");
    expect(output).toContain("`![inline](/inline.png)`");
    expect(output).toContain("[remote image: real](https://example.com/real.png)");
  });

  test("fails closed with bounded memory for dense protected Markdown spans", () => {
    const dense = "`x`".repeat((2 * 1024 * 1024) / 3);
    const output = rewriteContent(dense, base, new Map());
    expect(output).toContain("protected Markdown span limit was exceeded");
    expect(output).toContain("<pre>");
    expect(output).toContain("`x``x`");
    expect(output).toContain("source code unit(s) omitted");
    expect(output.length).toBeLessThan(300_000);

    const amplifying = "`x`".repeat(4_097) + "&".repeat(2 * 1024 * 1024);
    const bounded = rewriteContent(amplifying, base, new Map());
    expect(bounded.length).toBeLessThan(1_500_000);
    expect(bounded).toContain("source code unit(s) omitted");
  });

  test("reports bounded omission for dense prose followed by image or protected-markup adversaries", () => {
    const prose = "preserved prose ".repeat(24_000);
    expect(prose.length).toBeGreaterThan(256 * 1024);
    const variants = [
      `${prose}${"![x".repeat(250_001)}`,
      `${prose}${"`x`".repeat(4_097)}`,
    ];

    for (const input of variants) {
      const result = rewriteContentWithStatus(input, base, new Map());
      expect(result.truncated).toBeTrue();
      expect(result.content).toContain("source code unit(s) omitted");
      expect(result.content.length).toBeLessThan(input.length);
      expect(CONTENT_REWRITE_TRUNCATION_WARNING).toContain("reported as partial");
    }
  });

  test("handles malformed fence, backtick, and image-prefix adversaries with linear bounded fallbacks", () => {
    const unterminatedFences = "```x\n".repeat(100_000) + "tail";
    const fencedOutput = rewriteContent(unterminatedFences, base, new Map());
    expect(fencedOutput).toContain("protected Markdown span limit was exceeded");
    expect(fencedOutput).toContain("source code unit(s) omitted");
    expect(fencedOutput.length).toBeLessThan(1_500_000);

    const unmatchedBacktickRun = "`".repeat(2 * 1024 * 1024) + "x";
    const backtickOutput = rewriteContent(unmatchedBacktickRun, base, new Map());
    expect(backtickOutput).toHaveLength(unmatchedBacktickRun.length);
    expect(backtickOutput).toEndWith("x");

    const malformedImages = "![x".repeat(500_000);
    const imageOutput = rewriteContent(malformedImages, base, new Map());
    expect(imageOutput).toContain("image-candidate safety limit was exceeded");
    expect(imageOutput).toContain("source code unit(s) omitted");
    expect(imageOutput.length).toBeLessThan(1_500_000);

    for (const malformedMarkup of ["<img ".repeat(100_000), "<!--x".repeat(100_000)]) {
      const markupOutput = rewriteContent(malformedMarkup, base, new Map());
      expect(markupOutput).toContain("markup/image-candidate safety limit was exceeded");
      expect(markupOutput).toContain("source code unit(s) omitted");
      expect(markupOutput.length).toBeLessThan(1_500_000);
    }
  });

  test("neutralizes active Markdown targets and raw HTML outside code fences", () => {
    const input = [
      "![bad](javascript:alert(1))",
      "![inline](data:image/svg+xml,<svg onload=alert(1)></svg>)",
      "[click](javascript:alert(1))",
      "[reference][bad]",
      "[bad]: javascript:alert(1)",
      "![[../../private-note]]",
      '<img src="file:///etc/passwd" onerror="alert(1)">',
      '<a href="javascript:alert(1)" onclick="alert(1)">raw link</a>',
      '<strong onclick="alert(1)">safe structure</strong>',
      "```html",
      '<script>alert("example")</script>',
      "```",
    ].join("\n");
    const output = rewriteContent(input, new URL("https://example.com/post"), new Map());
    expect(output).not.toContain("javascript:");
    expect(output).not.toContain("data:image");
    expect(output).not.toContain("file:///etc/passwd");
    expect(output).not.toContain("onclick=");
    expect(output).toContain("[bad]: #");
    expect(output).toContain("*[omitted local embed: ../../private-note]*");
    expect(output).toContain("&lt;a&gt;raw link&lt;/a&gt;");
    expect(output).toContain("<strong>safe structure</strong>");
    expect(output).toContain('<script>alert("example")</script>');
  });

  test("localizes reference-style images and leaves failed remote images inert", () => {
    const input = ["![diagram][asset]", "", "[asset]: /diagram.png \"caption\""].join("\n");
    const local = rewriteContent(input, base, new Map([["/diagram.png", "assets/diagram.png"]]));
    const remote = rewriteContent(input, base, new Map());
    expect(local).toContain("![diagram](assets/diagram.png)");
    expect(remote).toContain("[remote image: diagram](https://example.com/diagram.png)");
    expect(remote).not.toContain("![diagram]");
  });

  test("strips opaque query credentials from failed remote image links", () => {
    const output = rewriteContent(
      "![private](https://cdn.example/image.jpg?kb=OPAQUE_SECRET&oe=DEADLINE#fragment)",
      new URL("https://example.com/post"),
      new Map(),
    );
    expect(output).toBe("[remote image: private](https://cdn.example/image.jpg)");
    expect(output).not.toContain("OPAQUE_SECRET");
  });

  test("escapes active markup in generated headings", () => {
    const output = buildClipMarkdown({
      content: "Body",
      title: "<img src=x onerror=alert(1)>",
      author: null,
      published: null,
      description: null,
    }, {
      slug: "safe",
      sourceHref: "https://example.com/",
      clipped: "2026-07-21",
      content: "Body",
    });
    expect(output).toContain("# &lt;img src=x onerror=alert(1)&gt;");
    expect(output).not.toContain("\n# <img");
  });
});

test("builds one complete article document", () => {
  const document = buildClipMarkdown(
    {
      content: "ignored original",
      title: "A title",
      author: "A writer",
      published: null,
      description: "A description",
    },
    {
      slug: "a-title",
      sourceHref: "https://example.com/a-title",
      clipped: "2026-07-17",
      content: "Body\n",
    },
  );
  expect(document).toContain('source: "https://example.com/a-title"');
  expect(document).toContain('clipped: "2026-07-17"');
  expect(document).not.toContain("published:");
  expect(document).toEndWith("# A title\n\nBody\n");
});

test("removes terminal protocols and bidi controls from generated Markdown", () => {
  const osc52 = "\u001b]52;c;c3RlYWwtY2xpcGJvYXJk\u0007";
  const document = buildClipMarkdown(
    { content: "ignored", title: "Café 漢字", author: null, published: null, description: null },
    {
      slug: "safe",
      sourceHref: "https://example.com/",
      clipped: "2026-07-21",
      content: `Before ${osc52} after \u202etxt.exe\u202c 🙂`,
    },
  );
  expect(document).toContain("Café 漢字");
  expect(document).toContain("Before  after txt.exe 🙂");
  expect(document).not.toContain("c3RlYWwtY2xpcGJvYXJk");
  expect(hasUnsafeTerminalCharacters(document)).toBeFalse();
});

test("resolves only HTTP targets", () => {
  const base = new URL("https://example.com/path/");
  expect(resolveRemote("../image.png", base)?.href).toBe("https://example.com/image.png");
  expect(resolveRemote("#part", base)).toBeNull();
  expect(resolveRemote("data:image/png;base64,abc", base)).toBeNull();
  expect(resolveRemote("file:///tmp/image.png", base)).toBeNull();
});
