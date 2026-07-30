#!/usr/bin/env bun
import { open } from "node:fs/promises";
import { relative } from "node:path";

import {
  agentContextGuidePath,
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextNotePath,
  analyzeAgentContexts,
  inspectAgentContextRepository,
  normalizeRepositoryScope,
  type AgentContextIssue,
  type AgentContextRepositoryInspection,
  type AgentContextTargetKind,
} from "./agent-context.js";
import {
  auditAgentGuideRepository,
  type AgentGuideAdvisory,
  type AgentGuideAuditReport,
  type AgentGuideDiscoveryIssue,
} from "./agent-guide-audit.js";
import {
  addNoteRelation,
  createNote,
  removeNoteRelation,
  type CreateNoteInput,
  type NoteAuthoringResult,
} from "./authoring.js";
import { main as runClipCommand } from "./clip/cli.js";
import { redactSensitiveText } from "./clip/persist.js";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./clip/terminal.js";
import { main as runPdfCommand } from "./pdf/cli.js";
import {
  lookupNote,
  type AuthoredRelation,
  type Backlink,
  type LinkIssue,
  type MetadataScalar,
  type RelationIssue,
  type VaultAnalysis,
} from "./graph.js";
import { initVault, type InitVaultResult } from "./init.js";
import { navigateLinks, type LinkDirection, type LinkNeighborhood } from "./navigation.js";
import {
  MAX_PERCOLATION_MENTION_PAIRS,
  MAX_PERCOLATION_MENTIONS,
  MAX_PERCOLATION_NOTES,
  MAX_SCOPED_PERCOLATION_MENTION_PAIRS,
  percolateVault,
  type PercolationResult,
} from "./percolate.js";
import {
  queryVault,
  type MetadataFilter,
  type QueryDirection,
  type QueryRow,
  type QuerySort,
} from "./query.js";
import {
  indexSemanticVault,
  type SemanticIndexResult,
} from "./semantic.js";
import {
  openKnowledgeBase,
  type KnowledgeBaseGraphOptions,
  type KnowledgeBaseSearchMode,
  type KnowledgeBaseSearchResult,
} from "./sdk.js";
import {
  refreshVault,
  scanVault,
  type ScanVaultOptions,
  type VaultSnapshot,
} from "./vault.js";

type Output = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

const defaultOutput: Output = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

async function readBoundedUtf8(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
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

export const usage = `kb — auditable capture and derived links for Markdown vaults

Usage:
  kb init [directory] [--json]
  kb clip <url|current> [capture options]
  kb inspect <url> [capture options]
  kb pdf <file-or-url> [PDF options]
  kb refresh [--root <directory>] [--index <path>] [--json]
  kb check [--root <directory>] [--index <path>] [--no-catalog] [--json]
  kb graph [--root <directory>] [--index <path>] [--json]
  kb backlinks <note> [--root <directory>] [--index <path>] [--json]
  kb links <note> [--root <directory>] [--direction <in|out|both>] [--depth <count>] [--limit <count>] [--json]
  kb note create <id> --title <title> [--type <type>] [--tag <tag>] [--body <markdown> | --body-file <path>] [--root <directory>] [--json]
  kb relation add <source> <predicate> <target> [--root <directory>] [--expected-revision <sha256:...>] [--json]
  kb relation remove <source> <predicate> <target> [--root <directory>] [--expected-revision <sha256:...>] [--json]
  kb relation list <note> [--root <directory>] [--json]
  kb percolate [note] [--root <directory>] [--min-support <count>] [--limit <count>] [--json]
  kb list [--root <directory>] [--where <path=value>] [--has <path>] [--tag <tag>] [--sort <field>] [--order <asc|desc>] [--limit <count>] [--json]
  kb index [--root <directory>] [--database <path>] [--force] [--json]
  kb search <query> [--root <directory>] [--repo <repository>] [--database <path>] [--mode <hybrid|exact|keyword|semantic>] [--where <path=value>] [--has <path>] [--tag <tag>] [--related <note>] [--graph-depth <1|2>] [--no-graph] [--no-history | --require-history] [--limit <count>] [--candidate-limit <count>] [--min-score <score>] [--json]
  kb context <repository-path> [--root <vault>] [--repo <repository>] [--kind <auto|file|directory>] [--json]
  kb agents identity <repository-scope> [--json]
  kb agents check [--root <vault>] [--repo <repository>] [--json]
  kb agents audit [--root <vault>] [--repo <repository>] [--json]
  kb doctor [--json]
  kb adapters [--json]

Run \`kb clip --help\` for web capture options or \`kb pdf --help\` for PDF conversion options.
`;

type VaultCommand = "refresh" | "check" | "graph" | "backlinks" | "links";

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "clip"; readonly arguments: readonly string[] }
  | { readonly kind: "pdf"; readonly arguments: readonly string[] }
  | { readonly kind: "init"; readonly directory: string; readonly json: boolean }
  | {
      readonly kind: "context";
      readonly root: string;
      readonly repository: string;
      readonly target: string;
      readonly targetKind: AgentContextTargetKind;
      readonly json: boolean;
    }
  | {
      readonly kind: "agent-identity";
      readonly scope: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "agents";
      readonly action: "check" | "audit";
      readonly root: string;
      readonly repository: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "index";
      readonly root: string;
      readonly database?: string;
      readonly force: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "search";
      readonly root: string;
      readonly repository: string;
      readonly database?: string;
      readonly mode: KnowledgeBaseSearchMode;
      readonly filters: readonly MetadataFilter[];
      readonly tags: readonly string[];
      readonly graph: false | KnowledgeBaseGraphOptions;
      readonly history: false | "auto" | "required";
      readonly limit?: number;
      readonly candidateLimit?: number;
      readonly minScore?: number;
      readonly query: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "list";
      readonly root: string;
      readonly options: ScanVaultOptions;
      readonly filters: readonly MetadataFilter[];
      readonly tags: readonly string[];
      readonly sort: QuerySort;
      readonly direction: QueryDirection;
      readonly limit?: number;
      readonly json: boolean;
    }
  | {
      readonly kind: VaultCommand;
      readonly root: string;
      readonly options: ScanVaultOptions;
      readonly json: boolean;
      readonly note?: string;
      readonly direction?: LinkDirection;
      readonly depth?: number;
      readonly limit?: number;
      readonly noCatalog?: boolean;
    }
  | {
      readonly kind: "note-create";
      readonly root: string;
      readonly input: Omit<CreateNoteInput, "body">;
      readonly body?: string;
      readonly bodyFile?: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "relation";
      readonly action: "add" | "remove" | "list";
      readonly root: string;
      readonly source: string;
      readonly predicate?: string;
      readonly target?: string;
      readonly expectedRevision?: `sha256:${string}`;
      readonly json: boolean;
    }
  | {
      readonly kind: "percolate";
      readonly root: string;
      readonly note?: string;
      readonly minSupport: number;
      readonly limit: number;
      readonly json: boolean;
    };

