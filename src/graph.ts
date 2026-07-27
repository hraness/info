import { posix } from "node:path";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
} from "yaml";

export const catalogStart = "<!-- kb:catalog:start -->";
export const catalogEnd = "<!-- kb:catalog:end -->";

export const MAX_ANALYZED_NOTES = 10_000;
export const MAX_CONNECTION_OBSERVATIONS = 250_000;
export const MAX_MENTION_PAIRS = 1_000_000;
export const MAX_MENTIONS = 50_000;

export type VaultAnalysisBudgetKind =
  | "notes"
  | "connection-observations"
  | "mention-pairs"
  | "mentions";

/** A stable failure for callers that need to distinguish bounded graph work. */
export class VaultAnalysisBudgetError extends RangeError {
  readonly kind: VaultAnalysisBudgetKind;
  readonly limit: number;

  constructor(
    kind: VaultAnalysisBudgetKind,
    limit: number,
    message: string,
  ) {
    super(message);
    this.name = "VaultAnalysisBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}

export type WikiLink = {
  target: string;
  line: number;
  embedded: boolean;
};

export type RelationDeclaration = {
  /** Strict lower-kebab predicate as authored after Unicode normalization. */
  readonly predicate: string;
  /** Authored target, normalized and trimmed but not yet resolved. */
  readonly target: string;
  readonly line: number;
};

export type RelationProvenance = {
  readonly kind: "frontmatter";
  /** Vault-relative Markdown path that owns the outbound assertion. */
  readonly source: string;
  readonly line: number;
  /** Target spelling retained for diagnostics and auditable projection. */
  readonly authoredTarget: string;
};

export type AuthoredRelation = {
  /** Canonical extensionless note ID. */
  readonly source: string;
  /** Canonical extensionless note ID. */
  readonly target: string;
  readonly predicate: string;
  readonly provenance: RelationProvenance;
};

export type MetadataScalar = string | number | boolean | null;

export type MetadataValue =
  | MetadataScalar
  | readonly MetadataValue[]
  | MetadataObject;

export interface MetadataObject {
  readonly [key: string]: MetadataValue;
}

function isMetadataObject(value: MetadataValue): value is MetadataObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type Note = {
  path: string;
  id: string;
  title: string;
  aliases: readonly string[];
  tags: readonly string[];
  properties: Readonly<Record<string, string>>;
  metadata: MetadataObject;
  content: string;
  summary: string;
  searchableText: string;
  links: readonly WikiLink[];
  /**
   * Always present on parser-produced notes. Optionality preserves compatibility
   * for callers that construct the older structural Note shape themselves.
   */
  relationDeclarations?: readonly RelationDeclaration[];
  /** Parser diagnostics promoted into VaultAnalysis.relationIssues. */
  relationIssues?: readonly MalformedRelationIssue[];
};

export type ResolvedLink = {
  source: string;
  target: string;
  line: number;
};

export type LinkIssue =
  | {
      kind: "broken";
      source: string;
      line: number;
      target: string;
    }
  | {
      kind: "ambiguous";
      source: string;
      line: number;
      target: string;
      candidates: readonly string[];
    };

export type MalformedRelationIssue = {
  readonly kind: "malformed";
  readonly source: string;
  readonly line: number;
  readonly predicate?: string;
  readonly target?: string;
  readonly message: string;
};

export type RelationIssue =
  | MalformedRelationIssue
  | {
      readonly kind: "broken";
      readonly source: string;
      readonly line: number;
      readonly predicate: string;
      readonly target: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly source: string;
      readonly line: number;
      readonly predicate: string;
      readonly target: string;
      readonly candidates: readonly string[];
    };

export type MentionCandidate = {
  source: string;
  line: number;
  target: string;
  phrase: string;
};

export type Backlink = {
  source: string;
  target: string;
  line: number;
};

export type NoteConnections = {
  id: string;
  path: string;
  inboundContextualCount: number;
  outboundContextualCount: number;
  backlinks: readonly Backlink[];
  inboundRelationCount: number;
  outboundRelationCount: number;
  relationBacklinks: readonly AuthoredRelation[];
};

export type NoteLookupResult =
  | { kind: "found"; note: Note }
  | { kind: "ambiguous"; query: string; candidates: readonly Note[] }
  | { kind: "missing"; query: string };

export type AnalyzeVaultOptions = {
  includeInSuggestions?: (note: Note) => boolean;
  /**
   * Restrict mention discovery to pairs touching an included note. An empty
   * scope skips mention pairing while retaining links and authored relations.
   */
  mentionScope?: (note: Note) => boolean;
  /** Maximum notes accepted by this analysis, up to the hard package limit. */
  maxNotes?: number;
  /** Maximum parsed wikilinks and relation records inspected in aggregate. */
  maxConnectionObservations?: number;
  /** Maximum source/target phrase pairs inspected for prose mentions. */
  maxMentionPairs?: number;
  /** Maximum mention candidates materialized in the result. */
  maxMentions?: number;
  /** Vault-relative path of the generated navigation catalog. */
  catalogNoteId?: string;
};

export type VaultAnalysis = {
  noteCount: number;
  contextualLinks: readonly ResolvedLink[];
  backlinks: readonly Backlink[];
  authoredRelations: readonly AuthoredRelation[];
  noteConnections: readonly NoteConnections[];
  issues: readonly LinkIssue[];
  relationIssues: readonly RelationIssue[];
  orphans: readonly string[];
  mentions: readonly MentionCandidate[];
};

type Frontmatter = {
  values: ReadonlyMap<string, string>;
  aliases: readonly string[];
  tags: readonly string[];
  metadata: MetadataObject;
  relationDeclarations: readonly RelationDeclaration[];
  relationIssues: readonly MalformedRelationIssue[];
};

type MetadataParseResult =
  | { readonly ok: true; readonly value: MetadataValue }
  | { readonly ok: false };

function parsedMetadataValue(
  value: unknown,
  ancestors: WeakSet<object>,
): MetadataParseResult {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? { ok: true, value }
      : { ok: false };
  }
  if (typeof value !== "object" || ancestors.has(value)) return { ok: false };

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parsed: MetadataValue[] = [];
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) =>
        typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
        return { ok: false };
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
        const result = parsedMetadataValue(descriptor.value, ancestors);
        if (!result.ok) return result;
        parsed.push(result.value);
      }
      return { ok: true, value: parsed };
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const parsed = Object.create(null) as Record<string, MetadataValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false };
      }
      const result = parsedMetadataValue(descriptor.value, ancestors);
      if (!result.ok) return result;
      Object.defineProperty(parsed, key, {
        configurable: false,
        enumerable: true,
        value: result.value,
        writable: false,
      });
    }
    return { ok: true, value: parsed };
  } finally {
    ancestors.delete(value);
  }
}

