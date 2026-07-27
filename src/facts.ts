import {
  type MetadataObject,
  type MetadataScalar,
  type Note,
  type VaultAnalysis,
} from "./graph.js";

export const FACT_ATTRIBUTES = {
  entityId: ":kb/id",
  entityKind: ":kb/kind",
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
  edgeAuthoredTarget: ":edge/authored-target",
} as const;

export type FactAttribute =
  (typeof FACT_ATTRIBUTES)[keyof typeof FACT_ATTRIBUTES];

export type FactScalar = MetadataScalar;

export type ScalarFact = {
  readonly kind: "scalar";
  readonly entity: string;
  readonly attribute: FactAttribute;
  readonly value: FactScalar;
};

export type ReferenceFact = {
  readonly kind: "reference";
  readonly entity: string;
  readonly attribute: FactAttribute;
  /** Stable semantic entity ID, never a DataScript entid. */
  readonly value: string;
};

export type VaultFact = ScalarFact | ReferenceFact;

export const MAX_PROJECTED_FACTS = 250_000;
export const MAX_METADATA_PROJECTION_DEPTH = 64;

export type FactProjectionOptions = {
  /**
   * Bound both emitted facts and metadata values visited while projecting.
   * A lower bound is useful to give callers a smaller, operation-specific
   * budget without ever permitting an unbounded projection.
   */
  readonly maxFacts?: number;
};

export type FactProjectionBudgetKind =
  | "fact-limit"
  | "metadata-value-limit"
  | "metadata-depth-limit";

export class FactProjectionBudgetError extends RangeError {
  readonly kind: FactProjectionBudgetKind;
  readonly limit: number;