type ParseResult =
  | { readonly ok: true; readonly value: ParsedCommand }
  | { readonly ok: false; readonly message: string };

type CliDependencies = {
  readonly runClipCommand?: typeof runClipCommand;
  readonly runPdfCommand?: typeof runPdfCommand;
  readonly initVault?: typeof initVault;
  readonly scanVault?: typeof scanVault;
  readonly refreshVault?: typeof refreshVault;
  readonly indexSemanticVault?: typeof indexSemanticVault;
  readonly openKnowledgeBase?: typeof openKnowledgeBase;
  readonly createNote?: typeof createNote;
  readonly addNoteRelation?: typeof addNoteRelation;
  readonly removeNoteRelation?: typeof removeNoteRelation;
  readonly percolateVault?: typeof percolateVault;
  readonly inspectAgentContextRepository?: typeof inspectAgentContextRepository;
  readonly auditAgentGuideRepository?: typeof auditAgentGuideRepository;
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

function readValue(arguments_: readonly string[], index: number): string | null {
  const value = arguments_[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseVaultCommand(command: VaultCommand, arguments_: readonly string[]): ParseResult {
  let root = ".";
  let index: string | undefined;
  let json = false;
  let direction: LinkDirection = "both";
  let depth = 1;
  let limit: number | undefined;
  let noCatalog = false;
  const positional: string[] = [];

  for (let cursor = 0; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
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
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else index = value;
      cursor += 1;
      continue;
    }
    if (command === "links" && (argument === "--direction" || argument === "--depth" || argument === "--limit")) {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
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
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
          return { ok: false, message: "--limit must be an integer from 1 through 1000" };
        }
        limit = parsed;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) return { ok: false, message: `unknown ${command} option` };
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
        ...(command === "links"
          ? { direction, depth, ...(limit === undefined ? {} : { limit }) }
          : {}),
      },
    };
  }
  if (positional.length !== 0) return { ok: false, message: `${command} does not accept positional arguments` };
  return {
    ok: true,
    value: {
      kind: command,
      root,
      options: index === undefined ? {} : { index },
      json,
      ...(command === "check" && noCatalog ? { noCatalog: true } : {}),
    },
  };
}

type MetadataScalarParse =
  | { readonly ok: true; readonly value: MetadataScalar }
  | { readonly ok: false; readonly message: string };

function metadataScalar(raw: string): MetadataScalarParse {
  const value = raw.trim();
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string"
        ? { ok: true, value: parsed }
        : { ok: false, message: "quoted --where values must be strings" };
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
  if (value === "null") return { ok: true, value: null };
  if (value === "true") return { ok: true, value: true };
  if (value === "false") return { ok: true, value: false };
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

function querySort(raw: string): QuerySort | null {
  const value = raw.trim();
  if (value === "title" || value === "path" || value === "inbound" || value === "outbound") {
    return { kind: "builtin", field: value };
  }
  const path = value.replace(/^(?:meta|metadata)\./u, "");
  return path === "" ? null : { kind: "metadata", path };
}

function parseListCommand(arguments_: readonly string[]): ParseResult {
  let root = ".";
  let index: string | undefined;
  let json = false;
  let sort: QuerySort = { kind: "builtin", field: "path" };
  let direction: QueryDirection = "asc";
  let limit: number | undefined;
  const filters: MetadataFilter[] = [];
  const tags: string[] = [];

  for (let cursor = 0; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (
      argument === "--root"
      || argument === "--index"
      || argument === "--where"
      || argument === "--has"
      || argument === "--tag"
      || argument === "--sort"
      || argument === "--order"
      || argument === "--limit"
    ) {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else if (argument === "--index") index = value;
      else if (argument === "--tag") tags.push(value);
      else if (argument === "--has") {
        if (value.trim() === "") return { ok: false, message: "--has requires a metadata path" };
        filters.push({ kind: "exists", path: value });
      } else if (argument === "--where") {
        const equals = value.indexOf("=");
        const path = equals === -1 ? "" : value.slice(0, equals).trim();
        if (path === "") return { ok: false, message: "--where requires path=value" };
        const scalar = metadataScalar(value.slice(equals + 1));
        if (!scalar.ok) return scalar;
        filters.push({ kind: "equals", path, value: scalar.value });
      } else if (argument === "--sort") {
        const parsed = querySort(value);
        if (parsed === null) return { ok: false, message: "--sort requires a field" };
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
      message: argument.startsWith("--")
        ? "unknown list option"
        : "list does not accept positional arguments",
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
      sort,
      direction,
      ...(limit === undefined ? {} : { limit }),
      json,
    },
  };
}

function parseSemanticCommand(command: "index" | "search", arguments_: readonly string[]): ParseResult {
  let root = ".";
  let repository = ".";
  let database: string | undefined;
  let force = false;
  let json = false;
  let mode: KnowledgeBaseSearchMode = "hybrid";
  let limit: number | undefined;
  let candidateLimit: number | undefined;
  let minScore: number | undefined;
  let graphDepth: number | undefined;
  let noGraph = false;
  let noHistory = false;
  let requireHistory = false;
  const filters: MetadataFilter[] = [];
  const tags: string[] = [];
  const related: string[] = [];
  const positional: string[] = [];

  for (let cursor = 0; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
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
    if (argument === "--require-history" && command === "search") {
      requireHistory = true;
      continue;
    }
    if (argument === "--root" || argument === "--database" || (command === "search" && argument === "--repo")) {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else if (argument === "--repo") repository = value;
      else database = value;
      cursor += 1;
      continue;
    }
    if (command === "search" && (
      argument === "--mode"
      || argument === "--limit"
      || argument === "--candidate-limit"
      || argument === "--min-score"
      || argument === "--where"
      || argument === "--has"
      || argument === "--tag"
      || argument === "--related"
      || argument === "--graph-depth"
    )) {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--mode") {
        if (value !== "hybrid" && value !== "exact" && value !== "semantic" && value !== "keyword") {
          return { ok: false, message: "--mode must be hybrid, exact, keyword, or semantic" };
        }
        mode = value;
      } else if (argument === "--where") {
        const equals = value.indexOf("=");
        const path = equals === -1 ? "" : value.slice(0, equals).trim();
        if (path === "") return { ok: false, message: "--where requires path=value" };
        const scalar = metadataScalar(value.slice(equals + 1));
        if (!scalar.ok) return scalar;
        filters.push({ kind: "equals", path, value: scalar.value });
      } else if (argument === "--has") {
        if (value.trim() === "") return { ok: false, message: "--has requires a metadata path" };
        filters.push({ kind: "exists", path: value });
      } else if (argument === "--tag") {
        tags.push(value);
      } else if (argument === "--related") {
        related.push(value);
      } else if (argument === "--min-score") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          return { ok: false, message: "--min-score must be a number from 0 through 1" };
        }
        minScore = parsed;
      } else {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return { ok: false, message: `${argument} must be a positive integer` };
        }
        if (argument === "--limit") limit = parsed;
        else if (argument === "--candidate-limit") candidateLimit = parsed;
        else if (parsed <= 2) graphDepth = parsed;
        else return { ok: false, message: "--graph-depth must be 1 or 2" };
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) return { ok: false, message: `unknown ${command} option` };
    positional.push(argument);
  }

  if (command === "index") {
    if (positional.length > 0) return { ok: false, message: "index does not accept positional arguments" };
    return {
      ok: true,
      value: { kind: "index", root, ...(database === undefined ? {} : { database }), force, json },
    };
  }
  if (noHistory && requireHistory) {
    return {
      ok: false,
      message: "--no-history and --require-history cannot be used together",
    };
  }
  const query = positional.join(" ").trim();
  if (query === "") return { ok: false, message: "search requires a query" };
  return {
    ok: true,
    value: {
      kind: "search",
      root,
      repository,
      ...(database === undefined ? {} : { database }),
      mode,
      filters,
      tags,
      graph: noGraph
        ? false
        : {
            ...(related.length === 0 ? {} : { related }),
            ...(graphDepth === undefined ? {} : { depth: graphDepth }),
          },
      history: noHistory ? false : requireHistory ? "required" : "auto",
      ...(limit === undefined ? {} : { limit }),
      ...(candidateLimit === undefined ? {} : { candidateLimit }),
      ...(minScore === undefined ? {} : { minScore }),
      query,
      json,
    },
  };
}