/** Narrow foreign parser output to the JSON-like metadata values owned by the graph. */
export function metadataValueFromUnknown(value: unknown): MetadataValue | undefined {
  try {
    const parsed = parsedMetadataValue(value, new WeakSet());
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function metadataObjectFromUnknown(value: unknown): MetadataObject | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const parsed = metadataValueFromUnknown(value);
  return parsed !== undefined && isMetadataObject(parsed) ? parsed : null;
}

function emptyMetadata(): MetadataObject {
  return Object.create(null) as MetadataObject;
}

type ParsedMetadata = {
  readonly metadata: MetadataObject;
  readonly relationDeclarations: readonly RelationDeclaration[];
  readonly relationIssues: readonly MalformedRelationIssue[];
};

const relationPredicatePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maxNoteIdLength = 2_048;

/**
 * Whether a value is the exact, extensionless vault-root ID used on disk.
 *
 * Relationship metadata and the authoring API share this predicate so a
 * value accepted by the reader can always be passed back to the writer
 * without a second normalization language.
 */
export function isCanonicalNoteId(value: string): boolean {
  if (
    value === ""
    || value.length > maxNoteIdLength
    || value !== value.trim()
    || value !== value.normalize("NFC")
    || value.includes("\\")
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.toLocaleLowerCase("en-US").endsWith(".md")
  ) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some((segment) =>
    segment === ""
    || segment === "."
    || segment === ".."
    || segment.startsWith("."))
    && posix.normalize(value) === value
    && posix.basename(`${value}.md`) !== "AGENTS.md";
}

function frontmatterSourceLine(
  lineCounter: LineCounter,
  node: Node | null | undefined,
  fallback = 2,
): number {
  const offset = node?.range?.[0];
  if (offset === undefined) return fallback;
  // The parsed source starts immediately after the opening frontmatter marker.
  return lineCounter.linePos(offset).line + 1;
}

function malformedRelation(
  source: string,
  line: number,
  message: string,
  details: {
    readonly predicate?: string;
    readonly target?: string;
  } = {},
): MalformedRelationIssue {
  return {
    kind: "malformed",
    source,
    line,
    ...details,
    message,
  };
}

function relationTarget(
  node: Node | null,
  predicate: string,
  source: string,
  lineCounter: LineCounter,
  fallbackLine: number,
): RelationDeclaration | MalformedRelationIssue {
  const line = frontmatterSourceLine(lineCounter, node, fallbackLine);
  if (!isScalar(node) || typeof node.value !== "string") {
    return malformedRelation(
      source,
      line,
      `Relation "${predicate}" targets must be non-empty strings.`,
      { predicate },
    );
  }
  const target = node.value;
  if (!isCanonicalNoteId(target)) {
    return malformedRelation(
      source,
      line,
      `Relation "${predicate}" target ${JSON.stringify(target)} must be an exact `
        + "extensionless vault-root note ID.",
      { predicate, target: node.value },
    );
  }
  return { predicate, target, line };
}

function parsedRelations(
  contents: Node | null,
  source: string,
  lineCounter: LineCounter,
): Pick<ParsedMetadata, "relationDeclarations" | "relationIssues"> {
  if (!isMap(contents)) return { relationDeclarations: [], relationIssues: [] };
  const relationsPair = contents.items.find((pair) =>
    isScalar(pair.key)
    && typeof pair.key.value === "string"
    && pair.key.value.toLocaleLowerCase("en-US") === "relations");
  if (relationsPair === undefined) {
    return { relationDeclarations: [], relationIssues: [] };
  }

  const relationsLine = frontmatterSourceLine(
    lineCounter,
    isScalar(relationsPair.key) ? relationsPair.key : null,
  );
  if (!isMap(relationsPair.value)) {
    return {
      relationDeclarations: [],
      relationIssues: [
        malformedRelation(
          source,
          relationsLine,
          "Relations must map strict lower-kebab predicates to a string or string list.",
        ),
      ],
    };
  }

  const relationDeclarations: RelationDeclaration[] = [];
  const relationIssues: MalformedRelationIssue[] = [];
  for (const pair of relationsPair.value.items) {
    const predicateLine = frontmatterSourceLine(
      lineCounter,
      isNode(pair.key) ? pair.key : null,
      relationsLine,
    );
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      relationIssues.push(malformedRelation(
        source,
        predicateLine,
        "Relation predicates must be strict lower kebab-case strings.",
      ));
      continue;
    }

    const predicate = pair.key.value.normalize("NFC");
    if (!relationPredicatePattern.test(predicate)) {
      relationIssues.push(malformedRelation(
        source,
        predicateLine,
        `Invalid relation predicate "${predicate}"; use strict lower kebab-case.`,
        { predicate },
      ));
      continue;
    }

    const nodes = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const node of nodes) {
      const parsed = relationTarget(
        isNode(node) ? node : null,
        predicate,
        source,
        lineCounter,
        predicateLine,
      );
      if ("kind" in parsed) relationIssues.push(parsed);
      else relationDeclarations.push(parsed);
    }
  }

  return {
    relationDeclarations: relationDeclarations.toSorted((left, right) =>
      left.predicate.localeCompare(right.predicate)
      || left.target.localeCompare(right.target)
      || left.line - right.line),
    relationIssues: relationIssues.toSorted((left, right) =>
      left.line - right.line
      || (left.predicate ?? "").localeCompare(right.predicate ?? "")
      || (left.target ?? "").localeCompare(right.target ?? "")),
  };
}

