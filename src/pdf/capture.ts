import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countWords } from "../clip/extract.js";
import { slugify } from "../clip/lib.js";
import { sanitizeTerminalText } from "../clip/terminal.js";
import { inspectPdf } from "./extract.js";
import {
  layoutBlocks,
  parsePdfImageInterpretations,
} from "./layout.js";
import {
  buildPdfMarkdown,
  type ResolvedPdfImage,
} from "./markdown.js";
import type {
  PdfCaptureDependencies,
  PdfCaptureManifest,
  PdfCaptureOptions,
  PdfCaptureOutcome,
  PdfImageCandidate,
  PdfImageInterpretation,
  PdfImageSemanticMetadata,
  PdfManifestImage,
} from "./model.js";
import {
  PDF_CAPTURE_MANIFEST_SCHEMA_VERSION,
  PDF_CAPTURE_ANNOTATIONS_FILENAME,
  PDF_CAPTURE_SOURCE_FILENAME,
} from "./model.js";
import { ocrPdfImage } from "./ocr.js";
import {
  pdfImageAssetPath,
  pdfMarkdownFilename,
  persistPdfCapture,
} from "./persist.js";
import { resolvePdfTools, runPdfToolCommand } from "./tools.js";

function parsedInterpretations(
  raw: readonly PdfImageInterpretation[] | undefined,
  images: readonly PdfImageCandidate[],
): {
  readonly byId: ReadonlyMap<string, PdfImageInterpretation>;
  readonly values: readonly PdfImageInterpretation[];
} {
  const parsed = raw === undefined ? [] : parsePdfImageInterpretations(raw);
  const candidates = new Map(images.map((image) => [image.id, image]));
  const output = new Map<string, PdfImageInterpretation>();
  for (const interpretation of parsed) {
    const image = candidates.get(interpretation.id);
    if (image === undefined) {
      throw new Error(`PDF image annotation does not match an extracted image: ${interpretation.id}`);
    }
    if (image.sha256 !== interpretation.sha256) {
      throw new Error(`PDF image annotation hash does not match the extracted image: ${interpretation.id}`);
    }
    output.set(interpretation.id, interpretation);
  }
  return { byId: output, values: parsed };
}

function sortedImages(images: readonly PdfImageCandidate[]): readonly PdfImageCandidate[] {
  return [...images].sort((left, right) =>
    left.page - right.page
    || left.top - right.top
    || left.left - right.left
    || left.id.localeCompare(right.id));
}

function normalizedMetadata(
  value: PdfImageSemanticMetadata | undefined,
): PdfImageSemanticMetadata | null {
  return value ?? null;
}

function resolvedAnnotation(
  image: PdfImageCandidate,
  annotation: PdfImageInterpretation,
): ResolvedPdfImage {
  const markdown = annotation.kind === "visual" ? "" : annotation.markdown;
  return {
    image,
    kind: annotation.kind,
    method: annotation.method ?? "manual",
    markdown,
    alt: annotation.kind === "visual" ? (annotation.alt ?? null) : null,
    confidence: null,
    wordCount: annotation.kind === "visual" ? 0 : countWords(markdown),
    metadata: normalizedMetadata(annotation.metadata),
  };
}

