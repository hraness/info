import { redactEvaluationMachinePaths } from "./evaluation-redaction.js";

export const RETRIEVAL_EVALUATION_SCHEMA_VERSION = 1;
export const RETRIEVAL_EVALUATION_REPORT_VERSION = 1;
export const MAX_EVALUATION_QUERIES = 2_000;
export const MAX_EVALUATION_QRELS_PER_QUERY = 2_000;
export const MAX_EVALUATION_RETRIEVERS = 32;
export const MAX_EVALUATION_RESULTS_PER_QUERY = 1_000;
export const MAX_EVALUATION_TEXT_BYTES = 16 * 1_024;
export const MAX_EVALUATION_EVIDENCE_BYTES = 64 * 1_024;
export const MAX_EVALUATION_DIAGNOSTICS = 100;
export const MAX_EVALUATION_TIMEOUT_MS = 5 * 60_000;
export const MAX_BOOTSTRAP_RESAMPLES = 100_000;

const objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const windowsAbsolutePattern = /^[a-z]:[\\/]/iu;

export type EvaluationQueryClass =
  | "active-plan"
  | "code-path-context"
  | "conceptual-recall"
  | "current-decision"
  | "exact-identifier"
  | "historical-rationale"
  | "no-answer"
  | "source-evidence"
  | "stale-current-conflict";

export type EvaluationSplit = "development" | "test";

export type EvaluationAssessor = {
  readonly id: string;
  readonly displayName?: string;
  readonly affiliation?: string;
};

export type EvaluationAdjudication = {
  readonly status: "not-required" | "resolved";
  readonly adjudicatorId?: string;
  readonly note?: string;
};

export type EvaluationQrel = {
  readonly documentId: string;
  readonly relevance: 0 | 1 | 2 | 3;
};

export type EvaluationMetadataFilter =
  | { readonly kind: "exists"; readonly path: string }
  | {
      readonly kind: "equals";
      readonly path: string;
      readonly value: string | number | boolean | null;
    };

export type EvaluationRetrievalInputs = {
  /** Executable text for exact, keyword, semantic, or fused text lanes. */
  readonly text?: string;
  /** Canonical note identity for direct read or identity fixtures. */
  readonly noteId?: string;
  readonly metadata?: {
    readonly filters: readonly EvaluationMetadataFilter[];
    readonly tags: readonly string[];
  };
  readonly graph?: {
    readonly seeds: readonly string[];
    readonly depth: 1 | 2;
  };
  readonly context?: {
    readonly repositoryPath: string;
  };
  readonly history?: {
    readonly query: string;
    readonly noteIds: readonly string[];
  };
};

export type EvaluationQuery = {
  readonly id: string;
  readonly text: string;
  readonly class: EvaluationQueryClass;
  readonly split: EvaluationSplit;
  readonly answer: "answerable" | "no-answer";
  /** Structured lane inputs keep execution independent from human prose parsing. */
  readonly inputs: EvaluationRetrievalInputs;
  readonly qrels: readonly EvaluationQrel[];
  readonly assessorIds: readonly string[];
  readonly adjudication: EvaluationAdjudication;
};

export type RetrievalEvaluationCorpus = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly frozen: {
    readonly repositoryCommit: string;
    readonly vaultTree: string;
    readonly vaultRoot: string;
  };
  readonly assessment: {
    readonly rubricVersion: string;
    readonly assessors: readonly EvaluationAssessor[];
  };
  readonly queries: readonly EvaluationQuery[];
};

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function strictKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) throw new TypeError(`${label} has unknown fields: ${extra.toSorted().join(", ")}.`);
}

function boundedString(value: unknown, label: string, maximumBytes = MAX_EVALUATION_TEXT_BYTES): string {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || /[\0\r\n]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${label} must be a non-empty, single-line string of at most ${maximumBytes} UTF-8 bytes.`);
  }
  return value.normalize("NFC");
}

function optionalBoundedString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label);
}

function stringArray(value: unknown, label: string, maximum = 100): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty array with at most ${maximum} entries.`);
  }
  const strings = value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(strings);
}