function parseMetadata(source: string, path: string): ParsedMetadata {
  if (source.trim() === "") {
    return {
      metadata: emptyMetadata(),
      relationDeclarations: [],
      relationIssues: [],
    };
  }
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(source, {
      lineCounter,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error("the YAML parser reported an error");
    }
    if (document.contents === null) {
      return {
        metadata: emptyMetadata(),
        relationDeclarations: [],
        relationIssues: [],
      };
    }
    const parsed: unknown = document.toJS({ mapAsMap: false, maxAliasCount: 50 });
    const metadata = metadataObjectFromUnknown(parsed);
    if (metadata === null) throw new Error("the YAML document is not a JSON-like object");
    return {
      metadata,
      ...parsedRelations(document.contents, path, lineCounter),
    };
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter in ${path}.`, { cause: error });
  }
}

function metadataProperty(
  metadata: MetadataObject,
  name: string,
): MetadataValue | undefined {
  if (Object.hasOwn(metadata, name)) return metadata[name];
  const lowerName = name.toLocaleLowerCase("en-US");
  const matches = Object.keys(metadata).filter(
    (key) => key.toLocaleLowerCase("en-US") === lowerName,
  );
  return matches.length === 1 ? metadata[matches[0] ?? ""] : undefined;
}

function normalizedTags(metadata: MetadataObject): readonly string[] {
  const value = metadataProperty(metadata, "tags");
  const candidates = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((candidate): candidate is string => typeof candidate === "string")
      : [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const tag = candidate.trim().replace(/^#+/u, "").normalize("NFC").toLocaleLowerCase("en-US");
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export const normalizeVaultPath = (path: string): string =>
  posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");

const withoutMarkdownExtension = (path: string): string =>
  path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;

function legacyPropertyValue(value: MetadataValue): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return undefined;
}

function aliasesFromMetadata(metadata: MetadataObject): readonly string[] {
  const value = metadataProperty(metadata, "aliases");
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim() !== "");
}

function frontmatterOf(content: string, path: string): Frontmatter {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {
      values: new Map(),
      aliases: [],
      tags: [],
      metadata: emptyMetadata(),
      relationDeclarations: [],
      relationIssues: [],
    };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new Error(`Invalid YAML frontmatter in ${path}: missing closing delimiter.`);
  }

  const parsed = parseMetadata(lines.slice(1, end).join("\n"), path);
  const metadata = parsed.metadata;

  const values = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (const [authoredKey, typedValue] of Object.entries(metadata)) {
    const key = authoredKey.toLocaleLowerCase("en-US");
    if (seenKeys.has(key)) {
      throw new Error(`Invalid YAML frontmatter in ${path}: keys must not differ only by case.`);
    }
    seenKeys.add(key);
    if (key === "aliases") continue;
    const value = legacyPropertyValue(typedValue);
    if (value !== undefined && value !== "") values.set(key, value);
  }
  return {
    values,
    aliases: aliasesFromMetadata(metadata),
    tags: normalizedTags(metadata),
    metadata,
    relationDeclarations: parsed.relationDeclarations,
    relationIssues: parsed.relationIssues,
  };
}

/**
 * Blank frontmatter, fenced code, inline code, and HTML comments while
 * preserving newlines so diagnostic line numbers remain stable.
 */
export function searchableMarkdown(content: string): string {
  const lines = content.split("\n");
  let inFrontmatter = lines[0]?.trim() === "---";
  let inFence: { readonly character: string; readonly length: number } | null = null;
  let inComment = false;

  const blockMasked = lines.map((line, index) => {
    if (inFrontmatter) {
      if (index > 0 && line.trim() === "---") inFrontmatter = false;
      return "";
    }

    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (inFence !== null) {
      const delimiter = /^\s{0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (
        delimiter !== undefined
        && delimiter[0] === inFence.character
        && delimiter.length >= inFence.length
      ) inFence = null;
      return "";
    }
    const openingDelimiter = fence?.[1];
    const openingRemainder = fence === null ? "" : line.slice(fence[0].length);
    if (
      openingDelimiter !== undefined
      && (openingDelimiter[0] === "~" || !openingRemainder.includes("`"))
    ) {
      const delimiter = openingDelimiter;
      inFence = { character: delimiter[0] ?? "`", length: delimiter.length };
      return "";
    }

    if (/^(?: {4,}|\t)/u.test(line)) return "";

    let output = line;
    if (inComment) {
      const close = output.indexOf("-->");
      if (close === -1) return "";
      output = output.slice(close + 3);
      inComment = false;
    }
    for (;;) {
      const open = output.indexOf("<!--");
      if (open === -1) break;
      const close = output.indexOf("-->", open + 4);
      if (close === -1) {
        output = output.slice(0, open);
        inComment = true;
        break;
      }
      output = output.slice(0, open) + output.slice(close + 3);
    }
    return output;
  }).join("\n");
  return maskInlineCodeBlocks(maskHtmlCodeBlocks(blockMasked));
}

