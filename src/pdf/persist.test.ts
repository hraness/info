import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type {
  PdfCaptureManifest,
  PdfImageCandidate,
} from "./model.js";
import { persistPdfCapture } from "./persist.js";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly root: string;
  readonly outputBase: string;
  readonly sourcePath: string;
  readonly image: PdfImageCandidate;
  readonly manifest: PdfCaptureManifest;
} {
  const root = mkdtempSync(join(tmpdir(), "kb-pdf-persist-test-"));
  roots.push(root);
  const outputBase = join(root, "articles");
  const sourcePath = join(root, "input.pdf");
  const imagePath = join(root, "image.png");
  const source = Buffer.from("%PDF-1.4\n%%EOF\n");
  writeFileSync(sourcePath, source);
  writeFileSync(imagePath, png);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const imageSha256 = createHash("sha256").update(png).digest("hex");
  const image: PdfImageCandidate = {
    id: `page-1-image-1-${imageSha256.slice(0, 12)}`,
    page: 1,
    sourcePath: imagePath,
    top: 100,
    left: 80,
    width: 400,
    height: 200,
    bytes: png.length,
    sha256: imageSha256,
    mimeType: "image/png",
  };
  const manifest: PdfCaptureManifest = {
    schemaVersion: 1,
    kind: "pdf",
    capturedAt: "2026-07-23T12:00:00.000Z",
    status: "complete",
    source: {
      originalFilename: "input.pdf",
      path: "source.pdf",
      mimeType: "application/pdf",
      bytes: source.length,
      sha256: sourceSha256,
    },
    document: {
      title: "Input",
      author: null,
      subject: null,
      keywords: null,
      creator: null,
      producer: null,
      createdAt: null,
      modifiedAt: null,
      pageCount: 1,
      encrypted: false,
      processedPages: 1,
    },
    extraction: {
      layout: "pdftohtml-xml",
      popplerVersion: "25.05.0",
      ocr: "tesseract",
      headingCount: 1,
      textBlockCount: 1,
      imageCount: 1,
      textImageCount: 0,
      mixedImageCount: 1,
      visualImageCount: 0,
    },
    images: [{
      id: image.id,
      page: 1,
      top: image.top,
      left: image.left,
      width: image.width,
      height: image.height,
      asset: {
        path: `assets/${imageSha256}.png`,
        mimeType: "image/png",
        bytes: png.length,
        sha256: imageSha256,
      },
      kind: "mixed",
      method: "tesseract",
      confidence: 90,
      wordCount: 4,
      metadata: null,
    }],
    annotations: null,
    embeddedPlatforms: [],
    warnings: [],
  };
  return { root, outputBase, sourcePath, image, manifest };
}

describe("PDF bundle persistence", () => {
  test("atomically writes source, manifest, Markdown, and content-addressed assets", () => {
    const value = fixture();
    const target = persistPdfCapture({
      outputBase: value.outputBase,
      slug: "input",
      force: false,
      sourcePath: value.sourcePath,
      markdown: "# Input\n\n![image](assets/example.png)\n",
      manifest: value.manifest,
      images: [value.image],
    });

    expect(readFileSync(join(target, "source.pdf"))).toEqual(readFileSync(value.sourcePath));
    expect(readFileSync(join(target, value.manifest.images[0]?.asset.path ?? ""))).toEqual(png);
    expect(JSON.parse(readFileSync(join(target, "capture.json"), "utf8"))).toMatchObject({
      kind: "pdf",
      schemaVersion: 1,
    });
    expect(readdirSync(value.outputBase).filter((name) => name.startsWith(".pdf-capture-"))).toEqual([]);
  });

  test("refuses unowned replacement and restores an owned bundle after install failure", () => {
    const value = fixture();
    const target = persistPdfCapture({
      outputBase: value.outputBase,
      slug: "input",
      force: false,
      sourcePath: value.sourcePath,
      markdown: "# Original\n",
      manifest: value.manifest,
      images: [value.image],
    });
    const original = readFileSync(join(target, "input.md"), "utf8");

    expect(() => persistPdfCapture({
      outputBase: value.outputBase,
      slug: "input",
      force: true,
      sourcePath: value.sourcePath,
      markdown: "# Replacement\n",
      manifest: value.manifest,
      images: [value.image],
      afterInstall: () => {
        throw new Error("simulated commit failure");
      },
    })).toThrow("simulated commit failure");
    expect(readFileSync(join(target, "input.md"), "utf8")).toBe(original);
    expect(existsSync(join(target, "capture.json"))).toBe(true);
    expect(readdirSync(value.outputBase).filter((name) => name.startsWith(".pdf-capture-"))).toEqual([]);
  });
});