function parseContextCommand(arguments_: readonly string[]): ParseResult {
  let root = ".";
  let repository = ".";
  let targetKind: AgentContextTargetKind = "auto";
  let json = false;
  const positional: string[] = [];

  for (let cursor = 0; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo" || argument === "--kind") {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else if (argument === "--repo") repository = value;
      else {
        if (value !== "auto" && value !== "file" && value !== "directory") {
          return { ok: false, message: "--kind must be auto, file, or directory" };
        }
        targetKind = value;
      }
      cursor += 1;
      continue;
    }
    if (argument.startsWith("--")) return { ok: false, message: "unknown context option" };
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
      json,
    },
  };
}

function parseAgentsCommand(arguments_: readonly string[]): ParseResult {
  const action = arguments_[0];
  if (action === "identity") {
    let json = false;
    const positional: string[] = [];
    for (const argument of arguments_.slice(1)) {
      if (argument === "--json") json = true;
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
        message: "agents identity requires exactly one repository scope",
      };
    }
    return {
      ok: true,
      value: { kind: "agent-identity", scope, json },
    };
  }
  if (action !== "check" && action !== "audit") {
    return { ok: false, message: "agents requires identity, check, or audit" };
  }
  let root = ".";
  let repository = ".";
  let json = false;
  for (let cursor = 1; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--repo") {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else repository = value;
      cursor += 1;
      continue;
    }
    return {
      ok: false,
      message: argument.startsWith("--")
        ? `unknown agents ${action} option`
        : `agents ${action} does not accept positional arguments`,
    };
  }
  return {
    ok: true,
    value: { kind: "agents", action, root, repository, json },
  };
}

function boundedInteger(
  raw: string,
  option: string,
  minimum: number,
  maximum: number,
): number | ParseResult {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return {
      ok: false,
      message: `${option} must be an integer from ${minimum} through ${maximum}`,
    };
  }
  return value;
}