type BacktickRun = {
  readonly start: number;
  readonly end: number;
  readonly length: number;
};

function maskInlineCodeSpans(value: string): string {
  const runs: BacktickRun[] = [];
  for (let index = 0; index < value.length;) {
    if (value[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (value[index] === "`") index += 1;
    let precedingBackslashes = 0;
    for (let before = start - 1; before >= 0 && value[before] === "\\"; before -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1) continue;
    runs.push({ start, end: index, length: index - start });
  }

  const remaining = new Map<number, number>();
  for (const run of runs) remaining.set(run.length, (remaining.get(run.length) ?? 0) + 1);
  const output: string[] = [];
  let cursor = 0;
  let delimiterLength: number | null = null;
  const appendSegment = (segment: string): void => {
    output.push(delimiterLength === null ? segment : segment.replace(/[^\n]/gu, ""));
  };
  for (const run of runs) {
    appendSegment(value.slice(cursor, run.start));
    remaining.set(run.length, (remaining.get(run.length) ?? 1) - 1);
    if (delimiterLength === null) {
      if ((remaining.get(run.length) ?? 0) > 0) delimiterLength = run.length;
      else output.push(value.slice(run.start, run.end));
    } else if (run.length === delimiterLength) {
      delimiterLength = null;
    }
    cursor = run.end;
  }
  appendSegment(value.slice(cursor));
  return output.join("");
}

function maskInlineCodeBlocks(value: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    output.push(...maskInlineCodeSpans(paragraph.join("\n")).split("\n"));
    paragraph = [];
  };
  const startsIndependentBlock = (line: string): boolean =>
    /^\s{0,3}(?:#{1,6}(?:\s|$)|>|(?:[-+*]|\d+[.)])\s+)/u.test(line);

  for (const line of value.split("\n")) {
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
  return output.join("\n");
}

function maskHtmlCodeBlocks(value: string): string {
  const tagPattern = /<\/?(pre|code|script|style)\b[^>]*>/giu;
  const output: string[] = [];
  let cursor = 0;
  let activeTag: string | null = null;
  let depth = 0;
  const append = (segment: string): void => {
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
      if (closing) depth -= 1;
      else depth += 1;
      if (depth === 0) activeTag = null;
    }
    output.push(match[0].replace(/[^\n]/gu, ""));
    cursor = start + match[0].length;
  }
  append(value.slice(cursor));
  return output.join("");
}

function markdownText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|([^\]]+))?\]\]/g, (_whole, target: string, label: string | undefined) =>
      label ?? posix.basename(target))
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstHeading(searchable: string): string | null {
  for (const line of searchable.split("\n")) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading !== null) return markdownText(heading[1] ?? "");
  }
  return null;
}