function frozenVaultRoot(value: unknown): string {
  const path = boundedString(value, "frozen.vaultRoot").replaceAll("\\", "/");
  if (
    path.startsWith("/")
    || windowsAbsolutePattern.test(path)
    || path.split("/").some((part) => part === "" || part === "..")
  ) throw new TypeError("frozen.vaultRoot must be a confined repository-relative path.");
  return path.replace(/^\.\//u, "");
}

function confinedRelativePath(value: unknown, label: string, allowRoot = false): string {
  const path = boundedString(value, label).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (allowRoot && path === ".") return path;
  if (
    path.startsWith("/")
    || windowsAbsolutePattern.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new TypeError(`${label} must be a confined repository-relative path.`);
  return path;
}

const queryClasses = new Set<EvaluationQueryClass>([
  "active-plan",
  "code-path-context",
  "conceptual-recall",
  "current-decision",
  "exact-identifier",
  "historical-rationale",
  "no-answer",
  "source-evidence",
  "stale-current-conflict",
]);

function parseAssessor(value: unknown, index: number): EvaluationAssessor {
  const input = record(value, `assessment.assessors[${index}]`);
  strictKeys(input, ["id", "displayName", "affiliation"], `assessment.assessors[${index}]`);
  const displayName = optionalBoundedString(input.displayName, `assessment.assessors[${index}].displayName`);
  const affiliation = optionalBoundedString(input.affiliation, `assessment.assessors[${index}].affiliation`);
  return Object.freeze({
    id: boundedString(input.id, `assessment.assessors[${index}].id`, 256),
    ...(displayName === undefined ? {} : { displayName }),
    ...(affiliation === undefined ? {} : { affiliation }),
  });
}

function parseQrel(value: unknown, queryIndex: number, index: number): EvaluationQrel {
  const label = `queries[${queryIndex}].qrels[${index}]`;
  const input = record(value, label);
  strictKeys(input, ["documentId", "relevance"], label);
  if (
    input.relevance !== 0
    && input.relevance !== 1
    && input.relevance !== 2
    && input.relevance !== 3
  ) throw new TypeError(`${label}.relevance must be an integer from 0 through 3.`);
  return Object.freeze({
    documentId: boundedString(input.documentId, `${label}.documentId`),
    relevance: input.relevance,
  });
}

function parseAdjudication(
  value: unknown,
  queryIndex: number,
  assessors: ReadonlySet<string>,
): EvaluationAdjudication {
  const label = `queries[${queryIndex}].adjudication`;
  const input = record(value, label);
  strictKeys(input, ["status", "adjudicatorId", "note"], label);
  if (input.status !== "not-required" && input.status !== "resolved") {
    throw new TypeError(`${label}.status must be not-required or resolved.`);
  }
  const adjudicatorId = optionalBoundedString(input.adjudicatorId, `${label}.adjudicatorId`);
  const note = optionalBoundedString(input.note, `${label}.note`);
  if (input.status === "resolved" && adjudicatorId === undefined) {
    throw new TypeError(`${label}.adjudicatorId is required for resolved judgments.`);
  }
  if (adjudicatorId !== undefined && !assessors.has(adjudicatorId)) {
    throw new TypeError(`${label}.adjudicatorId must name a declared assessor.`);
  }
  return Object.freeze({
    status: input.status,
    ...(adjudicatorId === undefined ? {} : { adjudicatorId }),
    ...(note === undefined ? {} : { note }),
  });
}

function parseMetadataFilter(
  value: unknown,
  queryIndex: number,
  index: number,
): EvaluationMetadataFilter {
  const label = `queries[${queryIndex}].inputs.metadata.filters[${index}]`;
  const input = record(value, label);
  strictKeys(input, ["kind", "path", "value"], label);
  const path = boundedString(input.path, `${label}.path`, 2_048);
  if (input.kind === "exists") {
    if (input.value !== undefined) throw new TypeError(`${label}.value is not allowed for an exists filter.`);
    return Object.freeze({ kind: "exists", path });
  }
  if (input.kind !== "equals") throw new TypeError(`${label}.kind must be exists or equals.`);
  const filterValue = input.value;
  if (
    filterValue !== null
    && typeof filterValue !== "string"
    && typeof filterValue !== "number"
    && typeof filterValue !== "boolean"
  ) throw new TypeError(`${label}.value must be a scalar.`);
  if (typeof filterValue === "number" && !Number.isFinite(filterValue)) {
    throw new TypeError(`${label}.value must be finite.`);
  }
  return Object.freeze({
    kind: "equals",
    path,
    value: typeof filterValue === "string"
      ? boundedString(filterValue, `${label}.value`)
      : filterValue,
  });
}

function optionalStringList(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} entries.`);
  }
  const strings = value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(strings);
}

function parseRetrievalInputs(value: unknown, queryIndex: number): EvaluationRetrievalInputs {
  const label = `queries[${queryIndex}].inputs`;
  const input = record(value, label);
  strictKeys(input, ["text", "noteId", "metadata", "graph", "context", "history"], label);
  if (Object.keys(input).length === 0) throw new TypeError(`${label} must define at least one retrieval lane input.`);
  const text = optionalBoundedString(input.text, `${label}.text`);
  const noteId = input.noteId === undefined
    ? undefined
    : confinedRelativePath(input.noteId, `${label}.noteId`);

  let metadata: EvaluationRetrievalInputs["metadata"];
  if (input.metadata !== undefined) {
    const metadataInput = record(input.metadata, `${label}.metadata`);
    strictKeys(metadataInput, ["filters", "tags"], `${label}.metadata`);
    const filtersInput = metadataInput.filters ?? [];
    if (!Array.isArray(filtersInput) || filtersInput.length > 32) {
      throw new TypeError(`${label}.metadata.filters must have at most 32 entries.`);
    }
    const filters = filtersInput.map((entry, index) =>
      parseMetadataFilter(entry, queryIndex, index));
    const tags = optionalStringList(metadataInput.tags, `${label}.metadata.tags`, 32);
    if (filters.length === 0 && tags.length === 0) {
      throw new TypeError(`${label}.metadata must contain a filter or tag.`);
    }
    metadata = Object.freeze({ filters: Object.freeze(filters), tags });
  }

  let graph: EvaluationRetrievalInputs["graph"];
  if (input.graph !== undefined) {
    const graphInput = record(input.graph, `${label}.graph`);
    strictKeys(graphInput, ["seeds", "depth"], `${label}.graph`);
    const seeds = stringArray(graphInput.seeds, `${label}.graph.seeds`, 10).map((seed, index) =>
      confinedRelativePath(seed, `${label}.graph.seeds[${index}]`));
    if (graphInput.depth !== 1 && graphInput.depth !== 2) {
      throw new TypeError(`${label}.graph.depth must be 1 or 2.`);
    }
    graph = Object.freeze({ seeds: Object.freeze(seeds), depth: graphInput.depth });
  }

  let context: EvaluationRetrievalInputs["context"];
  if (input.context !== undefined) {
    const contextInput = record(input.context, `${label}.context`);
    strictKeys(contextInput, ["repositoryPath"], `${label}.context`);
    context = Object.freeze({
      repositoryPath: confinedRelativePath(
        contextInput.repositoryPath,
        `${label}.context.repositoryPath`,
        true,
      ),
    });
  }

  let history: EvaluationRetrievalInputs["history"];
  if (input.history !== undefined) {
    const historyInput = record(input.history, `${label}.history`);
    strictKeys(historyInput, ["query", "noteIds"], `${label}.history`);
    const noteIds = optionalStringList(historyInput.noteIds, `${label}.history.noteIds`, 100)
      .map((id, index) => confinedRelativePath(id, `${label}.history.noteIds[${index}]`));
    history = Object.freeze({
      query: boundedString(historyInput.query, `${label}.history.query`, 2_048),
      noteIds: Object.freeze(noteIds),
    });
  }
  const parsed = {
    ...(text === undefined ? {} : { text }),
    ...(noteId === undefined ? {} : { noteId }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(graph === undefined ? {} : { graph }),
    ...(context === undefined ? {} : { context }),
    ...(history === undefined ? {} : { history }),
  };
  if (Object.keys(parsed).length === 0) {
    throw new TypeError(`${label} must define at least one retrieval lane input.`);
  }
  return Object.freeze(parsed);
}

function parseQuery(
  value: unknown,
  index: number,
  assessorIds: ReadonlySet<string>,
): EvaluationQuery {
  const label = `queries[${index}]`;
  const input = record(value, label);
  strictKeys(
    input,
    ["id", "text", "class", "split", "answer", "inputs", "qrels", "assessorIds", "adjudication"],
    label,
  );
  if (typeof input.class !== "string" || !queryClasses.has(input.class as EvaluationQueryClass)) {
    throw new TypeError(`${label}.class is not a supported query class.`);
  }
  if (input.split !== "development" && input.split !== "test") {
    throw new TypeError(`${label}.split must be development or test.`);
  }
  if (input.answer !== "answerable" && input.answer !== "no-answer") {
    throw new TypeError(`${label}.answer must be answerable or no-answer.`);
  }
  if (!Array.isArray(input.qrels) || input.qrels.length > MAX_EVALUATION_QRELS_PER_QUERY) {
    throw new TypeError(`${label}.qrels must have at most ${MAX_EVALUATION_QRELS_PER_QUERY} entries.`);
  }
  const qrels = input.qrels.map((entry, qrelIndex) => parseQrel(entry, index, qrelIndex));
  const documentIds = qrels.map(({ documentId }) => documentId);
  if (new Set(documentIds).size !== documentIds.length) {
    throw new TypeError(`${label}.qrels must not repeat a document ID.`);
  }
  const queryAssessorIds = stringArray(input.assessorIds, `${label}.assessorIds`);
  for (const id of queryAssessorIds) {
    if (!assessorIds.has(id)) throw new TypeError(`${label}.assessorIds names undeclared assessor ${id}.`);
  }
  if (input.answer === "answerable" && !qrels.some(({ relevance }) => relevance > 0)) {
    throw new TypeError(`${label} is answerable but has no positive relevance judgment.`);
  }
  if (input.answer === "no-answer" && qrels.some(({ relevance }) => relevance > 0)) {
    throw new TypeError(`${label} is no-answer but has a positive relevance judgment.`);
  }
  return Object.freeze({
    id: boundedString(input.id, `${label}.id`, 256),
    text: boundedString(input.text, `${label}.text`),
    class: input.class as EvaluationQueryClass,
    split: input.split,
    answer: input.answer,
    inputs: parseRetrievalInputs(input.inputs, index),
    qrels: Object.freeze(qrels),
    assessorIds: queryAssessorIds,
    adjudication: parseAdjudication(input.adjudication, index, assessorIds),
  });
}

/** Parse a strict, versioned real-corpus evaluation definition from unknown input. */
export function parseRetrievalEvaluationCorpus(inputValue: unknown): RetrievalEvaluationCorpus {
  const input = record(inputValue, "evaluation corpus");
  strictKeys(input, ["schemaVersion", "id", "description", "frozen", "assessment", "queries"], "evaluation corpus");
  if (input.schemaVersion !== RETRIEVAL_EVALUATION_SCHEMA_VERSION) {
    throw new TypeError(`evaluation corpus schemaVersion must be ${RETRIEVAL_EVALUATION_SCHEMA_VERSION}.`);
  }
  const frozenInput = record(input.frozen, "frozen");
  strictKeys(frozenInput, ["repositoryCommit", "vaultTree", "vaultRoot"], "frozen");
  if (typeof frozenInput.repositoryCommit !== "string" || !objectIdPattern.test(frozenInput.repositoryCommit)) {
    throw new TypeError("frozen.repositoryCommit must be a lowercase Git object ID.");
  }
  if (typeof frozenInput.vaultTree !== "string" || !objectIdPattern.test(frozenInput.vaultTree)) {
    throw new TypeError("frozen.vaultTree must be a lowercase Git object ID.");
  }
  const assessmentInput = record(input.assessment, "assessment");
  strictKeys(assessmentInput, ["rubricVersion", "assessors"], "assessment");
  if (!Array.isArray(assessmentInput.assessors) || assessmentInput.assessors.length < 1 || assessmentInput.assessors.length > 100) {
    throw new TypeError("assessment.assessors must have from 1 through 100 entries.");
  }
  const assessors = assessmentInput.assessors.map(parseAssessor);
  const assessorIdList = assessors.map(({ id }) => id);
  if (new Set(assessorIdList).size !== assessorIdList.length) {
    throw new TypeError("assessment.assessors must not repeat an ID.");
  }
  if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > MAX_EVALUATION_QUERIES) {
    throw new TypeError(`queries must have from 1 through ${MAX_EVALUATION_QUERIES} entries.`);
  }
  const assessorIds = new Set(assessorIdList);
  const queries = input.queries.map((entry, index) => parseQuery(entry, index, assessorIds));
  const queryIds = queries.map(({ id }) => id);
  if (new Set(queryIds).size !== queryIds.length) throw new TypeError("queries must not repeat an ID.");
  if (!queries.some(({ split }) => split === "development") || !queries.some(({ split }) => split === "test")) {
    throw new TypeError("evaluation corpus must contain both development and test queries.");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: boundedString(input.id, "id", 256),
    description: boundedString(input.description, "description"),
    frozen: Object.freeze({
      repositoryCommit: frozenInput.repositoryCommit,
      vaultTree: frozenInput.vaultTree,
      vaultRoot: frozenVaultRoot(frozenInput.vaultRoot),
    }),
    assessment: Object.freeze({
      rubricVersion: boundedString(assessmentInput.rubricVersion, "assessment.rubricVersion", 256),
      assessors: Object.freeze(assessors),
    }),
    queries: Object.freeze(queries),
  });
}

export type EvaluationRawHit = {
  readonly documentId: string;
  /** Raw rank assigned by the retriever before KB evaluation. */
  readonly rank: number;
  readonly score?: number;
  readonly evidence?: unknown;
};

export type EvaluationDiagnostic = {
  readonly lane: string;
  readonly status: "degraded" | "ready" | "unavailable";
  readonly message?: string;
};

export type EvaluationRetrieverResult = {
  readonly status: "degraded" | "ready" | "unavailable";
  readonly hits: readonly EvaluationRawHit[];
  readonly diagnostics?: readonly EvaluationDiagnostic[];
  readonly timings?: Readonly<Record<string, number>>;
  /** Optional raw resource counters. Units belong in the key, such as cpuUserMs. */
  readonly resources?: Readonly<Record<string, number>>;
};

export type EvaluationRetriever = {
  readonly id: string;
  readonly retrieve: (request: {
    readonly corpus: RetrievalEvaluationCorpus["frozen"];
    readonly query: EvaluationQuery;
    readonly limit: number;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
};

export type EvaluationRunFailure = {
  readonly kind: "exception" | "invalid-result" | "timeout";
  readonly message: string;
};

export type EvaluationRun = {
  readonly retrieverId: string;
  readonly queryId: string;
  readonly queryClass: EvaluationQueryClass;
  readonly split: EvaluationSplit;
  readonly status: "degraded" | "failed" | "ready" | "unavailable";
  readonly hits: readonly EvaluationRawHit[];
  readonly diagnostics: readonly EvaluationDiagnostic[];
  readonly timing: {
    readonly elapsedMs: number;
    readonly backend: Readonly<Record<string, number>>;
  };
  /** Raw bounded counters only; reports do not aggregate unlike units. */
  readonly resources: Readonly<Record<string, number>>;
  readonly failure?: EvaluationRunFailure;
};

function nonnegativeNumberMap(
  value: unknown,
  label: string,
): Readonly<Record<string, number>> {
  const input = value === undefined ? {} : record(value, label);
  if (Object.keys(input).length > 32) throw new TypeError(`${label} may have at most 32 fields.`);
  const output: Record<string, number> = {};
  for (const [rawKey, candidate] of Object.entries(input).toSorted(([left], [right]) =>
    left.localeCompare(right))) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new TypeError(`${label} ${rawKey} must be a non-negative finite number.`);
    }
    output[boundedString(rawKey, `${label} key`, 256)] = candidate;
  }
  return Object.freeze(output);
}

function jsonEvidence(value: unknown, label: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, candidate: unknown) =>
      typeof candidate === "string" ? redactEvaluationMachinePaths(candidate) : candidate);
  } catch (error: unknown) {
    throw new TypeError(`${label} must be JSON-serializable.`, { cause: error });
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EVALUATION_EVIDENCE_BYTES) {
    throw new TypeError(`${label} must serialize to at most ${MAX_EVALUATION_EVIDENCE_BYTES} UTF-8 bytes.`);
  }
  return JSON.parse(serialized) as unknown;
}

function parseRetrieverResult(value: unknown, limit: number): EvaluationRetrieverResult {
  const input = record(value, "retriever result");
  strictKeys(input, ["status", "hits", "diagnostics", "timings", "resources"], "retriever result");
  if (input.status !== "ready" && input.status !== "degraded" && input.status !== "unavailable") {
    throw new TypeError("retriever result status must be ready, degraded, or unavailable.");
  }
  if (!Array.isArray(input.hits) || input.hits.length > limit) {
    throw new TypeError(`retriever result must have at most ${limit} hits.`);
  }
  const hits = input.hits.map((entry, index): EvaluationRawHit => {
    const label = `retriever result hits[${index}]`;
    const hit = record(entry, label);
    strictKeys(hit, ["documentId", "rank", "score", "evidence"], label);
    if (!Number.isSafeInteger(hit.rank) || (hit.rank as number) < 1 || (hit.rank as number) > MAX_EVALUATION_RESULTS_PER_QUERY) {
      throw new TypeError(`${label}.rank must be an integer from 1 through ${MAX_EVALUATION_RESULTS_PER_QUERY}.`);
    }
    if (hit.score !== undefined && (typeof hit.score !== "number" || !Number.isFinite(hit.score))) {
      throw new TypeError(`${label}.score must be a finite number.`);
    }
    return Object.freeze({
      documentId: boundedString(hit.documentId, `${label}.documentId`),
      rank: hit.rank as number,
      ...(hit.score === undefined ? {} : { score: hit.score }),
      ...(hit.evidence === undefined ? {} : { evidence: jsonEvidence(hit.evidence, `${label}.evidence`) }),
    });
  });
  if (input.status === "unavailable" && hits.length > 0) {
    throw new TypeError("unavailable retriever results may not contain hits.");
  }
  if (new Set(hits.map(({ rank }) => rank)).size !== hits.length) {
    throw new TypeError("retriever result ranks must be unique.");
  }
  if (new Set(hits.map(({ documentId }) => documentId)).size !== hits.length) {
    throw new TypeError("retriever result document IDs must be unique.");
  }
  const diagnosticsInput = input.diagnostics ?? [];
  if (!Array.isArray(diagnosticsInput) || diagnosticsInput.length > MAX_EVALUATION_DIAGNOSTICS) {
    throw new TypeError(`retriever diagnostics must have at most ${MAX_EVALUATION_DIAGNOSTICS} entries.`);
  }
  const diagnostics = diagnosticsInput.map((entry, index): EvaluationDiagnostic => {
    const label = `retriever result diagnostics[${index}]`;
    const diagnostic = record(entry, label);
    strictKeys(diagnostic, ["lane", "status", "message"], label);
    if (diagnostic.status !== "ready" && diagnostic.status !== "degraded" && diagnostic.status !== "unavailable") {
      throw new TypeError(`${label}.status must be ready, degraded, or unavailable.`);
    }
    const rawMessage = optionalBoundedString(diagnostic.message, `${label}.message`);
    const message = rawMessage === undefined
      ? undefined
      : redactEvaluationMachinePaths(rawMessage);
    return Object.freeze({
      lane: boundedString(diagnostic.lane, `${label}.lane`, 256),
      status: diagnostic.status,
      ...(message === undefined ? {} : { message }),
    });
  });
  const timings = nonnegativeNumberMap(input.timings, "retriever result timings");
  const resources = nonnegativeNumberMap(input.resources, "retriever result resources");
  return Object.freeze({
    status: input.status,
    hits: Object.freeze(hits.toSorted((left, right) => left.rank - right.rank)),
    diagnostics: Object.freeze(diagnostics),
    timings,
    resources,
  });
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactEvaluationMachinePaths(
    message.normalize("NFC").replace(/[\0\r\n]/gu, " "),
  ).slice(0, 2_000);
}

async function evaluateOne(
  corpus: RetrievalEvaluationCorpus,
  query: EvaluationQuery,
  retriever: EvaluationRetriever,
  limit: number,
  timeoutMs: number,
  now: () => number,
): Promise<EvaluationRun> {
  const controller = new AbortController();
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const retrieval = Promise.resolve().then(() => retriever.retrieve({
      corpus: corpus.frozen,
      query,
      limit,
      signal: controller.signal,
    }));
    const timed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Retriever exceeded the ${timeoutMs}-millisecond limit.`));
        reject(new Error(`Retriever exceeded the ${timeoutMs}-millisecond limit.`));
      }, timeoutMs);
    });
    const raw = await Promise.race([retrieval, timed]);
    const result = parseRetrieverResult(raw, limit);
    return Object.freeze({
      retrieverId: retriever.id,
      queryId: query.id,
      queryClass: query.class,
      split: query.split,
      status: result.status,
      hits: result.hits,
      diagnostics: result.diagnostics ?? Object.freeze([]),
      timing: Object.freeze({
        elapsedMs: Math.max(0, now() - startedAt),
        backend: result.timings ?? Object.freeze({}),
      }),
      resources: result.resources ?? Object.freeze({}),
    });
  } catch (error: unknown) {
    const timeout = controller.signal.aborted;
    return Object.freeze({
      retrieverId: retriever.id,
      queryId: query.id,
      queryClass: query.class,
      split: query.split,
      status: "failed",
      hits: Object.freeze([]),
      diagnostics: Object.freeze([]),
      timing: Object.freeze({ elapsedMs: Math.max(0, now() - startedAt), backend: Object.freeze({}) }),
      resources: Object.freeze({}),
      failure: Object.freeze({
        kind: timeout
          ? "timeout"
          : error instanceof TypeError
            ? "invalid-result"
            : "exception",
        message: shortError(error),
      }),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Execute real injected retrievers serially so local model work stays bounded. */
export async function runRetrievalEvaluation(options: {
  readonly corpus: RetrievalEvaluationCorpus;
  readonly retrievers: readonly EvaluationRetriever[];
  readonly split?: EvaluationSplit | "all";
  readonly limit?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}): Promise<readonly EvaluationRun[]> {
  if (options.retrievers.length < 1 || options.retrievers.length > MAX_EVALUATION_RETRIEVERS) {
    throw new RangeError(`Evaluation accepts from 1 through ${MAX_EVALUATION_RETRIEVERS} retrievers.`);
  }
  const retrieverIds = options.retrievers.map(({ id }) => boundedString(id, "retriever id", 256));
  if (new Set(retrieverIds).size !== retrieverIds.length) throw new TypeError("Evaluation retriever IDs must be unique.");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVALUATION_RESULTS_PER_QUERY) {
    throw new RangeError(`Evaluation result limit must be from 1 through ${MAX_EVALUATION_RESULTS_PER_QUERY}.`);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EVALUATION_TIMEOUT_MS) {
    throw new RangeError(`Evaluation timeout must be from 1 through ${MAX_EVALUATION_TIMEOUT_MS} milliseconds.`);
  }
  const split = options.split ?? "test";
  const queries = options.corpus.queries.filter((query) => split === "all" || query.split === split);
  const runs: EvaluationRun[] = [];
  for (const retriever of options.retrievers) {
    for (const query of queries) {
      runs.push(await evaluateOne(
        options.corpus,
        query,
        retriever,
        limit,
        timeoutMs,
        options.now ?? performance.now.bind(performance),
      ));
    }
  }
  return Object.freeze(runs);
}

export type EvaluationMetrics = {
  readonly recall: number | null;
  readonly reciprocalRank: number | null;
  readonly ndcg: number | null;
  readonly noAnswerAccuracy: number | null;
};

function metricsFor(query: EvaluationQuery, hits: readonly EvaluationRawHit[], cutoff: number): EvaluationMetrics {
  const ranked = hits.filter(({ rank }) => rank <= cutoff).toSorted((left, right) => left.rank - right.rank);
  if (query.answer === "no-answer") {
    return Object.freeze({
      recall: null,
      reciprocalRank: null,
      ndcg: null,
      noAnswerAccuracy: ranked.length === 0 ? 1 : 0,
    });
  }
  const relevance = new Map(query.qrels.map((qrel) => [qrel.documentId, qrel.relevance]));
  const relevantIds = new Set(query.qrels.filter(({ relevance: value }) => value > 0).map(({ documentId }) => documentId));
  const retrievedRelevant = new Set(ranked.filter(({ documentId }) => relevantIds.has(documentId)).map(({ documentId }) => documentId));
  const firstRelevant = ranked.find(({ documentId }) => relevantIds.has(documentId));
  const dcg = ranked.reduce((total, hit) => {
    const grade = relevance.get(hit.documentId) ?? 0;
    return total + ((2 ** grade) - 1) / Math.log2(hit.rank + 1);
  }, 0);
  const ideal = query.qrels
    .map(({ relevance: value }) => value)
    .toSorted((left, right) => right - left)
    .slice(0, cutoff)
    .reduce<number>((total, grade, index) =>
      total + ((2 ** grade) - 1) / Math.log2(index + 2), 0);
  return Object.freeze({
    recall: retrievedRelevant.size / relevantIds.size,
    reciprocalRank: firstRelevant === undefined ? 0 : 1 / firstRelevant.rank,
    ndcg: ideal === 0 ? 0 : dcg / ideal,
    noAnswerAccuracy: null,
  });
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], proportion: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil(proportion * sorted.length) - 1);
  return sorted[index] ?? null;
}

