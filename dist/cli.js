#!/usr/bin/env bun
// @bun
import {
  main as main2
} from "./index-96t9a29m.js";
import {
  initVault
} from "./index-8v446y7q.js";
import {
  navigateLinks
} from "./index-9w6m3y9a.js";
import {
  queryVault
} from "./index-m4bexhht.js";
import {
  indexSemanticVault,
  refreshVault,
  scanVault,
  searchSemanticVault
} from "./index-zk5tvkvw.js";
import {
  lookupNote
} from "./index-rbfx133v.js";
import {
  auditAgentGuideRepository
} from "./index-wnymkm9j.js";
import {
  agentContextGuidePath,
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextNotePath,
  analyzeAgentContexts,
  inspectAgentContextRepository,
  normalizeRepositoryScope
} from "./index-rhd7x0cs.js";
import {
  main
} from "./index-9t61r4g8.js";
import"./index-sm1xsdta.js";
import"./index-8kjm73a2.js";
import"./index-5n05se68.js";
import"./index-vfbwp1t8.js";
import"./index-hgve9rh2.js";
import"./index-1nmbpv8m.js";
import"./index-m8nb76f2.js";
import"./index-b0b0vy11.js";
import {
  redactSensitiveText
} from "./index-ey9rycsn.js";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText
} from "./index-1xxnjn0d.js";
import"./index-p1vzcd6b.js";
import"./index-gh719d91.js";