function firstParagraph(searchable: string): string {
  const paragraphs = searchable.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        line !== ""
        && !line.startsWith("#")
        && !line.startsWith("- ")
        && !line.startsWith("* ")
        && !line.startsWith("|")
        && !line.startsWith(">"));
    const text = markdownText(lines.join(" "));
    if (text !== "") return text;
  }
  return "";
}

function concise(value: string, limit = 180): string {
  const text = markdownText(value);
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit + 1);
  const lastSpace = prefix.lastIndexOf(" ");
  return (lastSpace >= Math.floor(limit * 0.65) ? prefix.slice(0, lastSpace) : text.slice(0, limit)).trimEnd() + "…";
}

export function wikiLinks(searchable: string): readonly WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of searchable.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const offset = match.index ?? 0;
    let precedingBackslashes = 0;
    for (let before = offset - 1; before >= 0 && searchable[before] === "\\"; before -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1) continue;
    const inside = match[2] ?? "";
    const separator = inside.indexOf("|");
    const target = (separator === -1 ? inside : inside.slice(0, separator)).trim();
    links.push({
      target,
      line: searchable.slice(0, offset).split("\n").length,
      embedded: (match[1] ?? "") === "!",
    });
  }
  return links;
}

export function parseNote(path: string, content: string): Note {
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
    relationIssues: metadata.relationIssues,
  };
}