  constructor(
    kind: FactProjectionBudgetKind,
    limit: number,
    message: string,
  ) {
    super(message);
    this.name = "FactProjectionBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}

type AuthoredRelationLike = {
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly provenance: {
    readonly kind: "frontmatter";
    readonly source: string;
    readonly line: number;
    readonly authoredTarget: string;
  };
};

type AnalysisWithRelations = VaultAnalysis & {
  readonly authoredRelations?: readonly AuthoredRelationLike[];
};

function compoundEntityId(
  kind: "metadata" | "link" | "relation",
  parts: readonly string[],
): string {
  return `${kind}:${parts.map((part) => `${part.length}:${part}`).join(":")}`;
}

/** Stable public identity for the fact entity representing a Markdown note. */
export function noteFactEntityId(noteId: string): string {
  return `note:${noteId}`;
}

/** Stable public identity for one scalar metadata leaf. */
export function metadataFactEntityId(noteId: string, path: string): string {
  return compoundEntityId("metadata", [noteId, path]);
}

/** Stable public identity for one resolved wikilink edge. */
export function linkFactEntityId(source: string, target: string): string {
  return compoundEntityId("link", [source, target]);
}

/** Stable public identity for one canonical authored relationship edge. */
export function relationFactEntityId(
  source: string,
  predicate: string,
  target: string,
): string {
  return compoundEntityId("relation", [source, predicate, target]);
}

function factValueKey(value: FactScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "boolean:1" : "boolean:0";
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  return `string:${JSON.stringify(value)}`;
}

function factKey(fact: VaultFact): string {
  return [
    fact.entity,
    fact.attribute,
    fact.kind,
    fact.kind === "reference" ? fact.value : factValueKey(fact.value),
  ].join("\u0000");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFactValues(left: VaultFact, right: VaultFact): number {
  const leftValue = left.kind === "reference"
    ? `reference:${left.value}`
    : factValueKey(left.value);
  const rightValue = right.kind === "reference"
    ? `reference:${right.value}`
    : factValueKey(right.value);
  return compareText(leftValue, rightValue);
}

function compareFacts(left: VaultFact, right: VaultFact): number {
  return compareText(left.entity, right.entity)
    || compareText(left.attribute, right.attribute)
    || compareText(left.kind, right.kind)
    || compareFactValues(left, right);
}

function metadataType(value: MetadataScalar): "null" | "boolean" | "number" | "string" {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function escapedMetadataSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

type MetadataLeaf = {
  readonly path: string;
  readonly value: MetadataScalar;
};

type ProjectionBudget = {
  readonly maxFacts: number;
  metadataValues: number;
};

function checkedProjectionLimit(value: number | undefined): number {
  const limit = value ?? MAX_PROJECTED_FACTS;
  if (
    !Number.isSafeInteger(limit)
    || limit < 0
    || limit > MAX_PROJECTED_FACTS
  ) {
    throw new RangeError(
      `Fact projection limit must be a safe integer from 0 to ${MAX_PROJECTED_FACTS}.`,
    );
  }
  return limit;
}

function metadataScalar(value: unknown): value is MetadataScalar {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (
      typeof value === "number"
      && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
}

function assertDataOnlyArray(
  value: readonly unknown[],
  context: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) =>
    typeof key !== "string"
    || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
    throw new TypeError(`${context} must be a dense data-only array.`);
  }
}

function dataOnlyObjectKeys(
  value: object,
  context: string,
): readonly string[] {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain data-only object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${context} must have only string keys.`);
  }
  return (keys as string[]).toSorted(compareText);
}

function visitMetadataValue(
  budget: ProjectionBudget,
): void {
  budget.metadataValues += 1;
  if (budget.metadataValues > budget.maxFacts) {
    throw new FactProjectionBudgetError(
      "metadata-value-limit",
      budget.maxFacts,
      `Metadata projection exceeds the ${budget.maxFacts} value traversal limit.`,
    );
  }
}

function* metadataLeaves(
  value: unknown,
  budget: ProjectionBudget,
  path = "",
  depth = 0,
  ancestors = new Set<object>(),
): Generator<MetadataLeaf> {
  visitMetadataValue(budget);
  if (depth > MAX_METADATA_PROJECTION_DEPTH) {
    throw new FactProjectionBudgetError(
      "metadata-depth-limit",
      MAX_METADATA_PROJECTION_DEPTH,
      `Metadata projection exceeds the ${MAX_METADATA_PROJECTION_DEPTH} level depth limit.`,
    );
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
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError(
            "Note metadata array must be a dense data-only array.",
          );
        }
        yield* metadataLeaves(
          descriptor.value,
          budget,
          `${path}/${index}`,
          depth + 1,
          ancestors,
        );
      }
      return;
    }
    for (const key of dataOnlyObjectKeys(value, "Note metadata")) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        throw new TypeError(
          "Note metadata must have enumerable data properties.",
        );
      }
      yield* metadataLeaves(
        descriptor.value,
        budget,
        `${path}/${escapedMetadataSegment(key)}`,
        depth + 1,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function metadataObject(note: Note): MetadataObject {
  const value: unknown = note.metadata;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Note ${note.path} has invalid metadata.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Note ${note.path} has invalid metadata.`);
  }
  return value as MetadataObject;
}

function topLevelMetadataScalar(
  metadata: MetadataObject,
  expectedKey: string,
): MetadataScalar | undefined {
  const normalizedExpected = expectedKey.toLocaleLowerCase("en-US");
  const matches = Object.keys(metadata).filter(
    (key) => key.toLocaleLowerCase("en-US") === normalizedExpected,
  );
  if (matches.length !== 1) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    metadata,
    matches[0] ?? "",
  );
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || !descriptor.enumerable
  ) {
    throw new TypeError("Note metadata must have enumerable data properties.");
  }
  const value: unknown = descriptor.value;
  return metadataScalar(value) ? value : undefined;
}

function contentNotes(
  notes: readonly Note[],
  analysis: VaultAnalysis,
): readonly Note[] {
  const notesById = new Map<string, Note>();
  for (const note of notes) {
    if (notesById.has(note.id)) {
      throw new Error(`Duplicate note identity in fact projection: ${note.id}.`);
    }
    notesById.set(note.id, note);
  }

  const seenConnectionIds = new Set<string>();
  const projected: Note[] = [];
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

function addScalarFact(
  facts: Map<string, VaultFact>,
  budget: ProjectionBudget,
  entity: string,
  attribute: FactAttribute,
  value: FactScalar,
): void {
  const fact: ScalarFact = { kind: "scalar", entity, attribute, value };
  addFact(facts, budget, fact);
}

function addReferenceFact(
  facts: Map<string, VaultFact>,
  budget: ProjectionBudget,
  entity: string,
  attribute: FactAttribute,
  value: string,
): void {
  const fact: ReferenceFact = { kind: "reference", entity, attribute, value };
  addFact(facts, budget, fact);
}

function addFact(
  facts: Map<string, VaultFact>,
  budget: ProjectionBudget,
  fact: VaultFact,
): void {
  const key = factKey(fact);
  if (!facts.has(key) && facts.size >= budget.maxFacts) {
    throw new FactProjectionBudgetError(
      "fact-limit",
      budget.maxFacts,
      `Vault projection exceeds the ${budget.maxFacts} fact limit.`,
    );
  }
  facts.set(key, fact);
}

function addEntityIdentity(
  facts: Map<string, VaultFact>,
  budget: ProjectionBudget,
  entity: string,
  kind: "note" | "metadata" | "edge",
): void {
  addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.entityId, entity);
  addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.entityKind, kind);
}