// src/cli.ts
import { relative } from "path";
var defaultOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};
var usage = `oh \u2014 auditable capture and derived links for Markdown vaults

Usage:
  oh init [directory] [--json]
  oh clip <url|current> [capture options]
  oh inspect <url> [capture options]
  oh pdf <file-or-url> [PDF options]
  oh refresh [--root <directory>] [--index <path>] [--json]
  oh check [--root <directory>] [--index <path>] [--json]
  oh graph [--root <directory>] [--index <path>] [--json]
  oh backlinks <note> [--root <directory>] [--index <path>] [--json]
  oh links <note> [--root <directory>] [--direction <in|out|both>] [--depth <count>] [--limit <count>] [--json]
  oh list [--root <directory>] [--where <path=value>] [--has <path>] [--tag <tag>] [--sort <field>] [--order <asc|desc>] [--limit <count>] [--json]
  oh index [--root <directory>] [--database <path>] [--force] [--json]
  oh search <query> [--root <directory>] [--database <path>] [--mode <semantic|keyword>] [--limit <count>] [--min-score <score>] [--json]
  oh context <repository-path> [--root <vault>] [--repo <repository>] [--kind <auto|file|directory>] [--json]
  oh agents identity <repository-scope> [--json]
  oh agents check [--root <vault>] [--repo <repository>] [--json]
  oh agents audit [--root <vault>] [--repo <repository>] [--json]
  oh doctor [--json]
  oh adapters [--json]

Run \`oh clip --help\` for web capture options or \`oh pdf --help\` for PDF conversion options.
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
  const positional = [];
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
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
  for (let cursor = 0;cursor < arguments_.length; cursor += 1) {
    const argument = arguments_[cursor];
    if (argument === undefined)
      continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--root" || argument === "--index" || argument === "--where" || argument === "--has" || argument === "--tag" || argument === "--sort" || argument === "--order" || argument === "--limit") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else if (argument === "--index")
        index = value;
      else if (argument === "--tag")
        tags.push(value);
      else if (argument === "--has") {
        if (value.trim() === "")
          return { ok: false, message: "--has requires a metadata path" };
        filters.push({ kind: "exists", path: value });
      } else if (argument === "--where") {
        const equals = value.indexOf("=");
        const path = equals === -1 ? "" : value.slice(0, equals).trim();
        if (path === "")
          return { ok: false, message: "--where requires path=value" };
        const scalar = metadataScalar(value.slice(equals + 1));
        if (!scalar.ok)
          return scalar;
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
      ...limit === undefined ? {} : { limit },
      json
    }
  };
}
function finiteNumber(raw, option) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : { ok: false, message: `${option} requires a number` };
}
function parseSemanticCommand(command, arguments_) {
  let root = ".";
  let database;
  let force = false;
  let json = false;
  let mode = "semantic";
  let limit;
  let minScore;
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
    if (argument === "--root" || argument === "--database") {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--root")
        root = value;
      else
        database = value;
      cursor += 1;
      continue;
    }
    if (command === "search" && (argument === "--mode" || argument === "--limit" || argument === "--min-score")) {
      const value = readValue(arguments_, cursor);
      if (value === null)
        return { ok: false, message: `${argument} requires a value` };
      if (argument === "--mode") {
        if (value !== "semantic" && value !== "keyword") {
          return { ok: false, message: "--mode must be semantic or keyword" };
        }
        mode = value;
      } else {
        const parsed = finiteNumber(value, argument);
        if (typeof parsed !== "number")
          return parsed;
        if (argument === "--limit")
          limit = parsed;
        else
          minScore = parsed;
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
  const query = positional.join(" ").trim();
  if (query === "")
    return { ok: false, message: "search requires a query" };
  return {
    ok: true,
    value: {
      kind: "search",
      root,
      ...database === undefined ? {} : { database },
      mode,
      ...limit === undefined ? {} : { limit },
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
  if (command === "pdf") {
    return { ok: true, value: { kind: "pdf", arguments: arguments_.slice(1) } };
  }
  if (command === "doctor" || command === "adapters") {
    return { ok: true, value: { kind: "clip", arguments: arguments_ } };
  }
  if (command === "init") {
    let directory = "oh";
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
  if (command === "list" || command === "notes")
    return parseListCommand(arguments_.slice(1));
  if (command === "index" || command === "search") {
    return parseSemanticCommand(command, arguments_.slice(1));
  }
  if (command === "context")
    return parseContextCommand(arguments_.slice(1));
  if (command === "agents")
    return parseAgentsCommand(arguments_.slice(1));
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
function renderSemanticSearch(result) {
  const lines = [
    `${result.mode === "semantic" ? "Semantic" : "Keyword"} results for \u201C${safe(result.query)}\u201D (${result.results.length})`
  ];
  if (result.results.length === 0)
    lines.push("  None.");
  for (const hit of result.results) {
    const location = `${safe(hit.path)}${hit.line === undefined ? "" : `:${hit.line}`}`;
    lines.push(`  ${hit.score.toFixed(3)}  ${location} \u2014 ${safe(hit.title)}`);
    if (hit.snippet !== "")
      lines.push(`    ${safe(hit.snippet)}`);
  }
  return `${lines.join(`
`)}
`;
}
async function runSemantic(command, output, dependencies) {
  if (command.kind === "index") {
    const result2 = await (dependencies.indexSemanticVault ?? indexSemanticVault)({
      root: command.root,
      ...command.database === undefined ? {} : { database: command.database },
      force: command.force
    });
    output.stdout(command.json ? terminalSafeJson(result2) : sanitizeTerminalText(renderSemanticIndex(result2)));
    return 0;
  }
  const result = await (dependencies.searchSemanticVault ?? searchSemanticVault)({
    root: command.root,
    query: command.query,
    mode: command.mode,
    ...command.database === undefined ? {} : { database: command.database },
    ...command.limit === undefined ? {} : { limit: command.limit },
    ...command.minScore === undefined ? {} : { minScore: command.minScore }
  });
  output.stdout(command.json ? terminalSafeJson(result) : sanitizeTerminalText(renderSemanticSearch(result)));
  return 0;
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
function summary(snapshot) {
  return {
    root: snapshot.root,
    indexPath: snapshot.indexPath,
    index: snapshot.index,
    noteCount: snapshot.analysis.noteCount,
    contextualLinkCount: snapshot.analysis.contextualLinks.length,
    backlinkCount: snapshot.analysis.backlinks.length,
    issues: snapshot.analysis.issues.map(issueJson),
    orphans: snapshot.analysis.orphans,
    mentions: snapshot.analysis.mentions
  };
}
function renderIssue(issue) {
  if (issue.kind === "broken") {
    return `${safe(issue.source)}:${issue.line}: broken wikilink [[${safe(issue.target)}]]`;
  }
  return `${safe(issue.source)}:${issue.line}: ambiguous wikilink [[${safe(issue.target)}]] (${issue.candidates.map(safe).join(", ")})`;
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
function checkExitCode(snapshot) {
  return snapshot.index === "stale" || snapshot.analysis.issues.length > 0 ? 3 : 0;
}
function renderSnapshot(command, snapshot) {
  const lines = [
    `${command === "refresh" ? "Refreshed" : "Checked"} ${safe(snapshot.root)}`,
    `Index: ${snapshot.index}; notes: ${snapshot.analysis.noteCount}; contextual links: ${snapshot.analysis.contextualLinks.length}.`
  ];
  if (snapshot.index === "stale")
    lines.push(`error: generated catalog is stale (${safe(snapshot.indexPath)})`);
  for (const issue of snapshot.analysis.issues)
    lines.push(`error: ${renderIssue(issue)}`);
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
    `Graph: ${snapshot.analysis.noteCount} notes; ${snapshot.analysis.contextualLinks.length} contextual links.`
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
  for (const issue of snapshot.analysis.issues)
    lines.push(`error: ${renderIssue(issue)}`);
  lines.push(...renderAdvisories(snapshot.analysis));
  return `${lines.join(`
`)}
`;
}
function backlinkPayload(notePath, backlinks) {
  return { note: notePath, count: backlinks.length, backlinks };
}
function renderBacklinks(notePath, backlinks) {
  const lines = [`Backlinks to ${safe(notePath)} (${backlinks.length})`];
  if (backlinks.length === 0)
    lines.push("  None.");
  else
    for (const backlink of backlinks)
      lines.push(`  ${safe(backlink.source)}:${backlink.line}`);
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
  if (neighborhood.truncated)
    lines.push(`Truncated at ${neighborhood.limit} notes; lower the depth or raise --limit.`);
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
async function runList(command, output, dependencies) {
  const snapshot = await (dependencies.scanVault ?? scanVault)(command.root, command.options);
  const rows = queryVault(snapshot.notes, snapshot.analysis, {
    filters: command.filters,
    tags: command.tags,
    sort: command.sort,
    direction: command.direction,
    ...command.limit === undefined ? {} : { limit: command.limit }
  });
  output.stdout(command.json ? terminalSafeJson({ root: snapshot.root, count: rows.length, notes: rows }) : sanitizeTerminalText(renderList(rows)));
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
function contextPayload(inspection, snapshot) {
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
    issues: inspection.issues.map(contextIssuePayload)
  };
}
function renderContext(inspection, snapshot) {
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
  lines.push("Oh hubs (nearest \u2192 root):");
  if (inspection.matchingContexts.length === 0)
    lines.push("  None.");
  for (const context of inspection.matchingContexts) {
    const connection = snapshot.analysis.noteConnections.find(({ id }) => id === context.note.id);
    lines.push(`  ${safe(context.note.id)} \u2014 ${safe(context.note.title)}  \u2190 ${connection?.inboundContextualCount ?? 0}  \u2192 ${connection?.outboundContextualCount ?? 0}`);
    if (context.note.summary !== "")
      lines.push(`    ${safe(context.note.summary)}`);
  }
  for (const issue of inspection.issues)
    lines.push(`error: ${safe(issue.message)}`);
  if (inspection.matchingContexts.length > 0) {
    lines.push("Open a hub, then use `oh links <hub> --root <vault> --depth 1` for bounded neighboring context.");
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
  output.stdout(command.json ? terminalSafeJson(contextPayload(inspection, snapshot)) : sanitizeTerminalText(renderContext(inspection, snapshot)));
  return inspection.issues.length === 0 ? 0 : 3;
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
    `${action === "check" ? "Checked" : "Audited"} ${audit.guideCount} agent guides; ${audit.mappedGuideCount} markers, ${validContexts} valid Oh hubs.`,
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
    output.stdout(command.json ? terminalSafeJson(summary(snapshot)) : sanitizeTerminalText(renderSnapshot(command.kind, snapshot)));
    return checkExitCode(snapshot);
  }
  if (command.kind === "graph") {
    output.stdout(command.json ? terminalSafeJson(graphJson(snapshot)) : sanitizeTerminalText(renderGraph(snapshot)));
    return 0;
  }
  const lookup = lookupNote(snapshot.notes, command.note ?? "");
  if (lookup.kind === "missing") {
    output.stderr(`error: note was not found
