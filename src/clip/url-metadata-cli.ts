#!/usr/bin/env bun
import { resolve } from "node:path";

import { createRustMetadataSearchProvider, type SearchProvider } from "./metadata-search.js";
import {
  backfillSavedUrlMetadata,
  type UrlMetadataBackfillReport,
} from "./url-metadata-backfill.js";
import { findKbPackageRoot } from "./package-root.js";
import { sanitizeTerminalText } from "./terminal.js";

export const urlMetadataUsage = `kb url-metadata — backfill bounded metadata for saved URLs

Usage:
  kb url-metadata backfill [--root <vault>] [--search-binary <path>] [--refresh]
    [--archive | --no-archive] [--delay-ms <milliseconds>]
    [--max-results <count>] [--timeout <milliseconds>] [--json]

From the @hraness/kb package directory, build the search helper from the immutable
metadata-search-engine-rs revision:
  bun run url-metadata:tool:build
`;

type Output = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

const defaultOutput: Output = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

type ParsedUrlMetadataArguments =
  | { readonly kind: "help" }
  | {
      readonly kind: "backfill";
      readonly root: string;
      readonly binaryPath: string;
      readonly refresh: boolean;
      readonly discoverArchives: boolean;
      readonly delayMs: number;
      readonly maxResults: number;
      readonly timeoutMs: number;
      readonly json: boolean;
    };

type ParseResult =
  | { readonly ok: true; readonly value: ParsedUrlMetadataArguments }
  | { readonly ok: false; readonly message: string; readonly json: boolean };

export type UrlMetadataCliDependencies = {
  readonly createSearchProvider?: (binaryPath: string) => SearchProvider;
  readonly backfill?: typeof backfillSavedUrlMetadata;
};

function integer(value: string, minimum: number, maximum: number): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export function metadataSearchBinaryPath(
  packageRoot = findKbPackageRoot(),
  platform = process.platform,
): string {
  const executable = platform === "win32" ? "kb-url-metadata-search.exe" : "kb-url-metadata-search";
  return resolve(packageRoot, "src", "clip", "metadata-search-tool", "target", "release", executable);
}

function defaultBinaryPath(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = environment.HRANESS_KB_METADATA_SEARCH_BINARY;
  if (configured !== undefined && configured.trim() !== "") return resolve(configured);
  return metadataSearchBinaryPath();
}

export function parseUrlMetadataArguments(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ParseResult {
  const command = arguments_[0];
  const jsonRequested = arguments_.includes("--json");
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { ok: true, value: { kind: "help" } };
  }
  if (command !== "backfill") {
    return { ok: false, message: "url-metadata accepts only the backfill subcommand", json: jsonRequested };
  }

  let root = "kb";
  let binaryPath = defaultBinaryPath(environment);
  let refresh = false;
  let discoverArchives = true;
  let delayMs = 1_000;
  let maxResults = 20;
  let timeoutMs = 15_000;
  let json = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--refresh") refresh = true;
    else if (argument === "--archive") discoverArchives = true;
    else if (argument === "--no-archive") discoverArchives = false;
    else if (argument === "--json") json = true;
    else if (
      argument === "--root"
      || argument === "--search-binary"
      || argument === "--delay-ms"
      || argument === "--max-results"
      || argument === "--timeout"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `${argument} requires a value`, json: jsonRequested };
      }
      index += 1;
      if (argument === "--root") root = value;
      else if (argument === "--search-binary") binaryPath = resolve(value);
      else if (argument === "--delay-ms") {
        const parsed = integer(value, 0, 60_000);
        if (parsed === null) return { ok: false, message: "--delay-ms must be an integer from 0 through 60000", json: jsonRequested };
        delayMs = parsed;
      } else if (argument === "--max-results") {
        const parsed = integer(value, 1, 20);
        if (parsed === null) return { ok: false, message: "--max-results must be an integer from 1 through 20", json: jsonRequested };
        maxResults = parsed;
      } else {
        const parsed = integer(value, 500, 15_000);
        if (parsed === null) return { ok: false, message: "--timeout must be an integer from 500 through 15000", json: jsonRequested };
        timeoutMs = parsed;
      }
    } else {
      return { ok: false, message: `unknown url-metadata option: ${argument ?? ""}`, json: jsonRequested };
    }
  }
  if (root.trim() === "") return { ok: false, message: "--root must not be empty", json: jsonRequested };
  return {
    ok: true,
    value: {
      kind: "backfill",
      root,
      binaryPath,
      refresh,
      discoverArchives,
      delayMs,
      maxResults,
      timeoutMs,
      json,
    },
  };
}

function terminalJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, candidate: unknown) => typeof candidate === "string" ? sanitizeTerminalText(candidate) : candidate,
    2,
  )}\n`;
}

function renderReport(report: UrlMetadataBackfillReport): string {
  const counts = report.statusCounts;
  return [
    `URL metadata: ${report.processedRecords} processed, ${report.skippedRecords} resumed, ${report.remainingRecords} remaining.`,
    `Writes: ${report.writtenRecords} new or refreshed, ${report.unchangedRecords} unchanged.`,
    `Status: ${counts.matched} matched, ${counts.partial} partial, ${counts.notFound} not found, ${counts.unavailable} unavailable.`,
  ].join("\n") + "\n";
}

/** Dedicated entry point, delegated by the main `kb` CLI. */
export async function main(
  rawArguments: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: Output = defaultOutput,
  dependencies: UrlMetadataCliDependencies = {},
): Promise<number> {
  const parsed = parseUrlMetadataArguments(rawArguments, environment);
  if (!parsed.ok) {
    if (parsed.json) output.stdout(terminalJson({ ok: false, error: parsed.message }));
    else output.stderr(`error: ${sanitizeTerminalText(parsed.message)}\n\n${urlMetadataUsage}`);
    return 2;
  }
  if (parsed.value.kind === "help") {
    output.stdout(urlMetadataUsage);
    return 0;
  }
  try {
    const provider = (dependencies.createSearchProvider ?? ((binaryPath) =>
      createRustMetadataSearchProvider({ binaryPath })))(parsed.value.binaryPath);
    const report = await (dependencies.backfill ?? backfillSavedUrlMetadata)({
      vaultRoot: parsed.value.root,
      refresh: parsed.value.refresh,
      discoverArchives: parsed.value.discoverArchives,
      interRequestDelayMs: parsed.value.delayMs,
      maxResults: parsed.value.maxResults,
      searchTimeoutMs: parsed.value.timeoutMs,
    }, { searchProvider: provider });
    if (parsed.value.json) output.stdout(terminalJson({ ok: !report.aborted, ...report }));
    else output.stdout(renderReport(report));
    if (report.aborted) return 130;
    return report.statusCounts.unavailable > 0 ? 3 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.value.json) output.stdout(terminalJson({ ok: false, error: message }));
    else output.stderr(`error: ${sanitizeTerminalText(message)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