type LinkResolution =
  | { kind: "note"; id: string }
  | { kind: "attachment" }
  | { kind: "broken" }
  | { kind: "ambiguous"; candidates: readonly string[] };

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function lookupNote(notes: readonly Note[], query: string): NoteLookupResult {
  const trimmed = decoded(query.trim()).replaceAll("\\", "/").replace(/^\/+/, "");
  if (trimmed === "") return { kind: "missing", query };

  const queryId = withoutMarkdownExtension(normalizeVaultPath(trimmed));
  const exact = notes.find((note) => note.id === queryId);
  if (exact !== undefined) return { kind: "found", note: exact };

  const lowerQueryId = queryId.toLocaleLowerCase("en-US");
  const idMatches = notes.filter((note) => note.id.toLocaleLowerCase("en-US") === lowerQueryId);
  const onlyIdMatch = idMatches.length === 1 ? idMatches[0] : undefined;
  if (onlyIdMatch !== undefined) return { kind: "found", note: onlyIdMatch };
  if (idMatches.length > 1) {
    return {
      kind: "ambiguous",
      query,
      candidates: idMatches.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  }

  const lowerLabel = query.trim().toLocaleLowerCase("en-US");
  const lowerBasename = posix.basename(queryId).toLocaleLowerCase("en-US");
  const candidates = notes.filter((note) => {
    const labels = [posix.basename(note.id), note.title, ...note.aliases]
      .map((value) => value.toLocaleLowerCase("en-US"));
    return labels.includes(lowerLabel) || labels.includes(lowerBasename);
  }).toSorted((left, right) => left.path.localeCompare(right.path));

  const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
  if (onlyCandidate !== undefined) return { kind: "found", note: onlyCandidate };
  if (candidates.length > 1) return { kind: "ambiguous", query, candidates };
  return { kind: "missing", query };
}

function resolveTarget(
  source: Note,
  rawTarget: string,
  byId: ReadonlyMap<string, Note>,
  byBasename: ReadonlyMap<string, readonly string[]>,
): LinkResolution {
  const targetWithoutAnchor = rawTarget.split("#", 1)[0]?.split("^", 1)[0]?.trim() ?? "";
  if (targetWithoutAnchor === "") return { kind: "note", id: source.id };

  let target = decoded(targetWithoutAnchor).replaceAll("\\", "/");
  const extension = posix.extname(target).toLowerCase();
  if (extension !== "" && extension !== ".md") return { kind: "attachment" };
  target = withoutMarkdownExtension(target).replace(/^\//, "");

  if (target.startsWith(".")) {
    const relativeTarget = posix.normalize(posix.join(posix.dirname(source.id), target));
    return byId.has(relativeTarget) ? { kind: "note", id: relativeTarget } : { kind: "broken" };
  }

  if (byId.has(target)) return { kind: "note", id: target };
  if (target.includes("/")) return { kind: "broken" };

  const candidates = byBasename.get(target) ?? [];
  if (candidates.length === 1) return { kind: "note", id: candidates[0] ?? target };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "broken" };
}

const pairKey = (left: string, right: string): string =>
  left.localeCompare(right) <= 0 ? `${left}\0${right}` : `${right}\0${left}`;

function compareAuthoredRelations(
  left: AuthoredRelation,
  right: AuthoredRelation,
): number {
  return left.source.localeCompare(right.source)
    || left.predicate.localeCompare(right.predicate)
    || left.target.localeCompare(right.target)
    || left.provenance.line - right.provenance.line
    || left.provenance.authoredTarget.localeCompare(right.provenance.authoredTarget);
}

function compareRelationIssues(left: RelationIssue, right: RelationIssue): number {
  const predicateComparison = (left.predicate ?? "").localeCompare(right.predicate ?? "");
  const targetComparison = (left.target ?? "").localeCompare(right.target ?? "");
  return left.source.localeCompare(right.source)
    || left.line - right.line
    || left.kind.localeCompare(right.kind)
    || predicateComparison
    || targetComparison;
}

const wordCharacter = (value: string): boolean => /[A-Za-z0-9]/.test(value);

function phraseOffset(lowerHaystack: string, lowerPhrase: string): number {
  let offset = lowerHaystack.indexOf(lowerPhrase);
  while (offset !== -1) {
    const before = offset === 0 ? "" : lowerHaystack[offset - 1] ?? "";
    const afterIndex = offset + lowerPhrase.length;
    const after = afterIndex >= lowerHaystack.length ? "" : lowerHaystack[afterIndex] ?? "";
    const startsClean = !wordCharacter(lowerPhrase[0] ?? "") || !wordCharacter(before);
    const endsClean = !wordCharacter(lowerPhrase.at(-1) ?? "") || !wordCharacter(after);
    if (startsClean && endsClean) return offset;
    offset = lowerHaystack.indexOf(lowerPhrase, offset + 1);
  }
  return -1;
}

function candidatePhrases(note: Note): readonly string[] {
  const values = [note.title, ...note.aliases]
    .map((value) => value.trim())
    .filter((value) => value.length >= 4 && /[A-Za-z]/.test(value));
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

type UniquePhrase = {
  readonly phrase: string;
  readonly lowerPhrase: string;
};

function uniquePhrasesByTarget(notes: readonly Note[]): ReadonlyMap<string, readonly UniquePhrase[]> {
  const ownersByPhrase = new Map<string, Map<string, string>>();
  for (const note of notes) {
    for (const phrase of candidatePhrases(note)) {
      const lowerPhrase = phrase.toLocaleLowerCase("en-US");
      const owners = ownersByPhrase.get(lowerPhrase) ?? new Map<string, string>();
      if (!owners.has(note.id)) owners.set(note.id, phrase);
      ownersByPhrase.set(lowerPhrase, owners);
    }
  }

  const phrasesByTarget = new Map<string, UniquePhrase[]>();
  for (const [lowerPhrase, owners] of ownersByPhrase) {
    if (owners.size !== 1) continue;
    const owner = owners.entries().next().value;
    if (owner === undefined) continue;
    const [targetId, phrase] = owner;
    const phrases = phrasesByTarget.get(targetId) ?? [];
    phrases.push({ phrase, lowerPhrase });
    phrasesByTarget.set(targetId, phrases);
  }
  for (const phrases of phrasesByTarget.values()) {
    phrases.sort((left, right) =>
      right.lowerPhrase.length - left.lowerPhrase.length
      || left.lowerPhrase.localeCompare(right.lowerPhrase));
  }
  return phrasesByTarget;
}

function checkedAnalysisLimit(
  value: number | undefined,
  hardMaximum: number,
  option:
    | "maxNotes"
    | "maxConnectionObservations"
    | "maxMentionPairs"
    | "maxMentions",
): number {
  const limit = value ?? hardMaximum;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > hardMaximum) {
    throw new RangeError(
      `${option} must be a safe integer from 0 through ${hardMaximum}.`,
    );
  }
  return limit;
}

export function analyzeVault(
  notes: readonly Note[],
  options: AnalyzeVaultOptions = {},
): VaultAnalysis {
  const maxNotes = checkedAnalysisLimit(
    options.maxNotes,
    MAX_ANALYZED_NOTES,
    "maxNotes",
  );
  const maxMentionPairs = checkedAnalysisLimit(
    options.maxMentionPairs,
    MAX_MENTION_PAIRS,
    "maxMentionPairs",
  );
  const maxMentions = checkedAnalysisLimit(
    options.maxMentions,
    MAX_MENTIONS,
    "maxMentions",
  );
  const maxConnectionObservations = checkedAnalysisLimit(
    options.maxConnectionObservations,
    MAX_CONNECTION_OBSERVATIONS,
    "maxConnectionObservations",
  );
  if (notes.length > maxNotes) {
    throw new VaultAnalysisBudgetError(
      "notes",
      maxNotes,
      `Vault analysis exceeds the ${maxNotes} note limit.`,
    );
  }
  const catalogNoteId = withoutMarkdownExtension(
    normalizeVaultPath(options.catalogNoteId ?? "index"),
  );
  const byId = new Map(notes.map((note) => [note.id, note]));
  const byBasename = new Map<string, string[]>();
  for (const note of notes) {
    const basename = posix.basename(note.id);
    const matches = byBasename.get(basename) ?? [];
    matches.push(note.id);
    byBasename.set(basename, matches);
  }
  for (const matches of byBasename.values()) matches.sort();

  let connectionObservations = 0;
  const observeConnection = (): void => {
    if (connectionObservations >= maxConnectionObservations) {
      throw new VaultAnalysisBudgetError(
        "connection-observations",
        maxConnectionObservations,
        `Vault analysis exceeds the ${maxConnectionObservations} `
          + "connection-observation limit.",
      );
    }
    connectionObservations += 1;
  };

  const issues: LinkIssue[] = [];
  const relationIssues: RelationIssue[] = [];
  for (const note of notes) {
    for (const issue of note.relationIssues ?? []) {
      observeConnection();
      relationIssues.push(issue);
    }
  }
  const contextualLinks: ResolvedLink[] = [];
  const edgeKeys = new Set<string>();
  for (const source of notes) {
    for (const link of source.links) {
      observeConnection();
      const resolution = resolveTarget(source, link.target, byId, byBasename);
      if (resolution.kind === "attachment") continue;
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
          candidates: resolution.candidates,
        });
        continue;
      }
      if (
        source.id === catalogNoteId
        || resolution.id === catalogNoteId
        || source.id === resolution.id
      ) continue;
      const edgeKey = `${source.id}\0${resolution.id}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      contextualLinks.push({ source: source.path, target: `${resolution.id}.md`, line: link.line });
    }
  }

  const authoredRelations: AuthoredRelation[] = [];
  const declarationKeys = new Set<string>();
  const relationEdgeKeys = new Set<string>();
  for (const source of notes) {
    const declarations: RelationDeclaration[] = [];
    for (const declaration of source.relationDeclarations ?? []) {
      observeConnection();
      declarations.push(declaration);
    }
    declarations.sort((left, right) =>
      left.line - right.line
      || left.predicate.localeCompare(right.predicate)
      || left.target.localeCompare(right.target));
    for (const declaration of declarations) {
      const declarationKey = `${source.id}\0${declaration.predicate}\0${declaration.target}`;
      if (declarationKeys.has(declarationKey)) continue;
      declarationKeys.add(declarationKey);

      const exactTarget = byId.get(declaration.target);
      if (exactTarget === undefined) {
        const basenameMatches = declaration.target.includes("/")
          ? []
          : (byBasename.get(declaration.target) ?? [])
            .filter((candidate) => candidate !== declaration.target);
        if (basenameMatches.length > 0) {
          relationIssues.push(malformedRelation(
            source.path,
            declaration.line,
            `Relation "${declaration.predicate}" target `
              + `${JSON.stringify(declaration.target)} is only a basename; `
              + "store the exact vault-root note ID.",
            {
              predicate: declaration.predicate,
              target: declaration.target,
            },
          ));
          continue;
        }
        relationIssues.push({
          kind: "broken",
          source: source.path,
          line: declaration.line,
          predicate: declaration.predicate,
          target: declaration.target,
        });
        continue;
      }
      if (source.id === catalogNoteId || exactTarget.id === catalogNoteId) continue;

      const edgeKey = `${source.id}\0${declaration.predicate}\0${exactTarget.id}`;
      if (relationEdgeKeys.has(edgeKey)) continue;
      relationEdgeKeys.add(edgeKey);
      authoredRelations.push({
        source: source.id,
        target: exactTarget.id,
        predicate: declaration.predicate,
        provenance: {
          kind: "frontmatter",
          source: source.path,
          line: declaration.line,
          authoredTarget: declaration.target,
        },
      });
    }
  }

  const sortedContextualLinks = contextualLinks.toSorted((left, right) =>
    left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.line - right.line);
  const sortedAuthoredRelations = authoredRelations.toSorted(compareAuthoredRelations);
  const backlinks = sortedContextualLinks.toSorted((left, right) =>
    left.target.localeCompare(right.target)
    || left.source.localeCompare(right.source)
    || left.line - right.line);
  const contentNotes = notes.filter((note) => note.id !== catalogNoteId);
  const connected = new Set<string>();
  const linkedPairs = new Set<string>();
  const inboundById = new Map<string, Backlink[]>();
  const outboundById = new Map<string, number>();
  const inboundRelationsById = new Map<string, AuthoredRelation[]>();
  const outboundRelationsById = new Map<string, number>();
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
    outboundRelationsById.set(
      relation.source,
      (outboundRelationsById.get(relation.source) ?? 0) + 1,
    );
  }

  const includeInSuggestions = options.includeInSuggestions ?? (() => true);
  const suggestionNotes = contentNotes.filter(includeInSuggestions);
  const scopedMentionNotes = options.mentionScope === undefined
    ? suggestionNotes
    : suggestionNotes.filter(options.mentionScope);
  const scopedMentionIds = new Set(scopedMentionNotes.map((note) => note.id));
  const phrasesByTarget = scopedMentionNotes.length === 0
    ? new Map<string, readonly UniquePhrase[]>()
    : uniquePhrasesByTarget(suggestionNotes);
  const mentions: MentionCandidate[] = [];
  let mentionPairs = 0;
  for (const source of suggestionNotes) {
    const targets = options.mentionScope === undefined
      || scopedMentionIds.has(source.id)
      ? suggestionNotes
      : scopedMentionNotes;
    let lowerSearchableText: string | undefined;
    for (const target of targets) {
      if (source.id === target.id) continue;
      if (mentionPairs >= maxMentionPairs) {
        throw new VaultAnalysisBudgetError(
          "mention-pairs",
          maxMentionPairs,
          `Vault analysis exceeds the ${maxMentionPairs} mention-pair limit.`,
        );
      }
      mentionPairs += 1;
      if (linkedPairs.has(pairKey(source.id, target.id))) continue;
      lowerSearchableText ??= source.searchableText.toLocaleLowerCase("en-US");
      for (const { phrase, lowerPhrase } of phrasesByTarget.get(target.id) ?? []) {
        const offset = phraseOffset(lowerSearchableText, lowerPhrase);
        if (offset === -1) continue;
        if (mentions.length >= maxMentions) {
          throw new VaultAnalysisBudgetError(
            "mentions",
            maxMentions,
            `Vault analysis exceeds the ${maxMentions} mention limit.`,
          );
        }
        mentions.push({
          source: source.path,
          line: source.searchableText.slice(0, offset).split("\n").length,
          target: target.path,
          phrase,
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
    noteConnections: contentNotes
      .map((note): NoteConnections => ({
        id: note.id,
        path: note.path,
        inboundContextualCount: inboundById.get(note.id)?.length ?? 0,
        outboundContextualCount: outboundById.get(note.id) ?? 0,
        backlinks: inboundById.get(note.id) ?? [],
        inboundRelationCount: inboundRelationsById.get(note.id)?.length ?? 0,
        outboundRelationCount: outboundRelationsById.get(note.id) ?? 0,
        relationBacklinks: inboundRelationsById.get(note.id) ?? [],
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    issues: issues.sort((left, right) =>
      left.source.localeCompare(right.source) || left.line - right.line || left.target.localeCompare(right.target)),
    relationIssues: relationIssues.toSorted(compareRelationIssues),
    orphans: suggestionNotes
      .filter((note) => !connected.has(note.id))
      .map((note) => note.path)
      .sort(),
    mentions: mentions.sort((left, right) =>
      left.source.localeCompare(right.source) || left.line - right.line || left.target.localeCompare(right.target)),
  };
}

const sectionTitle = (directory: string): string =>
  directory
    .split("-")
    .map((part) => part === "" ? "" : (part[0]?.toUpperCase() ?? "") + part.slice(1))
    .join(" ");

function safeCatalogCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x2028 && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ? " "
    : character;
}

function safeCatalogText(value: string, limit: number): string {
  return [...concise(value, limit)]
    .map(safeCatalogCharacter)
    .join("")
    .replaceAll("<!--", "‹!--")
    .replaceAll("-->", "--›")
    .replaceAll("|", " — ")
    .replaceAll("]]", "]")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeWikiTarget(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function renderCatalog(
  notes: readonly Note[],
  catalogNoteId = "index",
): string {
  const normalizedCatalogNoteId = withoutMarkdownExtension(
    normalizeVaultPath(catalogNoteId),
  );
  const groups = new Map<string, Note[]>();
  for (const note of notes.filter((candidate) => candidate.id !== normalizedCatalogNoteId)) {
    const directory = note.id.includes("/") ? note.id.split("/", 1)[0] ?? "Notes" : "Notes";
    const group = groups.get(directory) ?? [];
    group.push(note);
    groups.set(directory, group);
  }

  const lines = [catalogStart, "## Note catalog", ""];
  if (groups.size === 0) {
    lines.push("_No durable notes have been filed yet._", "", catalogEnd);
    return lines.join("\n");
  }

  for (const [directory, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${safeCatalogText(sectionTitle(directory), 120) || "Notes"}`, "");
    for (const note of group.sort((left, right) =>
      left.title.localeCompare(right.title) || left.id.localeCompare(right.id))) {
      const details = [
        note.properties.type === "plan" && note.properties.status !== undefined
          ? `Status: ${safeCatalogText(note.properties.status, 60)}.`
          : "",
        safeCatalogText(note.summary, 180),
      ].filter((value) => value !== "").join(" ");
      const suffix = details === "" ? "" : ` — ${details}`;
      const label = safeCatalogText(note.title, 240)
        || safeCatalogText(posix.basename(note.id), 240)
        || "Untitled";
      lines.push(`- [[${safeWikiTarget(note.id)}|${label}]]${suffix}`);
    }
    lines.push("");
  }
  lines.push(catalogEnd);
  return lines.join("\n");
}

export function replaceCatalog(indexContent: string, catalog: string): string {
  const start = indexContent.indexOf(catalogStart);
  const end = indexContent.indexOf(catalogEnd);
  if (start === -1 && end === -1) return indexContent.trimEnd() + "\n\n" + catalog + "\n";
  if (start === -1 || end === -1 || end < start) {
    throw new Error("kb/index.md has a malformed managed catalog boundary");
  }
  if (indexContent.indexOf(catalogStart, start + catalogStart.length) !== -1
    || indexContent.indexOf(catalogEnd, end + catalogEnd.length) !== -1) {
    throw new Error("kb/index.md has duplicate managed catalog boundaries");
  }
  return indexContent.slice(0, start) + catalog + indexContent.slice(end + catalogEnd.length);
}
