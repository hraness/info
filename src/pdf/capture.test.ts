import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runPdfCapture } from "./capture.js";
import type {
  PdfCaptureDependencies,
  PdfImageInterpretation,
  PdfToolCommand,
  PdfToolCommandResult,
} from "./model.js";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const imageSha256 = createHash("sha256").update(png).digest("hex");
const imageId = `page-1-image-1-${imageSha256.slice(0, 12)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tsv(): string {
  const header = [
    "level",
    "page_num",
    "block_num",
    "par_num",
    "line_num",
    "word_num",
    "left",
    "top",
    "width",
    "height",
    "conf",
    "text",
  ].join("\t");
  const words = ["Ben", "leaves", "Zo", "today"].map((text, index) =>
    [5, 1, 1, 1, 1, index + 1, 0, 0, 10, 10, 92, text].join("\t"));
  return [header, ...words].join("\n");
}

function fakeDependencies(
  options: {
    readonly failOnTesseract?: boolean;
    readonly imageCount?: number;
  } = {},
): PdfCaptureDependencies {
  return {
    tools: {
      pdfinfo: "/fake/pdfinfo",
      pdftohtml: "/fake/pdftohtml",
      tesseract: "/fake/tesseract",
    },
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    runTool: async (specification: PdfToolCommand): Promise<PdfToolCommandResult> => {
      await Promise.resolve();
      const executable = specification.command[0];
      if (executable === "/fake/pdfinfo") {
        return {
          stdout: [
            "Title: Fixture PDF",
            "Author: Example",
            "Pages: 1",
            "Encrypted: no",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (executable === "/fake/pdftohtml") {
        const layoutPath = specification.command.at(-1);
        if (layoutPath === undefined) throw new Error("missing layout path");
        const imageCount = options.imageCount ?? 1;
        const images = Array.from({ length: imageCount }, (_, index) => {
          const imagePath = join(dirname(layoutPath), `layout-1_${index + 1}.png`);
          writeFileSync(imagePath, png);
          return `<image top="${210 + index * 40}" left="60" width="500" height="30" src="${basename(imagePath)}"/>`;
        });
        writeFileSync(layoutPath, `<pdf2xml producer="poppler" version="25.05.0">
<page number="1" position="absolute" top="0" left="0" height="1000" width="800">
<fontspec id="0" size="24" family="Helvetica" color="#000000"/>
<fontspec id="1" size="12" family="Helvetica" color="#000000"/>
<text top="70" left="60" width="500" height="30" font="0"><b>Fixture PDF</b></text>
<text top="130" left="60" width="500" height="16" font="1">A useful paragraph.</text>
${images.join("\n")}
</page>
</pdf2xml>`);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (executable === "/fake/tesseract") {
        if (options.failOnTesseract === true) throw new Error("annotations should skip OCR");
        return { stdout: tsv(), stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected tool: ${executable}`);
    },
  };
}

function sourceFixture(): { readonly root: string; readonly sourcePath: string; readonly outputBase: string } {
  const root = mkdtempSync(join(tmpdir(), "kb-pdf-capture-test-"));
  roots.push(root);
  const sourcePath = join(root, "fixture.pdf");
  writeFileSync(sourcePath, "%PDF-1.4\n%%EOF\n");
  return { root, sourcePath, outputBase: join(root, "articles") };
}

