// @bun
// src/facts.ts
var FACT_ATTRIBUTES = {
  entityId: ":oh/id",
  entityKind: ":oh/kind",
  noteId: ":note/id",
  notePath: ":note/path",
  noteTitle: ":note/title",
  noteSummary: ":note/summary",
  noteAlias: ":note/alias",
  noteTag: ":note/tag",
  noteType: ":note/type",
  noteConcept: ":note/concept",
  metadataNote: ":metadata/note",
  metadataPath: ":metadata/path",
  metadataValue: ":metadata/value",
  metadataValueType: ":metadata/value-type",
  edgeKind: ":edge/kind",
  edgeSource: ":edge/source",
  edgeTarget: ":edge/target",
  edgePredicate: ":edge/predicate",
  edgeLine: ":edge/line",
  edgeProvenance: ":edge/provenance",
  edgeAuthoredTarget: ":edge/authored-target"
};
var MAX_PROJECTED_FACTS = 250000;
var MAX_METADATA_PROJECTION_DEPTH = 64;

class FactProjectionBudgetError extends RangeError {
  kind;
  limit;
  constructor(kind, limit, message) {
    super(message);
    this.name = "FactProjectionBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}
function compoundEntityId(kind, parts) {
  return `${kind}:${parts.map((part) => `${part.length}:${part}`).join(":")}`;
}
function noteFactEntityId(noteId) {
  return `note:${noteId}`;
}
function metadataFactEntityId(noteId, path) {
  return compoundEntityId("metadata", [noteId, path]);
}
function linkFactEntityId(source, target) {
  return compoundEntityId("link", [source, target]);
}
function relationFactEntityId(source, predicate, target) {
  return compoundEntityId("relation", [source, predicate, target]);
}
function factValueKey(value) {
  if (value === null)
    return "null";
  if (typeof value === "boolean")
    return value ? "boolean:1" : "boolean:0";
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  return `string:${JSON.stringify(value)}`;
}
function factKey(fact) {
  return [
    fact.entity,
    fact.attribute,
    fact.kind,
    fact.kind === "reference" ? fact.value : factValueKey(fact.value)
  ].join("\x00");
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareFactValues(left, right) {
  const leftValue = left.kind === "reference" ? `reference:${left.value}` : factValueKey(left.value);
  const rightValue = right.kind === "reference" ? `reference:${right.value}` : factValueKey(right.value);
  return compareText(leftValue, rightValue);
}
function compareFacts(left, right) {
  return compareText(left.entity, right.entity) || compareText(left.attribute, right.attribute) || compareText(left.kind, right.kind) || compareFactValues(left, right);
}
function metadataType(value) {
  if (value === null)
    return "null";
  if (typeof value === "boolean")
    return "boolean";
  if (typeof value === "number")
    return "number";
  return "string";
}
function escapedMetadataSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function checkedProjectionLimit(value) {
  const limit = value ?? MAX_PROJECTED_FACTS;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PROJECTED_FACTS) {
    throw new RangeError(`Fact projection limit must be a safe integer from 0 to ${MAX_PROJECTED_FACTS}.`);
  }
  return limit;
}
function metadataScalar(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}
function assertDataOnlyArray(value, context) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
    throw new TypeError(`${context} must be a dense data-only array.`);
  }
}
function dataOnlyObjectKeys(value, context) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain data-only object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${context} must have only string keys.`);
  }
  return keys.toSorted(compareText);
}
function visitMetadataValue(budget) {
  budget.metadataValues += 1;
  if (budget.metadataValues > budget.maxFacts) {
    throw new FactProjectionBudgetError("metadata-value-limit", budget.maxFacts, `Metadata projection exceeds the ${budget.maxFacts} value traversal limit.`);
  }
}
function* metadataLeaves(value, budget, path = "", depth = 0, ancestors = new Set) {
  visitMetadataValue(budget);
  if (depth > MAX_METADATA_PROJECTION_DEPTH) {
    throw new FactProjectionBudgetError("metadata-depth-limit", MAX_METADATA_PROJECTION_DEPTH, `Metadata projection exceeds the ${MAX_METADATA_PROJECTION_DEPTH} level depth limit.`);
  }
  if (metadataScalar(value)) {
    yield { path, value };
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Note metadata must contain only owned scalar values.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Note metadata must not contain cycles.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDataOnlyArray(value, "Note metadata array");
      for (let index = 0;index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("Note metadata array must be a dense data-only array.");
        }
        yield* metadataLeaves(descriptor.value, budget, `${path}/${index}`, depth + 1, ancestors);
      }
      return;
    }
    for (const key of dataOnlyObjectKeys(value, "Note metadata")) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Note metadata must have enumerable data properties.");
      }
      yield* metadataLeaves(descriptor.value, budget, `${path}/${escapedMetadataSegment(key)}`, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
function metadataObject(note) {
  const value = note.metadata;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Note ${note.path} has invalid metadata.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Note ${note.path} has invalid metadata.`);
  }
  return value;
}
function topLevelMetadataScalar(metadata, expectedKey) {
  const normalizedExpected = expectedKey.toLocaleLowerCase("en-US");
  const matches = Object.keys(metadata).filter((key) => key.toLocaleLowerCase("en-US") === normalizedExpected);
  if (matches.length !== 1)
    return;
  const descriptor = Object.getOwnPropertyDescriptor(metadata, matches[0] ?? "");
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError("Note metadata must have enumerable data properties.");
  }
  const value = descriptor.value;
  return metadataScalar(value) ? value : undefined;
}
function contentNotes(notes, analysis) {
  const notesById = new Map;
  for (const note of notes) {
    if (notesById.has(note.id)) {
      throw new Error(`Duplicate note identity in fact projection: ${note.id}.`);
    }
    notesById.set(note.id, note);
  }
  const seenConnectionIds = new Set;
  const projected = [];
  for (const connection of analysis.noteConnections) {
    if (seenConnectionIds.has(connection.id)) {
      throw new Error(`Duplicate analyzed note identity: ${connection.id}.`);
    }
    seenConnectionIds.add(connection.id);
    const note = notesById.get(connection.id);
    if (note === undefined) {
      throw new Error(`Analysis references missing note identity: ${connection.id}.`);
    }
    projected.push(note);
  }
  return projected.toSorted((left, right) => compareText(left.id, right.id));
}
function addScalarFact(facts, budget, entity, attribute, value) {
  const fact = { kind: "scalar", entity, attribute, value };
  addFact(facts, budget, fact);
}
function addReferenceFact(facts, budget, entity, attribute, value) {
  const fact = { kind: "reference", entity, attribute, value };
  addFact(facts, budget, fact);
}
function addFact(facts, budget, fact) {
  const key = factKey(fact);
  if (!facts.has(key) && facts.size >= budget.maxFacts) {
    throw new FactProjectionBudgetError("fact-limit", budget.maxFacts, `Vault projection exceeds the ${budget.maxFacts} fact limit.`);
  }
  facts.set(key, fact);
}
function addEntityIdentity(facts, budget, entity, kind) {
  addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.entityId, entity);
  addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.entityKind, kind);
}
function requirePositiveLine(line, context) {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new TypeError(`${context} has an invalid source line.`);
  }
}
function projectVaultFacts(notes, analysis, options = {}) {
  const budget = {
    maxFacts: checkedProjectionLimit(options.maxFacts),
    metadataValues: 0
  };
  const projectedNotes = contentNotes(notes, analysis);
  const notesById = new Map(projectedNotes.map((note) => [note.id, note]));
  const notesByPath = new Map;
  for (const note of projectedNotes) {
    if (notesByPath.has(note.path)) {
      throw new Error(`Duplicate note path in fact projection: ${note.path}.`);
    }
    notesByPath.set(note.path, note);
  }
  const facts = new Map;
  for (const note of projectedNotes) {
    const entity = noteFactEntityId(note.id);
    addEntityIdentity(facts, budget, entity, "note");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteId, note.id);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.notePath, note.path);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteTitle, note.title);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteSummary, note.summary);
    for (const alias of note.aliases) {
      addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteAlias, alias);
    }
    for (const tag of note.tags) {
      addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteTag, tag);
    }
    const metadata = metadataObject(note);
    const type = topLevelMetadataScalar(metadata, "type");
    if (type !== undefined) {
      addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteType, type);
      if (typeof type === "string" && type.normalize("NFC").toLocaleLowerCase("en-US") === "concept") {
        addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteConcept, true);
      }
    }
    for (const leaf of metadataLeaves(metadata, budget)) {
      const metadataEntity = metadataFactEntityId(note.id, leaf.path);
      addEntityIdentity(facts, budget, metadataEntity, "metadata");
      addReferenceFact(facts, budget, metadataEntity, FACT_ATTRIBUTES.metadataNote, entity);
      addScalarFact(facts, budget, metadataEntity, FACT_ATTRIBUTES.metadataPath, leaf.path);
      addScalarFact(facts, budget, metadataEntity, FACT_ATTRIBUTES.metadataValue, leaf.value);
      addScalarFact(facts, budget, metadataEntity, FACT_ATTRIBUTES.metadataValueType, metadataType(leaf.value));
    }
  }
  for (const link of analysis.contextualLinks) {
    const source = notesByPath.get(link.source);
    const target = notesByPath.get(link.target);
    if (source === undefined || target === undefined) {
      throw new Error(`Contextual link references an unprojected note: ${link.source} -> ${link.target}.`);
    }
    requirePositiveLine(link.line, `Contextual link ${link.source} -> ${link.target}`);
    const entity = linkFactEntityId(source.id, target.id);
    addEntityIdentity(facts, budget, entity, "edge");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeKind, "wikilink");
    addReferenceFact(facts, budget, entity, FACT_ATTRIBUTES.edgeSource, noteFactEntityId(source.id));
    addReferenceFact(facts, budget, entity, FACT_ATTRIBUTES.edgeTarget, noteFactEntityId(target.id));
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgePredicate, "links-to");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeLine, link.line);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeProvenance, "wikilink");
  }
  const authoredRelations = analysis.authoredRelations ?? [];
  for (const relation of authoredRelations) {
    if (!notesById.has(relation.source) || !notesById.has(relation.target)) {
      throw new Error(`Authored relation references an unprojected note: ${relation.source} -> ${relation.target}.`);
    }
    requirePositiveLine(relation.provenance.line, `Authored relation ${relation.source} -> ${relation.target}`);
    const entity = relationFactEntityId(relation.source, relation.predicate, relation.target);
    addEntityIdentity(facts, budget, entity, "edge");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeKind, "relation");
    addReferenceFact(facts, budget, entity, FACT_ATTRIBUTES.edgeSource, noteFactEntityId(relation.source));
    addReferenceFact(facts, budget, entity, FACT_ATTRIBUTES.edgeTarget, noteFactEntityId(relation.target));
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgePredicate, relation.predicate);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeLine, relation.provenance.line);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeProvenance, "frontmatter");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeAuthoredTarget, relation.provenance.authoredTarget);
  }
  return [...facts.values()].toSorted(compareFacts);
}

export { FACT_ATTRIBUTES, MAX_PROJECTED_FACTS, MAX_METADATA_PROJECTION_DEPTH, FactProjectionBudgetError, noteFactEntityId, metadataFactEntityId, linkFactEntityId, relationFactEntityId, projectVaultFacts };