export type PairedBootstrapInterval = {
  readonly pairs: number;
  readonly seed: number;
  readonly resamples: number;
  readonly confidence: number;
  readonly observedDifference: number;
  readonly lower: number;
  readonly upper: number;
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Query-level paired percentile bootstrap with a reproducible integer seed. */
export function pairedBootstrapConfidenceInterval(
  pairs: readonly { readonly baseline: number; readonly candidate: number }[],
  options: {
    readonly seed: number;
    readonly resamples?: number;
    readonly confidence?: number;
  },
): PairedBootstrapInterval {
  if (pairs.length < 1 || pairs.length > MAX_EVALUATION_QUERIES) {
    throw new RangeError(`Paired bootstrap accepts from 1 through ${MAX_EVALUATION_QUERIES} pairs.`);
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new RangeError("Bootstrap seed must be an unsigned 32-bit integer.");
  }
  const resamples = options.resamples ?? 10_000;
  if (!Number.isSafeInteger(resamples) || resamples < 100 || resamples > MAX_BOOTSTRAP_RESAMPLES) {
    throw new RangeError(`Bootstrap resamples must be from 100 through ${MAX_BOOTSTRAP_RESAMPLES}.`);
  }
  const confidence = options.confidence ?? 0.95;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("Bootstrap confidence must be between 0 and 1.");
  }
  for (const pair of pairs) {
    if (!Number.isFinite(pair.baseline) || !Number.isFinite(pair.candidate)) {
      throw new TypeError("Bootstrap pairs must contain finite values.");
    }
  }
  const random = seededRandom(options.seed);
  const samples: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let difference = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)];
      if (pair !== undefined) difference += pair.candidate - pair.baseline;
    }
    samples.push(difference / pairs.length);
  }
  samples.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  const lowerIndex = Math.floor(alpha * resamples);
  const upperIndex = Math.min(resamples - 1, Math.ceil((1 - alpha) * resamples) - 1);
  return Object.freeze({
    pairs: pairs.length,
    seed: options.seed,
    resamples,
    confidence,
    observedDifference: pairs.reduce((sum, pair) => sum + pair.candidate - pair.baseline, 0) / pairs.length,
    lower: samples[lowerIndex] ?? 0,
    upper: samples[upperIndex] ?? 0,
  });
}

