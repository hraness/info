export const pdfUsage = `kb pdf — save a local or public remote PDF as an auditable Markdown bundle

Usage:
  kb pdf <file-or-url> [--output <directory>] [--slug <slug>] [--annotations <json>] [--force] [--json]
  kb pdf save <file-or-url> [capture options]

Capture options:
  --output <directory>          Bundle parent (default: KB_PDF_OUTPUT or kb/articles)
  --slug <slug>                 Override the title-derived bundle name
  --annotations <json>         Optional hash-bound image interpretations from an agent
  --timeout-ms <milliseconds>  Per-tool timeout
  --max-pdf-bytes <size>       Input limit, for example 512mb
  --max-pages <count>          Maximum pages to process
  --max-images <count>         Maximum embedded images
  --max-asset-bytes <size>     Per-image limit
  --max-total-asset-bytes <size>
  --force                       Replace only a compatible PDF capture bundle
  --json                        Emit a machine-readable result
  --quiet                       Suppress progress and warning lines
`;

export type PdfCliArguments =
  | { readonly command: "help" }
  | {
      readonly command: "capture";
      readonly input: string;
      readonly outputBase: string;
      readonly slug?: string;
      readonly interpretationsPath?: string;
      readonly force: boolean;
      readonly json: boolean;
      readonly quiet: boolean;
      readonly timeoutMs?: number;
      readonly maxPdfBytes?: number;
      readonly maxPages?: number;
      readonly maxImages?: number;
      readonly maxAssetBytes?: number;
      readonly maxTotalAssetBytes?: number;
    };

export type ParsePdfArgumentsResult =
  | { readonly ok: true; readonly value: PdfCliArguments }
  | { readonly ok: false; readonly message: string };

const valueOptions = new Set([
  "--output",
  "--slug",
  "--annotations",
  "--timeout-ms",
  "--max-pdf-bytes",
  "--max-pages",
  "--max-images",
  "--max-asset-bytes",
  "--max-total-asset-bytes",
]);

function optionValue(
  arguments_: readonly string[],
  index: number,
  name: string,
): string | ParsePdfArgumentsResult {
  const value = arguments_[index + 1];
  return value === undefined || value.startsWith("--")
    ? { ok: false, message: `${name} requires a value` }
    : value;
}

function positiveInteger(value: string, name: string, maximum: number): number | string {
  if (!/^\d+$/u.test(value)) return `${name} must be a positive integer`;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : `${name} must be between 1 and ${maximum}`;
}

function byteSize(value: string, name: string, maximum: number): number | string {
  const match = /^(\d+)(b|kb|mb|gb)?$/iu.exec(value);
  if (match === null || match[1] === undefined) {
    return `${name} must be an integer byte size such as 500000, 25mb, or 1gb`;
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  const multiplier = unit === "gb"
    ? 1024 ** 3
    : unit === "mb"
      ? 1024 ** 2
      : unit === "kb"
        ? 1024
        : 1;
  const parsed = amount * multiplier;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : `${name} must be between 1 byte and ${maximum} bytes`;
}

/** Parse the delegated `kb pdf` surface without touching the filesystem. */
export function parsePdfArguments(
  rawArguments: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): ParsePdfArgumentsResult {
  if (
    rawArguments.length === 0
    || rawArguments[0] === "help"
    || rawArguments[0] === "--help"
    || rawArguments[0] === "-h"
  ) return { ok: true, value: { command: "help" } };

  let cursor = rawArguments[0] === "save" || rawArguments[0] === "capture" ? 1 : 0;
  const positional: string[] = [];
  let outputBase = environment.KB_PDF_OUTPUT ?? "kb/articles";
  let slug: string | undefined;
  let interpretationsPath: string | undefined;
  let force = false;
  let json = false;
  let quiet = false;
  let timeoutMs: number | undefined;
  let maxPdfBytes: number | undefined;
  let maxPages: number | undefined;
  let maxImages: number | undefined;
  let maxAssetBytes: number | undefined;
  let maxTotalAssetBytes: number | undefined;

  for (; cursor < rawArguments.length; cursor += 1) {
    const argument = rawArguments[cursor];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--quiet") {
      quiet = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      return { ok: false, message: `unknown PDF option: ${argument}` };
    }
    const rawValue = optionValue(rawArguments, cursor, argument);
    if (typeof rawValue !== "string") return rawValue;
    cursor += 1;
    if (argument === "--output") outputBase = rawValue;
    else if (argument === "--slug") slug = rawValue;
    else if (argument === "--annotations") interpretationsPath = rawValue;
    else if (argument === "--timeout-ms") {
      const parsed = positiveInteger(rawValue, argument, 10 * 60_000);
      if (typeof parsed === "string") return { ok: false, message: parsed };
      timeoutMs = parsed;
    } else if (argument === "--max-pages") {
      const parsed = positiveInteger(rawValue, argument, 10_000);
      if (typeof parsed === "string") return { ok: false, message: parsed };
      maxPages = parsed;
    } else if (argument === "--max-images") {
      const parsed = positiveInteger(rawValue, argument, 10_000);
      if (typeof parsed === "string") return { ok: false, message: parsed };
      maxImages = parsed;
    } else {
      const maximum = argument === "--max-asset-bytes" ? 2 * 1024 ** 3 : 8 * 1024 ** 3;
      const parsed = byteSize(rawValue, argument, maximum);
      if (typeof parsed === "string") return { ok: false, message: parsed };
      if (argument === "--max-pdf-bytes") maxPdfBytes = parsed;
      else if (argument === "--max-asset-bytes") maxAssetBytes = parsed;
      else maxTotalAssetBytes = parsed;
    }
  }

  const input = positional[0];
  if (input === undefined || positional.length !== 1) {
    return { ok: false, message: "kb pdf requires exactly one PDF path or public URL" };
  }
  if (input.length > 64 * 1024) {
    return { ok: false, message: "PDF input exceeds the 65536 code-unit limit" };
  }
  if (outputBase.trim() === "") return { ok: false, message: "--output must not be empty" };
  if (slug !== undefined && slug.trim() === "") return { ok: false, message: "--slug must not be empty" };

  return {
    ok: true,
    value: {
      command: "capture",
      input,
      outputBase,
      ...(slug === undefined ? {} : { slug }),
      ...(interpretationsPath === undefined ? {} : { interpretationsPath }),
      force,
      json,
      quiet,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxPdfBytes === undefined ? {} : { maxPdfBytes }),
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(maxImages === undefined ? {} : { maxImages }),
      ...(maxAssetBytes === undefined ? {} : { maxAssetBytes }),
      ...(maxTotalAssetBytes === undefined ? {} : { maxTotalAssetBytes }),
    },
  };
}