function embeddedPlatforms(images: readonly ResolvedPdfImage[]): readonly string[] {
  const byIdentity = new Map<string, string>();
  for (const image of images) {
    const platform = image.metadata?.platform?.trim();
    if (platform === undefined || platform === "") continue;
    const key = platform.toLocaleLowerCase("en-US");
    if (!byIdentity.has(key)) byIdentity.set(key, platform);
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function manifestImage(image: ResolvedPdfImage): PdfManifestImage {
  return {
    id: image.image.id,
    page: image.image.page,
    top: image.image.top,
    left: image.image.left,
    width: image.image.width,
    height: image.image.height,
    asset: {
      path: pdfImageAssetPath(image.image),
      mimeType: image.image.mimeType,
      bytes: image.image.bytes,
      sha256: image.image.sha256,
    },
    kind: image.kind,
    method: image.method,
    confidence: image.confidence,
    wordCount: image.wordCount,
    metadata: image.metadata,
  };
}

/** Inspect, OCR/annotate, render, and atomically persist one prepared PDF source. */
export async function runPdfCapture(
  options: PdfCaptureOptions,
  dependencies: PdfCaptureDependencies = {},
): Promise<PdfCaptureOutcome> {
  const callerOwnedWorkspace = options.workspaceDirectory !== undefined;
  const workspaceDirectory = options.workspaceDirectory
    ?? mkdtempSync(join(tmpdir(), "hraness-oh-pdf-"));
  try {
    const inspection = await inspectPdf({
      inputPath: options.inputPath,
      workspaceDirectory,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxPdfBytes === undefined ? {} : { maxPdfBytes: options.maxPdfBytes }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      ...(options.maxImages === undefined ? {} : { maxImages: options.maxImages }),
      ...(options.maxAssetBytes === undefined ? {} : { maxAssetBytes: options.maxAssetBytes }),
      ...(options.maxTotalAssetBytes === undefined ? {} : { maxTotalAssetBytes: options.maxTotalAssetBytes }),
    }, dependencies);
    const tools = resolvePdfTools(dependencies);
    const runTool = dependencies.runTool ?? runPdfToolCommand;
    const images = sortedImages(inspection.pages.flatMap((page) => page.images));
    const annotations = parsedInterpretations(options.interpretations, images);
    const resolvedImages: ResolvedPdfImage[] = [];
    const warnings = [...inspection.warnings];
    let unclassifiedImages = 0;
    let ocrWarningCount = 0;

    for (const image of images) {
      const annotation = annotations.byId.get(image.id);
      if (annotation !== undefined) {
        resolvedImages.push(resolvedAnnotation(image, annotation));
        continue;
      }
      const ocr = await ocrPdfImage(image, {
        tesseractPath: tools.tesseract,
        timeoutMs: options.timeoutMs ?? 120_000,
        runTool,
      });
      if (tools.tesseract === null) unclassifiedImages += 1;
      for (const warning of ocr.warnings) {
        warnings.push(`Page ${image.page} image ${image.id}: ${warning}`);
        ocrWarningCount += 1;
      }
      resolvedImages.push({
        image,
        kind: ocr.kind,
        method: tools.tesseract === null ? "unclassified" : "tesseract",
        markdown: ocr.markdown,
        alt: null,
        confidence: ocr.confidence,
        wordCount: ocr.wordCount,
        metadata: null,
      });
    }
    const platforms = embeddedPlatforms(resolvedImages);
    const status = warnings.length > 0 || unclassifiedImages > 0 || ocrWarningCount > 0
      ? "partial"
      : "complete";
    const filenameTitle = inspection.originalFilename.replace(/\.pdf$/iu, "").trim();
    const requestedSlug = options.slug ?? inspection.metadata.title ?? filenameTitle;
    const slug = slugify(sanitizeTerminalText(requestedSlug));
    if (slug === "") throw new Error("could not derive a safe PDF capture slug; pass an explicit slug");
    const blocks = layoutBlocks(inspection.pages);
    const byId = new Map(resolvedImages.map((image) => [image.image.id, image]));
    const capturedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const built = buildPdfMarkdown({
      slug,
      originalFilename: inspection.originalFilename,
      sourceSha256: inspection.sourceSha256,
      ...(options.remoteSource === undefined ? {} : { sourceUrl: options.remoteSource.finalUrl }),
      capturedDate: capturedAt.slice(0, 10),
      status,
      metadata: inspection.metadata,
      blocks,
      images: byId,
      embeddedPlatforms: platforms,
    });
    const textImageCount = resolvedImages.filter((image) => image.kind === "text").length;
    const mixedImageCount = resolvedImages.filter((image) => image.kind === "mixed").length;
    const visualImageCount = resolvedImages.filter((image) => image.kind === "visual").length;
    const annotationCount = resolvedImages.filter((image) =>
      image.method === "agent" || image.method === "manual").length;
    const tesseractCount = resolvedImages.filter((image) => image.method === "tesseract").length;
    const ocr: PdfCaptureManifest["extraction"]["ocr"] = annotationCount > 0 && tesseractCount > 0
      ? "mixed"
      : annotationCount > 0
        ? "annotations"
        : tesseractCount > 0
          ? "tesseract"
          : "unavailable";
    const finalWarnings = [...new Set(warnings)];
    const annotationsJson = annotations.values.length === 0
      ? null
      : `${JSON.stringify(annotations.values, null, 2)}\n`;
    const annotationsManifest: PdfCaptureManifest["annotations"] = annotationsJson === null
      ? null
      : {
          path: PDF_CAPTURE_ANNOTATIONS_FILENAME,
          count: annotations.values.length,
          bytes: Buffer.byteLength(annotationsJson),
          sha256: createHash("sha256").update(annotationsJson).digest("hex"),
        };
    const manifest: PdfCaptureManifest = {
      schemaVersion: PDF_CAPTURE_MANIFEST_SCHEMA_VERSION,
      kind: "pdf",
      capturedAt,
      status,
      source: {
        originalFilename: sanitizeTerminalText(inspection.originalFilename).slice(0, 4_096),
        path: PDF_CAPTURE_SOURCE_FILENAME,
        mimeType: "application/pdf",
        bytes: inspection.sourceBytes,
        sha256: inspection.sourceSha256,
        ...(options.remoteSource === undefined
          ? {}
          : {
              requestedUrl: options.remoteSource.requestedUrl,
              finalUrl: options.remoteSource.finalUrl,
            }),
      },
      document: {
        ...inspection.metadata,
        processedPages: inspection.processedPages,
      },
      extraction: {
        layout: "pdftohtml-xml",
        popplerVersion: inspection.popplerVersion,
        ocr,
        headingCount: built.headingCount,
        textBlockCount: built.textBlockCount,
        imageCount: resolvedImages.length,
        textImageCount,
        mixedImageCount,
        visualImageCount,
      },
      images: resolvedImages.map(manifestImage),
      annotations: annotationsManifest,
      embeddedPlatforms: platforms,
      warnings: finalWarnings,
    };
    const outputDirectory = persistPdfCapture({
      outputBase: options.outputBase,
      slug,
      force: options.force ?? false,
      sourcePath: inspection.inputPath,
      markdown: built.markdown,
      manifest,
      images,
      ...(annotationsJson === null ? {} : { annotationsJson }),
    });
    return {
      status,
      slug,
      outputDirectory,
      markdownPath: join(outputDirectory, pdfMarkdownFilename(slug)),
      sourcePath: join(outputDirectory, PDF_CAPTURE_SOURCE_FILENAME),
      wordCount: countWords(built.markdown),
      pageCount: inspection.metadata.pageCount,
      processedPages: inspection.processedPages,
      imageCount: images.length,
      warnings: finalWarnings,
      markdown: built.markdown,
      manifest,
    };
  } finally {
    if (!callerOwnedWorkspace) rmSync(workspaceDirectory, { recursive: true, force: true });
  }
}
