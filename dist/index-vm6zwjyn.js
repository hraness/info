// @bun
import {
  MAX_ANALYZED_NOTES,
  MAX_MENTIONS,
  lookupNote
} from "./index-q2ks380z.js";

// src/percolate.ts
import { createHash } from "crypto";
import { posix } from "path";
var DEFAULT_PERCOLATION_LIMIT = 100;
var MAX_PERCOLATION_LIMIT = 1000;
var DEFAULT_PERCOLATION_MIN_SUPPORT = 2;
var MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE = 100;
var MAX_PERCOLATION_NOTES = MAX_ANALYZED_NOTES;
var MAX_PERCOLATION_MENTION_PAIRS = 250000;
var MAX_PERCOLATION_MENTIONS = MAX_MENTIONS;
var MAX_SCOPED_PERCOLATION_MENTION_PAIRS = MAX_PERCOLATION_NOTES * 2;
var MAX_PERCOLATION_EVIDENCE = 250000;
var MAX_PERCOLATION_PAIR_OBSERVATIONS = MAX_PERCOLATION_MENTION_PAIRS;
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function pairKey(left, right) {
  return compareText(left, right) <= 0 ? `${left}\x00${right}` : `${right}\x00${left}`;
}
function directedKey(source, target) {
  return `${source}\x00${target}`;
}
function relationKey(source, predicate, target) {
  return `${source}\x00${predicate}\x00${target}`;
}
function checkedLine(line, context) {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new TypeError(`${context} has an invalid evidence line.`);
  }
  return line;
}
function checkedOptions(options) {
  const limit = options.limit ?? DEFAULT_PERCOLATION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PERCOLATION_LIMIT) {
    throw new RangeError(`Percolation limit must be a safe integer from 0 to ${MAX_PERCOLATION_LIMIT}.`);
  }
  const minSupport = options.minSupport ?? DEFAULT_PERCOLATION_MIN_SUPPORT;
  if (!Number.isSafeInteger(minSupport) || minSupport < 1 || minSupport > MAX_PERCOLATION_EVIDENCE) {
    throw new RangeError(`Percolation minimum support must be a safe integer from 1 to ${MAX_PERCOLATION_EVIDENCE}.`);
  }
  return { limit, minSupport };
}
function indexedContentNotes(notes, analysis) {
  if (analysis.noteConnections.length > MAX_PERCOLATION_NOTES) {
    throw new RangeError(`Percolation exceeds the ${MAX_PERCOLATION_NOTES} note limit.`);
  }
  const allById = new Map;
  for (const note of notes) {
    if (allById.has(note.id)) {
      throw new Error(`Duplicate note identity in percolation: ${note.id}.`);
    }
    allById.set(note.id, note);
  }
  const byId = new Map;
  const byPath = new Map;
  for (const connection of analysis.noteConnections) {
    if (byId.has(connection.id)) {
      throw new Error(`Duplicate analyzed note identity: ${connection.id}.`);
    }
    const note = allById.get(connection.id);
    if (note === undefined) {
      throw new Error(`Analysis references missing note identity: ${connection.id}.`);
    }
    if (byPath.has(note.path)) {
      throw new Error(`Duplicate note path in percolation: ${note.path}.`);
    }
    byId.set(note.id, note);
    byPath.set(note.path, note);
  }
  return {
    notes: [...byId.values()].toSorted((left, right) => compareText(left.id, right.id)),
    byId,
    byPath
  };
}
function conceptKey(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/^#+/u, "").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "");
}
function isConcept(note) {
  return note.properties.type?.normalize("NFC").toLocaleLowerCase("en-US") === "concept";
}
function conceptLabels(note) {
  return [
    note.title,
    ...note.aliases,
    posix.basename(note.id)
  ].map(conceptKey).filter((value) => value !== "");
}
function naturalConceptId(tag) {
  const slug = conceptKey(tag);
  const digest = createHash("sha256").update(tag.normalize("NFC")).digest("hex");
  if (slug === "")
    return `notes/concept-${digest.slice(0, 16)}`;
  if (slug.length <= 160)
    return `notes/${slug}`;
  let prefix = "";
  let count = 0;
  for (const character of slug) {
    if (count >= 144)
      break;
    prefix += character;
    count += 1;
  }
  return `notes/${prefix.replace(/-+$/u, "")}-${digest.slice(0, 12)}`;
}
function suggestedConceptId(tag, occupiedIds) {
  const natural = naturalConceptId(tag);
  const foldedNatural = natural.toLocaleLowerCase("en-US");
  const collidesWith = occupiedIds.get(foldedNatural) ?? null;
  if (collidesWith === null)
    return { id: natural, collidesWith: null };
  const suffixed = `${natural}-concept`;
  if (!occupiedIds.has(suffixed.toLocaleLowerCase("en-US"))) {
    return { id: suffixed, collidesWith };
  }
  for (let suffix = 2;suffix <= MAX_PERCOLATION_NOTES + 2; suffix += 1) {
    const candidate = `${suffixed}-${suffix}`;
    if (!occupiedIds.has(candidate.toLocaleLowerCase("en-US"))) {
      return { id: candidate, collidesWith };
    }
  }
  throw new RangeError("Percolation could not choose an unoccupied concept ID.");
}
function resolvedNoteFilter(notes, query) {
  if (query === undefined)
    return null;
  const result = lookupNote(notes, query);
  if (result.kind === "found")
    return result.note.id;
  if (result.kind === "ambiguous") {
    throw new Error(`Percolation note is ambiguous: ${result.candidates.map((note) => note.id).join(", ")}.`);
  }
  throw new Error(`Percolation note does not exist: ${query}.`);
}
function candidateInvolvesNote(candidate, note) {
  if (note === null)
    return true;
  if (candidate.kind === "missing-concept") {
    return candidate.evidence.some((evidence) => evidence.note === note);
  }
  return candidate.source === note || candidate.target === note;
}
function compareSharedEvidence(left, right) {
  return compareText(left.kind, right.kind) || compareText(left.kind === "shared-tag" ? left.tag : left.concept, right.kind === "shared-tag" ? right.tag : right.concept) || compareText(left.note, right.note);
}
function candidateIdentity(candidate) {
  switch (candidate.kind) {
    case "missing-concept":
      return candidate.tag;
    case "missing-relation":
      return `${candidate.source}\x00${candidate.target}`;
    case "unlinked-mention":
      return `${candidate.source}\x00${candidate.target}`;
    case "relation-hygiene":
      return [
        candidate.problem,
        candidate.source,
        candidate.predicate ?? "",
        candidate.target ?? ""
      ].join("\x00");
  }
}
var candidateKindRank = {
  "relation-hygiene": 0,
  "unlinked-mention": 1,
  "missing-relation": 2,
  "missing-concept": 3
};
function compareCandidates(left, right) {
  return right.support - left.support || candidateKindRank[left.kind] - candidateKindRank[right.kind] || compareText(candidateIdentity(left), candidateIdentity(right));
}
function relationEvidence(relation) {
  return {
    kind: "relation",
    source: relation.source,
    target: relation.target,
    predicate: relation.predicate,
    line: checkedLine(relation.provenance.line, `Authored relation ${relation.source} -> ${relation.target}`),
    authoredTarget: relation.provenance.authoredTarget
  };
}
function issueEvidence(issue, source) {
  const line = checkedLine(issue.line, `Relation issue in ${issue.source}`);
  if (issue.kind === "malformed") {
    return {
      kind: "relation-issue",
      issue: issue.kind,
      source,
      line,
      predicate: issue.predicate ?? null,
      target: issue.target ?? null,
      candidates: [],
      candidatesTruncated: false,
      message: issue.message
    };
  }
  if (issue.kind === "broken") {
    return {
      kind: "relation-issue",
      issue: issue.kind,
      source,
      line,
      predicate: issue.predicate,
      target: issue.target,
      candidates: [],
      candidatesTruncated: false,
      message: `Relationship target does not exist: ${issue.target}.`
    };
  }
  return {
    kind: "relation-issue",
    issue: issue.kind,
    source,
    line,
    predicate: issue.predicate,
    target: issue.target,
    candidates: [...issue.candidates].toSorted(compareText).slice(0, MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE),
    candidatesTruncated: issue.candidates.length > MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE,
    message: `Relationship target is ambiguous: ${issue.target}.`
  };
}
function percolateVault(notes, analysis, options = {}) {
  const { limit, minSupport } = checkedOptions(options);
  const indexed = indexedContentNotes(notes, analysis);
  const noteFilter = resolvedNoteFilter(indexed.notes, options.note);
  const relations = analysis.authoredRelations ?? [];
  const relationIssues = analysis.relationIssues ?? [];
  let evidenceObservations = analysis.mentions.length + relations.length + relationIssues.length;
  for (const issue of relationIssues) {
    if (issue.kind !== "ambiguous")
      continue;
    evidenceObservations += issue.candidates.length;
    if (evidenceObservations > MAX_PERCOLATION_EVIDENCE)
      break;
  }
  if (evidenceObservations > MAX_PERCOLATION_EVIDENCE) {
    throw new RangeError(`Percolation exceeds the ${MAX_PERCOLATION_EVIDENCE} evidence limit.`);
  }
  const conceptIds = new Set(indexed.notes.filter(isConcept).map((note) => note.id));
  const occupiedIds = new Map(indexed.notes.map((note) => [
    note.id.toLocaleLowerCase("en-US"),
    note.id
  ]));
  const nonConceptNotes = indexed.notes.filter((note) => !conceptIds.has(note.id));
  const conceptLabelKeys = new Set(indexed.notes.filter((note) => conceptIds.has(note.id)).flatMap(conceptLabels));
  const candidates = [];
  const notesByTag = new Map;
  let tagEvidenceCount = 0;
  for (const note of nonConceptNotes) {
    for (const tag of new Set(note.tags)) {
      tagEvidenceCount += 1;
      if (tagEvidenceCount > MAX_PERCOLATION_EVIDENCE) {
        throw new RangeError(`Percolation exceeds the ${MAX_PERCOLATION_EVIDENCE} tag evidence limit.`);
      }
      const matches = notesByTag.get(tag) ?? [];
      matches.push(note);
      notesByTag.set(tag, matches);
    }
  }
  for (const [tag, matchingNotes] of [...notesByTag].toSorted(([left], [right]) => compareText(left, right))) {
    const sortedMatches = matchingNotes.toSorted((left, right) => (left.id === noteFilter ? -1 : 0) - (right.id === noteFilter ? -1 : 0) || compareText(left.id, right.id));
    const evidence = sortedMatches.slice(0, MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE).map((note) => ({
      kind: "tag",
      note: note.id,
      path: note.path,
      tag
    }));
    if (matchingNotes.length >= Math.max(2, minSupport) && !conceptLabelKeys.has(conceptKey(tag)) && (noteFilter === null || matchingNotes.some((note) => note.id === noteFilter))) {
      const suggestion = suggestedConceptId(tag, occupiedIds);
      candidates.push({
        kind: "missing-concept",
        tag,
        suggestedId: suggestion.id,
        collidesWith: suggestion.collidesWith,
        support: matchingNotes.length,
        evidenceTruncated: matchingNotes.length > MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE,
        evidence
      });
    }
  }
  const explicitPairs = new Set;
  const noteConcepts = new Map;
  const addConceptConnection = (noteId, conceptId) => {
    if (conceptIds.has(noteId) || !conceptIds.has(conceptId))
      return;
    const concepts = noteConcepts.get(noteId) ?? new Set;
    concepts.add(conceptId);
    noteConcepts.set(noteId, concepts);
  };
  for (const link of analysis.contextualLinks) {
    const source = indexed.byPath.get(link.source);
    const target = indexed.byPath.get(link.target);
    if (source === undefined || target === undefined) {
      throw new Error(`Contextual link references an unknown percolation note: ${link.source} -> ${link.target}.`);
    }
    explicitPairs.add(pairKey(source.id, target.id));
    addConceptConnection(source.id, target.id);
    addConceptConnection(target.id, source.id);
  }
  for (const relation of relations) {
    if (!indexed.byId.has(relation.source) || !indexed.byId.has(relation.target)) {
      throw new Error(`Authored relation references an unknown percolation note: ${relation.source} -> ${relation.target}.`);
    }
    explicitPairs.add(pairKey(relation.source, relation.target));
    addConceptConnection(relation.source, relation.target);
    addConceptConnection(relation.target, relation.source);
  }
  const pairEvidence = new Map;
  let pairObservations = 0;
  const addPairEvidence = (left, right, evidence) => {
    pairObservations += 1;
    if (pairObservations > MAX_PERCOLATION_PAIR_OBSERVATIONS) {
      throw new RangeError(`Percolation exceeds the ${MAX_PERCOLATION_PAIR_OBSERVATIONS} pair observation limit.`);
    }
    const key = pairKey(left.id, right.id);
    if (explicitPairs.has(key))
      return;
    const accumulated = pairEvidence.get(key) ?? {
      support: 0,
      evidenceCount: 0,
      evidence: []
    };
    accumulated.support += 1;
    accumulated.evidenceCount += evidence.length;
    for (const item of evidence) {
      if (accumulated.evidence.length < MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE) {
        accumulated.evidence.push(item);
      }
    }
    pairEvidence.set(key, accumulated);
  };
  const addPairsForGroup = (matchingNotes, evidenceFor) => {
    const sortedNotes = matchingNotes.toSorted((left, right) => compareText(left.id, right.id));
    if (noteFilter !== null) {
      const scoped = sortedNotes.find((note) => note.id === noteFilter);
      if (scoped === undefined)
        return;
      for (const other of sortedNotes) {
        if (other.id === scoped.id)
          continue;
        const [left, right] = compareText(scoped.id, other.id) < 0 ? [scoped, other] : [other, scoped];
        addPairEvidence(left, right, evidenceFor(left, right));
      }
      return;
    }
    for (let leftIndex = 0;leftIndex < sortedNotes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1;rightIndex < sortedNotes.length; rightIndex += 1) {
        const left = sortedNotes[leftIndex];
        const right = sortedNotes[rightIndex];
        if (left === undefined || right === undefined)
          continue;
        addPairEvidence(left, right, evidenceFor(left, right));
      }
    }
  };
  for (const [tag, matchingNotes] of [...notesByTag].toSorted(([left], [right]) => compareText(left, right))) {
    addPairsForGroup(matchingNotes, (left, right) => [
      { kind: "shared-tag", note: left.id, path: left.path, tag },
      { kind: "shared-tag", note: right.id, path: right.path, tag }
    ]);
  }
  const notesByConcept = new Map;
  for (const [noteId, connectedConcepts] of noteConcepts) {
    const note = indexed.byId.get(noteId);
    if (note === undefined)
      continue;
    for (const concept of connectedConcepts) {
      const matches = notesByConcept.get(concept) ?? [];
      matches.push(note);
      notesByConcept.set(concept, matches);
    }
  }
  for (const [concept, matchingNotes] of [...notesByConcept].toSorted(([left], [right]) => compareText(left, right))) {
    const conceptNote = indexed.byId.get(concept);
    if (conceptNote === undefined)
      continue;
    addPairsForGroup(matchingNotes, (left, right) => [
      {
        kind: "shared-concept",
        note: left.id,
        path: left.path,
        concept,
        conceptPath: conceptNote.path
      },
      {
        kind: "shared-concept",
        note: right.id,
        path: right.path,
        concept,
        conceptPath: conceptNote.path
      }
    ]);
  }
  for (const [key, accumulated] of pairEvidence) {
    const separator = key.indexOf("\x00");
    const source = key.slice(0, separator);
    const target = key.slice(separator + 1);
    const evidence = accumulated.evidence.toSorted(compareSharedEvidence);
    if (accumulated.support < minSupport)
      continue;
    candidates.push({
      kind: "missing-relation",
      source,
      target,
      suggestedPredicate: "related-to",
      support: accumulated.support,
      evidenceTruncated: accumulated.evidenceCount > MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE,
      evidence
    });
  }
  const mentionEvidenceByPair = new Map;
  for (const mention of analysis.mentions) {
    const source = indexed.byPath.get(mention.source);
    const target = indexed.byPath.get(mention.target);
    if (source === undefined || target === undefined) {
      throw new Error(`Mention references an unknown percolation note: ${mention.source} -> ${mention.target}.`);
    }
    if (noteFilter !== null && source.id !== noteFilter && target.id !== noteFilter)
      continue;
    if (explicitPairs.has(pairKey(source.id, target.id)))
      continue;
    const key = directedKey(source.id, target.id);
    const accumulated = mentionEvidenceByPair.get(key) ?? {
      support: 0,
      evidence: []
    };
    accumulated.support += 1;
    if (accumulated.evidence.length < MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE)
      accumulated.evidence.push({
        kind: "mention",
        source: source.id,
        target: target.id,
        line: checkedLine(mention.line, `Mention ${mention.source} -> ${mention.target}`),
        phrase: mention.phrase
      });
    mentionEvidenceByPair.set(key, accumulated);
  }
  for (const [key, accumulated] of mentionEvidenceByPair) {
    const separator = key.indexOf("\x00");
    const source = key.slice(0, separator);
    const target = key.slice(separator + 1);
    const sortedEvidence = accumulated.evidence.toSorted((left, right) => left.line - right.line || compareText(left.phrase, right.phrase));
    candidates.push({
      kind: "unlinked-mention",
      source,
      target,
      support: accumulated.support,
      evidenceTruncated: accumulated.support > MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE,
      evidence: sortedEvidence
    });
  }
  const relationsByKey = new Map(relations.map((relation) => [
    relationKey(relation.source, relation.predicate, relation.target),
    relation
  ]));
  for (const relation of relations) {
    if (noteFilter !== null && relation.source !== noteFilter && relation.target !== noteFilter)
      continue;
    if (relation.source === relation.target) {
      candidates.push({
        kind: "relation-hygiene",
        problem: "self-relation",
        source: relation.source,
        target: relation.target,
        predicate: relation.predicate,
        message: "Review an authored relationship whose source and target are the same note.",
        support: 1,
        evidenceTruncated: false,
        evidence: [relationEvidence(relation)]
      });
      continue;
    }
    if (compareText(relation.source, relation.target) >= 0)
      continue;
    const reciprocal = relationsByKey.get(relationKey(relation.target, relation.predicate, relation.source));
    if (reciprocal === undefined)
      continue;
    const evidence = [
      relationEvidence(relation),
      relationEvidence(reciprocal)
    ].toSorted((left, right) => compareText(left.source, right.source) || compareText(left.target, right.target));
    candidates.push({
      kind: "relation-hygiene",
      problem: "reciprocal-relation",
      source: relation.source,
      target: relation.target,
      predicate: relation.predicate,
      message: "Review reciprocal assertions of the same directional predicate.",
      support: evidence.length,
      evidenceTruncated: false,
      evidence
    });
  }
  for (const issue of relationIssues) {
    const sourceNote = indexed.byPath.get(issue.source);
    if (sourceNote === undefined)
      continue;
    if (noteFilter !== null && sourceNote.id !== noteFilter)
      continue;
    const evidence = issueEvidence(issue, sourceNote.id);
    const problem = issue.kind === "malformed" ? "malformed-relation" : issue.kind === "broken" ? "broken-relation" : "ambiguous-relation";
    candidates.push({
      kind: "relation-hygiene",
      problem,
      source: sourceNote.id,
      target: evidence.target,
      predicate: evidence.predicate,
      message: evidence.message,
      support: 1,
      evidenceTruncated: evidence.candidatesTruncated,
      evidence: [evidence]
    });
  }
  if (candidates.length > MAX_PERCOLATION_EVIDENCE) {
    throw new RangeError(`Percolation exceeds the ${MAX_PERCOLATION_EVIDENCE} candidate limit.`);
  }
  const sorted = candidates.filter((candidate) => candidateInvolvesNote(candidate, noteFilter)).toSorted(compareCandidates);
  return {
    candidates: sorted.slice(0, limit),
    truncated: sorted.length > limit
  };
}

export { DEFAULT_PERCOLATION_LIMIT, MAX_PERCOLATION_LIMIT, DEFAULT_PERCOLATION_MIN_SUPPORT, MAX_PERCOLATION_EVIDENCE_PER_CANDIDATE, MAX_PERCOLATION_NOTES, MAX_PERCOLATION_MENTION_PAIRS, MAX_PERCOLATION_MENTIONS, MAX_SCOPED_PERCOLATION_MENTION_PAIRS, percolateVault };
