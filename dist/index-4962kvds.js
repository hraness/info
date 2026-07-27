// @bun
// src/graph.ts
import { posix } from "path";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument
} from "yaml";
var catalogStart = "<!-- kb:catalog:start -->";
var catalogEnd = "<!-- kb:catalog:end -->";
var MAX_ANALYZED_NOTES = 1e4;
var MAX_CONNECTION_OBSERVATIONS = 250000;
var MAX_MENTION_PAIRS = 1e6;
var MAX_MENTIONS = 50000;

class VaultAnalysisBudgetError extends RangeError {
  kind;
  limit;
  constructor(kind, limit, message) {
    super(message);
    this.name = "VaultAnalysisBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}
function isMetadataObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parsedMetadataValue(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "object" || ancestors.has(value))
    return { ok: false };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parsed2 = [];
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" || key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
        return { ok: false };
      }
      for (let index = 0;index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor))
          return { ok: false };
        const result = parsedMetadataValue(descriptor.value, ancestors);
        if (!result.ok)
          return result;
        parsed2.push(result.value);
      }
      return { ok: true, value: parsed2 };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return { ok: false };
    const parsed = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string")
        return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false };
      }
      const result = parsedMetadataValue(descriptor.value, ancestors);
      if (!result.ok)
        return result;
      Object.defineProperty(parsed, key, {
        configurable: false,
        enumerable: true,
        value: result.value,
        writable: false
      });
    }
    return { ok: true, value: parsed };
  } finally {
    ancestors.delete(value);
  }
}
function metadataValueFromUnknown(value) {
  try {
    const parsed = parsedMetadataValue(value, new WeakSet);
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return;
  }
}
function metadataObjectFromUnknown(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    return null;
  const parsed = metadataValueFromUnknown(value);
  return parsed !== undefined && isMetadataObject(parsed) ? parsed : null;
}
function emptyMetadata() {
  return Object.create(null);
}
var relationPredicatePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var maxNoteIdLength = 2048;
function isCanonicalNoteId(value) {
  if (value === "" || value.length > maxNoteIdLength || value !== value.trim() || value !== value.normalize("NFC") || value.includes("\\") || value.includes("\x00") || value.includes(`
`) || value.includes("\r") || value.startsWith("/") || value.endsWith("/") || value.toLocaleLowerCase("en-US").endsWith(".md")) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".")) && posix.normalize(value) === value && posix.basename(`${value}.md`) !== "AGENTS.md";
}
function frontmatterSourceLine(lineCounter, node, fallback = 2) {
  const offset = node?.range?.[0];
  if (offset === undefined)
    return fallback;
  return lineCounter.linePos(offset).line + 1;
}
function malformedRelation(source, line, message, details = {}) {
  return {
    kind: "malformed",
    source,
    line,
    ...details,
    message
  };
}
function relationTarget(node, predicate, source, lineCounter, fallbackLine) {
  const line = frontmatterSourceLine(lineCounter, node, fallbackLine);
  if (!isScalar(node) || typeof node.value !== "string") {
    return malformedRelation(source, line, `Relation "${predicate}" targets must be non-empty strings.`, { predicate });
  }
  const target = node.value;
  if (!isCanonicalNoteId(target)) {
    return malformedRelation(source, line, `Relation "${predicate}" target ${JSON.stringify(target)} must be an exact ` + "extensionless vault-root note ID.", { predicate, target: node.value });
  }
  return { predicate, target, line };
}
function parsedRelations(contents, source, lineCounter) {
  if (!isMap(contents))
    return { relationDeclarations: [], relationIssues: [] };
  const relationsPair = contents.items.find((pair) => isScalar(pair.key) && typeof pair.key.value === "string" && pair.key.value.toLocaleLowerCase("en-US") === "relations");
  if (relationsPair === undefined) {
    return { relationDeclarations: [], relationIssues: [] };
  }
  const relationsLine = frontmatterSourceLine(lineCounter, isScalar(relationsPair.key) ? relationsPair.key : null);
  if (!isMap(relationsPair.value)) {
    return {
      relationDeclarations: [],
      relationIssues: [
        malformedRelation(source, relationsLine, "Relations must map strict lower-kebab predicates to a string or string list.")
      ]
    };
  }
  const relationDeclarations = [];
  const relationIssues = [];
  for (const pair of relationsPair.value.items) {
    const predicateLine = frontmatterSourceLine(lineCounter, isNode(pair.key) ? pair.key : null, relationsLine);
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      relationIssues.push(malformedRelation(source, predicateLine, "Relation predicates must be strict lower kebab-case strings."));
      continue;
    }
    const predicate = pair.key.value.normalize("NFC");
    if (!relationPredicatePattern.test(predicate)) {
      relationIssues.push(malformedRelation(source, predicateLine, `Invalid relation predicate "${predicate}"; use strict lower kebab-case.`, { predicate }));
      continue;
    }
    const nodes = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const node of nodes) {
      const parsed = relationTarget(isNode(node) ? node : null, predicate, source, lineCounter, predicateLine);
      if ("kind" in parsed)
        relationIssues.push(parsed);
      else
        relationDeclarations.push(parsed);
    }
  }
  return {
    relationDeclarations: relationDeclarations.toSorted((left, right) => left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target) || left.line - right.line),
    relationIssues: relationIssues.toSorted((left, right) => left.line - right.line || (left.predicate ?? "").localeCompare(right.predicate ?? "") || (left.target ?? "").localeCompare(right.target ?? ""))
  };
}
function parseMetadata(source, path) {
  if (source.trim() === "") {
    return {
      metadata: emptyMetadata(),
      relationDeclarations: [],
      relationIssues: []
    };
  }
  try {
    const lineCounter = new LineCounter;
    const document = parseDocument(source, {
      lineCounter,
      schema: "core",
      uniqueKeys: true
    });
    if (document.errors.length > 0) {
      throw new Error("the YAML parser reported an error");
    }
    if (document.contents === null) {
      return {
        metadata: emptyMetadata(),
        relationDeclarations: [],
        relationIssues: []
      };
    }
    const parsed = document.toJS({ mapAsMap: false, maxAliasCount: 50 });
    const metadata = metadataObjectFromUnknown(parsed);
    if (metadata === null)
      throw new Error("the YAML document is not a JSON-like object");
    return {
      metadata,
      ...parsedRelations(document.contents, path, lineCounter)
    };
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter in ${path}.`, { cause: error });
  }
}
function metadataProperty(metadata, name) {
  if (Object.hasOwn(metadata, name))
    return metadata[name];
  const lowerName = name.toLocaleLowerCase("en-US");
  const matches = Object.keys(metadata).filter((key) => key.toLocaleLowerCase("en-US") === lowerName);
  return matches.length === 1 ? metadata[matches[0] ?? ""] : undefined;
}
function normalizedTags(metadata) {
  const value = metadataProperty(metadata, "tags");
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((candidate) => typeof candidate === "string") : [];
  const tags = [];
  const seen = new Set;
  for (const candidate of candidates) {
    const tag = candidate.trim().replace(/^#+/u, "").normalize("NFC").toLocaleLowerCase("en-US");
    if (tag === "" || seen.has(tag))
      continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}
var normalizeVaultPath = (path) => posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
var withoutMarkdownExtension = (path) => path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
function legacyPropertyValue(value) {
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null)
    return "null";
  return;
}
function aliasesFromMetadata(metadata) {
  const value = metadataProperty(metadata, "aliases");
  if (typeof value === "string")
    return value.trim() === "" ? [] : [value];
  if (!Array.isArray(value))
    return [];
  return value.filter((candidate) => typeof candidate === "string" && candidate.trim() !== "");
}
function frontmatterOf(content, path) {
  const lines = content.split(`
`);
  if (lines[0]?.trim() !== "---") {
    return {
      values: new Map,
      aliases: [],
      tags: [],
      metadata: emptyMetadata(),
      relationDeclarations: [],
      relationIssues: []
    };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new Error(`Invalid YAML frontmatter in ${path}: missing closing delimiter.`);
  }
  const parsed = parseMetadata(lines.slice(1, end).join(`
`), path);
  const metadata = parsed.metadata;
  const values = new Map;
  const seenKeys = new Set;
  for (const [authoredKey, typedValue] of Object.entries(metadata)) {
    const key = authoredKey.toLocaleLowerCase("en-US");
    if (seenKeys.has(key)) {
      throw new Error(`Invalid YAML frontmatter in ${path}: keys must not differ only by case.`);
    }
    seenKeys.add(key);
    if (key === "aliases")
      continue;
    const value = legacyPropertyValue(typedValue);
    if (value !== undefined && value !== "")
      values.set(key, value);
  }
  return {
    values,
    aliases: aliasesFromMetadata(metadata),
    tags: normalizedTags(metadata),
    metadata,
    relationDeclarations: parsed.relationDeclarations,
    relationIssues: parsed.relationIssues
  };
}
function searchableMarkdown(content) {
  const lines = content.split(`
`);
  let inFrontmatter = lines[0]?.trim() === "---";
  let inFence = null;
  let inComment = false;
  const blockMasked = lines.map((line, index) => {
    if (inFrontmatter) {
      if (index > 0 && line.trim() === "---")
        inFrontmatter = false;
      return "";
    }
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (inFence !== null) {
      const delimiter = /^\s{0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (delimiter !== undefined && delimiter[0] === inFence.character && delimiter.length >= inFence.length)
        inFence = null;
      return "";
    }
    const openingDelimiter = fence?.[1];
    const openingRemainder = fence === null ? "" : line.slice(fence[0].length);
    if (openingDelimiter !== undefined && (openingDelimiter[0] === "~" || !openingRemainder.includes("`"))) {
      const delimiter = openingDelimiter;
      inFence = { character: delimiter[0] ?? "`", length: delimiter.length };
      return "";
    }
    if (/^(?: {4,}|\t)/u.test(line))
      return "";
    let output = line;
    if (inComment) {
      const close = output.indexOf("-->");
      if (close === -1)
        return "";
      output = output.slice(close + 3);
      inComment = false;
    }
    for (;; ) {
      const open = output.indexOf("<!--");
      if (open === -1)
        break;
      const close = output.indexOf("-->", open + 4);
      if (close === -1) {
        output = output.slice(0, open);
        inComment = true;
        break;
      }
      output = output.slice(0, open) + output.slice(close + 3);
    }
    return output;
  }).join(`
`);
  return maskInlineCodeBlocks(maskHtmlCodeBlocks(blockMasked));
}
function maskInlineCodeSpans(value) {
  const runs = [];
  for (let index = 0;index < value.length; ) {
    if (value[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (value[index] === "`")
      index += 1;
    let precedingBackslashes = 0;
    for (let before = start - 1;before >= 0 && value[before] === "\\"; before -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1)
      continue;
    runs.push({ start, end: index, length: index - start });
  }
  const remaining = new Map;
  for (const run of runs)
    remaining.set(run.length, (remaining.get(run.length) ?? 0) + 1);
  const output = [];
  let cursor = 0;
  let delimiterLength = null;
  const appendSegment = (segment) => {
    output.push(delimiterLength === null ? segment : segment.replace(/[^\n]/gu, ""));
  };
  for (const run of runs) {
    appendSegment(value.slice(cursor, run.start));
    remaining.set(run.length, (remaining.get(run.length) ?? 1) - 1);
    if (delimiterLength === null) {
      if ((remaining.get(run.length) ?? 0) > 0)
        delimiterLength = run.length;
      else
        output.push(value.slice(run.start, run.end));
    } else if (run.length === delimiterLength) {
      delimiterLength = null;
    }
    cursor = run.end;
  }
  appendSegment(value.slice(cursor));
  return output.join("");
}
function maskInlineCodeBlocks(value) {
  const output = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length === 0)
      return;
    output.push(...maskInlineCodeSpans(paragraph.join(`
`)).split(`
`));
    paragraph = [];
  };
  const startsIndependentBlock = (line) => /^\s{0,3}(?:#{1,6}(?:\s|$)|>|(?:[-+*]|\d+[.)])\s+)/u.test(line);
  for (const line of value.split(`
`)) {
    if (line.trim() === "") {
      flush();
      output.push("");
    } else if (startsIndependentBlock(line)) {
      flush();
      output.push(maskInlineCodeSpans(line));
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return output.join(`
`);
}
function maskHtmlCodeBlocks(value) {
  const tagPattern = /<\/?(pre|code|script|style)\b[^>]*>/giu;
  const output = [];
  let cursor = 0;
  let activeTag = null;
  let depth = 0;
  const append = (segment) => {
    output.push(activeTag === null ? segment : segment.replace(/[^\n]/gu, ""));
  };
  for (const match of value.matchAll(tagPattern)) {
    const start = match.index ?? 0;
    append(value.slice(cursor, start));
    const tag = (match[1] ?? "").toLowerCase();
    const closing = match[0].startsWith("</");
    if (activeTag === null && !closing) {
      activeTag = tag;
      depth = 1;
    } else if (activeTag === tag) {
      if (closing)
        depth -= 1;
      else
        depth += 1;
      if (depth === 0)
        activeTag = null;
    }
    output.push(match[0].replace(/[^\n]/gu, ""));
    cursor = start + match[0].length;
  }
  append(value.slice(cursor));
  return output.join("");
}
function markdownText(value) {
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|([^\]]+))?\]\]/g, (_whole, target, label) => label ?? posix.basename(target)).replace(/[*_~]/g, "").replace(/\s+/g, " ").trim();
}
function firstHeading(searchable) {
  for (const line of searchable.split(`
`)) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading !== null)
      return markdownText(heading[1] ?? "");
  }
  return null;
}
function firstParagraph(searchable) {
  const paragraphs = searchable.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const lines = paragraph.split(`
`).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("- ") && !line.startsWith("* ") && !line.startsWith("|") && !line.startsWith(">"));
    const text = markdownText(lines.join(" "));
    if (text !== "")
      return text;
  }
  return "";
}
function concise(value, limit = 180) {
  const text = markdownText(value);
  if (text.length <= limit)
    return text;
  const prefix = text.slice(0, limit + 1);
  const lastSpace = prefix.lastIndexOf(" ");
  return (lastSpace >= Math.floor(limit * 0.65) ? prefix.slice(0, lastSpace) : text.slice(0, limit)).trimEnd() + "\u2026";
}
function wikiLinks(searchable) {
  const links = [];
  for (const match of searchable.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const offset = match.index ?? 0;
    let precedingBackslashes = 0;
    for (let before = offset - 1;before >= 0 && searchable[before] === "\\"; before -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1)
      continue;
    const inside = match[2] ?? "";
    const separator = inside.indexOf("|");
    const target = (separator === -1 ? inside : inside.slice(0, separator)).trim();
    links.push({
      target,
      line: searchable.slice(0, offset).split(`
`).length,
      embedded: (match[1] ?? "") === "!"
    });
  }
  return links;
}
function parseNote(path, content) {
  const notePath = normalizeVaultPath(path);
  const metadata = frontmatterOf(content, notePath);
  const searchable = searchableMarkdown(content);
  const fallback = posix.basename(withoutMarkdownExtension(notePath)).replaceAll("-", " ");
  const title = metadata.values.get("title") ?? firstHeading(searchable) ?? fallback;
  const summary = concise(metadata.values.get("description") ?? firstParagraph(searchable));
  return {
    path: notePath,
    id: withoutMarkdownExtension(notePath),
    title,
    aliases: metadata.aliases,
    tags: metadata.tags,
    properties: Object.fromEntries(metadata.values),
    metadata: metadata.metadata,
    content,
    summary,
    searchableText: searchable,
    links: wikiLinks(searchable),
    relationDeclarations: metadata.relationDeclarations,
    relationIssues: metadata.relationIssues
  };
}
function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function lookupNote(notes, query) {
  const trimmed = decoded(query.trim()).replaceAll("\\", "/").replace(/^\/+/, "");
  if (trimmed === "")
    return { kind: "missing", query };
  const queryId = withoutMarkdownExtension(normalizeVaultPath(trimmed));
  const exact = notes.find((note) => note.id === queryId);
  if (exact !== undefined)
    return { kind: "found", note: exact };
  const lowerQueryId = queryId.toLocaleLowerCase("en-US");
  const idMatches = notes.filter((note) => note.id.toLocaleLowerCase("en-US") === lowerQueryId);
  const onlyIdMatch = idMatches.length === 1 ? idMatches[0] : undefined;
  if (onlyIdMatch !== undefined)
    return { kind: "found", note: onlyIdMatch };
  if (idMatches.length > 1) {
    return {
      kind: "ambiguous",
      query,
      candidates: idMatches.toSorted((left, right) => left.path.localeCompare(right.path))
    };
  }
  const lowerLabel = query.trim().toLocaleLowerCase("en-US");
  const lowerBasename = posix.basename(queryId).toLocaleLowerCase("en-US");
  const candidates = notes.filter((note) => {
    const labels = [posix.basename(note.id), note.title, ...note.aliases].map((value) => value.toLocaleLowerCase("en-US"));
    return labels.includes(lowerLabel) || labels.includes(lowerBasename);
  }).toSorted((left, right) => left.path.localeCompare(right.path));
  const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
  if (onlyCandidate !== undefined)
    return { kind: "found", note: onlyCandidate };
  if (candidates.length > 1)
    return { kind: "ambiguous", query, candidates };
  return { kind: "missing", query };
}
function resolveTarget(source, rawTarget, byId, byBasename) {
  const targetWithoutAnchor = rawTarget.split("#", 1)[0]?.split("^", 1)[0]?.trim() ?? "";
  if (targetWithoutAnchor === "")
    return { kind: "note", id: source.id };
  let target = decoded(targetWithoutAnchor).replaceAll("\\", "/");
  const extension = posix.extname(target).toLowerCase();
  if (extension !== "" && extension !== ".md")
    return { kind: "attachment" };
  target = withoutMarkdownExtension(target).replace(/^\//, "");
  if (target.startsWith(".")) {
    const relativeTarget = posix.normalize(posix.join(posix.dirname(source.id), target));
    return byId.has(relativeTarget) ? { kind: "note", id: relativeTarget } : { kind: "broken" };
  }
  if (byId.has(target))
    return { kind: "note", id: target };
  if (target.includes("/"))
    return { kind: "broken" };
  const candidates = byBasename.get(target) ?? [];
  if (candidates.length === 1)
    return { kind: "note", id: candidates[0] ?? target };
  if (candidates.length > 1)
    return { kind: "ambiguous", candidates };
  return { kind: "broken" };
}
var pairKey = (left, right) => left.localeCompare(right) <= 0 ? `${left}\x00${right}` : `${right}\x00${left}`;
function compareAuthoredRelations(left, right) {
  return left.source.localeCompare(right.source) || left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target) || left.provenance.line - right.provenance.line || left.provenance.authoredTarget.localeCompare(right.provenance.authoredTarget);
}
function compareRelationIssues(left, right) {
  const predicateComparison = (left.predicate ?? "").localeCompare(right.predicate ?? "");
  const targetComparison = (left.target ?? "").localeCompare(right.target ?? "");
  return left.source.localeCompare(right.source) || left.line - right.line || left.kind.localeCompare(right.kind) || predicateComparison || targetComparison;
}
var wordCharacter = (value) => /[A-Za-z0-9]/.test(value);
function phraseOffset(lowerHaystack, lowerPhrase) {
  let offset = lowerHaystack.indexOf(lowerPhrase);
  while (offset !== -1) {
    const before = offset === 0 ? "" : lowerHaystack[offset - 1] ?? "";
    const afterIndex = offset + lowerPhrase.length;
    const after = afterIndex >= lowerHaystack.length ? "" : lowerHaystack[afterIndex] ?? "";
    const startsClean = !wordCharacter(lowerPhrase[0] ?? "") || !wordCharacter(before);
    const endsClean = !wordCharacter(lowerPhrase.at(-1) ?? "") || !wordCharacter(after);
    if (startsClean && endsClean)
      return offset;
    offset = lowerHaystack.indexOf(lowerPhrase, offset + 1);
  }
  return -1;
}
function candidatePhrases(note) {
  const values = [note.title, ...note.aliases].map((value) => value.trim()).filter((value) => value.length >= 4 && /[A-Za-z]/.test(value));
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}
function uniquePhrasesByTarget(notes) {
  const ownersByPhrase = new Map;
  for (const note of notes) {
    for (const phrase of candidatePhrases(note)) {
      const lowerPhrase = phrase.toLocaleLowerCase("en-US");
      const owners = ownersByPhrase.get(lowerPhrase) ?? new Map;
      if (!owners.has(note.id))
        owners.set(note.id, phrase);
      ownersByPhrase.set(lowerPhrase, owners);
    }
  }
  const phrasesByTarget = new Map;
  for (const [lowerPhrase, owners] of ownersByPhrase) {
    if (owners.size !== 1)
      continue;
    const owner = owners.entries().next().value;
    if (owner === undefined)
      continue;
    const [targetId, phrase] = owner;
    const phrases = phrasesByTarget.get(targetId) ?? [];
    phrases.push({ phrase, lowerPhrase });
    phrasesByTarget.set(targetId, phrases);
  }
  for (const phrases of phrasesByTarget.values()) {
    phrases.sort((left, right) => right.lowerPhrase.length - left.lowerPhrase.length || left.lowerPhrase.localeCompare(right.lowerPhrase));
  }
  return phrasesByTarget;
}
function checkedAnalysisLimit(value, hardMaximum, option) {
  const limit = value ?? hardMaximum;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > hardMaximum) {
    throw new RangeError(`${option} must be a safe integer from 0 through ${hardMaximum}.`);
  }
  return limit;
}
function analyzeVault(notes, options = {}) {
  const maxNotes = checkedAnalysisLimit(options.maxNotes, MAX_ANALYZED_NOTES, "maxNotes");
  const maxMentionPairs = checkedAnalysisLimit(options.maxMentionPairs, MAX_MENTION_PAIRS, "maxMentionPairs");
  const maxMentions = checkedAnalysisLimit(options.maxMentions, MAX_MENTIONS, "maxMentions");
  const maxConnectionObservations = checkedAnalysisLimit(options.maxConnectionObservations, MAX_CONNECTION_OBSERVATIONS, "maxConnectionObservations");
  if (notes.length > maxNotes) {
    throw new VaultAnalysisBudgetError("notes", maxNotes, `Vault analysis exceeds the ${maxNotes} note limit.`);
  }
  const catalogNoteId = withoutMarkdownExtension(normalizeVaultPath(options.catalogNoteId ?? "index"));
  const byId = new Map(notes.map((note) => [note.id, note]));
  const byBasename = new Map;
  for (const note of notes) {
    const basename = posix.basename(note.id);
    const matches = byBasename.get(basename) ?? [];
    matches.push(note.id);
    byBasename.set(basename, matches);
  }
  for (const matches of byBasename.values())
    matches.sort();
  let connectionObservations = 0;
  const observeConnection = () => {
    if (connectionObservations >= maxConnectionObservations) {
      throw new VaultAnalysisBudgetError("connection-observations", maxConnectionObservations, `Vault analysis exceeds the ${maxConnectionObservations} ` + "connection-observation limit.");
    }
    connectionObservations += 1;
  };
  const issues = [];
  const relationIssues = [];
  for (const note of notes) {
    for (const issue of note.relationIssues ?? []) {
      observeConnection();
      relationIssues.push(issue);
    }
  }
  const contextualLinks = [];
  const edgeKeys = new Set;
  for (const source of notes) {
    for (const link of source.links) {
      observeConnection();
      const resolution = resolveTarget(source, link.target, byId, byBasename);
      if (resolution.kind === "attachment")
        continue;
      if (resolution.kind === "broken") {
        issues.push({ kind: "broken", source: source.path, line: link.line, target: link.target });
        continue;
      }
      if (resolution.kind === "ambiguous") {
        issues.push({
          kind: "ambiguous",
          source: source.path,
          line: link.line,
          target: link.target,
          candidates: resolution.candidates
        });
        continue;
      }
      if (source.id === catalogNoteId || resolution.id === catalogNoteId || source.id === resolution.id)
        continue;
      const edgeKey = `${source.id}\x00${resolution.id}`;
      if (edgeKeys.has(edgeKey))
        continue;
      edgeKeys.add(edgeKey);
      contextualLinks.push({ source: source.path, target: `${resolution.id}.md`, line: link.line });
    }
  }
  const authoredRelations = [];
  const declarationKeys = new Set;
  const relationEdgeKeys = new Set;
  for (const source of notes) {
    const declarations = [];
    for (const declaration of source.relationDeclarations ?? []) {
      observeConnection();
      declarations.push(declaration);
    }
    declarations.sort((left, right) => left.line - right.line || left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target));
    for (const declaration of declarations) {
      const declarationKey = `${source.id}\x00${declaration.predicate}\x00${declaration.target}`;
      if (declarationKeys.has(declarationKey))
        continue;
      declarationKeys.add(declarationKey);
      const exactTarget = byId.get(declaration.target);
      if (exactTarget === undefined) {
        const basenameMatches = declaration.target.includes("/") ? [] : (byBasename.get(declaration.target) ?? []).filter((candidate) => candidate !== declaration.target);
        if (basenameMatches.length > 0) {
          relationIssues.push(malformedRelation(source.path, declaration.line, `Relation "${declaration.predicate}" target ` + `${JSON.stringify(declaration.target)} is only a basename; ` + "store the exact vault-root note ID.", {
            predicate: declaration.predicate,
            target: declaration.target
          }));
          continue;
        }
        relationIssues.push({
          kind: "broken",
          source: source.path,
          line: declaration.line,
          predicate: declaration.predicate,
          target: declaration.target
        });
        continue;
      }
      if (source.id === catalogNoteId || exactTarget.id === catalogNoteId)
        continue;
      const edgeKey = `${source.id}\x00${declaration.predicate}\x00${exactTarget.id}`;
      if (relationEdgeKeys.has(edgeKey))
        continue;
      relationEdgeKeys.add(edgeKey);
      authoredRelations.push({
        source: source.id,
        target: exactTarget.id,
        predicate: declaration.predicate,
        provenance: {
          kind: "frontmatter",
          source: source.path,
          line: declaration.line,
          authoredTarget: declaration.target
        }
      });
    }
  }
  const sortedContextualLinks = contextualLinks.toSorted((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.line - right.line);
  const sortedAuthoredRelations = authoredRelations.toSorted(compareAuthoredRelations);
  const backlinks = sortedContextualLinks.toSorted((left, right) => left.target.localeCompare(right.target) || left.source.localeCompare(right.source) || left.line - right.line);
  const contentNotes = notes.filter((note) => note.id !== catalogNoteId);
  const connected = new Set;
  const linkedPairs = new Set;
  const inboundById = new Map;
  const outboundById = new Map;
  const inboundRelationsById = new Map;
  const outboundRelationsById = new Map;
  for (const link of sortedContextualLinks) {
    const sourceId = withoutMarkdownExtension(link.source);
    const targetId = withoutMarkdownExtension(link.target);
    connected.add(sourceId);
    connected.add(targetId);
    linkedPairs.add(pairKey(sourceId, targetId));
    const inbound = inboundById.get(targetId) ?? [];
    inbound.push(link);
    inboundById.set(targetId, inbound);
    outboundById.set(sourceId, (outboundById.get(sourceId) ?? 0) + 1);
  }
  for (const relation of sortedAuthoredRelations) {
    connected.add(relation.source);
    connected.add(relation.target);
    linkedPairs.add(pairKey(relation.source, relation.target));
    const inbound = inboundRelationsById.get(relation.target) ?? [];
    inbound.push(relation);
    inboundRelationsById.set(relation.target, inbound);
    outboundRelationsById.set(relation.source, (outboundRelationsById.get(relation.source) ?? 0) + 1);
  }
  const includeInSuggestions = options.includeInSuggestions ?? (() => true);
  const suggestionNotes = contentNotes.filter(includeInSuggestions);
  const scopedMentionNotes = options.mentionScope === undefined ? suggestionNotes : suggestionNotes.filter(options.mentionScope);
  const scopedMentionIds = new Set(scopedMentionNotes.map((note) => note.id));
  const phrasesByTarget = scopedMentionNotes.length === 0 ? new Map : uniquePhrasesByTarget(suggestionNotes);
  const mentions = [];
  let mentionPairs = 0;
  for (const source of suggestionNotes) {
    const targets = options.mentionScope === undefined || scopedMentionIds.has(source.id) ? suggestionNotes : scopedMentionNotes;
    let lowerSearchableText;
    for (const target of targets) {
      if (source.id === target.id)
        continue;
      if (mentionPairs >= maxMentionPairs) {
        throw new VaultAnalysisBudgetError("mention-pairs", maxMentionPairs, `Vault analysis exceeds the ${maxMentionPairs} mention-pair limit.`);
      }
      mentionPairs += 1;
      if (linkedPairs.has(pairKey(source.id, target.id)))
        continue;
      lowerSearchableText ??= source.searchableText.toLocaleLowerCase("en-US");
      for (const { phrase, lowerPhrase } of phrasesByTarget.get(target.id) ?? []) {
        const offset = phraseOffset(lowerSearchableText, lowerPhrase);
        if (offset === -1)
          continue;
        if (mentions.length >= maxMentions) {
          throw new VaultAnalysisBudgetError("mentions", maxMentions, `Vault analysis exceeds the ${maxMentions} mention limit.`);
        }
        mentions.push({
          source: source.path,
          line: source.searchableText.slice(0, offset).split(`
`).length,
          target: target.path,
          phrase
        });
        break;
      }
    }
  }
  return {
    noteCount: contentNotes.length,
    contextualLinks: sortedContextualLinks,
    backlinks,
    authoredRelations: sortedAuthoredRelations,
    noteConnections: contentNotes.map((note) => ({
      id: note.id,
      path: note.path,
      inboundContextualCount: inboundById.get(note.id)?.length ?? 0,
      outboundContextualCount: outboundById.get(note.id) ?? 0,
      backlinks: inboundById.get(note.id) ?? [],
      inboundRelationCount: inboundRelationsById.get(note.id)?.length ?? 0,
      outboundRelationCount: outboundRelationsById.get(note.id) ?? 0,
      relationBacklinks: inboundRelationsById.get(note.id) ?? []
    })).toSorted((left, right) => left.path.localeCompare(right.path)),
    issues: issues.sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line || left.target.localeCompare(right.target)),
    relationIssues: relationIssues.toSorted(compareRelationIssues),
    orphans: suggestionNotes.filter((note) => !connected.has(note.id)).map((note) => note.path).sort(),
    mentions: mentions.sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line || left.target.localeCompare(right.target))
  };
}
var sectionTitle = (directory) => directory.split("-").map((part) => part === "" ? "" : (part[0]?.toUpperCase() ?? "") + part.slice(1)).join(" ");
function safeCatalogCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 1564 || codePoint === 8206 || codePoint === 8207 || codePoint >= 8232 && codePoint <= 8238 || codePoint >= 8294 && codePoint <= 8297 ? " " : character;
}
function safeCatalogText(value, limit) {
  return [...concise(value, limit)].map(safeCatalogCharacter).join("").replaceAll("<!--", "\u2039!--").replaceAll("-->", "--\u203A").replaceAll("|", " \u2014 ").replaceAll("]]", "]").replace(/\s+/gu, " ").trim();
}
function safeWikiTarget(value) {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function renderCatalog(notes, catalogNoteId = "index") {
  const normalizedCatalogNoteId = withoutMarkdownExtension(normalizeVaultPath(catalogNoteId));
  const groups = new Map;
  for (const note of notes.filter((candidate) => candidate.id !== normalizedCatalogNoteId)) {
    const directory = note.id.includes("/") ? note.id.split("/", 1)[0] ?? "Notes" : "Notes";
    const group = groups.get(directory) ?? [];
    group.push(note);
    groups.set(directory, group);
  }
  const lines = [catalogStart, "## Note catalog", ""];
  if (groups.size === 0) {
    lines.push("_No durable notes have been filed yet._", "", catalogEnd);
    return lines.join(`
`);
  }
  for (const [directory, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${safeCatalogText(sectionTitle(directory), 120) || "Notes"}`, "");
    for (const note of group.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))) {
      const details = [
        note.properties.type === "plan" && note.properties.status !== undefined ? `Status: ${safeCatalogText(note.properties.status, 60)}.` : "",
        safeCatalogText(note.summary, 180)
      ].filter((value) => value !== "").join(" ");
      const suffix = details === "" ? "" : ` \u2014 ${details}`;
      const label = safeCatalogText(note.title, 240) || safeCatalogText(posix.basename(note.id), 240) || "Untitled";
      lines.push(`- [[${safeWikiTarget(note.id)}|${label}]]${suffix}`);
    }
    lines.push("");
  }
  lines.push(catalogEnd);
  return lines.join(`
`);
}
function replaceCatalog(indexContent, catalog) {
  const start = indexContent.indexOf(catalogStart);
  const end = indexContent.indexOf(catalogEnd);
  if (start === -1 && end === -1)
    return indexContent.trimEnd() + `

` + catalog + `
`;
  if (start === -1 || end === -1 || end < start) {
    throw new Error("kb/index.md has a malformed managed catalog boundary");
  }
  if (indexContent.indexOf(catalogStart, start + catalogStart.length) !== -1 || indexContent.indexOf(catalogEnd, end + catalogEnd.length) !== -1) {
    throw new Error("kb/index.md has duplicate managed catalog boundaries");
  }
  return indexContent.slice(0, start) + catalog + indexContent.slice(end + catalogEnd.length);
}

export { catalogStart, catalogEnd, MAX_ANALYZED_NOTES, MAX_CONNECTION_OBSERVATIONS, MAX_MENTION_PAIRS, MAX_MENTIONS, VaultAnalysisBudgetError, metadataValueFromUnknown, isCanonicalNoteId, normalizeVaultPath, searchableMarkdown, wikiLinks, parseNote, lookupNote, analyzeVault, renderCatalog, replaceCatalog };