function requirePositiveLine(line: number, context: string): void {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new TypeError(`${context} has an invalid source line.`);
  }
}

/**
 * Project canonical Markdown and its derived analysis into a deterministic,
 * engine-neutral fact relation.
 */
export function projectVaultFacts(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  options: FactProjectionOptions = {},
): readonly VaultFact[] {
  const budget: ProjectionBudget = {
    maxFacts: checkedProjectionLimit(options.maxFacts),
    metadataValues: 0,
  };
  const projectedNotes = contentNotes(notes, analysis);
  const notesById = new Map(projectedNotes.map((note) => [note.id, note]));
  const notesByPath = new Map<string, Note>();
  for (const note of projectedNotes) {
    if (notesByPath.has(note.path)) {
      throw new Error(`Duplicate note path in fact projection: ${note.path}.`);
    }
    notesByPath.set(note.path, note);
  }

  const facts = new Map<string, VaultFact>();
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
      if (
        typeof type === "string"
        && type.normalize("NFC").toLocaleLowerCase("en-US") === "concept"
      ) {
        addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.noteConcept, true);
      }
    }

    for (const leaf of metadataLeaves(metadata, budget)) {
      const metadataEntity = metadataFactEntityId(note.id, leaf.path);
      addEntityIdentity(facts, budget, metadataEntity, "metadata");
      addReferenceFact(
        facts,
        budget,
        metadataEntity,
        FACT_ATTRIBUTES.metadataNote,
        entity,
      );
      addScalarFact(
        facts,
        budget,
        metadataEntity,
        FACT_ATTRIBUTES.metadataPath,
        leaf.path,
      );
      addScalarFact(
        facts,
        budget,
        metadataEntity,
        FACT_ATTRIBUTES.metadataValue,
        leaf.value,
      );
      addScalarFact(
        facts,
        budget,
        metadataEntity,
        FACT_ATTRIBUTES.metadataValueType,
        metadataType(leaf.value),
      );
    }
  }

  for (const link of analysis.contextualLinks) {
    const source = notesByPath.get(link.source);
    const target = notesByPath.get(link.target);
    if (source === undefined || target === undefined) {
      throw new Error(
        `Contextual link references an unprojected note: ${link.source} -> ${link.target}.`,
      );
    }
    requirePositiveLine(link.line, `Contextual link ${link.source} -> ${link.target}`);
    const entity = linkFactEntityId(source.id, target.id);
    addEntityIdentity(facts, budget, entity, "edge");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeKind, "wikilink");
    addReferenceFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeSource,
      noteFactEntityId(source.id),
    );
    addReferenceFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeTarget,
      noteFactEntityId(target.id),
    );
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgePredicate, "links-to");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeLine, link.line);
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeProvenance, "wikilink");
  }

  const authoredRelations =
    (analysis as AnalysisWithRelations).authoredRelations ?? [];
  for (const relation of authoredRelations) {
    if (!notesById.has(relation.source) || !notesById.has(relation.target)) {
      throw new Error(
        `Authored relation references an unprojected note: ${relation.source} -> ${relation.target}.`,
      );
    }
    requirePositiveLine(
      relation.provenance.line,
      `Authored relation ${relation.source} -> ${relation.target}`,
    );
    const entity = relationFactEntityId(
      relation.source,
      relation.predicate,
      relation.target,
    );
    addEntityIdentity(facts, budget, entity, "edge");
    addScalarFact(facts, budget, entity, FACT_ATTRIBUTES.edgeKind, "relation");
    addReferenceFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeSource,
      noteFactEntityId(relation.source),
    );
    addReferenceFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeTarget,
      noteFactEntityId(relation.target),
    );
    addScalarFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgePredicate,
      relation.predicate,
    );
    addScalarFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeLine,
      relation.provenance.line,
    );
    addScalarFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeProvenance,
      "frontmatter",
    );
    addScalarFact(
      facts,
      budget,
      entity,
      FACT_ATTRIBUTES.edgeAuthoredTarget,
      relation.provenance.authoredTarget,
    );
  }

  return [...facts.values()].toSorted(compareFacts);
}
