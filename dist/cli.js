#!/usr/bin/env bun
// @bun
import {
  backfillSavedUrlMetadata,
  createRustMetadataSearchProvider
} from "./index-tpcs0zbm.js";
import {
  main as main2
} from "./index-t800m4cc.js";
import {
  initVault
} from "./index-mqx4nd6v.js";
import {
  MAX_PERCOLATION_MENTIONS,
  MAX_PERCOLATION_MENTION_PAIRS,
  MAX_PERCOLATION_NOTES,
  MAX_SCOPED_PERCOLATION_MENTION_PAIRS,
  percolateVault
} from "./index-egdc3x6v.js";
import {
  MAX_SOURCE_INBOX_PREFIXES,
  MAX_SOURCE_INBOX_RESULTS,
  sourceInbox
} from "./index-pj501bh1.js";
import {
  knowledgeBaseEvaluationRetrieverIds,
  openKnowledgeBaseEvaluation
} from "./index-gr1qf1b5.js";
import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_CANDIDATES,
  MAX_SEARCH_NOTE_REFERENCE_BYTES,
  MAX_SEARCH_RELATED_SEEDS,
  MAX_SEARCH_RESULTS,
  openKnowledgeBase
} from "./index-1qtgx1er.js";
import {
  indexSemanticVault,
  qmdIndexerVersion,
  recommendedEmbeddingModel,
  recommendedEmbeddingModelSha256,
  refreshVault,
  scanVault,
  sha256EmbeddingModelFile
} from "./index-b4vcr4gt.js";
import {
  MAX_EVALUATION_RESULTS_PER_QUERY,
  MAX_EVALUATION_TIMEOUT_MS,
  buildRetrievalEvaluationReport,
  parseRetrievalEvaluationCorpus,
  runRetrievalEvaluation
} from "./index-b88v3vtm.js";
import"./index-1gwbassd.js";
import {
  auditAgentGuideRepository
} from "./index-hya40gb2.js";
import {
  validateMarkdownAttachments
} from "./index-x3fthpsc.js";
import {
  addNoteRelation,
  createNote,
  removeNoteRelation
} from "./index-2fr3hf9q.js";
import {
  validateSearchQuery
} from "./index-4cknf4jw.js";
import {
  MAX_QUERY_FILTERS,
  MAX_QUERY_TAGS,
  queryVault,
  validateQueryOptions
} from "./index-48pz4jpc.js";
import {
  MAX_REPOSITORY_SCOPES,
  buildRepositoryMemoryContext,
  repositoryMemoryGroupKeys
} from "./index-06c9ctr6.js";
import {
  navigateLinks
} from "./index-d13v9ckt.js";
import {
  agentContextGuidePath,
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextNotePath,
  analyzeAgentContexts,
  inspectAgentContextRepository,
  normalizeRepositoryScope
} from "./index-5vwpzb5a.js";
import {
  lookupNote,
  renderCatalog
} from "./index-4962kvds.js";
import {
  main
} from "./index-2cw7jeq4.js";
import"./index-tp2p17gt.js";
import"./index-f984hw45.js";
import"./index-h2a142gc.js";
import {
  findKbPackageRoot
} from "./index-bt118a7q.js";
import"./index-hgve9rh2.js";
import"./index-w2zc0vwa.js";
import {
  redactSensitiveText
} from "./index-ey9rycsn.js";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText
} from "./index-1xxnjn0d.js";
import"./index-6g2pv9d2.js";
import"./index-84x0vjjp.js";
import"./index-e5fbsywq.js";
import"./index-gh719d91.js";
import"./index-5n05se68.js";

// src/cli.ts
import { open } from "fs/promises";
import { cpus, release, totalmem } from "os";
import { relative, resolve as resolve2 } from "path";
import { format } from "util";

// src/clip/url-metadata-cli.ts
import { resolve } from "path";
var urlMetadataUsage = `kb url-metadata \u2014 backfill bounded metadata for saved URLs

Usage:
  kb url-metadata backfill [--root <vault>] [--search-binary <path>] [--refresh]
    [--archive | --no-archive] [--delay-ms <milliseconds>]
    [--max-results <count>] [--timeout <milliseconds>] [--json]

From the @hraness/kb package directory, build the search helper from the immutable
metadata-search-engine-rs revision:
  bun run url-metadata:tool:build
`;
var defaultOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};
function integer(value, minimum, maximum) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}
function metadataSearchBinaryPath(packageRoot = findKbPackageRoot(), platform = process.platform) {
  const executable = platform === "win32" ? "kb-url-metadata-search.exe" : "kb-url-metadata-search";
  return resolve(packageRoot, "src", "clip", "metadata-search-tool", "target", "release", executable);
}
function defaultBinaryPath(environment) {
  const configured = environment.HRANESS_KB_METADATA_SEARCH_BINARY;
  if (configured !== undefined && configured.trim() !== "")
    return resolve(configured);
  return metadataSearchBinaryPath();
}
function parseUrlMetadataArguments(arguments_, environment = process.env) {
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
  let delayMs = 1000;
  let maxResults = 20;
  let timeoutMs = 15000;
  let json = false;
  for (let index = 1;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--refresh")
      refresh = true;
    else if (argument === "--archive")
      discoverArchives = true;
    else if (argument === "--no-archive")
      discoverArchives = false;
    else if (argument === "--json")
      json = true;
    else if (argument === "--root" || argument === "--search-binary" || argument === "--delay-ms" || argument === "--max-results" || argument === "--timeout") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `${argument} requires a value`, json: jsonRequested };
      }
      index += 1;
      if (argument === "--root")
        root = value;
      else if (argument === "--search-binary")
        binaryPath = resolve(value);
      else if (argument === "--delay-ms") {
        const parsed = integer(value, 0, 60000);
        if (parsed === null)
          return { ok: false, message: "--delay-ms must be an integer from 0 through 60000", json: jsonRequested };
        delayMs = parsed;
      } else if (argument === "--max-results") {
        const parsed = integer(value, 1, 20);
        if (parsed === null)
          return { ok: false, message: "--max-results must be an integer from 1 through 20", json: jsonRequested };
        maxResults = parsed;
      } else {
        const parsed = integer(value, 500, 15000);
        if (parsed === null)
          return { ok: false, message: "--timeout must be an integer from 500 through 15000", json: jsonRequested };
        timeoutMs = parsed;
      }
    } else {
      return { ok: false, message: `unknown url-metadata option: ${argument ?? ""}`, json: jsonRequested };
    }
  }
  if (root.trim() === "")
    return { ok: false, message: "--root must not be empty", json: jsonRequested };
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
      json
    }
  };
}
function terminalJson(value) {
  return `${JSON.stringify(value, (_key, candidate) => typeof candidate === "string" ? sanitizeTerminalText(candidate) : candidate, 2)}
`;
}
function renderReport(report) {
  const counts = report.statusCounts;
  return [
    `URL metadata: ${report.processedRecords} processed, ${report.skippedRecords} resumed, ${report.remainingRecords} remaining.`,
    `Writes: ${report.writtenRecords} new or refreshed, ${report.unchangedRecords} unchanged.`,
    `Status: ${counts.matched} matched, ${counts.partial} partial, ${counts.notFound} not found, ${counts.unavailable} unavailable.`
  ].join(`
`) + `
`;
}
async function main3(rawArguments = process.argv.slice(2), environment = process.env, output = defaultOutput, dependencies = {}) {
  const parsed = parseUrlMetadataArguments(rawArguments, environment);
  if (!parsed.ok) {
    if (parsed.json)
      output.stdout(terminalJson({ ok: false, error: parsed.message }));
    else
      output.stderr(`error: ${sanitizeTerminalText(parsed.message)}

${urlMetadataUsage}`);
    return 2;
  }
  if (parsed.value.kind === "help") {
    output.stdout(urlMetadataUsage);
    return 0;
  }
  try {
    const provider = (dependencies.createSearchProvider ?? ((binaryPath) => createRustMetadataSearchProvider({ binaryPath })))(parsed.value.binaryPath);
    const report = await (dependencies.backfill ?? backfillSavedUrlMetadata)({
      vaultRoot: parsed.value.root,
      refresh: parsed.value.refresh,
      discoverArchives: parsed.value.discoverArchives,
      interRequestDelayMs: parsed.value.delayMs,
      maxResults: parsed.value.maxResults,
      searchTimeoutMs: parsed.value.timeoutMs
    }, { searchProvider: provider });
    if (parsed.value.json)
      output.stdout(terminalJson({ ok: !report.aborted, ...report }));
    else
      output.stdout(renderReport(report));
    if (report.aborted)
      return 130;
    return report.statusCounts.unavailable > 0 ? 3 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.value.json)
      output.stdout(terminalJson({ ok: false, error: message }));
    else
      output.stderr(`error: ${sanitizeTerminalText(message)}
`);
    return 1;
  }
}
if (false)
  ;

// src/cli.ts
var defaultOutput2 = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};
async function readBoundedUtf8(path, maximumBytes, label) {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0)
        break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}