`);
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
  output.stdout(command.json ? terminalSafeJson(backlinkPayload(lookup.note.path, backlinks)) : sanitizeTerminalText(renderBacklinks(lookup.note.path, backlinks)));
  return 0;
}
async function main3(rawArguments = process.argv.slice(2), output = defaultOutput, dependencies = {}) {
  const parsed = parseArguments(rawArguments);
  if (!parsed.ok) {
    output.stderr(`error: ${safe(parsed.message)}

${sanitizeTerminalText(usage)}`);
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
    if (command.kind === "pdf") {
      return await (dependencies.runPdfCommand ?? main2)(command.arguments, process.env, output);
    }
    if (command.kind === "init") {
      return await runInit(command, output, dependencies.initVault ?? initVault);
    }
    if (command.kind === "index" || command.kind === "search") {
      return await runSemantic(command, output, dependencies);
    }
    if (command.kind === "context")
      return await runContext(command, output, dependencies);
    if (command.kind === "agent-identity")
      return runAgentIdentity(command, output);
    if (command.kind === "agents")
      return await runAgents(command, output, dependencies);
    if (command.kind === "list")
      return await runList(command, output, dependencies);
    return await runVault(command, output, dependencies);
  } catch (error) {
    output.stderr(`error: ${safe(error instanceof Error ? error.message : String(error))}
`);
    return 1;
  }
}
if (import.meta.main)
  process.exitCode = await main3();
export {
  usage,
  parseArguments,
  main3 as main
};