describe("PDF capture", () => {
  test("records remote source provenance in the manifest and Markdown", async () => {
    const fixture = sourceFixture();
    const outcome = await runPdfCapture({
      inputPath: fixture.sourcePath,
      outputBase: fixture.outputBase,
      remoteSource: {
        requestedUrl: "https://example.com/paper",
        finalUrl: "https://cdn.example.com/paper.pdf",
      },
    }, fakeDependencies());

    expect(outcome.manifest.source).toMatchObject({
      requestedUrl: "https://example.com/paper",
      finalUrl: "https://cdn.example.com/paper.pdf",
    });
    expect(outcome.markdown).toContain('source_url: "https://cdn.example.com/paper.pdf"');
  });

  test("keeps OCR-rich screenshots visible and classifies them as mixed", async () => {
    const fixture = sourceFixture();
    const outcome = await runPdfCapture({
      inputPath: fixture.sourcePath,
      outputBase: fixture.outputBase,
    }, fakeDependencies());

    expect(outcome.status).toBe("complete");
    expect(outcome.manifest.kind).toBe("pdf");
    expect(outcome.manifest.extraction.mixedImageCount).toBe(1);
    expect(outcome.manifest.images[0]).toMatchObject({
      id: imageId,
      kind: "mixed",
      method: "tesseract",
      wordCount: 4,
    });
    const markdown = readFileSync(outcome.markdownPath, "utf8");
    expect(markdown).toContain(`![PDF image from page 1](assets/${imageSha256}.png)`);
    expect(markdown).toContain("#### Text visible in image");
    expect(markdown).toContain("> Ben leaves Zo today");
    expect(readFileSync(outcome.sourcePath, "utf8")).toBe("%PDF-1.4\n%%EOF\n");
  });

  test("accepts hash-bound skill annotations with metadata and still embeds the image", async () => {
    const fixture = sourceFixture();
    const interpretation: PdfImageInterpretation = {
      id: imageId,
      sha256: imageSha256,
      kind: "mixed",
      markdown: "> **Ben**: I am leaving Zo.",
      method: "agent",
      metadata: {
        platform: "Slack",
        contentType: "message screenshot",
        channel: "#company",
        participants: ["Ben", "Ada"],
      },
    };
    const outcome = await runPdfCapture({
      inputPath: fixture.sourcePath,
      outputBase: fixture.outputBase,
      interpretations: [interpretation],
    }, fakeDependencies({ failOnTesseract: true }));

    expect(outcome.manifest.extraction.ocr).toBe("annotations");
    expect(outcome.manifest.embeddedPlatforms).toEqual(["Slack"]);
    expect(outcome.manifest.images[0]).toMatchObject({
      kind: "mixed",
      method: "agent",
      metadata: {
        platform: "Slack",
        channel: "#company",
      },
    });
    expect(outcome.markdown).toContain(`![message screenshot from page 1](assets/${imageSha256}.png)`);
    expect(outcome.markdown).toContain("#### Text visible in Slack image");
    expect(outcome.markdown).toContain("platform: Slack");
    expect(outcome.markdown).toContain("> **Ben**: I am leaving Zo.");
    expect(outcome.manifest.annotations).toMatchObject({
      path: "annotations.json",
      count: 1,
    });
    expect(JSON.parse(readFileSync(
      join(outcome.outputDirectory, "annotations.json"),
      "utf8",
    ))).toEqual([interpretation]);
  });

  test("records configured image limits as partial instead of aborting after Poppler output", async () => {
    const fixture = sourceFixture();
    const outcome = await runPdfCapture({
      inputPath: fixture.sourcePath,
      outputBase: fixture.outputBase,
      maxImages: 1,
    }, fakeDependencies({ imageCount: 3 }));

    expect(outcome.status).toBe("partial");
    expect(outcome.imageCount).toBe(1);
    expect(outcome.warnings.join(" ")).toContain("configured page, image, or text-fragment limit");
  });

  test("records configured asset byte limits as partial instead of aborting", async () => {
    const fixture = sourceFixture();
    const outcome = await runPdfCapture({
      inputPath: fixture.sourcePath,
      outputBase: fixture.outputBase,
      maxTotalAssetBytes: png.length,
    }, fakeDependencies({ imageCount: 3 }));

    expect(outcome.status).toBe("partial");
    expect(outcome.imageCount).toBe(1);
    expect(outcome.warnings.join(" ")).toContain("configured asset byte limit was reached");
  });
});
