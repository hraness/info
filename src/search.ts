import type {
  AuthoredRelation,
  Note,
  ResolvedLink,
  VaultAnalysis,
} from "./graph.js";
import { lookupNote } from "./graph.js";
import { navigateLinks } from "./navigation.js";
import {
  queryVault,
  type MetadataFilter,
} from "./query.js";

const MAX_EXACT_RESULTS = 500;
export const MAX_SEARCH_QUERY_BYTES = 16 * 1_024;
export const MAX_SEARCH_QUERY_TERMS = 64;
const MAX_FUSION_LANES = 16;
const MAX_FUSION_RESULTS_PER_LANE = 500;
const MAX_RELATED_SEEDS = 10;
const MAX_RELATED_RESULTS = 100;
const MAX_GRAPH_CONNECTIONS_PER_KIND = 200;
const MAX_GRAPH_EVIDENCE_PER_RESULT = 40;

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "why",
  "with",
]);

export type ExactMatchField =
  | "alias"
  | "content"
  | "metadata"
  | "path"
  | "tag"
  | "title";

export type ExactMatchEvidence = {
  readonly kind: "identity" | "phrase" | "term";
  readonly field: ExactMatchField;
  readonly value: string;
};

export type ExactSearchHit = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly identity: boolean;
  /** A deterministic lane-local score used only to establish exact-search rank. */
  readonly score: number;
  readonly line?: number;
  readonly snippet: string;
  readonly matches: readonly ExactMatchEvidence[];
};

export type ExactSearchOptions = {
  readonly query: string;
  readonly filters?: readonly MetadataFilter[];
  readonly tags?: readonly string[];
  readonly limit?: number;
};

export type ValidatedSearchQuery = {
  /** Trimmed, original-casing query passed to retrieval backends. */
  readonly query: string;
  /** NFC-normalized query used for deterministic exact matching. */
  readonly normalized: string;
  /** Unique normalized terms used by exact matching. */
  readonly terms: readonly string[];
};

export type FusionLaneName = string;

export type FusionLane = {
  readonly name: FusionLaneName;
  readonly weight: number;
  readonly ids: readonly string[];
};

export type FusionContribution = {
  readonly lane: FusionLaneName;
  readonly rank: number;
  readonly weight: number;
  readonly value: number;
};

export type FusedCandidate = {
  readonly id: string;
  readonly rank: number;
  /** Normalized weighted reciprocal-rank score. It is not a probability. */
  readonly score: number;
  readonly contributions: readonly FusionContribution[];
};

export type GraphContextEvidence =
  | {
      readonly kind: "link";
      readonly seed: string;
      readonly seedRank: number;
      readonly distance: number;
      readonly source: string;
      readonly target: string;
      readonly line: number;
    }
  | {
      readonly kind: "relation";
      readonly seed: string;
      readonly seedRank: number;
      readonly distance: number;
      readonly source: string;
      readonly target: string;
      readonly predicate: string;
      readonly line: number;
    };

export type RelatedContextHit = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly distance: number;
  readonly evidence: readonly GraphContextEvidence[];
};

export type GraphContext = {
  readonly seeds: readonly string[];
  readonly linksAmongResults: readonly ResolvedLink[];
  readonly relationsAmongResults: readonly AuthoredRelation[];
  readonly related: readonly RelatedContextHit[];
  readonly truncated: boolean;
};

export type GraphContextOptions = {
  readonly seeds: readonly string[];
  readonly primaryIds: readonly string[];
  readonly depth?: number;
  readonly neighborsPerSeed?: number;
  readonly limit?: number;
};

function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function checkedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return limit;
}

