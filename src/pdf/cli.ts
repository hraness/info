import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { redactSensitiveText } from "../clip/persist.js";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../clip/terminal.js";
import { parsePdfArguments, pdfUsage } from "./args.js";
import { runPdfCapture } from "./capture.js";
import { parsePdfImageInterpretations } from "./layout.js";
import { preparePdfSource, type PreparedPdfSource } from "./source.js";
import type {
  PdfCaptureDependencies,
  PdfCaptureOptions,
  PdfCaptureOutcome,
  PdfImageInterpretation,
} from "./model.js";

export type PdfCliOutput = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

const defaultOutput: PdfCliOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export type PdfCliDependencies = {
  readonly runPdfCapture?: typeof runPdfCapture;
  readonly captureDependencies?: PdfCaptureDependencies;
  readonly readInterpretations?: (path: string) => readonly PdfImageInterpretation[];
  readonly preparePdfSource?: typeof preparePdfSource;
};

function safe(value: string): string {
  return sanitizeTerminalLine(redactSensitiveText(value));
}

function terminalSafeJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, candidate: unknown) => typeof candidate === "string"
      ? sanitizeTerminalText(redactSensitiveText(candidate))
      : candidate,
    2,
  )}\n`;
}

function readInterpretations(path: string): readonly PdfImageInterpretation[] {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("PDF image annotations must be a regular JSON file");
  }
  if (stats.size > 16 * 1024 * 1024) {
    throw new Error("PDF image annotations exceed the 16MB limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch {
    throw new Error("PDF image annotations are not valid JSON");
  }
  return parsePdfImageInterpretations(value);
}

export function pdfCaptureSummary(outcome: PdfCaptureOutcome): Record<string, unknown> {
  return {
    ok: true,
    status: outcome.status,
    slug: outcome.slug,
    outputDirectory: outcome.outputDirectory,
    markdownPath: outcome.markdownPath,
    sourcePath: outcome.sourcePath,
    wordCount: outcome.wordCount,
    pageCount: outcome.pageCount,
    processedPages: outcome.processedPages,
    imageCount: outcome.imageCount,
    warnings: outcome.warnings,
    manifest: outcome.manifest,
  };
}

/** Delegated CLI entry point for the root `kb pdf` command. */
export async function main(
  rawArguments: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: PdfCliOutput = defaultOutput,
  dependencies: PdfCliDependencies = {},
): Promise<number> {
  const parsed = parsePdfArguments(rawArguments, environment);
  if (!parsed.ok) {
    output.stderr(`error: ${safe(parsed.message)}\n\n${sanitizeTerminalText(pdfUsage)}`);
    return 2;
  }
  const arguments_ = parsed.value;
  if (arguments_.command === "help") {
    output.stdout(sanitizeTerminalText(pdfUsage));
    return 0;
  }
  if (!arguments_.quiet && !arguments_.json) {
    output.stderr(`Saving PDF ${safe(arguments_.input)} ...\n`);
  }
  let preparedSource: PreparedPdfSource | null = null;
  try {
    const interpretations = arguments_.interpretationsPath === undefined
      ? undefined
      : (dependencies.readInterpretations ?? readInterpretations)(arguments_.interpretationsPath);
    preparedSource = await (dependencies.preparePdfSource ?? preparePdfSource)(
      arguments_.input,
      {
        ...(arguments_.timeoutMs === undefined ? {} : { timeoutMs: arguments_.timeoutMs }),
        ...(arguments_.maxPdfBytes === undefined ? {} : { maxPdfBytes: arguments_.maxPdfBytes }),
      },
    );
    const options: PdfCaptureOptions = {
      inputPath: preparedSource.inputPath,
      outputBase: arguments_.outputBase,
      ...(preparedSource.remoteSource === undefined ? {} : { remoteSource: preparedSource.remoteSource }),
      ...(arguments_.slug === undefined ? {} : { slug: arguments_.slug }),
      ...(interpretations === undefined ? {} : { interpretations }),
      force: arguments_.force,
      ...(arguments_.timeoutMs === undefined ? {} : { timeoutMs: arguments_.timeoutMs }),
      ...(arguments_.maxPdfBytes === undefined ? {} : { maxPdfBytes: arguments_.maxPdfBytes }),
      ...(arguments_.maxPages === undefined ? {} : { maxPages: arguments_.maxPages }),
      ...(arguments_.maxImages === undefined ? {} : { maxImages: arguments_.maxImages }),
      ...(arguments_.maxAssetBytes === undefined ? {} : { maxAssetBytes: arguments_.maxAssetBytes }),
      ...(arguments_.maxTotalAssetBytes === undefined
        ? {}
        : { maxTotalAssetBytes: arguments_.maxTotalAssetBytes }),
    };
    const outcome = await (dependencies.runPdfCapture ?? runPdfCapture)(
      options,
      dependencies.captureDependencies,
    );
    if (arguments_.json) output.stdout(terminalSafeJson(pdfCaptureSummary(outcome)));
    else {
      output.stdout(`Done: ${safe(outcome.markdownPath)}\n`);
      const pages = outcome.processedPages === outcome.pageCount
        ? `${outcome.pageCount} pages`
        : `${outcome.processedPages} of ${outcome.pageCount} pages processed`;
      output.stdout(
        `Status: ${outcome.status}; ${pages}; ${outcome.wordCount} words; ${outcome.imageCount} images.\n`,
      );
    }
    if (!arguments_.quiet && !arguments_.json) {
      for (const warning of outcome.warnings) output.stderr(`warning: ${safe(warning)}\n`);
    }
    return 0;
  } catch (error) {
    const message = safe(error instanceof Error ? error.message : String(error));
    if (arguments_.json) output.stdout(terminalSafeJson({ ok: false, error: message }));
    else output.stderr(`error: ${message}\n`);
    return 1;
  } finally {
    preparedSource?.dispose();
  }
}

if (import.meta.main) process.exitCode = await main();