export type EvaluationEnvironment = {
  readonly generatedAt: string;
  readonly runtime: {
    readonly bun: string;
    readonly node: string;
    readonly os: string;
    readonly arch: string;
    readonly hardware: string;
  };
  readonly model:
    | { readonly kind: "none"; readonly reason: string }
    | {
        readonly kind: "local";
        readonly id: string;
        readonly revision: string;
        readonly sha256: string;
      };
  readonly cache: {
    readonly state: "cold" | "mixed" | "not-applicable" | "warm";
    readonly fingerprint?: string;
  };
  readonly retrievers: readonly {
    readonly id: string;
    readonly version: string;
    readonly configuration: Readonly<Record<string, string | number | boolean | null>>;
  }[];
};

export type EvaluationRetrieverSummary = {
  readonly retrieverId: string;
  readonly runs: number;
  readonly ready: number;
  readonly degraded: number;
  readonly unavailable: number;
  readonly failed: number;
  readonly metrics: EvaluationMetrics;
  readonly byClass: readonly {
    readonly class: EvaluationQueryClass;
    readonly queries: number;
    readonly metrics: EvaluationMetrics;
  }[];
  readonly latencyMs: {
    readonly p50: number | null;
    readonly p90: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
};

export type EvaluationComparison = {
  readonly baselineRetrieverId: string;
  readonly candidateRetrieverId: string;
  readonly metric: keyof EvaluationMetrics;
  readonly interval: PairedBootstrapInterval;
};

export type RetrievalEvaluationReport = {
  readonly schemaVersion: 1;
  readonly corpus: RetrievalEvaluationCorpus;
  readonly environment: EvaluationEnvironment;
  /** Exact query partition represented by every retriever in this report. */
  readonly split: EvaluationSplit | "all";
  readonly queryCount: number;
  readonly cutoff: number;
  readonly summaries: readonly EvaluationRetrieverSummary[];
  readonly comparisons: readonly EvaluationComparison[];
  readonly runs: readonly (EvaluationRun & { readonly metrics: EvaluationMetrics })[];
};

function validateEnvironment(
  environment: EvaluationEnvironment,
  expectedRetrieverIds: readonly string[],
): EvaluationEnvironment {
  const timestamp = new Date(environment.generatedAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== environment.generatedAt) {
    throw new TypeError("Evaluation environment generatedAt must be a canonical ISO timestamp.");
  }
  if (environment.model.kind === "local" && !sha256Pattern.test(environment.model.sha256)) {
    throw new TypeError("Evaluation model sha256 must be 64 lowercase hexadecimal characters.");
  }
  const runtime = Object.freeze({
    bun: boundedString(environment.runtime.bun, "environment.runtime.bun", 256),
    node: boundedString(environment.runtime.node, "environment.runtime.node", 256),
    os: boundedString(environment.runtime.os, "environment.runtime.os", 256),
    arch: boundedString(environment.runtime.arch, "environment.runtime.arch", 256),
    hardware: boundedString(environment.runtime.hardware, "environment.runtime.hardware"),
  });
  const model = environment.model.kind === "none"
    ? Object.freeze({
        kind: "none" as const,
        reason: boundedString(environment.model.reason, "environment.model.reason"),
      })
    : Object.freeze({
        kind: "local" as const,
        id: boundedString(environment.model.id, "environment.model.id", 256),
        revision: boundedString(environment.model.revision, "environment.model.revision", 512),
        sha256: environment.model.sha256,
      });
  const fingerprint = environment.cache.fingerprint === undefined
    ? undefined
    : boundedString(environment.cache.fingerprint, "environment.cache.fingerprint", 512);
  if (
    environment.cache.state !== "cold"
    && environment.cache.state !== "mixed"
    && environment.cache.state !== "not-applicable"
    && environment.cache.state !== "warm"
  ) throw new TypeError("environment.cache.state is invalid.");
  if (
    environment.retrievers.length < 1
    || environment.retrievers.length > MAX_EVALUATION_RETRIEVERS
  ) throw new TypeError(`environment.retrievers must have from 1 through ${MAX_EVALUATION_RETRIEVERS} entries.`);
  const retrievers = environment.retrievers.map((retriever, index) => {
    const id = boundedString(retriever.id, `environment.retrievers[${index}].id`, 256);
    const entries = Object.entries(retriever.configuration);
    if (entries.length > 64) {
      throw new TypeError(`environment.retrievers[${index}].configuration may have at most 64 fields.`);
    }
    const configuration: Record<string, string | number | boolean | null> = {};
    for (const [rawKey, value] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
      const key = boundedString(rawKey, `environment.retrievers[${index}] configuration key`, 256);
      if (
        value !== null
        && typeof value !== "string"
        && typeof value !== "number"
        && typeof value !== "boolean"
      ) throw new TypeError(`environment.retrievers[${index}].configuration.${key} is not scalar.`);
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`environment.retrievers[${index}].configuration.${key} must be finite.`);
      }
      configuration[key] = typeof value === "string"
        ? boundedString(value, `environment.retrievers[${index}].configuration.${key}`)
        : value;
    }
    return Object.freeze({
      id,
      version: boundedString(retriever.version, `environment.retrievers[${index}].version`, 512),
      configuration: Object.freeze(configuration),
    });
  }).toSorted((left, right) => left.id.localeCompare(right.id));
  const environmentIds = retrievers.map(({ id }) => id);
  if (new Set(environmentIds).size !== environmentIds.length) {
    throw new TypeError("environment.retrievers must not repeat an ID.");
  }
  if (
    environmentIds.length !== expectedRetrieverIds.length
    || environmentIds.some((id, index) => id !== expectedRetrieverIds[index])
  ) throw new TypeError("environment.retrievers must exactly describe the report retrievers.");
  return Object.freeze({
    generatedAt: environment.generatedAt,
    runtime,
    model,
    cache: Object.freeze({
      state: environment.cache.state,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    }),
    retrievers: Object.freeze(retrievers),
  });
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function metricValues(
  rows: readonly { readonly metrics: EvaluationMetrics }[],
): EvaluationMetrics {
  const values = <K extends keyof EvaluationMetrics>(key: K): number[] =>
    rows.flatMap(({ metrics }) => {
      const value = metrics[key];
      return value === null ? [] : [value];
    });
  return Object.freeze({
    recall: average(values("recall")),
    reciprocalRank: average(values("reciprocalRank")),
    ndcg: average(values("ndcg")),
    noAnswerAccuracy: average(values("noAnswerAccuracy")),
  });
}

