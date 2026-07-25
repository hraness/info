import { posix } from "node:path";
import { parseDocument } from "yaml";

export const catalogStart = "<!-- oh:catalog:start -->";
export const catalogEnd = "<!-- oh:catalog:end -->";

export type WikiLink = {
  target: string;
  line: number;
  embedded: boolean;
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
};

export type NoteLookupResult =
  | { kind: "found"; note: Note }
  | { kind: "ambiguous"; query: string; candidates: readonly Note[] }
  | { kind: "missing"; query: string };

export type AnalyzeVaultOptions = {
  includeInSuggestions?: (note: Note) => boolean;
  /** Vault-relative path of the generated navigation catalog. */
  catalogNoteId?: string;
};

export type VaultAnalysis = {
  noteCount: number;
  contextualLinks: readonly ResolvedLink[];
  backlinks: readonly Backlink[];
  noteConnections: readonly NoteConnections[];
  issues: readonly LinkIssue[];
  orphans: readonly string[];
  mentions: readonly MentionCandidate[];
};

type Frontmatter = {
  values: ReadonlyMap<string, string>;
  aliases: readonly string[];
  tags: readonly string[];
  metadata: MetadataObject;
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

function parseMetadata(source: string, path: string): MetadataObject {
  if (source.trim() === "") return emptyMetadata();
  try {
    const document = parseDocument(source, {
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error("the YAML parser reported an error");
    }
    if (document.contents === null) return emptyMetadata();
    const parsed: unknown = document.toJS({ mapAsMap: false, maxAliasCount: 50 });
    const metadata = metadataObjectFromUnknown(parsed);
    if (metadata === null) throw new Error("the YAML document is not a JSON-like object");
    return metadata;
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
    };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new Error(`Invalid YAML frontmatter in ${path}: missing closing delimiter.`);
  }

  const metadata = parseMetadata(lines.slice(1, end).join("\n"), path);

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

export function analyzeVault(
  notes: readonly Note[],
  options: AnalyzeVaultOptions = {},
): VaultAnalysis {
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

  const issues: LinkIssue[] = [];
  const contextualLinks: ResolvedLink[] = [];
  const edgeKeys = new Set<string>();
  for (const source of notes) {
    for (const link of source.links) {
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

  const sortedContextualLinks = contextualLinks.toSorted((left, right) =>
    left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.line - right.line);
  const backlinks = sortedContextualLinks.toSorted((left, right) =>
    left.target.localeCompare(right.target)
    || left.source.localeCompare(right.source)
    || left.line - right.line);
  const contentNotes = notes.filter((note) => note.id !== catalogNoteId);
  const connected = new Set<string>();
  const linkedPairs = new Set<string>();
  const inboundById = new Map<string, Backlink[]>();
  const outboundById = new Map<string, number>();
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

  const includeInSuggestions = options.includeInSuggestions ?? (() => true);
  const suggestionNotes = contentNotes.filter(includeInSuggestions);
  const phrasesByTarget = uniquePhrasesByTarget(suggestionNotes);
  const mentions: MentionCandidate[] = [];
  for (const source of suggestionNotes) {
    const lowerSearchableText = source.searchableText.toLocaleLowerCase("en-US");
    for (const target of suggestionNotes) {
      if (source.id === target.id || linkedPairs.has(pairKey(source.id, target.id))) continue;
      for (const { phrase, lowerPhrase } of phrasesByTarget.get(target.id) ?? []) {
        const offset = phraseOffset(lowerSearchableText, lowerPhrase);
        if (offset === -1) continue;
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
    noteConnections: contentNotes
      .map((note): NoteConnections => ({
        id: note.id,
        path: note.path,
        inboundContextualCount: inboundById.get(note.id)?.length ?? 0,
        outboundContextualCount: outboundById.get(note.id) ?? 0,
        backlinks: inboundById.get(note.id) ?? [],
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    issues: issues.sort((left, right) =>
      left.source.localeCompare(right.source) || left.line - right.line || left.target.localeCompare(right.target)),
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
    throw new Error("oh/index.md has a malformed managed catalog boundary");
  }
  if (indexContent.indexOf(catalogStart, start + catalogStart.length) !== -1
    || indexContent.indexOf(catalogEnd, end + catalogEnd.length) !== -1) {
    throw new Error("oh/index.md has duplicate managed catalog boundaries");
  }
  return indexContent.slice(0, start) + catalog + indexContent.slice(end + catalogEnd.length);
}