/** Validate one bounded query before exact scanning or local-model work begins. */
export function validateSearchQuery(value: unknown): ValidatedSearchQuery {
  if (typeof value !== "string") {
    throw new TypeError("Search query must be a string.");
  }
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > MAX_SEARCH_QUERY_BYTES) {
      throw new RangeError(
        `Search query must be at most ${MAX_SEARCH_QUERY_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
      );
    }
  }
  const query = value.trim();
  if (query === "") throw new Error("Search query must not be empty.");
  const normalized = normalize(query);
  const unique = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) {
    const term = match[0];
    unique.add(term);
    if (unique.size > MAX_SEARCH_QUERY_TERMS) {
      throw new RangeError(
        `Search query may contain at most ${MAX_SEARCH_QUERY_TERMS} unique normalized terms.`,
      );
    }
  }
  const raw = [...unique];
  const meaningful = raw.filter((term) => term.length > 1 && !stopWords.has(term));
  return {
    query,
    normalized,
    terms: meaningful.length > 0 ? meaningful : raw,
  };
}

function occurrenceCount(text: string, needle: string, maximum = 8): number {
  if (needle === "") return 0;
  let count = 0;
  let offset = 0;
  while (count < maximum) {
    const found = text.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}

type ExactMatchLocation = {
  readonly offset: number;
  readonly line: number;
};

function originalLineOffset(
  line: string,
  normalizedOffset: number,
): number {
  let consumed = 0;
  for (const part of new Intl.Segmenter("en-US", {
    granularity: "grapheme",
  }).segment(line)) {
    const width = normalize(part.segment).length;
    if (consumed + width > normalizedOffset) return part.index;
    consumed += width;
  }
  return line.length;
}

function firstMatchLocation(
  content: string,
  phrase: string,
  terms: readonly string[],
): ExactMatchLocation | null {
  const normalized = normalize(content);
  let normalizedOffset = normalized.indexOf(phrase);
  if (normalizedOffset < 0) {
    for (const term of terms) {
      normalizedOffset = normalized.indexOf(term);
      if (normalizedOffset >= 0) break;
    }
  }
  if (normalizedOffset < 0) return null;

  const normalizedPrefix = normalized.slice(0, normalizedOffset);
  const line = normalizedPrefix.split("\n").length;
  const normalizedLineStart = normalizedPrefix.lastIndexOf("\n") + 1;
  let lineStart = 0;
  for (let current = 1; current < line; current += 1) {
    lineStart = content.indexOf("\n", lineStart) + 1;
  }
  const lineEnd = content.indexOf("\n", lineStart);
  const originalLine = content.slice(
    lineStart,
    lineEnd < 0 ? content.length : lineEnd,
  );
  return {
    line,
    offset: lineStart + originalLineOffset(
      originalLine,
      normalizedOffset - normalizedLineStart,
    ),
  };
}

function exactSnippet(content: string, location: ExactMatchLocation | null, summary: string): {
  readonly line?: number;
  readonly snippet: string;
} {
  if (location === null) return { snippet: summary };
  const { line, offset } = location;
  const start = Math.max(0, offset - 180);
  const end = Math.min(content.length, start + 600);
  const snippet = content.slice(start, end).replace(/\s+/gu, " ").trim();
  return {
    line,
    snippet: `${start > 0 ? "…" : ""}${snippet}${end < content.length ? "…" : ""}`,
  };
}

function metadataText(note: Note): string {
  return normalize(JSON.stringify(note.metadata));
}

function pushEvidence(
  evidence: ExactMatchEvidence[],
  candidate: ExactMatchEvidence,
): void {
  if (evidence.length >= 12) return;
  if (evidence.some((item) =>
    item.kind === candidate.kind
    && item.field === candidate.field
    && item.value === candidate.value)) return;
  evidence.push(candidate);
}

function exactHit(
  note: Note,
  phrase: string,
  terms: readonly string[],
): ExactSearchHit | null {
  const title = normalize(note.title);
  const aliases = note.aliases.map(normalize);
  const path = normalize(note.path);
  const id = normalize(note.id);
  const tags = note.tags.map(normalize);
  const metadata = metadataText(note);
  const content = normalize(note.content);
  const matches: ExactMatchEvidence[] = [];
  let score = 0;
  let identity = false;
  let phraseMatched = false;

  if (title === phrase) {
    identity = true;
    score += 1_000;
    pushEvidence(matches, { kind: "identity", field: "title", value: note.title });
  }
  const exactAlias = note.aliases.find((_, index) => aliases[index] === phrase);
  if (exactAlias !== undefined) {
    identity = true;
    score += 950;
    pushEvidence(matches, { kind: "identity", field: "alias", value: exactAlias });
  }
  if (path === phrase || id === phrase) {
    identity = true;
    score += 900;
    pushEvidence(matches, { kind: "identity", field: "path", value: note.path });
  }

  const phraseFields: readonly [ExactMatchField, string, number][] = [
    ["title", title, 400],
    ["alias", aliases.join("\n"), 350],
    ["path", `${path}\n${id}`, 300],
    ["tag", tags.join("\n"), 250],
    ["content", content, 150],
    ["metadata", metadata, 100],
  ];
  for (const [field, value, weight] of phraseFields) {
    if (!value.includes(phrase)) continue;
    phraseMatched = true;
    score += weight;
    pushEvidence(matches, { kind: "phrase", field, value: phrase });
  }

  let matchedTerms = 0;
  for (const term of terms) {
    let matched = false;
    const termFields: readonly [ExactMatchField, string, number][] = [
      ["title", title, 40],
      ["alias", aliases.join("\n"), 35],
      ["path", `${path}\n${id}`, 30],
      ["tag", tags.join("\n"), 30],
      ["metadata", metadata, 10],
      ["content", content, 5],
    ];
    for (const [field, value, weight] of termFields) {
      if (occurrenceCount(value, term, 1) === 0) continue;
      matched = true;
      score += weight;
      pushEvidence(matches, { kind: "term", field, value: term });
    }
    if (matched) matchedTerms += 1;
  }
  const requiredTerms = terms.length <= 1
    ? terms.length
    : Math.min(3, Math.ceil(terms.length / 2));
  if (!identity && !phraseMatched && matchedTerms < requiredTerms) return null;
  if (terms.length > 0) score += Math.round((matchedTerms / terms.length) * 100);
  if (score === 0) return null;

  const snippet = exactSnippet(
    note.content,
    firstMatchLocation(note.content, phrase, terms),
    note.summary,
  );
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    identity,
    score,
    ...snippet,
    matches,
  };
}

/** Search the live Markdown snapshot for exact identities, phrases, and terms. */
export function searchExactVault(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  options: ExactSearchOptions,
): readonly ExactSearchHit[] {
  const validated = validateSearchQuery(options.query);
  const phrase = validated.normalized;
  const limit = checkedLimit(options.limit, 40, MAX_EXACT_RESULTS, "Exact search limit");
  const allowed = new Set(queryVault(notes, analysis, {
    filters: options.filters ?? [],
    tags: options.tags ?? [],
  }).map(({ id }) => id));
  const terms = validated.terms;
  return notes
    .filter((note) => allowed.has(note.id))
    .map((note) => exactHit(note, phrase, terms))
    .filter((hit): hit is ExactSearchHit => hit !== null)
    .toSorted((left, right) =>
      Number(right.identity) - Number(left.identity)
      || right.score - left.score
      || left.path.localeCompare(right.path))
    .slice(0, limit);
}

/** Fuse incomparable retrieval scores through deterministic weighted ranks. */
export function fuseRankedCandidates(
  lanes: readonly FusionLane[],
  k = 60,
): readonly FusedCandidate[] {
  if (!Number.isSafeInteger(k) || k < 1 || k > 1_000) {
    throw new RangeError("Fusion k must be an integer from 1 through 1000.");
  }
  if (lanes.length === 0 || lanes.length > MAX_FUSION_LANES) {
    throw new RangeError(
      `Fusion requires from 1 through ${MAX_FUSION_LANES} lanes.`,
    );
  }
  const names = new Set<string>();
  const active = lanes.filter(({ ids }) => ids.length > 0);
  let maximum = 0;
  const contributionsById = new Map<string, FusionContribution[]>();
  for (const lane of lanes) {
    if (lane.name.trim() === "" || names.has(lane.name)) {
      throw new Error("Fusion lane names must be non-empty and unique.");
    }
    names.add(lane.name);
    if (!Number.isFinite(lane.weight) || lane.weight <= 0 || lane.weight > 100) {
      throw new RangeError("Fusion lane weights must be greater than 0 and at most 100.");
    }
    if (lane.ids.length > MAX_FUSION_RESULTS_PER_LANE) {
      throw new RangeError(
        `Fusion lanes may contain at most ${MAX_FUSION_RESULTS_PER_LANE} results.`,
      );
    }
    if (lane.ids.length > 0) maximum += lane.weight / (k + 1);
    const seen = new Set<string>();
    for (const [index, id] of lane.ids.entries()) {
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      const rank = index + 1;
      const contribution: FusionContribution = {
        lane: lane.name,
        rank,
        weight: lane.weight,
        value: lane.weight / (k + rank),
      };
      const existing = contributionsById.get(id) ?? [];
      existing.push(contribution);
      contributionsById.set(id, existing);
    }
  }
  if (active.length === 0) return [];
  const ranked = [...contributionsById].map(([id, contributions]) => ({
    id,
    score: contributions.reduce((sum, item) => sum + item.value, 0) / maximum,
    contributions: contributions.toSorted((left, right) =>
      left.lane.localeCompare(right.lane)),
  })).toSorted((left, right) =>
    right.score - left.score || left.id.localeCompare(right.id));
  return ranked.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function graphEvidenceForCandidate(
  seed: string,
  seedRank: number,
  distance: number,
  candidatePath: string,
  links: readonly ResolvedLink[],
  relations: readonly AuthoredRelation[],
  notePathById: ReadonlyMap<string, string>,
): {
  readonly evidence: readonly GraphContextEvidence[];
  readonly truncated: boolean;
} {
  const evidence: GraphContextEvidence[] = [];
  for (const relation of relations) {
    const source = notePathById.get(relation.source);
    const target = notePathById.get(relation.target);
    if (source === undefined || target === undefined) continue;
    if (source !== candidatePath && target !== candidatePath) continue;
    evidence.push({
      kind: "relation",
      seed,
      seedRank,
      distance,
      source,
      target,
      predicate: relation.predicate,
      line: relation.provenance.line,
    });
  }
  for (const link of links) {
    if (link.source !== candidatePath && link.target !== candidatePath) continue;
    evidence.push({
      kind: "link",
      seed,
      seedRank,
      distance,
      source: link.source,
      target: link.target,
      line: link.line,
    });
  }
  const sorted = evidence.toSorted((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.line - right.line);
  return {
    evidence: sorted.slice(0, MAX_GRAPH_EVIDENCE_PER_RESULT),
    truncated: sorted.length > MAX_GRAPH_EVIDENCE_PER_RESULT,
  };
}

/** Expand explicit graph context without inserting neighbors into relevance rank. */
export function buildGraphContext(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  options: GraphContextOptions,
): GraphContext {
  const depth = checkedLimit(options.depth, 1, 2, "Graph context depth");
  const neighborsPerSeed = checkedLimit(
    options.neighborsPerSeed,
    3,
    20,
    "Graph neighbors per seed",
  );
  const limit = checkedLimit(
    options.limit,
    20,
    MAX_RELATED_RESULTS,
    "Graph context limit",
  );
  if (options.seeds.length > MAX_RELATED_SEEDS) {
    throw new RangeError(
      `Graph context accepts at most ${MAX_RELATED_SEEDS} seeds.`,
    );
  }
  if (options.primaryIds.length > MAX_RELATED_RESULTS) {
    throw new RangeError(
      `Graph context accepts at most ${MAX_RELATED_RESULTS} primary results.`,
    );
  }
  const primary = new Set(options.primaryIds);
  const notePathById = new Map(notes.map((note) => [note.id, note.path]));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const candidateById = new Map<string, {
    readonly note: Note;
    readonly evidence: GraphContextEvidence[];
    distance: number;
  }>();
  let truncated = false;
  const resolvedSeeds: string[] = [];

  for (const [seedIndex, requestedSeed] of options.seeds.entries()) {
    const lookup = lookupNote(notes, requestedSeed);
    if (lookup.kind === "missing") {
      throw new Error(
        `Graph context seed ${JSON.stringify(requestedSeed)} was not found.`,
      );
    }
    if (lookup.kind === "ambiguous") {
      throw new Error(
        `Graph context seed ${JSON.stringify(requestedSeed)} is ambiguous: `
          + lookup.candidates.map(({ path }) => path).join(", "),
      );
    }
    const seed = lookup.note;
    if (resolvedSeeds.includes(seed.id)) continue;
    resolvedSeeds.push(seed.id);
    const neighborhood = navigateLinks(notes, analysis, seed, {
      direction: "both",
      depth,
      limit: Math.min(1_000, limit + options.seeds.length + primary.size + 1),
    });
    truncated ||= neighborhood.truncated;
    let acceptedForSeed = 0;
    for (const node of neighborhood.nodes) {
      if (node.id === seed.id || primary.has(node.id)) continue;
      if (acceptedForSeed >= neighborsPerSeed) {
        truncated = true;
        break;
      }
      const note = noteById.get(node.id);
      if (note === undefined) continue;
      const candidateEvidence = graphEvidenceForCandidate(
        seed.id,
        seedIndex + 1,
        node.distance,
        note.path,
        neighborhood.edges,
        neighborhood.relations,
        notePathById,
      );
      truncated ||= candidateEvidence.truncated;
      const { evidence } = candidateEvidence;
      if (evidence.length === 0) continue;
      const existing = candidateById.get(note.id);
      if (existing === undefined) {
        candidateById.set(note.id, {
          note,
          evidence: [...evidence],
          distance: node.distance,
        });
      } else {
        existing.evidence.push(...evidence);
        existing.distance = Math.min(existing.distance, node.distance);
      }
      acceptedForSeed += 1;
    }
  }

  const primaryPaths = new Set(
    options.primaryIds
      .map((id) => notePathById.get(id))
      .filter((path): path is string => path !== undefined),
  );
  const allLinksAmongResults = analysis.contextualLinks
    .filter(({ source, target }) => primaryPaths.has(source) && primaryPaths.has(target))
    .toSorted((left, right) =>
      left.source.localeCompare(right.source)
      || left.target.localeCompare(right.target)
      || left.line - right.line);
  const allRelationsAmongResults = analysis.authoredRelations
    .filter(({ source, target }) => primary.has(source) && primary.has(target))
    .toSorted((left, right) =>
      left.source.localeCompare(right.source)
      || left.predicate.localeCompare(right.predicate)
      || left.target.localeCompare(right.target)
      || left.provenance.line - right.provenance.line);
  if (
    allLinksAmongResults.length > MAX_GRAPH_CONNECTIONS_PER_KIND
    || allRelationsAmongResults.length > MAX_GRAPH_CONNECTIONS_PER_KIND
  ) {
    truncated = true;
  }
  const linksAmongResults = allLinksAmongResults.slice(0, MAX_GRAPH_CONNECTIONS_PER_KIND);
  const relationsAmongResults = allRelationsAmongResults.slice(
    0,
    MAX_GRAPH_CONNECTIONS_PER_KIND,
  );
  const sorted = [...candidateById.values()].toSorted((left, right) => {
    const leftSeeds = new Set(left.evidence.map(({ seed }) => seed)).size;
    const rightSeeds = new Set(right.evidence.map(({ seed }) => seed)).size;
    const leftTyped = left.evidence.some(({ kind }) => kind === "relation");
    const rightTyped = right.evidence.some(({ kind }) => kind === "relation");
    const leftRank = Math.min(...left.evidence.map(({ seedRank }) => seedRank));
    const rightRank = Math.min(...right.evidence.map(({ seedRank }) => seedRank));
    return rightSeeds - leftSeeds
      || Number(rightTyped) - Number(leftTyped)
      || left.distance - right.distance
      || leftRank - rightRank
      || left.note.path.localeCompare(right.note.path);
  });
  if (sorted.length > limit) truncated = true;
  return {
    seeds: resolvedSeeds,
    linksAmongResults,
    relationsAmongResults,
    related: sorted.slice(0, limit).map(({ note, distance, evidence }) => {
      const sortedEvidence = evidence.toSorted((left, right) =>
        left.seedRank - right.seedRank
        || left.distance - right.distance
        || left.kind.localeCompare(right.kind)
        || left.source.localeCompare(right.source)
        || left.target.localeCompare(right.target)
        || left.line - right.line);
      if (sortedEvidence.length > MAX_GRAPH_EVIDENCE_PER_RESULT) truncated = true;
      return {
        id: note.id,
        path: note.path,
        title: note.title,
        distance,
        evidence: sortedEvidence.slice(0, MAX_GRAPH_EVIDENCE_PER_RESULT),
      };
    }),
    truncated,
  };
}