var usage = `kb \u2014 auditable capture and derived links for Markdown vaults

Usage:
  kb init [directory] [--json]
  kb clip <url|current> [capture options]
  kb url-metadata backfill [metadata options]
  kb inspect <url> [capture options]
  kb pdf <file-or-url> [PDF options]
  kb refresh [--root <directory>] [--index <path>] [--json]
  kb check [--root <directory>] [--index <path>] [--no-catalog] [--json]
  kb catalog [--root <directory>] [--index <path>] [--json]
  kb graph [--root <directory>] [--index <path>] [--json]
  kb backlinks <note> [--root <directory>] [--index <path>] [--json]
  kb links <note> [--root <directory>] [--direction <in|out|both>] [--depth <count>] [--limit <count>] [--json]
  kb note create <id> --title <title> [--type <type>] [--tag <tag>] [--body <markdown> | --body-file <path>] [--root <directory>] [--json]
  kb relation add <source> <predicate> <target> [--root <directory>] [--expected-revision <sha256:...>] [--json]
  kb relation remove <source> <predicate> <target> [--root <directory>] [--expected-revision <sha256:...>] [--json]
  kb relation list <note> [--root <directory>] [--json]
  kb percolate [note] [--root <directory>] [--min-support <count>] [--limit <count>] [--json]
  kb list [--root <directory>] [--where <path=value>] [--has <path>] [--tag <tag>] [--scope <repository-path>] [--sort <field>] [--order <asc|desc>] [--limit <count>] [--json]
  kb index [--root <directory>] [--database <path>] [--force] [--json]
  kb search <query> [--root <directory>] [--repo <repository>] [--database <path>] [--mode <hybrid|exact|keyword|semantic>] [--where <path=value>] [--has <path>] [--tag <tag>] [--scope <repository-path>] [--related <note>] [--graph-depth <1|2>] [--no-graph] [--history | --no-history | --require-history] [--limit <count>] [--candidate-limit <count>] [--min-score <score>] [--json]
  kb history <note> [--root <directory>] [--repo <repository>] [--limit <count>] [--cochanged-limit <count>] [--json]
  kb history search <query-or-path> [--root <directory>] [--repo <repository>] [--limit <count>] [--commit-limit <count>] [--cochanged-limit <count>] [--json]
  kb evaluate <manifest.json> [--root <directory>] [--repo <repository>] [--database <path>] [--retriever <id>] [--split <development|test|all>] [--limit <count>] [--cutoff <count>] [--timeout <milliseconds>] [--baseline <id>] [--model-file <path>] [--cache-state <cold|mixed|warm>] [--json]
  kb inbox [--root <directory>] [--source-prefix <directory>] [--limit <count>] [--json]
  kb context <repository-path> [--root <vault>] [--repo <repository>] [--kind <auto|file|directory>] [--json]
  kb agents identity <repository-scope> [--json]
  kb agents check [--root <vault>] [--repo <repository>] [--json]
  kb agents audit [--root <vault>] [--repo <repository>] [--json]
  kb doctor [--json]
  kb adapters [--json]

Run \`kb clip --help\` for web capture options or \`kb pdf --help\` for PDF conversion options.
`;
function safe(value) {
  return sanitizeTerminalLine(redactSensitiveText(value));
}
function terminalSafeJson(value) {
  return `${JSON.stringify(value, (_key, candidate) => typeof candidate === "string" ? sanitizeTerminalText(redactSensitiveText(candidate)) : candidate, 2)}
`;
}
function readValue(arguments_, index) {
  const value = arguments_[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}
function parseVaultCommand(command, arguments_) {
  let root = ".";
  let index;
  let json = false;
  let direction = "both";
  let depth = 1;
  let limit;
  let noCatalog = false;
  const positional = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--no-catalog" && command === "check") {
      noCatalog = true;
      continue;
    }
    if (argument === "--root" || argument === "--index") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else
        index = value;
      cursor += 1;
      continue;
    }
    if (command === "links" && (argument === "--direction" || argument === "--depth" || argument === "--limit")) {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--direction") {
        if (value !== "in" && value !== "out" && value !== "both") {
          return { ok: false, message: "--direction must be in, out, or both" };
        }
        direction = value;
      } else if (argument === "--depth") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
          return { ok: false, message: "--depth must be an integer from 1 through 10" };
        }
        depth = parsed;
      } else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
          return { ok: false, message: "--limit must be an integer from 1 through 1000" };
        }
        limit = parsed;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--"))
      return { ok: false, message: `unknown ${command} option` };
    positional.push(argument);
  }
  if (command === "backlinks" || command === "links") {
    const note = positional[0];
    if (positional.length !== 1 || note === undefined) {
      return { ok: false, message: `${command} requires exactly one note path, title, or alias` };
    }
    return {
      ok: true,
      value: {
        kind: command,
        root,
        options: index === undefined ? {} : { index },
        json,
        note,
        ...command === "links" ? { direction, depth, ...limit === undefined ? {} : { limit } } : {}
      }
    };
  }
  if (positional.length !== 0)
    return { ok: false, message: `${command} does not accept positional arguments` };
  return {
    ok: true,
    value: {
      kind: command,
      root,
      options: index === undefined ? {} : { index },
      json,
      ...command === "check" && noCatalog ? { noCatalog: true } : {}
    }
  };
}
function parseCatalogCommand(arguments_) {
  let root = ".";
  let index;
  let json = false;
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--index") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else
        index = value;
      cursor += 1;
      continue;
    }
    return {
      ok: false,
      message: argument?.startsWith("--") === true ? "unknown catalog option" : "catalog does not accept positional arguments"
    };
  }
  return {
    ok: true,
    value: {
      kind: "catalog",
      root,
      options: index === undefined ? { mentionScope: false } : { index, mentionScope: false },
      json
    }
  };
}
function metadataScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? { ok: true, value: parsed } : { ok: false, message: "quoted --where values must be strings" };
    } catch {
      return { ok: false, message: "double-quoted --where values must be valid JSON strings" };
    }
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      return { ok: false, message: "single-quoted --where values must have a closing quote" };
    }
    return { ok: true, value: value.slice(1, -1).replaceAll("''", "'") };
  }
  if (value === "null")
    return { ok: true, value: null };
  if (value === "true")
    return { ok: true, value: true };
  if (value === "false")
    return { ok: true, value: false };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
        return { ok: false, message: "numeric --where values must be safe integers; quote large identifiers" };
      }
      return { ok: true, value: number };
    }
  }
  return { ok: true, value };
}
function querySort(raw) {
  const value = raw.trim();
  if (value === "title" || value === "path" || value === "inbound" || value === "outbound") {
    return { kind: "builtin", field: value };
  }
  const path = value.replace(/^(?:meta|metadata)\./u, "");
  return path === "" ? null : { kind: "metadata", path };
}
function parseListCommand(arguments_) {
  let root = ".";
  let index;
  let json = false;
  let sort = { kind: "builtin", field: "path" };
  let direction = "asc";
  let limit;
  const filters = [];
  const tags = [];
  const repositoryScopes = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--index" || argument === "--where" || argument === "--has" || argument === "--tag" || argument === "--scope" || argument === "--repository-scope" || argument === "--sort" || argument === "--order" || argument === "--limit") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--index")
        index = value;
      else if (argument === "--tag") {
        if (tags.length >= MAX_QUERY_TAGS) {
          return {
            ok: false,
            message: `Query tags may contain at most ${MAX_QUERY_TAGS} entries.`
          };
        }
        tags.push(value);
      } else if (argument === "--scope" || argument === "--repository-scope") {
        if (repositoryScopes.length >= MAX_REPOSITORY_SCOPES) {
          return {
            ok: false,
            message: `Repository scope filters may contain at most ${MAX_REPOSITORY_SCOPES} entries.`
          };
        }
        repositoryScopes.push(value);
      } else if (argument === "--has") {
        if (value.trim() === "")
          return { ok: false, message: "--has requires a metadata path" };
        if (filters.length >= MAX_QUERY_FILTERS) {
          return {
            ok: false,
            message: `Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`
          };
        }
        filters.push({ kind: "exists", path: value });
      } else if (argument === "--where") {
        const equals = value.indexOf("=");
        const path = equals === -1 ? "" : value.slice(0, equals).trim();
        if (path === "")
          return { ok: false, message: "--where requires path=value" };
        const scalar = metadataScalar(value.slice(equals + 1));
        if (!scalar.ok)
          return scalar;
        if (filters.length >= MAX_QUERY_FILTERS) {
          return {
            ok: false,
            message: `Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`
          };
        }
        filters.push({ kind: "equals", path, value: scalar.value });
      } else if (argument === "--sort") {
        const parsed = querySort(value);
        if (parsed === null)
          return { ok: false, message: "--sort requires a field" };
        sort = parsed;
      } else if (argument === "--order") {
        if (value !== "asc" && value !== "desc") {
          return { ok: false, message: "--order must be asc or desc" };
        }
        direction = value;
      } else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          return { ok: false, message: "--limit must be a non-negative integer" };
        }
        limit = parsed;
      }
      cursor += 1;
      continue;
    }
    return {
      ok: false,
      message: argument.startsWith("--") ? "unknown list option" : "list does not accept positional arguments"
    };
  }
  try {
    validateQueryOptions({
      filters,
      tags,
      repositoryScopes,
      sort,
      direction,
      ...limit === undefined ? {} : { limit }
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    ok: true,
    value: {
      kind: "list",
      root,
      options: index === undefined ? {} : { index },
      filters,
      tags,
      repositoryScopes,
      sort,
      direction,
      ...limit === undefined ? {} : { limit },
      json
    }
  };
}
function parseInboxCommand(arguments_) {
  let root = ".";
  let index;
  let json = false;
  let limit = 100;
  const sourcePrefixes = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--index" || argument === "--limit" || argument === "--source-prefix") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--index")
        index = value;
      else if (argument === "--source-prefix") {
        if (sourcePrefixes.length >= MAX_SOURCE_INBOX_PREFIXES) {
          return {
            ok: false,
            message: `Source inbox accepts at most ${MAX_SOURCE_INBOX_PREFIXES} source prefixes.`
          };
        }
        sourcePrefixes.push(value);
      } else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_SOURCE_INBOX_RESULTS) {
          return {
            ok: false,
            message: `--limit must be an integer from 0 through ${MAX_SOURCE_INBOX_RESULTS}`
          };
        }
        limit = parsed;
      }
      cursor += 1;
      continue;
    }
    return {
      ok: false,
      message: argument.startsWith("--") ? "unknown inbox option" : "inbox does not accept positional arguments"
    };
  }
  return {
    ok: true,
    value: {
      kind: "inbox",
      root,
      options: index === undefined ? { mentionScope: false } : { index, mentionScope: false },
      sourcePrefixes,
      limit,
      json
    }
  };
}
function parseSemanticCommand(command, arguments_) {
  let root = ".";
  let repository = ".";
  let database;
  let force = false;
  let json = false;
  let mode = "hybrid";
  let limit;
  let candidateLimit;
  let minScore;
  let graphDepth;
  let noGraph = false;
  let history = false;
  let noHistory = false;
  let requireHistory = false;
  const filters = [];
  const tags = [];
  const repositoryScopes = [];
  const related = [];
  const positional = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--force" && command === "index") {
      force = true;
      continue;
    }
    if (argument === "--no-graph" && command === "search") {
      noGraph = true;
      continue;
    }
    if (argument === "--no-history" && command === "search") {
      noHistory = true;
      continue;
    }
    if (argument === "--history" && command === "search") {
      history = true;
      continue;
    }
    if (argument === "--require-history" && command === "search") {
      requireHistory = true;
      continue;
    }
    if (argument === "--root" || argument === "--database" || command === "search" && argument === "--repo") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--repo")
        repository = value;
      else
        database = value;
      cursor += 1;
      continue;
    }
    if (command === "search" && (argument === "--mode" || argument === "--limit" || argument === "--candidate-limit" || argument === "--min-score" || argument === "--where" || argument === "--has" || argument === "--tag" || argument === "--scope" || argument === "--repository-scope" || argument === "--related" || argument === "--graph-depth")) {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--mode") {
        if (value !== "hybrid" && value !== "exact" && value !== "semantic" && value !== "keyword") {
          return { ok: false, message: "--mode must be hybrid, exact, keyword, or semantic" };
        }
        mode = value;
      } else if (argument === "--where") {
        const equals = value.indexOf("=");
        const path = equals === -1 ? "" : value.slice(0, equals).trim();
        if (path === "")
          return { ok: false, message: "--where requires path=value" };
        const scalar = metadataScalar(value.slice(equals + 1));
        if (!scalar.ok)
          return scalar;
        if (filters.length >= MAX_QUERY_FILTERS) {
          return {
            ok: false,
            message: `Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`
          };
        }
        filters.push({ kind: "equals", path, value: scalar.value });
      } else if (argument === "--has") {
        if (value.trim() === "")
          return { ok: false, message: "--has requires a metadata path" };
        if (filters.length >= MAX_QUERY_FILTERS) {
          return {
            ok: false,
            message: `Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`
          };
        }
        filters.push({ kind: "exists", path: value });
      } else if (argument === "--tag") {
        if (tags.length >= MAX_QUERY_TAGS) {
          return {
            ok: false,
            message: `Query tags may contain at most ${MAX_QUERY_TAGS} entries.`
          };
        }
        tags.push(value);
      } else if (argument === "--scope" || argument === "--repository-scope") {
        if (repositoryScopes.length >= MAX_REPOSITORY_SCOPES) {
          return {
            ok: false,
            message: `Repository scope filters may contain at most ${MAX_REPOSITORY_SCOPES} entries.`
          };
        }
        repositoryScopes.push(value);
      } else if (argument === "--related") {
        if (related.length >= MAX_SEARCH_RELATED_SEEDS) {
          return {
            ok: false,
            message: `Hybrid search accepts at most ${MAX_SEARCH_RELATED_SEEDS} explicit related-note seeds.`
          };
        }
        if (Buffer.byteLength(value, "utf8") > MAX_SEARCH_NOTE_REFERENCE_BYTES) {
          return {
            ok: false,
            message: `Search related-note seed ${related.length + 1} must be at most ` + `${MAX_SEARCH_NOTE_REFERENCE_BYTES.toLocaleString("en-US")} UTF-8 bytes.`
          };
        }
        if (value.trim() === "") {
          return {
            ok: false,
            message: `Search related-note seed ${related.length + 1} must not be empty.`
          };
        }
        related.push(value);
      } else if (argument === "--min-score") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          return { ok: false, message: "--min-score must be a number from 0 through 1" };
        }
        minScore = parsed;
      } else {
        const parsed = Number(value);
        if (argument === "--limit" || argument === "--candidate-limit") {
          const maximum = argument === "--limit" ? MAX_SEARCH_RESULTS : MAX_SEARCH_CANDIDATES;
          if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
            return {
              ok: false,
              message: `${argument} must be an integer from 1 through ${maximum}`
            };
          }
          if (argument === "--limit")
            limit = parsed;
          else
            candidateLimit = parsed;
        } else if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2) {
          return { ok: false, message: "--graph-depth must be 1 or 2" };
        } else {
          graphDepth = parsed;
        }
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--"))
      return { ok: false, message: `unknown ${command} option` };
    positional.push(argument);
  }
  if (command === "index") {
    if (positional.length > 0)
      return { ok: false, message: "index does not accept positional arguments" };
    return {
      ok: true,
      value: { kind: "index", root, ...database === undefined ? {} : { database }, force, json }
    };
  }
  if (noHistory && requireHistory) {
    return {
      ok: false,
      message: "--no-history and --require-history cannot be used together"
    };
  }
  if (history && noHistory) {
    return {
      ok: false,
      message: "--history and --no-history cannot be used together"
    };
  }
  if (history && requireHistory) {
    return {
      ok: false,
      message: "--history and --require-history cannot be used together"
    };
  }
  if (candidateLimit !== undefined && candidateLimit < (limit ?? DEFAULT_SEARCH_RESULTS)) {
    return {
      ok: false,
      message: "Search candidate limit must be at least the result limit."
    };
  }
  if (mode === "exact" && minScore !== undefined) {
    return {
      ok: false,
      message: "Search minimum score applies only to hybrid, keyword, or semantic mode."
    };
  }
  const rawQuery = positional.join(" ");
  if (rawQuery.trim() === "")
    return { ok: false, message: "search requires a query" };
  let query;
  try {
    query = validateSearchQuery(rawQuery).query;
    validateQueryOptions({ filters, tags, repositoryScopes });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    ok: true,
    value: {
      kind: "search",
      root,
      repository,
      ...database === undefined ? {} : { database },
      mode,
      filters,
      tags,
      repositoryScopes,
      graph: noGraph ? false : {
        ...related.length === 0 ? {} : { related },
        ...graphDepth === undefined ? {} : { depth: graphDepth }
      },
      history: requireHistory ? "required" : history ? "auto" : false,
      ...limit === undefined ? {} : { limit },
      ...candidateLimit === undefined ? {} : { candidateLimit },
      ...minScore === undefined ? {} : { minScore },
      query,
      json
    }
  };
}
function parseContextCommand(arguments_) {
  let root = ".";
  let repository = ".";
  let targetKind = "auto";
  let json = false;
  const positional = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo" || argument === "--kind") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--repo")
        repository = value;
      else {
        if (value !== "auto" && value !== "file" && value !== "directory") {
          return { ok: false, message: "--kind must be auto, file, or directory" };
        }
        targetKind = value;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--"))
      return { ok: false, message: "unknown context option" };
    positional.push(argument);
  }
  const target = positional[0];
  if (target === undefined || positional.length !== 1) {
    return { ok: false, message: "context requires exactly one repository path" };
  }
  return {
    ok: true,
    value: {
      kind: "context",
      root,
      repository,
      target,
      targetKind,
      json
    }
  };
}
var MAX_HISTORY_QUERY_CHARACTERS = 500;
var MAX_HISTORY_RESULT_LIMIT = 100;
var MAX_HISTORY_COMMIT_LIMIT = 50;
var MAX_HISTORY_COCHANGED_LIMIT = 100;
function parseHistoryCommand(arguments_) {
  const search = arguments_[0] === "search";
  let root = ".";
  let repository = ".";
  let limit;
  let commitLimit;
  let cochangedLimit;
  let json = false;
  const positional = [];
  for (let cursor = search ? 1 : 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo" || argument === "--limit" || argument === "--commit-limit" || argument === "--cochanged-limit") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--repo")
        repository = value;
      else {
        if (!search && argument === "--commit-limit") {
          return {
            ok: false,
            message: "history <note> uses --limit for its per-note commit limit"
          };
        }
        const maximum = argument === "--cochanged-limit" ? MAX_HISTORY_COCHANGED_LIMIT : argument === "--commit-limit" ? MAX_HISTORY_COMMIT_LIMIT : search ? MAX_HISTORY_RESULT_LIMIT : MAX_HISTORY_COMMIT_LIMIT;
        const minimum = argument === "--cochanged-limit" ? 0 : 1;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
          return {
            ok: false,
            message: `${argument} must be an integer from ${minimum} through ${maximum}`
          };
        }
        if (argument === "--cochanged-limit")
          cochangedLimit = parsed;
        else if (argument === "--commit-limit")
          commitLimit = parsed;
        else
          limit = parsed;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return { ok: false, message: `unknown history ${search ? "search " : ""}option` };
    }
    positional.push(argument);
  }
  const query = search ? positional.join(" ").trim() : positional[0]?.trim();
  if (query === undefined || query === "" || !search && positional.length !== 1) {
    return {
      ok: false,
      message: search ? "history search requires a query or repository path" : "history requires exactly one note path, title, or alias"
    };
  }
  if (query.length > MAX_HISTORY_QUERY_CHARACTERS || /[\0\r\n]/u.test(query)) {
    return {
      ok: false,
      message: `history ${search ? "search query" : "note"} must be one to ${MAX_HISTORY_QUERY_CHARACTERS} characters on one line`
    };
  }
  return {
    ok: true,
    value: {
      kind: "history",
      action: search ? "search" : "note",
      root,
      repository,
      query,
      ...limit === undefined ? {} : { limit },
      ...commitLimit === undefined ? {} : { commitLimit },
      ...cochangedLimit === undefined ? {} : { cochangedLimit },
      json
    }
  };
}
function parseAgentsCommand(arguments_) {
  const action = arguments_[0];
  if (action === "identity") {
    let json2 = false;
    const positional = [];
    for (const argument of arguments_.slice(1)) {
      if (argument === "--json")
        json2 = true;
      else if (argument.startsWith("--")) {
        return { ok: false, message: "unknown agents identity option" };
      } else {
        positional.push(argument);
      }
    }
    const scope = positional[0];
    if (scope === undefined || positional.length !== 1) {
      return {
        ok: false,
        message: "agents identity requires exactly one repository scope"
      };
    }
    return {
      ok: true,
      value: { kind: "agent-identity", scope, json: json2 }
    };
  }
  if (action !== "check" && action !== "audit") {
    return { ok: false, message: "agents requires identity, check, or audit" };
  }
  let root = ".";
  let repository = ".";
  let json = false;
  for (let cursor = 1;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else
        repository = value;
      cursor += 1;
      continue;
    }
    return {
      ok: false,
      message: argument.startsWith("--") ? `unknown agents ${action} option` : `agents ${action} does not accept positional arguments`
    };
  }
  return {
    ok: true,
    value: { kind: "agents", action, root, repository, json }
  };
}
function boundedInteger(raw, option, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return {
      ok: false,
      message: `${option} must be an integer from ${minimum} through ${maximum}`
    };
  }
  return value;
}
function parseEvaluationCommand(arguments_) {
  let root = ".";
  let repository = ".";
  let database;
  let split = "test";
  let limit = 20;
  let cutoff = 10;
  let timeoutMs = 30000;
  let baseline;
  let modelFile;
  let cacheState = "mixed";
  let json = false;
  const retrievers = [];
  const positional = [];
  const supported = new Set(knowledgeBaseEvaluationRetrieverIds);
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo" || argument === "--database" || argument === "--retriever" || argument === "--split" || argument === "--limit" || argument === "--cutoff" || argument === "--timeout" || argument === "--baseline" || argument === "--model-file" || argument === "--cache-state") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--repo")
        repository = value;
      else if (argument === "--database")
        database = value;
      else if (argument === "--retriever") {
        if (!supported.has(value)) {
          return {
            ok: false,
            message: `--retriever must be one of ${knowledgeBaseEvaluationRetrieverIds.join(", ")}`
          };
        }
        retrievers.push(value);
      } else if (argument === "--split") {
        if (value !== "development" && value !== "test" && value !== "all") {
          return { ok: false, message: "--split must be development, test, or all" };
        }
        split = value;
      } else if (argument === "--limit" || argument === "--cutoff") {
        const parsed = boundedInteger(value, argument, 1, MAX_CLI_EVALUATION_RESULT_LIMIT);
        if (typeof parsed !== "number")
          return parsed;
        if (argument === "--limit")
          limit = parsed;
        else
          cutoff = parsed;
      } else if (argument === "--timeout") {
        const parsed = boundedInteger(value, argument, 1, MAX_EVALUATION_TIMEOUT_MS);
        if (typeof parsed !== "number")
          return parsed;
        timeoutMs = parsed;
      } else if (argument === "--baseline")
        baseline = value;
      else if (argument === "--model-file")
        modelFile = value;
      else {
        if (value !== "cold" && value !== "mixed" && value !== "warm") {
          return { ok: false, message: "--cache-state must be cold, mixed, or warm" };
        }
        cacheState = value;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return { ok: false, message: "unknown evaluate option" };
    }
    positional.push(argument);
  }
  const manifest = positional[0];
  if (manifest === undefined || positional.length !== 1) {
    return { ok: false, message: "evaluate requires exactly one manifest path" };
  }
  const selected = retrievers.length === 0 ? [...knowledgeBaseEvaluationRetrieverIds] : retrievers;
  if (new Set(selected).size !== selected.length) {
    return { ok: false, message: "--retriever values must not repeat" };
  }
  const selectedBaseline = baseline ?? (selected.includes("exact") ? "exact" : selected[0]);
  if (selectedBaseline === undefined || !selected.includes(selectedBaseline)) {
    return { ok: false, message: "--baseline must name a selected retriever" };
  }
  if (cutoff > limit) {
    return { ok: false, message: "--cutoff must not exceed --limit" };
  }
  const needsModel = selected.includes("semantic") || selected.includes("hybrid");
  if (needsModel && modelFile === undefined) {
    return {
      ok: false,
      message: "semantic and hybrid evaluation require --model-file to bind the pinned model bytes"
    };
  }
  if (!needsModel && modelFile !== undefined) {
    return {
      ok: false,
      message: "--model-file is only valid when semantic or hybrid evaluation is selected"
    };
  }
  return {
    ok: true,
    value: {
      kind: "evaluate",
      manifest,
      root,
      repository,
      ...database === undefined ? {} : { database },
      retrievers: selected,
      split,
      limit,
      cutoff,
      timeoutMs,
      baseline: selectedBaseline,
      ...modelFile === undefined ? {} : { modelFile },
      cacheState: needsModel ? cacheState : "not-applicable",
      json
    }
  };
}
function parseNoteCommand(arguments_) {
  if (arguments_[0] !== "create") {
    return { ok: false, message: "note requires create" };
  }
  let root = ".";
  let title;
  let type = "note";
  let body;
  let bodyFile;
  let json = false;
  const tags = [];
  const positional = [];
  for (let cursor = 1;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--title" || argument === "--type" || argument === "--tag" || argument === "--body" || argument === "--body-file") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--title")
        title = value;
      else if (argument === "--type")
        type = value;
      else if (argument === "--tag")
        tags.push(value);
      else if (argument === "--body")
        body = value;
      else
        bodyFile = value;
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return { ok: false, message: "unknown note create option" };
    }
    positional.push(argument);
  }
  const id = positional[0];
  if (id === undefined || positional.length !== 1) {
    return { ok: false, message: "note create requires exactly one canonical note ID" };
  }
  if (title === undefined)
    return { ok: false, message: "note create requires --title" };
  if (body !== undefined && bodyFile !== undefined) {
    return { ok: false, message: "note create accepts either --body or --body-file, not both" };
  }
  return {
    ok: true,
    value: {
      kind: "note-create",
      root,
      input: { id, title, type, ...tags.length === 0 ? {} : { tags } },
      ...body === undefined ? {} : { body },
      ...bodyFile === undefined ? {} : { bodyFile },
      json
    }
  };
}
function isNoteRevision(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
function parseRelationCommand(arguments_) {
  const action = arguments_[0];
  if (action !== "add" && action !== "remove" && action !== "list") {
    return { ok: false, message: "relation requires add, remove, or list" };
  }
  let root = ".";
  let expectedRevision;
  let json = false;
  const positional = [];
  for (let cursor = 1;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--expected-revision") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") {
        root = value;
      } else {
        if (!isNoteRevision(value)) {
          return {
            ok: false,
            message: "--expected-revision must be sha256 followed by 64 lowercase hexadecimal characters"
          };
        }
        expectedRevision = value;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return { ok: false, message: `unknown relation ${action} option` };
    }
    positional.push(argument);
  }
  const source = positional[0];
  if (action === "list") {
    if (source === undefined || positional.length !== 1) {
      return { ok: false, message: "relation list requires exactly one canonical note ID" };
    }
    if (expectedRevision !== undefined) {
      return { ok: false, message: "relation list does not accept --expected-revision" };
    }
    return { ok: true, value: { kind: "relation", action, root, source, json } };
  }
  const predicate = positional[1];
  const target = positional[2];
  if (source === undefined || predicate === undefined || target === undefined || positional.length !== 3) {
    return {
      ok: false,
      message: `relation ${action} requires exact source, predicate, and target IDs`
    };
  }
  return {
    ok: true,
    value: {
      kind: "relation",
      action,
      root,
      source,
      predicate,
      target,
      ...expectedRevision === undefined ? {} : { expectedRevision },
      json
    }
  };
}
function parsePercolateCommand(arguments_) {
  let root = ".";
  let minSupport = 2;
  let limit = 25;
  let json = false;
  const positional = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--min-support" || argument === "--limit") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") {
        root = value;
      } else {
        const parsed = boundedInteger(value, argument, argument === "--min-support" ? 2 : 1, 1000);
        if (typeof parsed !== "number")
          return parsed;
        if (argument === "--min-support")
          minSupport = parsed;
        else
          limit = parsed;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return { ok: false, message: "unknown percolate option" };
    }
    positional.push(argument);
  }
  const note = positional[0];
  if (positional.length > 1) {
    return { ok: false, message: "percolate accepts at most one note ID" };
  }
  return {
    ok: true,
    value: {
      kind: "percolate",
      root,
      ...note === undefined ? {} : { note },
      minSupport,
      limit,
      json
    }
  };
}
function parseArguments(arguments_) {
  const command = arguments_[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { ok: true, value: { kind: "help" } };
  }
  if (command === "clip" || command === "capture" || command === "inspect") {
    if (arguments_[1] === "--help" || arguments_[1] === "-h" || arguments_[1] === "help") {
      return { ok: true, value: { kind: "clip", arguments: ["help"] } };
    }
    const delegated = command === "inspect" ? "inspect" : "capture";
    return { ok: true, value: { kind: "clip", arguments: [delegated, ...arguments_.slice(1)] } };
  }
  if (command === "url-metadata") {
    return { ok: true, value: { kind: "url-metadata", arguments: arguments_.slice(1) } };
  }
  if (command === "pdf") {
    return { ok: true, value: { kind: "pdf", arguments: arguments_.slice(1) } };
  }
  if (command === "doctor" || command === "adapters") {
    return { ok: true, value: { kind: "clip", arguments: arguments_ } };
  }
  if (command === "init") {
    let directory = "kb";
    let json = false;
    const positional = [];
    for (const argument of arguments_.slice(1)) {
      if (argument === "--json")
        json = true;
      else if (argument.startsWith("--"))
        return { ok: false, message: "unknown init option" };
      else
        positional.push(argument);
    }
    if (positional.length > 1)
      return { ok: false, message: "init accepts at most one directory" };
    if (positional[0] !== undefined)
      directory = positional[0];
    return { ok: true, value: { kind: "init", directory, json } };
  }
  if (command === "refresh" || command === "check" || command === "graph" || command === "backlinks" || command === "links") {
    return parseVaultCommand(command, arguments_.slice(1));
  }
  if (command === "catalog")
    return parseCatalogCommand(arguments_.slice(1));
  if (command === "list" || command === "notes")
    return parseListCommand(arguments_.slice(1));
  if (command === "inbox" || command === "source-inbox") {
    return parseInboxCommand(arguments_.slice(1));
  }
  if (command === "index" || command === "search") {
    return parseSemanticCommand(command, arguments_.slice(1));
  }
  if (command === "history")
    return parseHistoryCommand(arguments_.slice(1));
  if (command === "evaluate")
    return parseEvaluationCommand(arguments_.slice(1));
  if (command === "context")
    return parseContextCommand(arguments_.slice(1));
  if (command === "agents")
    return parseAgentsCommand(arguments_.slice(1));
  if (command === "note")
    return parseNoteCommand(arguments_.slice(1));
  if (command === "relation")
    return parseRelationCommand(arguments_.slice(1));
  if (command === "percolate")
    return parsePercolateCommand(arguments_.slice(1));
  return { ok: false, message: "unknown command" };
}
function embeddingCount(result) {
  return result.embedding?.chunksEmbedded ?? 0;
}
function renderSemanticIndex(result) {
  const changed = result.update.indexed + result.update.updated;
  return [
    `Indexed ${safe(result.root)} with QMD.`,
    `Documents: ${changed} changed, ${result.update.unchanged} unchanged, ${result.update.removed} removed.`,
    `Embeddings: ${embeddingCount(result)} chunks; model: ${safe(result.model)}.`,
    `Database: ${safe(result.database)}`,
    ""
  ].join(`
`);
}
function renderKnowledgeBaseSearch(result) {
  const lines = [
    `${result.mode[0]?.toLocaleUpperCase("en-US") ?? ""}${result.mode.slice(1)} results for \u201C${safe(result.query)}\u201D (${result.results.length})${result.partial ? " [partial]" : ""}`
  ];
  if (result.results.length === 0)
    lines.push("  None.");
  for (const hit of result.results) {
    const location = `${safe(hit.path)}${hit.line === undefined ? "" : `:${hit.line}`}`;
    const evidence = hit.evidence.map((item) => `${item.kind}#${item.rank}`).join(", ");
    lines.push(`  ${hit.rank}. ${hit.score.toFixed(3)}  ${location} \u2014 ${safe(hit.title)} [${safe(evidence)}]`);
    if (hit.snippet !== "")
      lines.push(`    ${safe(hit.snippet)}`);
  }
  if ((result.graph?.related.length ?? 0) > 0) {
    lines.push(`  Related graph context: ${result.graph?.related.length ?? 0}`);
  }
  if (result.history?.status === "ready") {
    const limited = result.history.limitedCommits?.length ?? 0;
    lines.push(`  Git provenance: ${result.history.notes.length} notes at ${safe(result.history.head.slice(0, 12))}` + (limited === 0 ? "" : `; ${limited} commit${limited === 1 ? "" : "s"} with incomplete co-change paths`));
  }
  return `${lines.join(`
`)}
`;
}
async function runSemantic(command, output, dependencies) {
  if (command.kind === "index") {
    const result = await (dependencies.indexSemanticVault ?? indexSemanticVault)({
      root: command.root,
      ...command.database === undefined ? {} : { database: command.database },
      force: command.force
    });
    output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderSemanticIndex(result)));
    return 0;
  }
  const kb = await (dependencies.openKnowledgeBase ?? openKnowledgeBase)({
    root: command.root,
    repository: command.repository,
    ...command.database === undefined ? {} : { database: command.database }
  });
  try {
    const result = await kb.search({
      query: command.query,
      mode: command.mode,
      filters: command.filters,
      tags: command.tags,
      repositoryScopes: command.repositoryScopes,
      graph: command.graph,
      history: command.history,
      ...command.limit === undefined ? {} : { limit: command.limit },
      ...command.candidateLimit === undefined ? {} : { candidateLimit: command.candidateLimit },
      ...command.minScore === undefined ? {} : { minScore: command.minScore }
    });
    output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderKnowledgeBaseSearch(result)));
    return 0;
  } finally {
    await kb.close();
  }
}
function historyIsPartial(result) {
  return result.status === "unavailable" || (result.limitedCommits?.length ?? 0) > 0;
}
function renderHistoryAvailability(result) {
  if (result.status === "unavailable") {
    return [`Git history unavailable: ${safe(result.reason)}`];
  }
  const limited = result.limitedCommits?.length ?? 0;
  return limited === 0 ? [] : [
    `Coverage: ${limited} oversized commit${limited === 1 ? "" : "s"} ` + "have incomplete co-change paths."
  ];
}
function renderNoteHistory(note, result) {
  const lines = [`Git history for ${safe(note.path)} \u2014 ${safe(note.title)}`];
  lines.push(...renderHistoryAvailability(result));
  if (result.status === "unavailable")
    return `${lines.join(`
`)}
`;
  const provenance = result.notes.find(({ id }) => id === note.id);
  const commits = provenance?.commits ?? [];
  lines.push(`Head: ${safe(result.head)}; commits: ${commits.length}.`);
  if (commits.length === 0)
    lines.push("  No indexed commits.");
  for (const commit of commits) {
    lines.push(`  ${safe(commit.hash.slice(0, 12))}  ${safe(commit.committedAt)}  ${safe(commit.subject)}`);
    for (const path of commit.cochangedPaths)
      lines.push(`    ${safe(path)}`);
    if (commit.cochangeDetailsLimited === true) {
      lines.push("    Co-change paths are incomplete for this oversized commit.");
    }
  }
  return `${lines.join(`
`)}
`;
}
function renderHistorySearch(result) {
  const lines = [
    result.status === "ready" ? `Git history results for \u201C${safe(result.query)}\u201D (${result.hits.length})` : "Git history search",
    ...renderHistoryAvailability(result)
  ];
  if (result.status === "unavailable")
    return `${lines.join(`
`)}
`;
  if (result.hits.length === 0)
    lines.push("  None.");
  for (const hit of result.hits) {
    lines.push(`  ${hit.score.toFixed(3)}  ${safe(hit.path)}`);
    for (const commit of hit.commits) {
      const matches = commit.matchedPaths.length === 0 ? "" : ` [${commit.matchedPaths.map(safe).join(", ")}]`;
      lines.push(`    ${safe(commit.hash.slice(0, 12))}  ${safe(commit.subject)}${matches}`);
    }
  }
  return `${lines.join(`
`)}
`;
}
var MAX_EVALUATION_MANIFEST_BYTES = 16 * 1024 * 1024;
var MAX_CLI_EVALUATION_RESULT_LIMIT = Math.min(100, MAX_EVALUATION_RESULTS_PER_QUERY);
var MAX_CLI_EVALUATION_QUERIES = 500;
var MAX_CLI_EVALUATION_RUNS = 4000;
function evaluationEnvironment(command, modelSha256, now) {
  const [modelId, modelRevision] = recommendedEmbeddingModel.split("#", 2);
  const processor = cpus()[0]?.model.trim() || "unknown processor";
  const hardware = `${processor}; ${cpus().length} logical CPUs; ` + `${(totalmem() / 1024 ** 3).toFixed(1)} GiB memory`;
  return {
    generatedAt: now().toISOString(),
    runtime: {
      bun: Bun.version,
      node: process.versions.node,
      os: `${process.platform} ${release()}`,
      arch: process.arch,
      hardware
    },
    model: modelSha256 === null ? {
      kind: "none",
      reason: "The selected retrievers do not use local vector embeddings."
    } : {
      kind: "local",
      id: modelId ?? recommendedEmbeddingModel,
      revision: modelRevision ?? "unversioned",
      sha256: modelSha256
    },
    cache: { state: command.cacheState },
    retrievers: command.retrievers.map((id) => ({
      id,
      version: id === "keyword" || id === "semantic" ? `qmd-${qmdIndexerVersion}/${id}` : id === "hybrid" ? `kb-rrf-v1+qmd-${qmdIndexerVersion}` : `kb-${id}-v1`,
      configuration: {
        resultLimit: command.limit,
        cutoff: command.cutoff,
        split: command.split
      }
    }))
  };
}
function metricText(value) {
  return value === null ? "n/a" : value.toFixed(4);
}
function renderEvaluationReport(report) {
  const lines = [
    `Retrieval evaluation ${safe(report.corpus.id)}: ${report.queryCount} ${safe(report.split)} queries at cutoff ${report.cutoff}.`,
    `Frozen repository: ${safe(report.corpus.frozen.repositoryCommit)}; vault tree: ${safe(report.corpus.frozen.vaultTree)}.`
  ];
  for (const summary of report.summaries) {
    lines.push(`  ${safe(summary.retrieverId)}: ready ${summary.ready}, degraded ${summary.degraded}, unavailable ${summary.unavailable}, failed ${summary.failed}; ` + `recall ${metricText(summary.metrics.recall)}, MRR ${metricText(summary.metrics.reciprocalRank)}, ` + `nDCG ${metricText(summary.metrics.ndcg)}, no-answer ${metricText(summary.metrics.noAnswerAccuracy)}, ` + `p95 ${summary.latencyMs.p95?.toFixed(2) ?? "n/a"} ms.`);
  }
  lines.push("These measurements describe only the frozen corpus, selected retrievers, cache state, and recorded machine.");
  return `${lines.join(`
`)}
`;
}
async function runEvaluation(command, output, dependencies) {
  const source = await readBoundedUtf8(command.manifest, MAX_EVALUATION_MANIFEST_BYTES, "evaluation manifest");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new TypeError("The evaluation manifest must contain valid JSON.", { cause: error });
  }
  const corpus = parseRetrievalEvaluationCorpus(parsed);
  const queryCount = corpus.queries.filter(({ split }) => command.split === "all" || split === command.split).length;
  if (queryCount > MAX_CLI_EVALUATION_QUERIES) {
    throw new RangeError(`CLI evaluation accepts at most ${MAX_CLI_EVALUATION_QUERIES} selected queries.`);
  }
  if (queryCount * command.retrievers.length > MAX_CLI_EVALUATION_RUNS) {
    throw new RangeError(`CLI evaluation accepts at most ${MAX_CLI_EVALUATION_RUNS} retriever/query runs.`);
  }
  const embeddingModelFile = command.modelFile === undefined ? undefined : resolve2(command.modelFile);
  const digestEvaluationModel = dependencies.digestEvaluationModel ?? sha256EmbeddingModelFile;
  const modelSha256 = embeddingModelFile === undefined ? null : await digestEvaluationModel(embeddingModelFile);
  if (modelSha256 !== null && modelSha256 !== recommendedEmbeddingModelSha256) {
    throw new Error("The evaluation model does not match the pinned recommended model SHA-256.");
  }
  const evaluation = await (dependencies.openKnowledgeBaseEvaluation ?? openKnowledgeBaseEvaluation)({
    corpus,
    root: command.root,
    repository: command.repository,
    ...command.database === undefined ? {} : { database: command.database },
    ...embeddingModelFile === undefined ? {} : { embeddingModelFile }
  });
  try {
    const byId = new Map(evaluation.retrievers.map((retriever) => [retriever.id, retriever]));
    const retrievers = command.retrievers.map((id) => {
      const retriever = byId.get(id);
      if (retriever === undefined)
        throw new Error(`Evaluation adapter ${id} is unavailable.`);
      return retriever;
    });
    const runs = await runRetrievalEvaluation({
      corpus,
      retrievers,
      split: command.split,
      limit: command.limit,
      timeoutMs: command.timeoutMs
    });
    if (embeddingModelFile !== undefined) {
      const afterSha256 = await digestEvaluationModel(embeddingModelFile);
      if (afterSha256 !== modelSha256) {
        throw new Error("The evaluation model changed while retrieval was running; retry.");
      }
    }
    const report = buildRetrievalEvaluationReport({
      corpus,
      runs,
      environment: evaluationEnvironment(command, modelSha256, dependencies.evaluationNow ?? (() => new Date)),
      cutoff: command.cutoff,
      baselineRetrieverId: command.baseline,
      bootstrapSeed: 1,
      bootstrapResamples: 1e4
    });
    output.stdout(command.json ? terminalSafeJson(report) : sanitizeTerminalText(renderEvaluationReport(report)));
    return 0;
  } finally {
    await evaluation.close();
  }
}
async function runHistory(command, output, dependencies) {
  const kb = await (dependencies.openKnowledgeBase ?? openKnowledgeBase)({
    root: command.root,
    repository: command.repository
  });
  try {
    if (command.action === "note") {
      const note = kb.read(command.query, { maxBytes: 1 });
      const history2 = await kb.history([note.id], {
        ...command.limit === undefined ? {} : { commitsPerNote: command.limit },
        ...command.cochangedLimit === undefined ? {} : { cochangedPathsPerCommit: command.cochangedLimit }
      });
      const payload = {
        kind: "note",
        note: { id: note.id, path: note.path, title: note.title },
        history: history2,
        partial: historyIsPartial(history2)
      };
      output.stdout(command.json ? terminalSafeJson(payload) : sanitizeTerminalText(renderNoteHistory(payload.note, history2)));
      return 0;
    }
    const history = await kb.searchHistory({
      query: command.query,
      ...command.limit === undefined ? {} : { limit: command.limit },
      ...command.commitLimit === undefined ? {} : { commitsPerHit: command.commitLimit },
      ...command.cochangedLimit === undefined ? {} : { cochangedPathsPerCommit: command.cochangedLimit }
    });
    output.stdout(command.json ? terminalSafeJson({
      kind: "search",
      history,
      partial: historyIsPartial(history)
    }) : sanitizeTerminalText(renderHistorySearch(history)));
    return 0;
  } finally {
    await kb.close();
  }
}
function issueJson(issue) {
  return issue.kind === "broken" ? { kind: issue.kind, source: issue.source, line: issue.line, target: issue.target } : {
    kind: issue.kind,
    source: issue.source,
    line: issue.line,
    target: issue.target,
    candidates: issue.candidates
  };
}
function relationIssueJson(issue) {
  return { ...issue };
}
function summary(snapshot, options = {}) {
  return {
    root: snapshot.root,
    indexPath: snapshot.indexPath,
    index: snapshot.index,
    catalogRequired: options.noCatalog !== true,
    noteCount: snapshot.analysis.noteCount,
    contextualLinkCount: snapshot.analysis.contextualLinks.length,
    backlinkCount: snapshot.analysis.backlinks.length,
    authoredRelationCount: snapshot.analysis.authoredRelations.length,
    issues: snapshot.analysis.issues.map(issueJson),
    relationIssues: snapshot.analysis.relationIssues.map(relationIssueJson),
    orphans: snapshot.analysis.orphans,
    mentions: snapshot.analysis.mentions,
    ...options.attachments === undefined ? {} : {
      attachments: {
        referenceCount: options.attachments.references.length,
        validatedCount: options.attachments.attachments.length,
        truncated: options.attachments.truncated,
        issues: options.attachments.issues
      }
    }
  };
}
function renderIssue(issue) {
  if (issue.kind === "broken") {
    return `${safe(issue.source)}:${issue.line}: broken wikilink [[${safe(issue.target)}]]`;
  }
  return `${safe(issue.source)}:${issue.line}: ambiguous wikilink [[${safe(issue.target)}]] (${issue.candidates.map(safe).join(", ")})`;
}
function renderRelationIssue(issue) {
  if (issue.kind === "malformed") {
    return `${safe(issue.source)}:${issue.line}: malformed relationship${issue.predicate === undefined ? "" : ` ${safe(issue.predicate)}`}: ${safe(issue.message)}`;
  }
  if (issue.kind === "broken") {
    return `${safe(issue.source)}:${issue.line}: broken relationship ${safe(issue.predicate)} \u2192 ${safe(issue.target)}`;
  }
  return `${safe(issue.source)}:${issue.line}: ambiguous relationship ${safe(issue.predicate)} \u2192 ${safe(issue.target)} (${issue.candidates.map(safe).join(", ")})`;
}
function renderAdvisories(analysis) {
  const lines = [];
  if (analysis.orphans.length > 0) {
    lines.push(`Advisory: ${analysis.orphans.length} contextual orphan${analysis.orphans.length === 1 ? "" : "s"}.`);
    for (const orphan of analysis.orphans)
      lines.push(`  ${safe(orphan)}`);
  }
  if (analysis.mentions.length > 0) {
    lines.push(`Advisory: ${analysis.mentions.length} exact unlinked title or alias mention${analysis.mentions.length === 1 ? "" : "s"}.`);
    for (const mention of analysis.mentions) {
      lines.push(`  ${safe(mention.source)}:${mention.line} mentions \u201C${safe(mention.phrase)}\u201D (${safe(mention.target)})`);
    }
  }
  return lines;
}
function checkExitCode(snapshot, noCatalog = false, attachments) {
  return !noCatalog && snapshot.index === "stale" || snapshot.analysis.issues.length > 0 || snapshot.analysis.relationIssues.length > 0 || (attachments?.issues.length ?? 0) > 0 || attachments?.truncated === true ? 3 : 0;
}
function renderAttachmentIssue(issue) {
  const candidates = issue.candidates === undefined ? "" : ` (${issue.candidates.map(safe).join(", ")})`;
  return `${safe(issue.source)}:${issue.line}: ${safe(issue.kind)} attachment ${safe(issue.target)}: ${safe(issue.message)}${candidates}`;
}
function renderSnapshot(command, snapshot, noCatalog = false, attachments) {
  const lines = [
    `${command === "refresh" ? "Refreshed" : "Checked"} ${safe(snapshot.root)}`,
    `Index: ${noCatalog ? `not required (${snapshot.index})` : snapshot.index}; notes: ${snapshot.analysis.noteCount}; contextual links: ${snapshot.analysis.contextualLinks.length}; typed relationships: ${snapshot.analysis.authoredRelations.length}.`
  ];
  if (!noCatalog && snapshot.index === "stale") {
    lines.push(`error: generated catalog is stale (${safe(snapshot.indexPath)})`);
  }
  for (const issue of snapshot.analysis.issues)
    lines.push(`error: ${renderIssue(issue)}`);
  for (const issue of snapshot.analysis.relationIssues) {
    lines.push(`error: ${renderRelationIssue(issue)}`);
  }
  for (const issue of attachments?.issues ?? []) {
    lines.push(`error: ${renderAttachmentIssue(issue)}`);
  }
  if (attachments?.truncated === true && attachments.issues.every(({ kind }) => kind !== "budget")) {
    lines.push("error: attachment validation was truncated by a resource limit");
  }
  lines.push(...renderAdvisories(snapshot.analysis));
  return `${lines.join(`
`)}
`;
}
function graphJson(snapshot) {
  return { ...summary(snapshot), notes: snapshot.analysis.noteConnections };
}
function renderGraph(snapshot) {
  const lines = [
    `Graph: ${snapshot.analysis.noteCount} notes; ${snapshot.analysis.contextualLinks.length} contextual links; ${snapshot.analysis.authoredRelations.length} typed relationships.`
  ];
  for (const note of snapshot.analysis.noteConnections) {
    lines.push(`${safe(note.path)}  \u2190 ${note.inboundContextualCount}  \u2192 ${note.outboundContextualCount}`);
  }
  if (snapshot.analysis.contextualLinks.length > 0) {
    lines.push("Contextual edges:");
    for (const link of snapshot.analysis.contextualLinks) {
      lines.push(`  ${safe(link.source)}:${link.line} \u2192 ${safe(link.target)}`);
    }
  }
  if (snapshot.analysis.authoredRelations.length > 0) {
    lines.push("Typed relationships:");
    for (const relation of snapshot.analysis.authoredRelations) {
      lines.push(`  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} \u2192 ${safe(relation.target)}`);
    }
  }
  for (const issue of snapshot.analysis.issues)
    lines.push(`error: ${renderIssue(issue)}`);
  for (const issue of snapshot.analysis.relationIssues) {
    lines.push(`error: ${renderRelationIssue(issue)}`);
  }
  lines.push(...renderAdvisories(snapshot.analysis));
  return `${lines.join(`
`)}
`;
}
function backlinkPayload(notePath, backlinks, relationships) {
  return {
    note: notePath,
    count: backlinks.length + relationships.length,
    backlinkCount: backlinks.length,
    relationshipCount: relationships.length,
    backlinks,
    relationships
  };
}
function renderBacklinks(notePath, backlinks, relationships) {
  const lines = [
    `Backlinks to ${safe(notePath)} (${backlinks.length} links, ${relationships.length} typed relationships)`
  ];
  if (backlinks.length === 0 && relationships.length === 0)
    lines.push("  None.");
  else
    for (const backlink of backlinks)
      lines.push(`  ${safe(backlink.source)}:${backlink.line}`);
  for (const relation of relationships) {
    lines.push(`  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} \u2192 ${safe(relation.target)}`);
  }
  return `${lines.join(`
`)}
`;
}
function renderLinks(neighborhood) {
  const lines = [
    `Links around ${safe(neighborhood.note)} (${neighborhood.direction}, depth ${neighborhood.depth}, limit ${neighborhood.limit})`
  ];
  for (const node of neighborhood.nodes) {
    lines.push(`  ${node.distance}  ${safe(node.path)} \u2014 ${safe(node.title)}  \u2190 ${node.inboundContextualCount}  \u2192 ${node.outboundContextualCount}`);
  }
  if (neighborhood.edges.length > 0) {
    lines.push("Edges:");
    for (const edge of neighborhood.edges) {
      lines.push(`  ${safe(edge.source)}:${edge.line} \u2192 ${safe(edge.target)}`);
    }
  }
  if (neighborhood.relations.length > 0) {
    lines.push("Typed relationships:");
    for (const relation of neighborhood.relations) {
      lines.push(`  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} \u2192 ${safe(relation.target)}`);
    }
  }
  if (neighborhood.truncated) {
    lines.push("Results were truncated by the node or connection limit; lower the depth or raise --limit.");
  }
  return `${lines.join(`
`)}
`;
}
function renderList(rows) {
  const lines = [`Notes (${rows.length})`];
  if (rows.length === 0)
    lines.push("  None.");
  for (const row of rows) {
    const tags = row.tags.length === 0 ? "" : `  #${row.tags.map(safe).join(" #")}`;
    lines.push(`  ${safe(row.path)} \u2014 ${safe(row.title)}  \u2190 ${row.inboundContextualCount}  \u2192 ${row.outboundContextualCount}${tags}`);
  }
  return `${lines.join(`
`)}
`;
}
function renderSourceInbox(report) {
  const lines = [
    `Source inbox: ${report.pendingSources} pending of ${report.totalSources} captures; ${report.disposedSources} disposed.`
  ];
  if (report.items.length === 0)
    lines.push("  None.");
  for (const item of report.items) {
    const clipped = item.clipped === null ? "undated" : item.clipped;
    lines.push(`  ${safe(clipped)}  ${safe(item.path)} \u2014 ${safe(item.title)}  (${safe(item.reason)})`);
  }
  if (report.truncated) {
    lines.push(`  \u2026 ${report.pendingSources - report.returnedSources} more; raise --limit to inspect them.`);
  }
  lines.push("Advisory only: a capture may remain an intentional leaf.");
  return `${lines.join(`
`)}
`;
}
function renderAuthoringResult(verb, result) {
  return [
    `${result.changed ? verb : "Unchanged"} ${safe(result.path)}`,
    `Revision: ${safe(result.revision)}; outbound relationships: ${result.relations.length}.`,
    ""
  ].join(`
`);
}
async function runNoteCreate(command, output, dependencies) {
  const body = command.body ?? (command.bodyFile === undefined ? undefined : await readBoundedUtf8(command.bodyFile, 16 * 1024 * 1024, "note body"));
  const result = await (dependencies.createNote ?? createNote)(command.root, {
    ...command.input,
    ...body === undefined ? {} : { body }
  });
  output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderAuthoringResult("Created", result)));
  return 0;
}
async function runRelation(command, output, dependencies) {
  if (command.action === "list") {
    const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, { mentionScope: false });
    const lookup = lookupNote(snapshot.notes, command.source);
    if (lookup.kind === "missing") {
      if (command.json) {
        output.stdout(terminalSafeJson({
          ok: false,
          kind: "missing",
          note: command.source
        }));
      } else {
        output.stderr(`error: note was not found
`);
      }
      return 3;
    }
    if (lookup.kind === "ambiguous") {
      if (command.json) {
        output.stdout(terminalSafeJson({
          ok: false,
          kind: "ambiguous",
          candidates: lookup.candidates.map(({ id }) => id)
        }));
      } else {
        output.stderr(`error: note is ambiguous (${lookup.candidates.map(({ id }) => safe(id)).join(", ")})
`);
      }
      return 3;
    }
    const outbound = snapshot.analysis.authoredRelations.filter(({ source }) => source === lookup.note.id);
    const inbound = snapshot.analysis.authoredRelations.filter(({ target: target2 }) => target2 === lookup.note.id);
    const payload = {
      note: lookup.note.id,
      outboundCount: outbound.length,
      inboundCount: inbound.length,
      outbound,
      inbound
    };
    if (command.json) {
      output.stdout(terminalSafeJson(payload));
    } else {
      const lines = [
        `Relationships for ${safe(lookup.note.id)} (${outbound.length} out, ${inbound.length} in)`
      ];
      if (outbound.length === 0 && inbound.length === 0)
        lines.push("  None.");
      for (const relation of outbound) {
        lines.push(`  \u2192 ${safe(relation.predicate)} \u2192 ${safe(relation.target)}`);
      }
      for (const relation of inbound) {
        lines.push(`  \u2190 ${safe(relation.predicate)} \u2190 ${safe(relation.source)}`);
      }
      output.stdout(`${lines.join(`
`)}
`);
    }
    return 0;
  }
  const predicate = command.predicate;
  const target = command.target;
  if (predicate === undefined || target === undefined) {
    throw new Error("relation command parser lost its predicate or target");
  }
  const options = command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision };
  const result = command.action === "add" ? await (dependencies.addNoteRelation ?? addNoteRelation)(command.root, command.source, predicate, target, options) : await (dependencies.removeNoteRelation ?? removeNoteRelation)(command.root, command.source, predicate, target, options);
  output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderAuthoringResult("Updated", result)));
  return 0;
}
function renderPercolation(result, note) {
  const lines = [
    `Percolation${note === undefined ? "" : ` for ${safe(note)}`}: ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}.`
  ];
  if (result.candidates.length === 0)
    lines.push("  None.");
  for (const candidate of result.candidates) {
    if (candidate.kind === "missing-concept") {
      lines.push(`  concept  #${safe(candidate.tag)} \u2192 ${safe(candidate.suggestedId)}  (${candidate.support} supporting notes)` + (candidate.collidesWith === null ? "" : `; natural ID is occupied by ${safe(candidate.collidesWith)}`));
    } else if (candidate.kind === "missing-relation") {
      lines.push(`  relation  ${safe(candidate.source)} ${safe(candidate.suggestedPredicate)} ${safe(candidate.target)}  (${candidate.support} shared signals)`);
    } else if (candidate.kind === "unlinked-mention") {
      lines.push(`  mention  ${safe(candidate.source)} \u2192 ${safe(candidate.target)}  (${candidate.support})`);
    } else {
      lines.push(`  hygiene  ${safe(candidate.problem)} in ${safe(candidate.source)}${candidate.target === null ? "" : ` \u2192 ${safe(candidate.target)}`}: ${safe(candidate.message)}`);
    }
    for (const evidence of candidate.evidence.slice(0, 3)) {
      if (evidence.kind === "tag") {
        lines.push(`    ${safe(evidence.path)}  #${safe(evidence.tag)}`);
      } else if (evidence.kind === "shared-tag") {
        lines.push(`    ${safe(evidence.path)} shares #${safe(evidence.tag)}`);
      } else if (evidence.kind === "shared-concept") {
        lines.push(`    ${safe(evidence.path)} shares ${safe(evidence.concept)}`);
      } else if (evidence.kind === "mention") {
        lines.push(`    ${safe(evidence.source)}:${evidence.line} mentions \u201C${safe(evidence.phrase)}\u201D`);
      } else if (evidence.kind === "relation") {
        lines.push(`    ${safe(evidence.source)}:${evidence.line} ${safe(evidence.predicate)} \u2192 ${safe(evidence.target)}`);
      } else {
        lines.push(`    ${safe(evidence.source)}:${evidence.line} ${safe(evidence.message)}`);
      }
    }
    if (candidate.evidence.length > 3) {
      lines.push(`    \u2026 ${candidate.evidence.length - 3} more evidence records`);
    }
  }
  return `${lines.join(`
`)}
`;
}
async function runPercolate(command, output, dependencies) {
  const maxMentionPairs = command.note === undefined ? MAX_PERCOLATION_MENTION_PAIRS : MAX_SCOPED_PERCOLATION_MENTION_PAIRS;
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, {
    maxNotes: MAX_PERCOLATION_NOTES,
    maxMentionPairs,
    maxMentions: Math.min(MAX_PERCOLATION_MENTIONS, maxMentionPairs),
    ...command.note === undefined ? {} : { mentionScope: command.note }
  });
  const result = (dependencies.percolateVault ?? percolateVault)(snapshot.notes, snapshot.analysis, {
    ...command.note === undefined ? {} : { note: command.note },
    minSupport: command.minSupport,
    limit: command.limit
  });
  output.stdout(command.json ? terminalSafeJson({
    root: snapshot.root,
    note: command.note ?? null,
    minSupport: command.minSupport,
    ...result
  }) : sanitizeTerminalText(renderPercolation(result, command.note)));
  return 0;
}
async function runList(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  const rows = queryVault(snapshot.notes, snapshot.analysis, {
    filters: command.filters,
    tags: command.tags,
    repositoryScopes: command.repositoryScopes,
    sort: command.sort,
    direction: command.direction,
    ...command.limit === undefined ? {} : { limit: command.limit }
  });
  output.stdout(command.json ? terminalSafeJson({ root: snapshot.root, count: rows.length, notes: rows }) : sanitizeTerminalText(renderList(rows)));
  return 0;
}
async function runCatalog(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  const relativeIndex = relative(snapshot.root, snapshot.indexPath).split("\\").join("/");
  const catalogNoteId = relativeIndex.toLocaleLowerCase("en-US").endsWith(".md") ? relativeIndex.slice(0, -3) : relativeIndex;
  const catalog = renderCatalog(snapshot.notes, catalogNoteId);
  output.stdout(command.json ? terminalSafeJson({
    root: snapshot.root,
    catalogMode: snapshot.catalogMode,
    noteCount: snapshot.analysis.noteCount,
    catalog
  }) : sanitizeTerminalText(`${catalog}
`));
  return 0;
}
async function runInbox(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  const report = sourceInbox(snapshot.notes, snapshot.analysis, {
    limit: command.limit,
    ...command.sourcePrefixes.length === 0 ? {} : { sourcePrefixes: command.sourcePrefixes }
  });
  output.stdout(command.json ? terminalSafeJson({ root: snapshot.root, ...report }) : sanitizeTerminalText(renderSourceInbox(report)));
  return 0;
}
async function runInit(command, output, initialize) {
  const result = await initialize(command.directory);
  if (command.json)
    output.stdout(terminalSafeJson(result));
  else {
    const relativeRoot = relative(process.cwd(), result.root) || ".";
    output.stdout(`Initialized ${safe(relativeRoot)} with ${result.files.length} files.
`);
  }
  return 0;
}
function contextIssuePayload(issue) {
  return { ...issue };
}
function uniqueAgentContextIssues(issues) {
  const unique = new Map;
  for (const issue of issues)
    unique.set(JSON.stringify(issue), issue);
  return [...unique.values()].toSorted((left, right) => `${left.kind}\x00${left.message}`.localeCompare(`${right.kind}\x00${right.message}`));
}
function contextPayload(inspection, snapshot, memory) {
  const connections = new Map(snapshot.analysis.noteConnections.map((connection) => [connection.id, connection]));
  return {
    repositoryRoot: inspection.repositoryRoot,
    vaultRoot: snapshot.root,
    target: inspection.target,
    targetScope: inspection.targetScope,
    guides: inspection.inheritedGuides.map((guide) => ({
      path: guide.path,
      scope: guide.scope,
      context: guide.marker.markers[0]?.noteId
    })),
    contexts: inspection.matchingContexts.map((context) => {
      const connection = connections.get(context.note.id);
      return {
        id: context.note.id,
        path: context.note.path,
        title: context.note.title,
        scope: context.scope,
        summary: context.note.summary,
        inboundContextualCount: connection?.inboundContextualCount ?? 0,
        outboundContextualCount: connection?.outboundContextualCount ?? 0
      };
    }),
    records: memory,
    issues: inspection.issues.map(contextIssuePayload)
  };
}
function renderContext(inspection, snapshot, memory) {
  const lines = [
    `Agent context for ${safe(inspection.target)} (scope ${safe(inspection.targetScope)})`,
    "Guides (root \u2192 nearest):"
  ];
  if (inspection.inheritedGuides.length === 0)
    lines.push("  None.");
  for (const guide of inspection.inheritedGuides) {
    const context = guide.marker.markers[0]?.noteId;
    lines.push(`  ${safe(guide.path)}${context === undefined ? "" : `  \u2192  ${safe(context)}`}`);
  }
  lines.push("KB hubs (nearest \u2192 root):");
  if (inspection.matchingContexts.length === 0)
    lines.push("  None.");
  for (const context of inspection.matchingContexts) {
    const connection = snapshot.analysis.noteConnections.find(({ id }) => id === context.note.id);
    lines.push(`  ${safe(context.note.id)} \u2014 ${safe(context.note.title)}  \u2190 ${connection?.inboundContextualCount ?? 0}  \u2192 ${connection?.outboundContextualCount ?? 0}`);
    if (context.note.summary !== "")
      lines.push(`    ${safe(context.note.summary)}`);
  }
  const groupLabels = {
    maintainedKnowledge: "Maintained knowledge",
    activePlans: "Active plans",
    datedResearch: "Dated research",
    reports: "Reports",
    historicalPlans: "Historical plans"
  };
  lines.push(`Repository memory (${memory.counts.returned} of ${memory.counts.matched} matched records):`);
  for (const key of repositoryMemoryGroupKeys) {
    const group = memory.groups[key];
    lines.push(`  ${groupLabels[key]} (${group.returned}/${group.total})`);
    if (group.records.length === 0)
      lines.push("    None.");
    for (const record of group.records) {
      const scopeState = record.scopeState.status === "present" ? record.scopeState.kind : record.scopeState.status;
      lines.push(`    ${safe(record.path)} \u2014 ${safe(record.title)}  [${safe(record.matchedScope)}; ${safe(record.match)}; ${safe(scopeState)}]`);
      if (record.description !== undefined)
        lines.push(`      ${safe(record.description)}`);
      else if (record.summary !== "")
        lines.push(`      ${safe(record.summary)}`);
    }
    if (group.truncated)
      lines.push(`    \u2026 ${group.total - group.returned} more.`);
  }
  if (memory.invalidRecords.total > 0) {
    lines.push(`Repository-memory errors (${memory.invalidRecords.returned}/${memory.invalidRecords.total}):`);
    for (const invalid of memory.invalidRecords.details) {
      lines.push(`  ${safe(invalid.path)}: ${invalid.issues.map(safe).join(" ")}`);
    }
  }
  if (memory.advisories.total > 0) {
    lines.push(`Repository-memory advisories (${memory.advisories.returned}/${memory.advisories.total}):`);
    for (const advisory of memory.advisories.details)
      lines.push(`  ${safe(advisory.message)}`);
  }
  for (const issue of inspection.issues)
    lines.push(`error: ${safe(issue.message)}`);
  if (inspection.matchingContexts.length > 0) {
    lines.push("Open a hub, then use `kb links <hub> --root <vault> --depth 1` for bounded neighboring context.");
  }
  return `${lines.join(`
`)}
`;
}
async function runContext(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root);
  const inspection = await (dependencies.inspectAgentContextRepository ?? inspectAgentContextRepository)(snapshot.notes, {
    repositoryRoot: command.repository,
    target: command.target,
    targetKind: command.targetKind
  });
  const memory = await (dependencies.buildRepositoryMemoryContext ?? buildRepositoryMemoryContext)(snapshot.notes, {
    repositoryRoot: command.repository,
    target: inspection.target
  });
  output.stdout(command.json ? terminalSafeJson(contextPayload(inspection, snapshot, memory)) : sanitizeTerminalText(renderContext(inspection, snapshot, memory)));
  return inspection.issues.length === 0 && memory.invalidRecords.total === 0 ? 0 : 3;
}
function agentIdentityPayload(scopeInput) {
  const scope = normalizeRepositoryScope(scopeInput);
  return {
    scope,
    noteId: agentContextNoteId(scope),
    notePath: agentContextNotePath(scope),
    guidePath: agentContextGuidePath(scope),
    marker: agentContextMarkerForScope(scope)
  };
}
function renderAgentIdentity(identity) {
  return [
    `Scope: ${safe(identity.scope ?? "")}`,
    `Note ID: ${safe(identity.noteId ?? "")}`,
    `Note path: ${safe(identity.notePath ?? "")}`,
    `Guide path: ${safe(identity.guidePath ?? "")}`,
    `Marker: ${safe(identity.marker ?? "")}`,
    ""
  ].join(`
`);
}
function runAgentIdentity(command, output) {
  const identity = agentIdentityPayload(command.scope);
  output.stdout(command.json ? terminalSafeJson(identity) : sanitizeTerminalText(renderAgentIdentity(identity)));
  return 0;
}
function agentCheckErrors(contextIssues, discoveryIssues, audit) {
  return [
    ...uniqueAgentContextIssues(contextIssues).map((issue) => ({ kind: "context", issue })),
    ...discoveryIssues.filter(({ kind }) => kind !== "symlink-directory").map((issue) => ({ kind: "discovery", issue })),
    ...audit.guides.flatMap((guide) => guide.shapeIssues.map((issue) => ({ kind: "shape", path: guide.path, issue })))
  ];
}
function renderAgentCheckError(error) {
  if (error.kind === "context")
    return error.issue.message;
  if (error.kind === "discovery")
    return error.issue.message;
  return `${error.path}: ${error.issue.message}`;
}
function advisoryLabel(advisory) {
  if (advisory.kind === "contents-budget") {
    return `${advisory.path}: Contents has ${advisory.actualWords} words / ${advisory.actualBullets} bullets`;
  }
  if (advisory.kind === "guidelines-budget") {
    return `${advisory.path}: Guidelines has ${advisory.actualWords} words / ${advisory.actualBullets} bullets`;
  }
  if (advisory.kind === "long-guideline") {
    return `${advisory.path}:${advisory.line}: guideline has ${advisory.words} words`;
  }
  if (advisory.kind === "inherited-budget") {
    return `${advisory.path}: inherited chain has ${advisory.words} words across ${advisory.guides.length} guides`;
  }
  return `${advisory.guides.length} guides repeat a ${advisory.words}-word rule: ${advisory.text}`;
}
function agentReportPayload(repositoryRoot, vaultRoot, audit, validContexts, errors, discoveryIssues, includeAudit) {
  return {
    repositoryRoot,
    vaultRoot,
    guideCount: audit.guideCount,
    mappedGuideCount: audit.mappedGuideCount,
    validContextCount: validContexts,
    words: audit.words,
    contentsWords: audit.contentsWords,
    guidelineWords: audit.guidelineWords,
    nonblankLines: audit.nonblankLines,
    errors,
    discoveryIssues,
    ...includeAudit ? {
      advisories: audit.advisories,
      duplicates: audit.duplicates,
      guides: audit.guides.map((guide) => ({
        path: guide.path,
        scope: guide.scope,
        words: guide.words,
        nonblankLines: guide.nonblankLines,
        contentsWords: guide.contents.words,
        guidelineWords: guide.guidelines.words,
        inheritedWords: guide.inheritedWords,
        inheritedGuidePaths: guide.inheritedGuidePaths,
        context: guide.marker.markers[0]?.noteId
      }))
    } : {}
  };
}
function renderAgentReport(action, audit, validContexts, errors, discoveryIssues) {
  const lines = [
    `${action === "check" ? "Checked" : "Audited"} ${audit.guideCount} agent guides; ${audit.mappedGuideCount} markers, ${validContexts} valid KB hubs.`,
    `Context: ${audit.words} words (${audit.contentsWords} Contents, ${audit.guidelineWords} Guidelines), ${audit.nonblankLines} nonblank lines.`
  ];
  if (errors.length === 0)
    lines.push("Mappings and guide shape: clean.");
  else
    for (const error of errors)
      lines.push(`error: ${safe(renderAgentCheckError(error))}`);
  const skippedDirectories = discoveryIssues.filter(({ kind }) => kind === "symlink-directory");
  if (skippedDirectories.length > 0) {
    lines.push(`Skipped symbolic-link directories (${skippedDirectories.length}):`);
    for (const issue of skippedDirectories)
      lines.push(`  ${safe(issue.path)}`);
  }
  if (action === "audit") {
    lines.push(`Advisories: ${audit.advisories.length}; exact duplicate rules: ${audit.duplicates.length}.`);
    const worstChains = audit.guides.toSorted((left, right) => right.inheritedWords - left.inheritedWords || left.path.localeCompare(right.path)).slice(0, 10);
    lines.push("Largest inherited chains:");
    for (const guide of worstChains) {
      lines.push(`  ${guide.inheritedWords} words / ${guide.inheritedGuidePaths.length} guides  ${safe(guide.path)}`);
    }
    const shown = audit.advisories.slice(0, 25);
    if (shown.length > 0)
      lines.push("Advisory sample:");
    for (const advisory of shown)
      lines.push(`  ${safe(advisoryLabel(advisory))}`);
    if (audit.advisories.length > shown.length) {
      lines.push(`  \u2026 ${audit.advisories.length - shown.length} more; rerun with --json for the complete audit.`);
    }
  }
  return `${lines.join(`
`)}
`;
}
async function runAgents(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root);
  const repository = await (dependencies.auditAgentGuideRepository ?? auditAgentGuideRepository)(command.repository);
  const mapping = analyzeAgentContexts(snapshot.notes, repository.guides);
  const filesystem = await (dependencies.inspectAgentContextRepository ?? inspectAgentContextRepository)(snapshot.notes, {
    repositoryRoot: command.repository,
    target: ".",
    targetKind: "directory",
    validationMode: "all"
  });
  const errors = agentCheckErrors([...mapping.issues, ...filesystem.issues], repository.issues, repository.audit);
  const validContexts = mapping.contexts.filter(({ valid }) => valid).length;
  if (command.json) {
    output.stdout(terminalSafeJson(agentReportPayload(repository.repositoryRoot, snapshot.root, repository.audit, validContexts, errors, repository.issues, command.action === "audit")));
  } else {
    output.stdout(sanitizeTerminalText(renderAgentReport(command.action, repository.audit, validContexts, errors, repository.issues)));
  }
  return errors.length === 0 ? 0 : 3;
}
async function runVault(command, output, dependencies) {
  const snapshot = command.kind === "refresh" ? await (dependencies.refreshVault ?? refreshVault)(command.root, command.options) : await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  if (command.kind === "refresh" || command.kind === "check") {
    const noCatalog = command.kind === "check" && command.noCatalog === true;
    const attachments = command.kind === "check" ? await (dependencies.validateMarkdownAttachments ?? validateMarkdownAttachments)({
      root: snapshot.root,
      documents: snapshot.notes.map(({ path, content }) => ({ path, content }))
    }) : undefined;
    output.stdout(command.json ? terminalSafeJson(summary(snapshot, { noCatalog, ...attachments === undefined ? {} : { attachments } })) : sanitizeTerminalText(renderSnapshot(command.kind, snapshot, noCatalog, attachments)));
    return checkExitCode(snapshot, noCatalog, attachments);
  }
  if (command.kind === "graph") {
    output.stdout(command.json ? terminalSafeJson(graphJson(snapshot)) : sanitizeTerminalText(renderGraph(snapshot)));
    return 0;
  }
  const lookup = lookupNote(snapshot.notes, command.note ?? "");
  if (lookup.kind === "missing") {
    if (command.json) {
      output.stdout(terminalSafeJson({
        ok: false,
        kind: "missing",
        note: command.note ?? ""
      }));
    } else {
      output.stderr(`error: note was not found
`);
    }
    return 3;
  }
  if (lookup.kind === "ambiguous") {
    if (command.json) {
      output.stdout(terminalSafeJson({ ok: false, kind: "ambiguous", candidates: lookup.candidates.map(({ path }) => path) }));
    } else {
      output.stderr(`error: note is ambiguous (${lookup.candidates.map(({ path }) => safe(path)).join(", ")})
`);
    }
    return 3;
  }
  if (command.kind === "links") {
    const neighborhood = navigateLinks(snapshot.notes, snapshot.analysis, lookup.note, {
      direction: command.direction ?? "both",
      depth: command.depth ?? 1,
      ...command.limit === undefined ? {} : { limit: command.limit }
    });
    output.stdout(command.json ? terminalSafeJson(neighborhood) : sanitizeTerminalText(renderLinks(neighborhood)));
    return 0;
  }
  const connection = snapshot.analysis.noteConnections.find(({ id }) => id === lookup.note.id);
  const backlinks = connection?.backlinks ?? [];
  const relationBacklinks = connection?.relationBacklinks ?? [];
  output.stdout(command.json ? terminalSafeJson(backlinkPayload(lookup.note.path, backlinks, relationBacklinks)) : sanitizeTerminalText(renderBacklinks(lookup.note.path, backlinks, relationBacklinks)));
  return 0;
}
async function main4(rawArguments = process.argv.slice(2), output = defaultOutput2, dependencies = {}) {
  const jsonRequested = rawArguments.includes("--json");
  const parsed = parseArguments(rawArguments);
  if (!parsed.ok) {
    if (jsonRequested) {
      output.stdout(terminalSafeJson({
        ok: false,
        error: { kind: "parse", message: parsed.message }
      }));
    } else {
      output.stderr(`error: ${safe(parsed.message)}

${sanitizeTerminalText(usage)}`);
    }
    return 2;
  }
  const command = parsed.value;
  if (command.kind === "help") {
    output.stdout(sanitizeTerminalText(usage));
    return 0;
  }
  try {
    if (command.kind === "clip") {
      return await (dependencies.runClipCommand ?? main)(command.arguments, process.env, output);
    }
    if (command.kind === "url-metadata") {
      return await (dependencies.runUrlMetadataCommand ?? main3)(command.arguments, process.env, output);
    }
    if (command.kind === "pdf") {
      return await (dependencies.runPdfCommand ?? main2)(command.arguments, process.env, output);
    }
    if (command.kind === "init") {
      return await runInit(command, output, dependencies.initVault ?? initVault);
    }
    if (command.kind === "index" || command.kind === "search") {
      return await runSemantic(command, output, dependencies);
    }
    if (command.kind === "history")
      return await runHistory(command, output, dependencies);
    if (command.kind === "evaluate")
      return await runEvaluation(command, output, dependencies);
    if (command.kind === "context")
      return await runContext(command, output, dependencies);
    if (command.kind === "agent-identity")
      return runAgentIdentity(command, output);
    if (command.kind === "agents")
      return await runAgents(command, output, dependencies);
    if (command.kind === "note-create")
      return await runNoteCreate(command, output, dependencies);
    if (command.kind === "relation")
      return await runRelation(command, output, dependencies);
    if (command.kind === "percolate")
      return await runPercolate(command, output, dependencies);
    if (command.kind === "list")
      return await runList(command, output, dependencies);
    if (command.kind === "inbox")
      return await runInbox(command, output, dependencies);
    if (command.kind === "catalog")
      return await runCatalog(command, output, dependencies);
    return await runVault(command, output, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonRequested) {
      output.stdout(terminalSafeJson({
        ok: false,
        error: { kind: "runtime", message }
      }));
    } else {
      output.stderr(`error: ${safe(message)}
`);
    }
    return 1;
  }
}
var strictJsonTail = Promise.resolve();
async function serializeStrictJson(operation) {
  const previous = strictJsonTail;
  let release2 = () => {
    return;
  };
  strictJsonTail = new Promise((resolvePromise) => {
    release2 = resolvePromise;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release2();
  }
}
function strictProtocolObject(value) {
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Machine output must be one JSON object.");
  }
  return parsed;
}
async function runExecutable(rawArguments = process.argv.slice(2), dependencies = {}) {
  if (!rawArguments.includes("--json")) {
    return main4(rawArguments, defaultOutput2, dependencies);
  }
  return serializeStrictJson(async () => {
    const stdout = process.stdout;
    const ownWrite = Object.getOwnPropertyDescriptor(stdout, "write");
    const rawStdoutWrite = stdout.write.bind(stdout);
    const rawStderrWrite = process.stderr.write.bind(process.stderr);
    const originalConsole = {
      log: console.log,
      info: console.info,
      debug: console.debug
    };
    const chunks = [];
    const protocolOutput = {
      stdout: (value) => chunks.push(value),
      stderr: (value) => {
        rawStderrWrite(value);
      }
    };
    const redirectedWrite = (...arguments_) => {
      Reflect.apply(rawStderrWrite, process.stderr, arguments_);
      return true;
    };
    const redirectedConsole = (...arguments_) => {
      rawStderrWrite(`${format(...arguments_)}
`);
    };
    try {
      Object.defineProperty(stdout, "write", {
        configurable: true,
        writable: true,
        value: redirectedWrite
      });
      console.log = redirectedConsole;
      console.info = redirectedConsole;
      console.debug = redirectedConsole;
    } catch (error) {
      if (ownWrite === undefined)
        Reflect.deleteProperty(stdout, "write");
      else
        Object.defineProperty(stdout, "write", ownWrite);
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
      const fallback = terminalSafeJson({
        ok: false,
        error: {
          kind: "protocol",
          message: `Could not guard machine stdout: ${error instanceof Error ? error.message : String(error)}`
        }
      });
      rawStdoutWrite(fallback);
      return 1;
    }
    let exitCode = 1;
    let protocolValue;
    try {
      exitCode = await main4(rawArguments, protocolOutput, dependencies);
      protocolValue = strictProtocolObject(chunks.join(""));
    } catch (error) {
      protocolValue = {
        ok: false,
        error: {
          kind: "protocol",
          message: error instanceof Error ? error.message : String(error)
        }
      };
      exitCode = 1;
    } finally {
      if (ownWrite === undefined) {
        Reflect.deleteProperty(stdout, "write");
      } else {
        Object.defineProperty(stdout, "write", ownWrite);
      }
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
    }
    rawStdoutWrite(terminalSafeJson(protocolValue));
    return exitCode;
  });
}
if (import.meta.main)
  process.exitCode = await runExecutable();
export {
  usage,
  runExecutable,
  parseArguments,
  main4 as main
};