function failedMetricsFor(query: EvaluationQuery): EvaluationMetrics {
  return query.answer === "no-answer"
    ? Object.freeze({ recall: null, reciprocalRank: null, ndcg: null, noAnswerAccuracy: 0 })
    : Object.freeze({ recall: 0, reciprocalRank: 0, ndcg: 0, noAnswerAccuracy: null });
}

/** Build the canonical raw-and-aggregate report without executing a model. */
export function buildRetrievalEvaluationReport(options: {
  readonly corpus: RetrievalEvaluationCorpus;
  readonly runs: readonly EvaluationRun[];
  readonly environment: EvaluationEnvironment;
  readonly cutoff?: number;
  readonly baselineRetrieverId?: string;
  readonly bootstrapSeed?: number;
  readonly bootstrapResamples?: number;
}): RetrievalEvaluationReport {
  const cutoff = options.cutoff ?? 10;
  if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff > MAX_EVALUATION_RESULTS_PER_QUERY) {
    throw new RangeError(`Evaluation cutoff must be from 1 through ${MAX_EVALUATION_RESULTS_PER_QUERY}.`);
  }
  const queryById = new Map(options.corpus.queries.map((query) => [query.id, query]));
  if (options.runs.length < 1) throw new TypeError("Evaluation report requires at least one run.");
  const runSplits = [...new Set(options.runs.map(({ split }) => split))].toSorted();
  const split: EvaluationSplit | "all" = runSplits.length === 1
    ? runSplits[0] ?? "all"
    : "all";
  const expectedQueries = options.corpus.queries.filter((query) =>
    split === "all" || query.split === split);
  const expectedQueryIds = expectedQueries.map(({ id }) => id);
  const seen = new Set<string>();
  const measured = options.runs.map((run) => {
    const query = queryById.get(run.queryId);
    if (query === undefined) throw new TypeError(`Evaluation run names unknown query ${run.queryId}.`);
    if (run.queryClass !== query.class || run.split !== query.split) {
      throw new TypeError(`Evaluation run metadata does not match query ${run.queryId}.`);
    }
    if (!Number.isFinite(run.timing.elapsedMs) || run.timing.elapsedMs < 0) {
      throw new TypeError(`Evaluation run ${run.retrieverId}/${run.queryId} has invalid elapsed time.`);
    }
    const backend = nonnegativeNumberMap(
      run.timing.backend,
      `Evaluation run ${run.retrieverId}/${run.queryId} backend timings`,
    );
    const resources = nonnegativeNumberMap(
      run.resources,
      `Evaluation run ${run.retrieverId}/${run.queryId} resources`,
    );
    const hits = Object.freeze(run.hits.map((hit, index) => Object.freeze({
      ...hit,
      ...(hit.evidence === undefined
        ? {}
        : {
            evidence: jsonEvidence(
              hit.evidence,
              `Evaluation run ${run.retrieverId}/${run.queryId} hits[${index}].evidence`,
            ),
          }),
    })));
    const diagnostics = Object.freeze(run.diagnostics.map((diagnostic) => Object.freeze({
      ...diagnostic,
      ...(diagnostic.message === undefined
        ? {}
        : { message: redactEvaluationMachinePaths(diagnostic.message) }),
    })));
    const failure = run.failure === undefined
      ? undefined
      : Object.freeze({
          ...run.failure,
          message: redactEvaluationMachinePaths(run.failure.message),
        });
    const key = `${run.retrieverId}\0${run.queryId}`;
    if (seen.has(key)) throw new TypeError(`Evaluation runs repeat ${run.retrieverId}/${run.queryId}.`);
    seen.add(key);
    return Object.freeze({
      ...run,
      hits,
      diagnostics,
      timing: Object.freeze({ elapsedMs: run.timing.elapsedMs, backend }),
      resources,
      ...(failure === undefined ? {} : { failure }),
      metrics: run.status === "failed" || run.status === "unavailable"
        ? failedMetricsFor(query)
        : metricsFor(query, hits, cutoff),
    });
  }).toSorted((left, right) =>
    left.retrieverId.localeCompare(right.retrieverId)
      || options.corpus.queries.findIndex(({ id }) => id === left.queryId)
        - options.corpus.queries.findIndex(({ id }) => id === right.queryId));
  const retrieverIds = [...new Set(measured.map(({ retrieverId }) => retrieverId))].toSorted();
  for (const retrieverId of retrieverIds) {
    const actualQueryIds = measured
      .filter((run) => run.retrieverId === retrieverId)
      .map(({ queryId }) => queryId);
    if (
      actualQueryIds.length !== expectedQueryIds.length
      || actualQueryIds.some((id, index) => id !== expectedQueryIds[index])
    ) {
      throw new TypeError(
        `Evaluation retriever ${retrieverId} must contain exactly the ${expectedQueryIds.length} ${split} query runs.`,
      );
    }
  }
  const summaries = retrieverIds.map((retrieverId): EvaluationRetrieverSummary => {
    const rows = measured.filter((run) => run.retrieverId === retrieverId);
    const classes = [...new Set(rows.map(({ queryClass }) => queryClass))].toSorted();
    const latencies = rows.map(({ timing }) => timing.elapsedMs);
    return Object.freeze({
      retrieverId,
      runs: rows.length,
      ready: rows.filter(({ status }) => status === "ready").length,
      degraded: rows.filter(({ status }) => status === "degraded").length,
      unavailable: rows.filter(({ status }) => status === "unavailable").length,
      failed: rows.filter(({ status }) => status === "failed").length,
      metrics: metricValues(rows),
      byClass: Object.freeze(classes.map((queryClass) => {
        const classRows = rows.filter((row) => row.queryClass === queryClass);
        return Object.freeze({
          class: queryClass,
          queries: classRows.length,
          metrics: metricValues(classRows),
        });
      })),
      latencyMs: Object.freeze({
        p50: percentile(latencies, 0.5),
        p90: percentile(latencies, 0.9),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
      }),
    });
  });
  const comparisons: EvaluationComparison[] = [];
  const baseline = options.baselineRetrieverId;
  if (baseline !== undefined) {
    if (!retrieverIds.includes(baseline)) throw new TypeError(`Unknown baseline retriever ${baseline}.`);
    const metricNames: readonly (keyof EvaluationMetrics)[] = [
      "recall",
      "reciprocalRank",
      "ndcg",
      "noAnswerAccuracy",
    ];
    for (const candidate of retrieverIds.filter((id) => id !== baseline)) {
      for (const metric of metricNames) {
        const pairs = expectedQueries.flatMap(({ id }) => {
          const baselineRow = measured.find((row) => row.retrieverId === baseline && row.queryId === id);
          const candidateRow = measured.find((row) => row.retrieverId === candidate && row.queryId === id);
          const baselineValue = baselineRow?.metrics[metric];
          const candidateValue = candidateRow?.metrics[metric];
          return baselineValue === null
            || baselineValue === undefined
            || candidateValue === null
            || candidateValue === undefined
            ? []
            : [{ baseline: baselineValue, candidate: candidateValue }];
        });
        if (pairs.length === 0) continue;
        const seed = ((options.bootstrapSeed ?? 1) ^ hashSeed(`${candidate}\0${metric}`)) >>> 0;
        comparisons.push(Object.freeze({
          baselineRetrieverId: baseline,
          candidateRetrieverId: candidate,
          metric,
          interval: pairedBootstrapConfidenceInterval(pairs, {
            seed,
            ...(options.bootstrapResamples === undefined
              ? {}
              : { resamples: options.bootstrapResamples }),
          }),
        }));
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    corpus: options.corpus,
    environment: validateEnvironment(options.environment, retrieverIds),
    split,
    queryCount: expectedQueries.length,
    cutoff,
    summaries: Object.freeze(summaries),
    comparisons: Object.freeze(comparisons),
    runs: Object.freeze(measured),
  });
}