function parseNoteCommand(arguments_: readonly string[]): ParseResult {
  if (arguments_[0] !== "create") {
    return { ok: false, message: "note requires create" };
  }
  let root = ".";
  let title: string | undefined;
  let type = "note";
  let body: string | undefined;
  let bodyFile: string | undefined;
  let json = false;
  const tags: string[] = [];
  const positional: string[] = [];
  for (let cursor = 1; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (
      argument === "--root"
      || argument === "--title"
      || argument === "--type"
      || argument === "--tag"
      || argument === "--body"
      || argument === "--body-file"
    ) {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") root = value;
      else if (argument === "--title") title = value;
      else if (argument === "--type") type = value;
      else if (argument === "--tag") tags.push(value);
      else if (argument === "--body") body = value;
      else bodyFile = value;
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
  if (title === undefined) return { ok: false, message: "note create requires --title" };
  if (body !== undefined && bodyFile !== undefined) {
    return { ok: false, message: "note create accepts either --body or --body-file, not both" };
  }
  return {
    ok: true,
    value: {
      kind: "note-create",
      root,
      input: { id, title, type, ...(tags.length === 0 ? {} : { tags }) },
      ...(body === undefined ? {} : { body }),
      ...(bodyFile === undefined ? {} : { bodyFile }),
      json,
    },
  };
}

function isNoteRevision(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function parseRelationCommand(arguments_: readonly string[]): ParseResult {
  const action = arguments_[0];
  if (action !== "add" && action !== "remove" && action !== "list") {
    return { ok: false, message: "relation requires add, remove, or list" };
  }
  let root = ".";
  let expectedRevision: `sha256:${string}` | undefined;
  let json = false;
  const positional: string[] = [];
  for (let cursor = 1; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--expected-revision") {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") {
        root = value;
      } else {
        if (!isNoteRevision(value)) {
          return {
            ok: false,
            message: "--expected-revision must be sha256 followed by 64 lowercase hexadecimal characters",
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
  if (
    source === undefined
    || predicate === undefined
    || target === undefined
    || positional.length !== 3
  ) {
    return {
      ok: false,
      message: `relation ${action} requires exact source, predicate, and target IDs`,
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
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      json,
    },
  };
}

function parsePercolateCommand(arguments_: readonly string[]): ParseResult {
  let root = ".";
  let minSupport = 2;
  let limit = 25;
  let json = false;
  const positional: string[] = [];
  for (let cursor = 0; cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--min-support" || argument === "--limit") {
      const value = readValue(arguments_, cursor);
      if (value === null) return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root") {
        root = value;
      } else {
        const parsed = boundedInteger(
          value,
          argument,
          argument === "--min-support" ? 2 : 1,
          1_000,
        );
        if (typeof parsed !== "number") return parsed;
        if (argument === "--min-support") minSupport = parsed;
        else limit = parsed;
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
      ...(note === undefined ? {} : { note }),
      minSupport,
      limit,
      json,
    },
  };
}

export function parseArguments(arguments_: readonly string[]): ParseResult {
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
  if (command === "pdf") {
    return { ok: true, value: { kind: "pdf", arguments: arguments_.slice(1) } };
  }
  if (command === "doctor" || command === "adapters") {
    return { ok: true, value: { kind: "clip", arguments: arguments_ } };
  }
  if (command === "init") {
    let directory = "kb";
    let json = false;
    const positional: string[] = [];
    for (const argument of arguments_.slice(1)) {
      if (argument === "--json") json = true;
      else if (argument.startsWith("--")) return { ok: false, message: "unknown init option" };
      else positional.push(argument);
    }
    if (positional.length > 1) return { ok: false, message: "init accepts at most one directory" };
    if (positional[0] !== undefined) directory = positional[0];
    return { ok: true, value: { kind: "init", directory, json } };
  }
  if (command === "refresh" || command === "check" || command === "graph" || command === "backlinks" || command === "links") {
    return parseVaultCommand(command, arguments_.slice(1));
  }
  if (command === "list" || command === "notes") return parseListCommand(arguments_.slice(1));
  if (command === "index" || command === "search") {
    return parseSemanticCommand(command, arguments_.slice(1));
  }
  if (command === "context") return parseContextCommand(arguments_.slice(1));
  if (command === "agents") return parseAgentsCommand(arguments_.slice(1));
  if (command === "note") return parseNoteCommand(arguments_.slice(1));
  if (command === "relation") return parseRelationCommand(arguments_.slice(1));
  if (command === "percolate") return parsePercolateCommand(arguments_.slice(1));
  return { ok: false, message: "unknown command" };
}

function embeddingCount(result: SemanticIndexResult): number {
  return result.embedding?.chunksEmbedded ?? 0;
}

function renderSemanticIndex(result: SemanticIndexResult): string {
  const changed = result.update.indexed + result.update.updated;
  return [
    `Indexed ${safe(result.root)} with QMD.`,
    `Documents: ${changed} changed, ${result.update.unchanged} unchanged, ${result.update.removed} removed.`,
    `Embeddings: ${embeddingCount(result)} chunks; model: ${safe(result.model)}.`,
    `Database: ${safe(result.database)}`,
    "",
  ].join("\n");
}

function renderKnowledgeBaseSearch(result: KnowledgeBaseSearchResult): string {
  const lines = [
    `${result.mode[0]?.toLocaleUpperCase("en-US") ?? ""}${result.mode.slice(1)} results for “${safe(result.query)}” (${result.results.length})${result.partial ? " [partial]" : ""}`,
  ];
  if (result.results.length === 0) lines.push("  None.");
  for (const hit of result.results) {
    const location = `${safe(hit.path)}${hit.line === undefined ? "" : `:${hit.line}`}`;
    const evidence = hit.evidence.map((item) => `${item.kind}#${item.rank}`).join(", ");
    lines.push(`  ${hit.rank}. ${hit.score.toFixed(3)}  ${location} — ${safe(hit.title)} [${safe(evidence)}]`);
    if (hit.snippet !== "") lines.push(`    ${safe(hit.snippet)}`);
  }
  if ((result.graph?.related.length ?? 0) > 0) {
    lines.push(`  Related graph context: ${result.graph?.related.length ?? 0}`);
  }
  if (result.history?.status === "ready") {
    lines.push(`  Git provenance: ${result.history.notes.length} notes at ${safe(result.history.head.slice(0, 12))}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runSemantic(
  command: Extract<ParsedCommand, { readonly kind: "index" | "search" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  if (command.kind === "index") {
    const result = await (dependencies.indexSemanticVault ?? indexSemanticVault)({
      root: command.root,
      ...(command.database === undefined ? {} : { database: command.database }),
      force: command.force,
    });
    output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderSemanticIndex(result)));
    return 0;
  }
  const kb = await (dependencies.openKnowledgeBase ?? openKnowledgeBase)({
    root: command.root,
    repository: command.repository,
    ...(command.database === undefined ? {} : { database: command.database }),
  });
  try {
    const result = await kb.search({
      query: command.query,
      mode: command.mode,
      filters: command.filters,
      tags: command.tags,
      graph: command.graph,
      history: command.history,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
      ...(command.candidateLimit === undefined
        ? {}
        : { candidateLimit: command.candidateLimit }),
      ...(command.minScore === undefined ? {} : { minScore: command.minScore }),
    });
    output.stdout(command.json
      ? terminalSafeJson(result)
      : sanitizeTerminalText(renderKnowledgeBaseSearch(result)));
    return 0;
  } finally {
    await kb.close();
  }
}

function issueJson(issue: LinkIssue): Record<string, unknown> {
  return issue.kind === "broken"
    ? { kind: issue.kind, source: issue.source, line: issue.line, target: issue.target }
    : {
        kind: issue.kind,
        source: issue.source,
        line: issue.line,
        target: issue.target,
        candidates: issue.candidates,
      };
}

function relationIssueJson(issue: RelationIssue): Record<string, unknown> {
  return { ...issue };
}

function summary(
  snapshot: VaultSnapshot,
  options: { readonly noCatalog?: boolean } = {},
): Record<string, unknown> {
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
  };
}

function renderIssue(issue: LinkIssue): string {
  if (issue.kind === "broken") {
    return `${safe(issue.source)}:${issue.line}: broken wikilink [[${safe(issue.target)}]]`;
  }
  return `${safe(issue.source)}:${issue.line}: ambiguous wikilink [[${safe(issue.target)}]] (${issue.candidates.map(safe).join(", ")})`;
}

function renderRelationIssue(issue: RelationIssue): string {
  if (issue.kind === "malformed") {
    return `${safe(issue.source)}:${issue.line}: malformed relationship${issue.predicate === undefined ? "" : ` ${safe(issue.predicate)}`}: ${safe(issue.message)}`;
  }
  if (issue.kind === "broken") {
    return `${safe(issue.source)}:${issue.line}: broken relationship ${safe(issue.predicate)} → ${safe(issue.target)}`;
  }
  return `${safe(issue.source)}:${issue.line}: ambiguous relationship ${safe(issue.predicate)} → ${safe(issue.target)} (${issue.candidates.map(safe).join(", ")})`;
}

function renderAdvisories(analysis: VaultAnalysis): string[] {
  const lines: string[] = [];
  if (analysis.orphans.length > 0) {
    lines.push(`Advisory: ${analysis.orphans.length} contextual orphan${analysis.orphans.length === 1 ? "" : "s"}.`);
    for (const orphan of analysis.orphans) lines.push(`  ${safe(orphan)}`);
  }
  if (analysis.mentions.length > 0) {
    lines.push(`Advisory: ${analysis.mentions.length} exact unlinked title or alias mention${analysis.mentions.length === 1 ? "" : "s"}.`);
    for (const mention of analysis.mentions) {
      lines.push(`  ${safe(mention.source)}:${mention.line} mentions “${safe(mention.phrase)}” (${safe(mention.target)})`);
    }
  }
  return lines;
}

function checkExitCode(snapshot: VaultSnapshot, noCatalog = false): number {
  return (
    (!noCatalog && snapshot.index === "stale")
    || snapshot.analysis.issues.length > 0
    || snapshot.analysis.relationIssues.length > 0
  ) ? 3 : 0;
}

function renderSnapshot(
  command: "refresh" | "check",
  snapshot: VaultSnapshot,
  noCatalog = false,
): string {
  const lines = [
    `${command === "refresh" ? "Refreshed" : "Checked"} ${safe(snapshot.root)}`,
    `Index: ${noCatalog ? `not required (${snapshot.index})` : snapshot.index}; notes: ${snapshot.analysis.noteCount}; contextual links: ${snapshot.analysis.contextualLinks.length}; typed relationships: ${snapshot.analysis.authoredRelations.length}.`,
  ];
  if (!noCatalog && snapshot.index === "stale") {
    lines.push(`error: generated catalog is stale (${safe(snapshot.indexPath)})`);
  }
  for (const issue of snapshot.analysis.issues) lines.push(`error: ${renderIssue(issue)}`);
  for (const issue of snapshot.analysis.relationIssues) {
    lines.push(`error: ${renderRelationIssue(issue)}`);
  }
  lines.push(...renderAdvisories(snapshot.analysis));
  return `${lines.join("\n")}\n`;
}

function graphJson(snapshot: VaultSnapshot): Record<string, unknown> {
  return { ...summary(snapshot), notes: snapshot.analysis.noteConnections };
}

function renderGraph(snapshot: VaultSnapshot): string {
  const lines = [
    `Graph: ${snapshot.analysis.noteCount} notes; ${snapshot.analysis.contextualLinks.length} contextual links; ${snapshot.analysis.authoredRelations.length} typed relationships.`,
  ];
  for (const note of snapshot.analysis.noteConnections) {
    lines.push(`${safe(note.path)}  ← ${note.inboundContextualCount}  → ${note.outboundContextualCount}`);
  }
  if (snapshot.analysis.contextualLinks.length > 0) {
    lines.push("Contextual edges:");
    for (const link of snapshot.analysis.contextualLinks) {
      lines.push(`  ${safe(link.source)}:${link.line} → ${safe(link.target)}`);
    }
  }
  if (snapshot.analysis.authoredRelations.length > 0) {
    lines.push("Typed relationships:");
    for (const relation of snapshot.analysis.authoredRelations) {
      lines.push(
        `  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} → ${safe(relation.target)}`,
      );
    }
  }
  for (const issue of snapshot.analysis.issues) lines.push(`error: ${renderIssue(issue)}`);
  for (const issue of snapshot.analysis.relationIssues) {
    lines.push(`error: ${renderRelationIssue(issue)}`);
  }
  lines.push(...renderAdvisories(snapshot.analysis));
  return `${lines.join("\n")}\n`;
}

function backlinkPayload(
  notePath: string,
  backlinks: readonly Backlink[],
  relationships: readonly AuthoredRelation[],
): Record<string, unknown> {
  return {
    note: notePath,
    count: backlinks.length + relationships.length,
    backlinkCount: backlinks.length,
    relationshipCount: relationships.length,
    backlinks,
    relationships,
  };
}

function renderBacklinks(
  notePath: string,
  backlinks: readonly Backlink[],
  relationships: readonly AuthoredRelation[],
): string {
  const lines = [
    `Backlinks to ${safe(notePath)} (${backlinks.length} links, ${relationships.length} typed relationships)`,
  ];
  if (backlinks.length === 0 && relationships.length === 0) lines.push("  None.");
  else for (const backlink of backlinks) lines.push(`  ${safe(backlink.source)}:${backlink.line}`);
  for (const relation of relationships) {
    lines.push(
      `  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} → ${safe(relation.target)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderLinks(neighborhood: LinkNeighborhood): string {
  const lines = [
    `Links around ${safe(neighborhood.note)} (${neighborhood.direction}, depth ${neighborhood.depth}, limit ${neighborhood.limit})`,
  ];
  for (const node of neighborhood.nodes) {
    lines.push(
      `  ${node.distance}  ${safe(node.path)} — ${safe(node.title)}  ← ${node.inboundContextualCount}  → ${node.outboundContextualCount}`,
    );
  }
  if (neighborhood.edges.length > 0) {
    lines.push("Edges:");
    for (const edge of neighborhood.edges) {
      lines.push(`  ${safe(edge.source)}:${edge.line} → ${safe(edge.target)}`);
    }
  }
  if (neighborhood.relations.length > 0) {
    lines.push("Typed relationships:");
    for (const relation of neighborhood.relations) {
      lines.push(
        `  ${safe(relation.source)}:${relation.provenance.line} ${safe(relation.predicate)} → ${safe(relation.target)}`,
      );
    }
  }
  if (neighborhood.truncated) {
    lines.push(
      "Results were truncated by the node or connection limit; lower the depth or raise --limit.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderList(rows: readonly QueryRow[]): string {
  const lines = [`Notes (${rows.length})`];
  if (rows.length === 0) lines.push("  None.");
  for (const row of rows) {
    const tags = row.tags.length === 0 ? "" : `  #${row.tags.map(safe).join(" #")}`;
    lines.push(
      `  ${safe(row.path)} — ${safe(row.title)}  ← ${row.inboundContextualCount}  → ${row.outboundContextualCount}${tags}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderAuthoringResult(
  verb: string,
  result: NoteAuthoringResult,
): string {
  return [
    `${result.changed ? verb : "Unchanged"} ${safe(result.path)}`,
    `Revision: ${safe(result.revision)}; outbound relationships: ${result.relations.length}.`,
    "",
  ].join("\n");
}

async function runNoteCreate(
  command: Extract<ParsedCommand, { readonly kind: "note-create" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const body = command.body ?? (
    command.bodyFile === undefined
      ? undefined
      : await readBoundedUtf8(command.bodyFile, 16 * 1024 * 1024, "note body")
  );
  const result = await (dependencies.createNote ?? createNote)(
    command.root,
    {
      ...command.input,
      ...(body === undefined ? {} : { body }),
    },
  );
  output.stdout(command.json
    ? terminalSafeJson(result)
    : sanitizeTerminalText(renderAuthoringResult("Created", result)));
  return 0;
}

async function runRelation(
  command: Extract<ParsedCommand, { readonly kind: "relation" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  if (command.action === "list") {
    const snapshot = await (dependencies.scanVault ?? scanVault)(
      command.root,
      { mentionScope: false },
    );
    const lookup = lookupNote(snapshot.notes, command.source);
    if (lookup.kind === "missing") {
      output.stderr("error: note was not found\n");
      return 3;
    }
    if (lookup.kind === "ambiguous") {
      if (command.json) {
        output.stdout(terminalSafeJson({
          ok: false,
          kind: "ambiguous",
          candidates: lookup.candidates.map(({ id }) => id),
        }));
      } else {
        output.stderr(`error: note is ambiguous (${lookup.candidates.map(({ id }) => safe(id)).join(", ")})\n`);
      }
      return 3;
    }
    const outbound = snapshot.analysis.authoredRelations.filter(
      ({ source }) => source === lookup.note.id,
    );
    const inbound = snapshot.analysis.authoredRelations.filter(
      ({ target }) => target === lookup.note.id,
    );
    const payload = {
      note: lookup.note.id,
      outboundCount: outbound.length,
      inboundCount: inbound.length,
      outbound,
      inbound,
    };
    if (command.json) {
      output.stdout(terminalSafeJson(payload));
    } else {
      const lines = [
        `Relationships for ${safe(lookup.note.id)} (${outbound.length} out, ${inbound.length} in)`,
      ];
      if (outbound.length === 0 && inbound.length === 0) lines.push("  None.");
      for (const relation of outbound) {
        lines.push(`  → ${safe(relation.predicate)} → ${safe(relation.target)}`);
      }
      for (const relation of inbound) {
        lines.push(`  ← ${safe(relation.predicate)} ← ${safe(relation.source)}`);
      }
      output.stdout(`${lines.join("\n")}\n`);
    }
    return 0;
  }

  const predicate = command.predicate;
  const target = command.target;
  if (predicate === undefined || target === undefined) {
    throw new Error("relation command parser lost its predicate or target");
  }
  const options = command.expectedRevision === undefined
    ? {}
    : { expectedRevision: command.expectedRevision };
  const result = command.action === "add"
    ? await (dependencies.addNoteRelation ?? addNoteRelation)(
        command.root,
        command.source,
        predicate,
        target,
        options,
      )
    : await (dependencies.removeNoteRelation ?? removeNoteRelation)(
        command.root,
        command.source,
        predicate,
        target,
        options,
      );
  output.stdout(command.json
    ? terminalSafeJson(result)
    : sanitizeTerminalText(renderAuthoringResult(
        "Updated",
        result,
      )));
  return 0;
}

function renderPercolation(result: PercolationResult, note: string | undefined): string {
  const lines = [
    `Percolation${note === undefined ? "" : ` for ${safe(note)}`}: ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}.`,
  ];
  if (result.candidates.length === 0) lines.push("  None.");
  for (const candidate of result.candidates) {
    if (candidate.kind === "missing-concept") {
      lines.push(
        `  concept  #${safe(candidate.tag)} → ${safe(candidate.suggestedId)}  (${candidate.support} supporting notes)`
          + (candidate.collidesWith === null
            ? ""
            : `; natural ID is occupied by ${safe(candidate.collidesWith)}`),
      );
    } else if (candidate.kind === "missing-relation") {
      lines.push(
        `  relation  ${safe(candidate.source)} ${safe(candidate.suggestedPredicate)} ${safe(candidate.target)}  (${candidate.support} shared signals)`,
      );
    } else if (candidate.kind === "unlinked-mention") {
      lines.push(
        `  mention  ${safe(candidate.source)} → ${safe(candidate.target)}  (${candidate.support})`,
      );
    } else {
      lines.push(
        `  hygiene  ${safe(candidate.problem)} in ${safe(candidate.source)}${candidate.target === null ? "" : ` → ${safe(candidate.target)}`}: ${safe(candidate.message)}`,
      );
    }
    for (const evidence of candidate.evidence.slice(0, 3)) {
      if (evidence.kind === "tag") {
        lines.push(`    ${safe(evidence.path)}  #${safe(evidence.tag)}`);
      } else if (evidence.kind === "shared-tag") {
        lines.push(`    ${safe(evidence.path)} shares #${safe(evidence.tag)}`);
      } else if (evidence.kind === "shared-concept") {
        lines.push(`    ${safe(evidence.path)} shares ${safe(evidence.concept)}`);
      } else if (evidence.kind === "mention") {
        lines.push(`    ${safe(evidence.source)}:${evidence.line} mentions “${safe(evidence.phrase)}”`);
      } else if (evidence.kind === "relation") {
        lines.push(
          `    ${safe(evidence.source)}:${evidence.line} ${safe(evidence.predicate)} → ${safe(evidence.target)}`,
        );
      } else {
        lines.push(`    ${safe(evidence.source)}:${evidence.line} ${safe(evidence.message)}`);
      }
    }
    if (candidate.evidence.length > 3) {
      lines.push(`    … ${candidate.evidence.length - 3} more evidence records`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runPercolate(
  command: Extract<ParsedCommand, { readonly kind: "percolate" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const maxMentionPairs = command.note === undefined
    ? MAX_PERCOLATION_MENTION_PAIRS
    : MAX_SCOPED_PERCOLATION_MENTION_PAIRS;
  const snapshot = await (dependencies.scanVault ?? scanVault)(
    command.root,
    {
      maxNotes: MAX_PERCOLATION_NOTES,
      maxMentionPairs,
      maxMentions: Math.min(MAX_PERCOLATION_MENTIONS, maxMentionPairs),
      ...(command.note === undefined ? {} : { mentionScope: command.note }),
    },
  );
  const result = (dependencies.percolateVault ?? percolateVault)(
    snapshot.notes,
    snapshot.analysis,
    {
      ...(command.note === undefined ? {} : { note: command.note }),
      minSupport: command.minSupport,
      limit: command.limit,
    },
  );
  output.stdout(command.json
    ? terminalSafeJson({
        root: snapshot.root,
        note: command.note ?? null,
        minSupport: command.minSupport,
        ...result,
      })
    : sanitizeTerminalText(renderPercolation(result, command.note)));
  return 0;
}

async function runList(
  command: Extract<ParsedCommand, { readonly kind: "list" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  const rows = queryVault(snapshot.notes, snapshot.analysis, {
    filters: command.filters,
    tags: command.tags,
    sort: command.sort,
    direction: command.direction,
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  });
  output.stdout(command.json
    ? terminalSafeJson({ root: snapshot.root, count: rows.length, notes: rows })
    : sanitizeTerminalText(renderList(rows)));
  return 0;
}

async function runInit(
  command: Extract<ParsedCommand, { readonly kind: "init" }>,
  output: Output,
  initialize: typeof initVault,
): Promise<number> {
  const result: InitVaultResult = await initialize(command.directory);
  if (command.json) output.stdout(terminalSafeJson(result));
  else {
    const relativeRoot = relative(process.cwd(), result.root) || ".";
    output.stdout(`Initialized ${safe(relativeRoot)} with ${result.files.length} files.\n`);
  }
  return 0;
}

function contextIssuePayload(issue: AgentContextIssue): Record<string, unknown> {
  return { ...issue };
}

function uniqueAgentContextIssues(
  issues: readonly AgentContextIssue[],
): readonly AgentContextIssue[] {
  const unique = new Map<string, AgentContextIssue>();
  for (const issue of issues) unique.set(JSON.stringify(issue), issue);
  return [...unique.values()].toSorted((left, right) =>
    `${left.kind}\0${left.message}`.localeCompare(`${right.kind}\0${right.message}`));
}

function contextPayload(
  inspection: AgentContextRepositoryInspection,
  snapshot: VaultSnapshot,
): Record<string, unknown> {
  const connections = new Map(
    snapshot.analysis.noteConnections.map((connection) => [connection.id, connection]),
  );
  return {
    repositoryRoot: inspection.repositoryRoot,
    vaultRoot: snapshot.root,
    target: inspection.target,
    targetScope: inspection.targetScope,
    guides: inspection.inheritedGuides.map((guide) => ({
      path: guide.path,
      scope: guide.scope,
      context: guide.marker.markers[0]?.noteId,
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
        outboundContextualCount: connection?.outboundContextualCount ?? 0,
      };
    }),
    issues: inspection.issues.map(contextIssuePayload),
  };
}

function renderContext(
  inspection: AgentContextRepositoryInspection,
  snapshot: VaultSnapshot,
): string {
  const lines = [
    `Agent context for ${safe(inspection.target)} (scope ${safe(inspection.targetScope)})`,
    "Guides (root → nearest):",
  ];
  if (inspection.inheritedGuides.length === 0) lines.push("  None.");
  for (const guide of inspection.inheritedGuides) {
    const context = guide.marker.markers[0]?.noteId;
    lines.push(`  ${safe(guide.path)}${context === undefined ? "" : `  →  ${safe(context)}`}`);
  }
  lines.push("KB hubs (nearest → root):");
  if (inspection.matchingContexts.length === 0) lines.push("  None.");
  for (const context of inspection.matchingContexts) {
    const connection = snapshot.analysis.noteConnections.find(({ id }) => id === context.note.id);
    lines.push(
      `  ${safe(context.note.id)} — ${safe(context.note.title)}  ← ${connection?.inboundContextualCount ?? 0}  → ${connection?.outboundContextualCount ?? 0}`,
    );
    if (context.note.summary !== "") lines.push(`    ${safe(context.note.summary)}`);
  }
  for (const issue of inspection.issues) lines.push(`error: ${safe(issue.message)}`);
  if (inspection.matchingContexts.length > 0) {
    lines.push("Open a hub, then use `kb links <hub> --root <vault> --depth 1` for bounded neighboring context.");
  }
  return `${lines.join("\n")}\n`;
}

async function runContext(
  command: Extract<ParsedCommand, { readonly kind: "context" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root);
  const inspection = await (
    dependencies.inspectAgentContextRepository ?? inspectAgentContextRepository
  )(snapshot.notes, {
    repositoryRoot: command.repository,
    target: command.target,
    targetKind: command.targetKind,
  });
  output.stdout(command.json
    ? terminalSafeJson(contextPayload(inspection, snapshot))
    : sanitizeTerminalText(renderContext(inspection, snapshot)));
  return inspection.issues.length === 0 ? 0 : 3;
}

function agentIdentityPayload(scopeInput: string): Record<string, string> {
  const scope = normalizeRepositoryScope(scopeInput);
  return {
    scope,
    noteId: agentContextNoteId(scope),
    notePath: agentContextNotePath(scope),
    guidePath: agentContextGuidePath(scope),
    marker: agentContextMarkerForScope(scope),
  };
}

function renderAgentIdentity(identity: Readonly<Record<string, string>>): string {
  return [
    `Scope: ${safe(identity.scope ?? "")}`,
    `Note ID: ${safe(identity.noteId ?? "")}`,
    `Note path: ${safe(identity.notePath ?? "")}`,
    `Guide path: ${safe(identity.guidePath ?? "")}`,
    `Marker: ${safe(identity.marker ?? "")}`,
    "",
  ].join("\n");
}

function runAgentIdentity(
  command: Extract<ParsedCommand, { readonly kind: "agent-identity" }>,
  output: Output,
): number {
  const identity = agentIdentityPayload(command.scope);
  output.stdout(command.json
    ? terminalSafeJson(identity)
    : sanitizeTerminalText(renderAgentIdentity(identity)));
  return 0;
}

type AgentCheckError =
  | {
      readonly kind: "context";
      readonly issue: AgentContextIssue;
    }
  | {
      readonly kind: "discovery";
      readonly issue: AgentGuideDiscoveryIssue;
    }
  | {
      readonly kind: "shape";
      readonly path: string;
      readonly issue: { readonly kind: string; readonly message: string };
    };

function agentCheckErrors(
  contextIssues: readonly AgentContextIssue[],
  discoveryIssues: readonly AgentGuideDiscoveryIssue[],
  audit: AgentGuideAuditReport,
): readonly AgentCheckError[] {
  return [
    ...uniqueAgentContextIssues(contextIssues).map(
      (issue): AgentCheckError => ({ kind: "context", issue }),
    ),
    ...discoveryIssues.filter(({ kind }) => kind !== "symlink-directory").map(
      (issue): AgentCheckError => ({ kind: "discovery", issue }),
    ),
    ...audit.guides.flatMap((guide) =>
      guide.shapeIssues.map(
        (issue): AgentCheckError => ({ kind: "shape", path: guide.path, issue }),
      )),
  ];
}

function renderAgentCheckError(error: AgentCheckError): string {
  if (error.kind === "context") return error.issue.message;
  if (error.kind === "discovery") return error.issue.message;
  return `${error.path}: ${error.issue.message}`;
}

function advisoryLabel(advisory: AgentGuideAdvisory): string {
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

function agentReportPayload(
  repositoryRoot: string,
  vaultRoot: string,
  audit: AgentGuideAuditReport,
  validContexts: number,
  errors: readonly AgentCheckError[],
  discoveryIssues: readonly AgentGuideDiscoveryIssue[],
  includeAudit: boolean,
): Record<string, unknown> {
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
    ...(includeAudit
      ? {
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
            context: guide.marker.markers[0]?.noteId,
          })),
        }
      : {}),
  };
}

function renderAgentReport(
  action: "check" | "audit",
  audit: AgentGuideAuditReport,
  validContexts: number,
  errors: readonly AgentCheckError[],
  discoveryIssues: readonly AgentGuideDiscoveryIssue[],
): string {
  const lines = [
    `${action === "check" ? "Checked" : "Audited"} ${audit.guideCount} agent guides; ${audit.mappedGuideCount} markers, ${validContexts} valid KB hubs.`,
    `Context: ${audit.words} words (${audit.contentsWords} Contents, ${audit.guidelineWords} Guidelines), ${audit.nonblankLines} nonblank lines.`,
  ];
  if (errors.length === 0) lines.push("Mappings and guide shape: clean.");
  else for (const error of errors) lines.push(`error: ${safe(renderAgentCheckError(error))}`);
  const skippedDirectories = discoveryIssues.filter(
    ({ kind }) => kind === "symlink-directory",
  );
  if (skippedDirectories.length > 0) {
    lines.push(`Skipped symbolic-link directories (${skippedDirectories.length}):`);
    for (const issue of skippedDirectories) lines.push(`  ${safe(issue.path)}`);
  }
  if (action === "audit") {
    lines.push(`Advisories: ${audit.advisories.length}; exact duplicate rules: ${audit.duplicates.length}.`);
    const worstChains = audit.guides
      .toSorted((left, right) =>
        right.inheritedWords - left.inheritedWords || left.path.localeCompare(right.path))
      .slice(0, 10);
    lines.push("Largest inherited chains:");
    for (const guide of worstChains) {
      lines.push(`  ${guide.inheritedWords} words / ${guide.inheritedGuidePaths.length} guides  ${safe(guide.path)}`);
    }
    const shown = audit.advisories.slice(0, 25);
    if (shown.length > 0) lines.push("Advisory sample:");
    for (const advisory of shown) lines.push(`  ${safe(advisoryLabel(advisory))}`);
    if (audit.advisories.length > shown.length) {
      lines.push(`  … ${audit.advisories.length - shown.length} more; rerun with --json for the complete audit.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runAgents(
  command: Extract<ParsedCommand, { readonly kind: "agents" }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root);
  const repository = await (
    dependencies.auditAgentGuideRepository ?? auditAgentGuideRepository
  )(command.repository);
  const mapping = analyzeAgentContexts(snapshot.notes, repository.guides);
  const filesystem = await (
    dependencies.inspectAgentContextRepository ?? inspectAgentContextRepository
  )(snapshot.notes, {
    repositoryRoot: command.repository,
    target: ".",
    targetKind: "directory",
    validationMode: "all",
  });
  const errors = agentCheckErrors(
    [...mapping.issues, ...filesystem.issues],
    repository.issues,
    repository.audit,
  );
  const validContexts = mapping.contexts.filter(({ valid }) => valid).length;
  if (command.json) {
    output.stdout(terminalSafeJson(agentReportPayload(
      repository.repositoryRoot,
      snapshot.root,
      repository.audit,
      validContexts,
      errors,
      repository.issues,
      command.action === "audit",
    )));
  } else {
    output.stdout(sanitizeTerminalText(renderAgentReport(
      command.action,
      repository.audit,
      validContexts,
      errors,
      repository.issues,
    )));
  }
  return errors.length === 0 ? 0 : 3;
}

async function runVault(
  command: Extract<ParsedCommand, { readonly kind: VaultCommand }>,
  output: Output,
  dependencies: CliDependencies,
): Promise<number> {
  const snapshot = command.kind === "refresh"
    ? await (dependencies.refreshVault ?? refreshVault)(command.root, command.options)
    : await (dependencies.scanVault ?? scanVault)(command.root, command.options);

  if (command.kind === "refresh" || command.kind === "check") {
    const noCatalog = command.kind === "check" && command.noCatalog === true;
    output.stdout(command.json
      ? terminalSafeJson(summary(snapshot, { noCatalog }))
      : sanitizeTerminalText(renderSnapshot(command.kind, snapshot, noCatalog)));
    return checkExitCode(snapshot, noCatalog);
  }
  if (command.kind === "graph") {
    output.stdout(command.json ? terminalSafeJson(graphJson(snapshot)) : sanitizeTerminalText(renderGraph(snapshot)));
    return 0;
  }

  const lookup = lookupNote(snapshot.notes, command.note ?? "");
  if (lookup.kind === "missing") {
    output.stderr("error: note was not found\n");
    return 3;
  }
  if (lookup.kind === "ambiguous") {
    if (command.json) {
      output.stdout(terminalSafeJson({ ok: false, kind: "ambiguous", candidates: lookup.candidates.map(({ path }) => path) }));
    } else {
      output.stderr(`error: note is ambiguous (${lookup.candidates.map(({ path }) => safe(path)).join(", ")})\n`);
    }
    return 3;
  }
  if (command.kind === "links") {
    const neighborhood = navigateLinks(snapshot.notes, snapshot.analysis, lookup.note, {
      direction: command.direction ?? "both",
      depth: command.depth ?? 1,
      ...(command.limit === undefined ? {} : { limit: command.limit }),
    });
    output.stdout(command.json
      ? terminalSafeJson(neighborhood)
      : sanitizeTerminalText(renderLinks(neighborhood)));
    return 0;
  }
  const connection = snapshot.analysis.noteConnections.find(({ id }) => id === lookup.note.id);
  const backlinks = connection?.backlinks ?? [];
  const relationBacklinks = connection?.relationBacklinks ?? [];
  output.stdout(command.json
    ? terminalSafeJson(backlinkPayload(lookup.note.path, backlinks, relationBacklinks))
    : sanitizeTerminalText(renderBacklinks(lookup.note.path, backlinks, relationBacklinks)));
  return 0;
}

/** Stable CLI entry point with injectable filesystem and capture boundaries. */
export async function main(
  rawArguments: readonly string[] = process.argv.slice(2),
  output: Output = defaultOutput,
  dependencies: CliDependencies = {},
): Promise<number> {
  const parsed = parseArguments(rawArguments);
  if (!parsed.ok) {
    output.stderr(`error: ${safe(parsed.message)}\n\n${sanitizeTerminalText(usage)}`);
    return 2;
  }
  const command = parsed.value;
  if (command.kind === "help") {
    output.stdout(sanitizeTerminalText(usage));
    return 0;
  }
  try {
    if (command.kind === "clip") {
      return await (dependencies.runClipCommand ?? runClipCommand)(command.arguments, process.env, output);
    }
    if (command.kind === "pdf") {
      return await (dependencies.runPdfCommand ?? runPdfCommand)(command.arguments, process.env, output);
    }
    if (command.kind === "init") {
      return await runInit(command, output, dependencies.initVault ?? initVault);
    }
    if (command.kind === "index" || command.kind === "search") {
      return await runSemantic(command, output, dependencies);
    }
    if (command.kind === "context") return await runContext(command, output, dependencies);
    if (command.kind === "agent-identity") return runAgentIdentity(command, output);
    if (command.kind === "agents") return await runAgents(command, output, dependencies);
    if (command.kind === "note-create") return await runNoteCreate(command, output, dependencies);
    if (command.kind === "relation") return await runRelation(command, output, dependencies);
    if (command.kind === "percolate") return await runPercolate(command, output, dependencies);
    if (command.kind === "list") return await runList(command, output, dependencies);
    return await runVault(command, output, dependencies);
  } catch (error) {
    output.stderr(`error: ${safe(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
