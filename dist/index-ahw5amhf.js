// @bun
import {
  navigateLinks
} from "./index-d13v9ckt.js";
import {
  queryVault
} from "./index-7gsmq0jt.js";
import {
  lookupNote
} from "./index-4962kvds.js";

// src/search.ts
var MAX_EXACT_RESULTS = 500;
var MAX_SEARCH_QUERY_BYTES = 16 * 1024;
var MAX_SEARCH_QUERY_TERMS = 64;
var MAX_FUSION_LANES = 16;
var MAX_FUSION_RESULTS_PER_LANE = 500;
var MAX_RELATED_SEEDS = 10;
var MAX_RELATED_RESULTS = 100;
var MAX_GRAPH_CONNECTIONS_PER_KIND = 200;
var MAX_GRAPH_EVIDENCE_PER_RESULT = 40;
var stopWords = new Set([
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
  "with"
]);
function normalize(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
function checkedLimit(value, fallback, maximum, label) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return limit;
}
function validateSearchQuery(value) {
  if (typeof value !== "string") {
    throw new TypeError("Search query must be a string.");
  }
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > MAX_SEARCH_QUERY_BYTES) {
      throw new RangeError(`Search query must be at most ${MAX_SEARCH_QUERY_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
    }
  }
  const query = value.trim();
  if (query === "")
    throw new Error("Search query must not be empty.");
  const normalized = normalize(query);
  const unique = new Set;
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) {
    const term = match[0];
    unique.add(term);
    if (unique.size > MAX_SEARCH_QUERY_TERMS) {
      throw new RangeError(`Search query may contain at most ${MAX_SEARCH_QUERY_TERMS} unique normalized terms.`);
    }
  }
  const raw = [...unique];
  const meaningful = raw.filter((term) => term.length > 1 && !stopWords.has(term));
  return {
    query,
    normalized,
    terms: meaningful.length > 0 ? meaningful : raw
  };
}
function occurrenceCount(text, needle, maximum = 8) {
  if (needle === "")
    return 0;
  let count = 0;
  let offset = 0;
  while (count < maximum) {
    const found = text.indexOf(needle, offset);
    if (found < 0)
      break;
    count += 1;
    offset = found + Math.max(1, needle.length);
  }
  return count;
}
function originalLineOffset(line, normalizedOffset) {
  let consumed = 0;
  for (const part of new Intl.Segmenter("en-US", {
    granularity: "grapheme"
  }).segment(line)) {
    const width = normalize(part.segment).length;
    if (consumed + width > normalizedOffset)
      return part.index;
    consumed += width;
  }
  return line.length;
}
function firstMatchLocation(content, phrase, terms) {
  const normalized = normalize(content);
  let normalizedOffset = normalized.indexOf(phrase);
  if (normalizedOffset < 0) {
    for (const term of terms) {
      normalizedOffset = normalized.indexOf(term);
      if (normalizedOffset >= 0)
        break;
    }
  }
  if (normalizedOffset < 0)
    return null;
  const normalizedPrefix = normalized.slice(0, normalizedOffset);
  const line = normalizedPrefix.split(`
`).length;
  const normalizedLineStart = normalizedPrefix.lastIndexOf(`
`) + 1;
  let lineStart = 0;
  for (let current = 1;current < line; current += 1) {
    lineStart = content.indexOf(`
`, lineStart) + 1;
  }
  const lineEnd = content.indexOf(`
`, lineStart);
  const originalLine = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
  return {
    line,
    offset: lineStart + originalLineOffset(originalLine, normalizedOffset - normalizedLineStart)
  };
}
function exactSnippet(content, location, summary) {
  if (location === null)
    return { snippet: summary };
  const { line, offset } = location;
  const start = Math.max(0, offset - 180);
  const end = Math.min(content.length, start + 600);
  const snippet = content.slice(start, end).replace(/\s+/gu, " ").trim();
  return {
    line,
    snippet: `${start > 0 ? "\u2026" : ""}${snippet}${end < content.length ? "\u2026" : ""}`
  };
}
function metadataText(note) {
  return normalize(JSON.stringify(note.metadata));
}
function pushEvidence(evidence, candidate) {
  if (evidence.length >= 12)
    return;
  if (evidence.some((item) => item.kind === candidate.kind && item.field === candidate.field && item.value === candidate.value))
    return;
  evidence.push(candidate);
}
function exactHit(note, phrase, terms) {
  const title = normalize(note.title);
  const aliases = note.aliases.map(normalize);
  const path = normalize(note.path);
  const id = normalize(note.id);
  const tags = note.tags.map(normalize);
  const metadata = metadataText(note);
  const content = normalize(note.content);
  const matches = [];
  let score = 0;
  let identity = false;
  let phraseMatched = false;
  if (title === phrase) {
    identity = true;
    score += 1000;
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
  const phraseFields = [
    ["title", title, 400],
    ["alias", aliases.join(`
`), 350],
    ["path", `${path}
${id}`, 300],
    ["tag", tags.join(`
`), 250],
    ["content", content, 150],
    ["metadata", metadata, 100]
  ];
  for (const [field, value, weight] of phraseFields) {
    if (!value.includes(phrase))
      continue;
    phraseMatched = true;
    score += weight;
    pushEvidence(matches, { kind: "phrase", field, value: phrase });
  }
  let matchedTerms = 0;
  for (const term of terms) {
    let matched = false;
    const termFields = [
      ["title", title, 40],
      ["alias", aliases.join(`
`), 35],
      ["path", `${path}
${id}`, 30],
      ["tag", tags.join(`
`), 30],
      ["metadata", metadata, 10],
      ["content", content, 5]
    ];
    for (const [field, value, weight] of termFields) {
      if (occurrenceCount(value, term, 1) === 0)
        continue;
      matched = true;
      score += weight;
      pushEvidence(matches, { kind: "term", field, value: term });
    }
    if (matched)
      matchedTerms += 1;
  }
  const requiredTerms = terms.length <= 1 ? terms.length : Math.min(3, Math.ceil(terms.length / 2));
  if (!identity && !phraseMatched && matchedTerms < requiredTerms)
    return null;
  if (terms.length > 0)
    score += Math.round(matchedTerms / terms.length * 100);
  if (score === 0)
    return null;
  const snippet = exactSnippet(note.content, firstMatchLocation(note.content, phrase, terms), note.summary);
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    identity,
    score,
    ...snippet,
    matches
  };
}
function searchExactVault(notes, analysis, options) {
  const validated = validateSearchQuery(options.query);
  const phrase = validated.normalized;
  const limit = checkedLimit(options.limit, 40, MAX_EXACT_RESULTS, "Exact search limit");
  const allowed = new Set(queryVault(notes, analysis, {
    filters: options.filters ?? [],
    tags: options.tags ?? []
  }).map(({ id }) => id));
  const terms = validated.terms;
  return notes.filter((note) => allowed.has(note.id)).map((note) => exactHit(note, phrase, terms)).filter((hit) => hit !== null).toSorted((left, right) => Number(right.identity) - Number(left.identity) || right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit);
}
function fuseRankedCandidates(lanes, k = 60) {
  if (!Number.isSafeInteger(k) || k < 1 || k > 1000) {
    throw new RangeError("Fusion k must be an integer from 1 through 1000.");
  }
  if (lanes.length === 0 || lanes.length > MAX_FUSION_LANES) {
    throw new RangeError(`Fusion requires from 1 through ${MAX_FUSION_LANES} lanes.`);
  }
  const names = new Set;
  const active = lanes.filter(({ ids }) => ids.length > 0);
  let maximum = 0;
  const contributionsById = new Map;
  for (const lane of lanes) {
    if (lane.name.trim() === "" || names.has(lane.name)) {
      throw new Error("Fusion lane names must be non-empty and unique.");
    }
    names.add(lane.name);
    if (!Number.isFinite(lane.weight) || lane.weight <= 0 || lane.weight > 100) {
      throw new RangeError("Fusion lane weights must be greater than 0 and at most 100.");
    }
    if (lane.ids.length > MAX_FUSION_RESULTS_PER_LANE) {
      throw new RangeError(`Fusion lanes may contain at most ${MAX_FUSION_RESULTS_PER_LANE} results.`);
    }
    if (lane.ids.length > 0)
      maximum += lane.weight / (k + 1);
    const seen = new Set;
    for (const [index, id] of lane.ids.entries()) {
      if (id === "" || seen.has(id))
        continue;
      seen.add(id);
      const rank = index + 1;
      const contribution = {
        lane: lane.name,
        rank,
        weight: lane.weight,
        value: lane.weight / (k + rank)
      };
      const existing = contributionsById.get(id) ?? [];
      existing.push(contribution);
      contributionsById.set(id, existing);
    }
  }
  if (active.length === 0)
    return [];
  const ranked = [...contributionsById].map(([id, contributions]) => ({
    id,
    score: contributions.reduce((sum, item) => sum + item.value, 0) / maximum,
    contributions: contributions.toSorted((left, right) => left.lane.localeCompare(right.lane))
  })).toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return ranked.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
function graphEvidenceForCandidate(seed, seedRank, distance, candidatePath, links, relations, notePathById) {
  const evidence = [];
  for (const relation of relations) {
    const source = notePathById.get(relation.source);
    const target = notePathById.get(relation.target);
    if (source === undefined || target === undefined)
      continue;
    if (source !== candidatePath && target !== candidatePath)
      continue;
    evidence.push({
      kind: "relation",
      seed,
      seedRank,
      distance,
      source,
      target,
      predicate: relation.predicate,
      line: relation.provenance.line
    });
  }
  for (const link of links) {
    if (link.source !== candidatePath && link.target !== candidatePath)
      continue;
    evidence.push({
      kind: "link",
      seed,
      seedRank,
      distance,
      source: link.source,
      target: link.target,
      line: link.line
    });
  }
  const sorted = evidence.toSorted((left, right) => left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.line - right.line);
  return {
    evidence: sorted.slice(0, MAX_GRAPH_EVIDENCE_PER_RESULT),
    truncated: sorted.length > MAX_GRAPH_EVIDENCE_PER_RESULT
  };
}
function buildGraphContext(notes, analysis, options) {
  const depth = checkedLimit(options.depth, 1, 2, "Graph context depth");
  const neighborsPerSeed = checkedLimit(options.neighborsPerSeed, 3, 20, "Graph neighbors per seed");
  const limit = checkedLimit(options.limit, 20, MAX_RELATED_RESULTS, "Graph context limit");
  if (options.seeds.length > MAX_RELATED_SEEDS) {
    throw new RangeError(`Graph context accepts at most ${MAX_RELATED_SEEDS} seeds.`);
  }
  if (options.primaryIds.length > MAX_RELATED_RESULTS) {
    throw new RangeError(`Graph context accepts at most ${MAX_RELATED_RESULTS} primary results.`);
  }
  const primary = new Set(options.primaryIds);
  const notePathById = new Map(notes.map((note) => [note.id, note.path]));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const candidateById = new Map;
  let truncated = false;
  const resolvedSeeds = [];
  for (const [seedIndex, requestedSeed] of options.seeds.entries()) {
    const lookup = lookupNote(notes, requestedSeed);
    if (lookup.kind === "missing") {
      throw new Error(`Graph context seed ${JSON.stringify(requestedSeed)} was not found.`);
    }
    if (lookup.kind === "ambiguous") {
      throw new Error(`Graph context seed ${JSON.stringify(requestedSeed)} is ambiguous: ` + lookup.candidates.map(({ path }) => path).join(", "));
    }
    const seed = lookup.note;
    if (resolvedSeeds.includes(seed.id))
      continue;
    resolvedSeeds.push(seed.id);
    const neighborhood = navigateLinks(notes, analysis, seed, {
      direction: "both",
      depth,
      limit: Math.min(1000, limit + options.seeds.length + primary.size + 1)
    });
    truncated ||= neighborhood.truncated;
    let acceptedForSeed = 0;
    for (const node of neighborhood.nodes) {
      if (node.id === seed.id || primary.has(node.id))
        continue;
      if (acceptedForSeed >= neighborsPerSeed) {
        truncated = true;
        break;
      }
      const note = noteById.get(node.id);
      if (note === undefined)
        continue;
      const candidateEvidence = graphEvidenceForCandidate(seed.id, seedIndex + 1, node.distance, note.path, neighborhood.edges, neighborhood.relations, notePathById);
      truncated ||= candidateEvidence.truncated;
      const { evidence } = candidateEvidence;
      if (evidence.length === 0)
        continue;
      const existing = candidateById.get(note.id);
      if (existing === undefined) {
        candidateById.set(note.id, {
          note,
          evidence: [...evidence],
          distance: node.distance
        });
      } else {
        existing.evidence.push(...evidence);
        existing.distance = Math.min(existing.distance, node.distance);
      }
      acceptedForSeed += 1;
    }
  }
  const primaryPaths = new Set(options.primaryIds.map((id) => notePathById.get(id)).filter((path) => path !== undefined));
  const allLinksAmongResults = analysis.contextualLinks.filter(({ source, target }) => primaryPaths.has(source) && primaryPaths.has(target)).toSorted((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.line - right.line);
  const allRelationsAmongResults = analysis.authoredRelations.filter(({ source, target }) => primary.has(source) && primary.has(target)).toSorted((left, right) => left.source.localeCompare(right.source) || left.predicate.localeCompare(right.predicate) || left.target.localeCompare(right.target) || left.provenance.line - right.provenance.line);
  if (allLinksAmongResults.length > MAX_GRAPH_CONNECTIONS_PER_KIND || allRelationsAmongResults.length > MAX_GRAPH_CONNECTIONS_PER_KIND) {
    truncated = true;
  }
  const linksAmongResults = allLinksAmongResults.slice(0, MAX_GRAPH_CONNECTIONS_PER_KIND);
  const relationsAmongResults = allRelationsAmongResults.slice(0, MAX_GRAPH_CONNECTIONS_PER_KIND);
  const sorted = [...candidateById.values()].toSorted((left, right) => {
    const leftSeeds = new Set(left.evidence.map(({ seed }) => seed)).size;
    const rightSeeds = new Set(right.evidence.map(({ seed }) => seed)).size;
    const leftTyped = left.evidence.some(({ kind }) => kind === "relation");
    const rightTyped = right.evidence.some(({ kind }) => kind === "relation");
    const leftRank = Math.min(...left.evidence.map(({ seedRank }) => seedRank));
    const rightRank = Math.min(...right.evidence.map(({ seedRank }) => seedRank));
    return rightSeeds - leftSeeds || Number(rightTyped) - Number(leftTyped) || left.distance - right.distance || leftRank - rightRank || left.note.path.localeCompare(right.note.path);
  });
  if (sorted.length > limit)
    truncated = true;
  return {
    seeds: resolvedSeeds,
    linksAmongResults,
    relationsAmongResults,
    related: sorted.slice(0, limit).map(({ note, distance, evidence }) => {
      const sortedEvidence = evidence.toSorted((left, right) => left.seedRank - right.seedRank || left.distance - right.distance || left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.line - right.line);
      if (sortedEvidence.length > MAX_GRAPH_EVIDENCE_PER_RESULT)
        truncated = true;
      return {
        id: note.id,
        path: note.path,
        title: note.title,
        distance,
        evidence: sortedEvidence.slice(0, MAX_GRAPH_EVIDENCE_PER_RESULT)
      };
    }),
    truncated
  };
}

export { MAX_SEARCH_QUERY_BYTES, MAX_SEARCH_QUERY_TERMS, validateSearchQuery, searchExactVault, fuseRankedCandidates, buildGraphContext };
