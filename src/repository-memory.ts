import { lstat, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { normalizeRepositoryScope } from "./agent-context.js";
import type { MetadataObject, Note } from "./graph.js";

export const repositoryScopesMetadataKey = "repository_scopes";
export const MAX_REPOSITORY_SCOPES = 16;
export const MAX_REPOSITORY_SCOPE_UTF8_BYTES = 1_024;
export const MAX_REPOSITORY_SCOPES_UTF8_BYTES = 8 * 1_024;
export const DEFAULT_REPOSITORY_MEMORY_GROUP_LIMIT = 10;
export const MAX_REPOSITORY_MEMORY_GROUP_LIMIT = 100;
export const DEFAULT_REPOSITORY_MEMORY_DETAIL_LIMIT = 20;
export const MAX_REPOSITORY_MEMORY_DETAIL_LIMIT = 100;
export const MAX_REPOSITORY_MEMORY_SUMMARY_UTF8_BYTES = 2 * 1_024;

export const activePlanStatuses = [
  "proposed",
  "accepted",
  "in-progress",
  "blocked",
] as const;

export const terminalPlanStatuses = [
  "completed",
  "superseded",
  "cancelled",
] as const;

export const planStatuses = [
  ...activePlanStatuses,
  ...terminalPlanStatuses,
] as const;

export type ActivePlanStatus = typeof activePlanStatuses[number];
export type TerminalPlanStatus = typeof terminalPlanStatuses[number];
export type PlanStatus = typeof planStatuses[number];

const activeStatusSet: ReadonlySet<string> = new Set(activePlanStatuses);
const terminalStatusSet: ReadonlySet<string> = new Set(terminalPlanStatuses);
const drivePathPattern = /^[A-Za-z]:/u;
const globCharacterPattern = /[*?[\]{}]/u;

export function isActivePlanStatus(value: unknown): value is ActivePlanStatus {
  return typeof value === "string" && activeStatusSet.has(value);
}

export function isTerminalPlanStatus(value: unknown): value is TerminalPlanStatus {
  return typeof value === "string" && terminalStatusSet.has(value);
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return isActivePlanStatus(value) || isTerminalPlanStatus(value);
}

export type RepositoryScopeValidationCode =
  | "absolute"
  | "case-fold-collision"
  | "control-character"
  | "duplicate"
  | "empty"
  | "glob"
  | "noncanonical"
  | "not-array"
  | "not-string"
  | "scope-bytes"
  | "scope-count"
  | "total-bytes"
  | "traversal";

export type RepositoryScopeValidationIssue = {
  readonly code: RepositoryScopeValidationCode;
  readonly message: string;
  readonly index?: number;
  readonly value?: unknown;
};

export class RepositoryScopesError extends TypeError {
  readonly issues: readonly RepositoryScopeValidationIssue[];

  constructor(label: string, issues: readonly RepositoryScopeValidationIssue[]) {
    super(`${label} is invalid: ${issues.map(({ message }) => message).join(" ")}`);
    this.name = "RepositoryScopesError";
    this.issues = issues;
  }
}

function formattedBytes(value: number): string {
  return value.toLocaleString("en-US");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point !== undefined
      && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function pathValidationCode(value: string): RepositoryScopeValidationCode {
  if (value.trim() === "") return "empty";
  if (hasControlCharacter(value)) return "control-character";
  if (/^[\\/]/u.test(value) || drivePathPattern.test(value)) return "absolute";
  if (globCharacterPattern.test(value)) return "glob";
  if (value.replaceAll("\\", "/").split("/").includes("..")) return "traversal";
  return "noncanonical";
}

/**
 * Validate one already-authored canonical repository-relative file or directory path.
 *
 * Unlike `normalizeRepositoryScope`, this function never repairs input. Callers get
 * back the exact string they supplied or a stable validation failure.
 */
export function canonicalRepositoryPath(value: string, label = "Repository scope"): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_REPOSITORY_SCOPE_UTF8_BYTES) {
    throw new RangeError(
      `${label} must be at most ${formattedBytes(MAX_REPOSITORY_SCOPE_UTF8_BYTES)} UTF-8 bytes.`,
    );
  }
  let canonical: string;
  try {
    canonical = normalizeRepositoryScope(value);
  } catch (error) {
    throw new RepositoryScopesError(label, [{
      code: pathValidationCode(value),
      value,
      message: error instanceof Error ? error.message : `${label} is invalid.`,
    }]);
  }
  if (canonical !== value) {
    throw new RepositoryScopesError(label, [{
      code: "noncanonical",
      value,
      message: `${label} must use its exact NFC-normalized POSIX form ${JSON.stringify(canonical)}.`,
    }]);
  }
  return value;
}

export type RepositoryScopesAnalysis =
  | {
      readonly present: false;
      readonly valid: true;
      readonly scopes: readonly [];
      readonly issues: readonly [];
    }
  | {
      readonly present: true;
      readonly valid: boolean;
      readonly scopes: readonly string[];
      readonly issues: readonly RepositoryScopeValidationIssue[];
    };

function analyzeScopeArray(
  value: unknown,
  options: { readonly allowEmpty: boolean; readonly label: string },
): RepositoryScopesAnalysis {
  if (!Array.isArray(value)) {
    return {
      present: true,
      valid: false,
      scopes: [],
      issues: [{
        code: "not-array",
        value,
        message: `${options.label} must be an array of canonical repository paths.`,
      }],
    };
  }
  const issues: RepositoryScopeValidationIssue[] = [];
  if (!options.allowEmpty && value.length === 0) {
    issues.push({
      code: "empty",
      message: `${options.label} must contain at least one repository path when present.`,
    });
  }
  if (value.length > MAX_REPOSITORY_SCOPES) {
    issues.push({
      code: "scope-count",
      message: `${options.label} may contain at most ${MAX_REPOSITORY_SCOPES} paths.`,
    });
  }

  let totalBytes = 0;
  const scopes: string[] = [];
  const exact = new Map<string, number>();
  const folded = new Map<string, { readonly scope: string; readonly index: number }>();
  for (let index = 0; index < Math.min(value.length, MAX_REPOSITORY_SCOPES); index += 1) {
    const candidate: unknown = value[index];
    if (typeof candidate !== "string") {
      issues.push({
        code: "not-string",
        index,
        value: candidate,
        message: `${options.label} entry ${index + 1} must be a string.`,
      });
      continue;
    }
    const bytes = Buffer.byteLength(candidate, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_REPOSITORY_SCOPE_UTF8_BYTES) {
      issues.push({
        code: "scope-bytes",
        index,
        value: candidate,
        message: `${options.label} entry ${index + 1} must be at most `
          + `${formattedBytes(MAX_REPOSITORY_SCOPE_UTF8_BYTES)} UTF-8 bytes.`,
      });
      continue;
    }
    try {
      canonicalRepositoryPath(candidate, `${options.label} entry ${index + 1}`);
    } catch (error) {
      if (error instanceof RepositoryScopesError) {
        issues.push(...error.issues.map((issue) => ({ ...issue, index })));
      } else {
        issues.push({
          code: "noncanonical",
          index,
          value: candidate,
          message: error instanceof Error ? error.message : "The repository path is invalid.",
        });
      }
      continue;
    }
    const duplicate = exact.get(candidate);
    if (duplicate !== undefined) {
      issues.push({
        code: "duplicate",
        index,
        value: candidate,
        message: `${options.label} entries ${duplicate + 1} and ${index + 1} are duplicates.`,
      });
      continue;
    }
    exact.set(candidate, index);
    const caseFolded = candidate.toLocaleLowerCase("en-US");
    const collision = folded.get(caseFolded);
    if (collision !== undefined && collision.scope !== candidate) {
      issues.push({
        code: "case-fold-collision",
        index,
        value: candidate,
        message: `${options.label} entries ${collision.index + 1} and ${index + 1} collide under case folding.`,
      });
      continue;
    }
    folded.set(caseFolded, { scope: candidate, index });
    scopes.push(candidate);
  }
  if (totalBytes > MAX_REPOSITORY_SCOPES_UTF8_BYTES) {
    issues.push({
      code: "total-bytes",
      message: `${options.label} may contain at most `
        + `${formattedBytes(MAX_REPOSITORY_SCOPES_UTF8_BYTES)} UTF-8 bytes in total.`,
    });
  }
  return {
    present: true,
    valid: issues.length === 0,
    scopes,
    issues,
  };
}

/** Parse the exact authored `repository_scopes` field without key or value folding. */
export function analyzeAuthoredRepositoryScopes(
  metadata: MetadataObject,
): RepositoryScopesAnalysis {
  const exactKeys = Object.keys(metadata).filter((key) =>
    key.toLocaleLowerCase("en-US") === repositoryScopesMetadataKey);
  if (exactKeys.length === 0) {
    return { present: false, valid: true, scopes: [], issues: [] };
  }
  if (exactKeys.length !== 1 || exactKeys[0] !== repositoryScopesMetadataKey) {
    return {
      present: true,
      valid: false,
      scopes: [],
      issues: [{
        code: "noncanonical",
        message: `Repository scope metadata must use the exact key ${repositoryScopesMetadataKey}.`,
      }],
    };
  }
  return analyzeScopeArray(metadata[repositoryScopesMetadataKey], {
    allowEmpty: false,
    label: repositoryScopesMetadataKey,
  });
}

/** Validate an API selection of exact authored scopes. An empty selection disables filtering. */
export function validateRepositoryScopeSelection(value: unknown): readonly string[] {
  const analysis = analyzeScopeArray(value, {
    allowEmpty: true,
    label: "Repository scope selection",
  });
  if (!analysis.valid) throw new RepositoryScopesError("Repository scope selection", analysis.issues);
  return analysis.scopes;
}

/** True when a canonical declaration is the exact path or a segment ancestor of a full path. */
export function repositoryScopeMatchesPath(scope: string, fullPath: string): boolean {
  const checkedScope = canonicalRepositoryPath(scope, "Repository scope");
  const checkedPath = canonicalRepositoryPath(fullPath, "Repository path");
  return checkedScope === "."
    || checkedScope === checkedPath
    || checkedPath.startsWith(`${checkedScope}/`);
}

export type RepositoryScopeMatch = {
  readonly scope: string;
  readonly kind: "ancestor" | "exact";
  readonly depth: number;
};

function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

/** Return the deepest exact-or-ancestor declaration for a full repository path. */
export function deepestRepositoryScopeMatch(
  scopes: readonly string[],
  fullPath: string,
): RepositoryScopeMatch | null {
  const checkedScopes = validateRepositoryScopeSelection(scopes);
  const checkedPath = canonicalRepositoryPath(fullPath, "Repository path");
  const matches = checkedScopes
    .filter((scope) => repositoryScopeMatchesPath(scope, checkedPath))
    .map((scope): RepositoryScopeMatch => ({
      scope,
      kind: scope === checkedPath ? "exact" : "ancestor",
      depth: scopeDepth(scope),
    }))
    .toSorted((left, right) =>
      right.depth - left.depth || left.scope.localeCompare(right.scope));
  return matches[0] ?? null;
}

/** Match any selected value against a record's valid declarations, exactly and case-sensitively. */
export function metadataMatchesExactRepositoryScopes(
  metadata: MetadataObject,
  selectedScopes: readonly string[],
): boolean {
  const selected = validateRepositoryScopeSelection(selectedScopes);
  if (selected.length === 0) return true;
  const authored = analyzeAuthoredRepositoryScopes(metadata);
  if (!authored.present || !authored.valid) return false;
  const declarations = new Set(authored.scopes);
  return selected.some((scope) => declarations.has(scope));
}

function isMissingFileError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

function pathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export type RepositoryScopeFilesystemState =
  | {
      readonly status: "present";
      readonly scope: string;
      readonly kind: "directory" | "file";
    }
  | {
      readonly status: "absent";
      readonly scope: string;
      readonly firstMissingPath: string;
    }
  | {
      readonly status: "invalid";
      readonly scope: string;
      readonly path: string;
      readonly reason: "ancestor-not-directory" | "symlink" | "unsupported-type";
    };

async function canonicalRepositoryRoot(rootInput: string): Promise<string> {
  const root = await realpath(resolve(rootInput));
  const metadata = await lstat(root);
  if (!metadata.isDirectory()) throw new TypeError("The repository root must be a directory.");
  return root;
}

async function inspectScopeAtRoot(
  root: string,
  scope: string,
): Promise<RepositoryScopeFilesystemState> {
  if (scope === ".") return { status: "present", scope, kind: "directory" };
  let current = root;
  const traversed: string[] = [];
  const segments = scope.split("/");
  for (const [index, segment] of segments.entries()) {
    traversed.push(segment);
    current = join(current, segment);
    if (!pathInside(root, current)) {
      throw new TypeError("A repository scope resolved outside the repository root.");
    }
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          status: "absent",
          scope,
          firstMissingPath: traversed.join("/"),
        };
      }
      throw error;
    }
    const repositoryPath = traversed.join("/");
    if (metadata.isSymbolicLink()) {
      return { status: "invalid", scope, path: repositoryPath, reason: "symlink" };
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      return {
        status: "invalid",
        scope,
        path: repositoryPath,
        reason: "ancestor-not-directory",
      };
    }
    if (index === segments.length - 1) {
      if (metadata.isDirectory()) return { status: "present", scope, kind: "directory" };
      if (metadata.isFile()) return { status: "present", scope, kind: "file" };
      return {
        status: "invalid",
        scope,
        path: repositoryPath,
        reason: "unsupported-type",
      };
    }
  }
  throw new Error("Repository scope inspection did not reach its final segment.");
}

/** Inspect one canonical declaration without following symlinks or repairing absent paths. */
export async function inspectRepositoryScopeState(
  repositoryRoot: string,
  scopeInput: string,
): Promise<RepositoryScopeFilesystemState> {
  const scope = canonicalRepositoryPath(scopeInput);
  return await inspectScopeAtRoot(await canonicalRepositoryRoot(repositoryRoot), scope);
}

export type RepositoryMemoryGroupKey =
  | "maintainedKnowledge"
  | "activePlans"
  | "datedResearch"
  | "reports"
  | "historicalPlans";

export const repositoryMemoryGroupKeys = [
  "maintainedKnowledge",
  "activePlans",
  "datedResearch",
  "reports",
  "historicalPlans",
] as const satisfies readonly RepositoryMemoryGroupKey[];

export type RepositoryMemoryClassification =
  | {
      readonly kind: "record";
      readonly group: RepositoryMemoryGroupKey;
      readonly current: boolean;
      readonly status?: string;
      readonly date?: string;
    }
  | { readonly kind: "ignored" }
  | {
      readonly kind: "invalid";
      readonly reason: string;
    };

function metadataString(metadata: MetadataObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

/** Classify one scoped Markdown record without consulting inferred links or search state. */
export function classifyRepositoryMemoryRecord(note: Note): RepositoryMemoryClassification {
  const type = metadataString(note.metadata, "type");
  const status = metadataString(note.metadata, "status");
  if (type === "note" || type === "concept") {
    return { kind: "record", group: "maintainedKnowledge", current: true };
  }
  if (type === "plan") {
    if (isActivePlanStatus(status)) {
      return { kind: "record", group: "activePlans", current: true, status };
    }
    if (isTerminalPlanStatus(status)) {
      return { kind: "record", group: "historicalPlans", current: false, status };
    }
    return { kind: "invalid", reason: "A scoped plan must declare one supported lifecycle status." };
  }
  if (type === "market-research") {
    const asOf = metadataString(note.metadata, "as_of");
    if (!/^projects\/[^/]+\/market\/.+\.md$/u.test(note.path)) {
      return {
        kind: "invalid",
        reason: "Scoped market research must live under projects/<domain>/market/.",
      };
    }
    if (status !== "snapshot" || asOf === undefined || !validCalendarDate(asOf)) {
      return {
        kind: "invalid",
        reason: "Scoped market research requires status snapshot and a valid as_of date.",
      };
    }
    return {
      kind: "record",
      group: "datedResearch",
      current: true,
      status,
      date: asOf,
    };
  }
  if (type === "report") {
    const generated = metadataString(note.metadata, "generated");
    if (generated === undefined || !validCalendarDate(generated)) {
      return { kind: "invalid", reason: "A scoped report requires a valid generated date." };
    }
    return {
      kind: "record",
      group: "reports",
      current: true,
      date: generated,
    };
  }
  return type === undefined
    ? { kind: "invalid", reason: "A scoped repository-memory record must declare a type." }
    : { kind: "ignored" };
}

export type RepositoryMemoryRecord = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly type: string;
  readonly status?: string;
  readonly date?: string;
  readonly area?: string;
  readonly description?: string;
  readonly repositoryScopes: readonly string[];
  readonly matchedScope: string;
  readonly match: "ancestor" | "exact";
  readonly scopeState: RepositoryScopeFilesystemState;
};

export type RepositoryMemoryGroup = {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly records: readonly RepositoryMemoryRecord[];
};

export type RepositoryMemoryInvalidRecord = {
  readonly path: string;
  readonly issues: readonly string[];
};

export type RepositoryMemoryAdvisory = {
  readonly kind: "absent-current-scope";
  readonly path: string;
  readonly scope: string;
  readonly message: string;
};

export type RepositoryMemoryDetailList<T> = {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly details: readonly T[];
};

export type RepositoryMemoryContext = {
  readonly repositoryRoot: string;
  readonly target: string;
  readonly targetState: RepositoryScopeFilesystemState;
  readonly groups: Readonly<Record<RepositoryMemoryGroupKey, RepositoryMemoryGroup>>;
  readonly counts: {
    readonly matched: number;
    readonly returned: number;
    readonly invalid: number;
    readonly advisories: number;
  };
  readonly invalidRecords: RepositoryMemoryDetailList<RepositoryMemoryInvalidRecord>;
  readonly advisories: RepositoryMemoryDetailList<RepositoryMemoryAdvisory>;
};

export type BuildRepositoryMemoryContextOptions = {
  readonly repositoryRoot: string;
  readonly target: string;
  readonly groupLimit?: number;
  readonly detailLimit?: number;
};

type Candidate = {
  readonly note: Note;
  readonly scopes: readonly string[];
  readonly classification: Extract<RepositoryMemoryClassification, { readonly kind: "record" }>;
  readonly match: RepositoryScopeMatch;
};

function checkedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new RangeError(`${label} must be a safe integer from 0 through ${maximum}.`);
  }
  return result;
}

function utf8Prefix(value: string, maximumBytes: number): {
  readonly value: string;
  readonly truncated: boolean;
} {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) return { value: value.slice(0, end), truncated: true };
    bytes += width;
    end += character.length;
  }
  return { value, truncated: false };
}

function boundedOptionalMetadata(metadata: MetadataObject, key: string): string | undefined {
  const value = metadataString(metadata, key);
  return value === undefined ? undefined : utf8Prefix(value, 1_024).value;
}

const statusOrder: ReadonlyMap<string, number> = new Map(
  planStatuses.map((status, index) => [status, index]),
);

function compareCandidates(left: Candidate, right: Candidate): number {
  const leftDate = left.classification.date ?? "";
  const rightDate = right.classification.date ?? "";
  return right.match.depth - left.match.depth
    || rightDate.localeCompare(leftDate)
    || (statusOrder.get(left.classification.status ?? "") ?? planStatuses.length)
      - (statusOrder.get(right.classification.status ?? "") ?? planStatuses.length)
    || left.note.title.localeCompare(right.note.title)
    || left.note.path.localeCompare(right.note.path);
}

function boundedDetails<T>(values: readonly T[], limit: number): RepositoryMemoryDetailList<T> {
  const details = values.slice(0, limit);
  return {
    total: values.length,
    returned: details.length,
    truncated: details.length < values.length,
    details,
  };
}

function invalidRecord(path: string, ...issues: string[]): RepositoryMemoryInvalidRecord {
  return { path, issues };
}

type ScopedRepositoryMemoryEntry = {
  readonly note: Note;
  readonly scopes: readonly string[];
  readonly classification: RepositoryMemoryClassification;
};

type ScopedRepositoryMemoryAnalysis = {
  readonly authoredRecords: number;
  readonly entries: readonly ScopedRepositoryMemoryEntry[];
  readonly records: readonly (ScopedRepositoryMemoryEntry & {
    readonly classification: Extract<
      RepositoryMemoryClassification,
      { readonly kind: "record" }
    >;
  })[];
  readonly invalid: readonly RepositoryMemoryInvalidRecord[];
};

function addInvalidIssue(
  issuesByPath: Map<string, string[]>,
  path: string,
  issues: readonly string[],
): void {
  const existing = issuesByPath.get(path) ?? [];
  existing.push(...issues);
  issuesByPath.set(path, existing);
}

function analyzeScopedRepositoryMemory(
  notes: readonly Note[],
): ScopedRepositoryMemoryAnalysis {
  let authoredRecords = 0;
  const entries: ScopedRepositoryMemoryEntry[] = [];
  const issuesByPath = new Map<string, string[]>();

  for (const note of notes) {
    const scopes = analyzeAuthoredRepositoryScopes(note.metadata);
    if (!scopes.present) continue;
    authoredRecords += 1;
    if (!scopes.valid) {
      addInvalidIssue(
        issuesByPath,
        note.path,
        scopes.issues.map(({ message }) => message),
      );
      continue;
    }
    entries.push({
      note,
      scopes: scopes.scopes,
      classification: classifyRepositoryMemoryRecord(note),
    });
  }

  const foldedDeclarations = new Map<string, Map<string, Set<string>>>();
  for (const entry of entries) {
    for (const scope of entry.scopes) {
      const folded = scope.toLocaleLowerCase("en-US");
      const declarations = foldedDeclarations.get(folded) ?? new Map<string, Set<string>>();
      const paths = declarations.get(scope) ?? new Set<string>();
      paths.add(entry.note.path);
      declarations.set(scope, paths);
      foldedDeclarations.set(folded, declarations);
    }
  }
  for (const declarations of foldedDeclarations.values()) {
    if (declarations.size < 2) continue;
    const scopes = [...declarations.keys()].toSorted((left, right) => left.localeCompare(right));
    const displayedScopes = scopes.slice(0, MAX_REPOSITORY_SCOPES);
    const scopeSummary = displayedScopes.join(", ")
      + (displayedScopes.length < scopes.length
        ? `, and ${scopes.length - displayedScopes.length} more`
        : "");
    for (const paths of declarations.values()) {
      for (const path of paths) {
        addInvalidIssue(
          issuesByPath,
          path,
          [`Repository scopes ${scopeSummary} collide under case folding.`],
        );
      }
    }
  }

  for (const entry of entries) {
    if (entry.classification.kind === "invalid") {
      addInvalidIssue(issuesByPath, entry.note.path, [entry.classification.reason]);
    }
  }

  const invalid = [...issuesByPath]
    .map(([path, issues]) => invalidRecord(path, ...issues))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const records = entries.filter((entry): entry is ScopedRepositoryMemoryEntry & {
    readonly classification: Extract<
      RepositoryMemoryClassification,
      { readonly kind: "record" }
    >;
  } => entry.classification.kind === "record" && !issuesByPath.has(entry.note.path));
  return { authoredRecords, entries, records, invalid };
}

async function inspectRepositoryScopesAtRoot(
  root: string,
  scopes: readonly string[],
): Promise<ReadonlyMap<string, RepositoryScopeFilesystemState>> {
  const sorted = [...new Set(scopes)].toSorted((left, right) => left.localeCompare(right));
  const states = new Map<string, RepositoryScopeFilesystemState>();
  let nextIndex = 0;
  const inspectNext = async (): Promise<void> => {
    while (nextIndex < sorted.length) {
      const index = nextIndex;
      nextIndex += 1;
      const scope = sorted[index];
      if (scope === undefined) continue;
      states.set(scope, await inspectScopeAtRoot(root, scope));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, sorted.length) }, () => inspectNext()),
  );
  return states;
}

/** Build the bounded non-authoritative memory lane for one full repository path. */
export async function buildRepositoryMemoryContext(
  notes: readonly Note[],
  options: BuildRepositoryMemoryContextOptions,
): Promise<RepositoryMemoryContext> {
  const groupLimit = checkedLimit(
    options.groupLimit,
    DEFAULT_REPOSITORY_MEMORY_GROUP_LIMIT,
    MAX_REPOSITORY_MEMORY_GROUP_LIMIT,
    "Repository-memory group limit",
  );
  const detailLimit = checkedLimit(
    options.detailLimit,
    DEFAULT_REPOSITORY_MEMORY_DETAIL_LIMIT,
    MAX_REPOSITORY_MEMORY_DETAIL_LIMIT,
    "Repository-memory detail limit",
  );
  const target = canonicalRepositoryPath(options.target, "Repository-memory target");
  const repositoryRoot = await canonicalRepositoryRoot(options.repositoryRoot);
  const targetState = await inspectScopeAtRoot(repositoryRoot, target);
  const scoped = analyzeScopedRepositoryMemory(notes);
  const invalid = [...scoped.invalid];
  const candidates: Candidate[] = [];
  for (const entry of scoped.records) {
    const match = deepestRepositoryScopeMatch(entry.scopes, target);
    if (match === null) continue;
    candidates.push({
      note: entry.note,
      scopes: entry.scopes,
      classification: entry.classification,
      match,
    });
  }

  const states = await inspectRepositoryScopesAtRoot(
    repositoryRoot,
    candidates.map(({ match }) => match.scope),
  );

  const accepted: Candidate[] = [];
  const advisories: RepositoryMemoryAdvisory[] = [];
  for (const candidate of candidates) {
    const state = states.get(candidate.match.scope);
    if (state === undefined) throw new Error("A matched repository scope was not inspected.");
    if (state.status === "invalid") {
      invalid.push(invalidRecord(
        candidate.note.path,
        `Repository scope ${state.scope} is invalid at ${state.path}: ${state.reason}.`,
      ));
      continue;
    }
    if (state.status === "present" && state.kind === "file" && candidate.match.kind === "ancestor") {
      continue;
    }
    accepted.push(candidate);
    if (state.status === "absent" && candidate.classification.current) {
      advisories.push({
        kind: "absent-current-scope",
        path: candidate.note.path,
        scope: state.scope,
        message: `Current repository memory ${candidate.note.path} declares absent scope ${state.scope}.`,
      });
    }
  }

  const groups = Object.create(null) as Record<RepositoryMemoryGroupKey, RepositoryMemoryGroup>;
  for (const key of repositoryMemoryGroupKeys) {
    const matches = accepted
      .filter(({ classification }) => classification.group === key)
      .toSorted(compareCandidates);
    const selected = matches.slice(0, groupLimit);
    const records = selected.map(({ note, scopes, classification, match }): RepositoryMemoryRecord => {
      const state = states.get(match.scope);
      if (state === undefined) throw new Error("A returned repository scope was not inspected.");
      const summary = utf8Prefix(note.summary, MAX_REPOSITORY_MEMORY_SUMMARY_UTF8_BYTES);
      const type = metadataString(note.metadata, "type");
      if (type === undefined) throw new Error("A classified repository-memory record lost its type.");
      const area = boundedOptionalMetadata(note.metadata, "area");
      const description = boundedOptionalMetadata(note.metadata, "description");
      return {
        id: note.id,
        path: note.path,
        title: note.title,
        summary: summary.value,
        summaryTruncated: summary.truncated,
        type,
        ...(classification.status === undefined ? {} : { status: classification.status }),
        ...(classification.date === undefined ? {} : { date: classification.date }),
        ...(area === undefined ? {} : { area }),
        ...(description === undefined ? {} : { description }),
        repositoryScopes: scopes,
        matchedScope: match.scope,
        match: match.kind,
        scopeState: state,
      };
    });
    groups[key] = {
      total: matches.length,
      returned: records.length,
      truncated: records.length < matches.length,
      records,
    };
  }

  invalid.sort((left, right) => left.path.localeCompare(right.path));
  advisories.sort((left, right) =>
    left.path.localeCompare(right.path) || left.scope.localeCompare(right.scope));
  const invalidRecords = boundedDetails(invalid, detailLimit);
  const boundedAdvisories = boundedDetails(advisories, detailLimit);
  const returned = repositoryMemoryGroupKeys.reduce(
    (count, key) => count + groups[key].returned,
    0,
  );
  return {
    repositoryRoot,
    target,
    targetState,
    groups,
    counts: {
      matched: accepted.length,
      returned,
      invalid: invalid.length,
      advisories: advisories.length,
    },
    invalidRecords,
    advisories: boundedAdvisories,
  };
}

const MAX_REPOSITORY_MEMORY_STATE_RECORD_PATHS = 20;

export type RepositoryMemoryScopeAuditRecord = {
  readonly path: string;
  readonly repositoryScopes: readonly string[];
  readonly classification: RepositoryMemoryClassification;
};

export type RepositoryMemoryScopeAuditState = {
  readonly scope: string;
  readonly state: RepositoryScopeFilesystemState;
  readonly recordCount: number;
  readonly recordPaths: readonly string[];
  readonly recordPathsTruncated: boolean;
};

export type RepositoryMemoryScopeAuditError =
  | {
      readonly kind: "invalid-record";
      readonly path: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: "invalid-scope-state";
      readonly scope: string;
      readonly state: Extract<RepositoryScopeFilesystemState, { readonly status: "invalid" }>;
      readonly recordCount: number;
      readonly recordPaths: readonly string[];
      readonly recordPathsTruncated: boolean;
    };

export type RepositoryMemoryScopeAudit = {
  readonly repositoryRoot: string;
  readonly counts: {
    readonly authoredRecords: number;
    readonly validDeclarationRecords: number;
    readonly classifiedRecords: number;
    readonly currentRecords: number;
    readonly terminalRecords: number;
    readonly ignoredRecords: number;
    readonly invalidRecords: number;
    readonly distinctScopes: number;
    readonly presentScopes: number;
    readonly absentScopes: number;
    readonly invalidScopes: number;
    readonly errors: number;
    readonly advisories: number;
  };
  readonly groups: Readonly<Record<RepositoryMemoryGroupKey, number>>;
  readonly records: RepositoryMemoryDetailList<RepositoryMemoryScopeAuditRecord>;
  readonly states: RepositoryMemoryDetailList<RepositoryMemoryScopeAuditState>;
  readonly errors: RepositoryMemoryDetailList<RepositoryMemoryScopeAuditError>;
  readonly advisories: RepositoryMemoryDetailList<RepositoryMemoryAdvisory>;
};

export type AuditRepositoryMemoryScopesOptions = {
  readonly repositoryRoot: string;
  readonly detailLimit?: number;
};

function scopeRecordPaths(
  pathsByScope: ReadonlyMap<string, ReadonlySet<string>>,
  scope: string,
): {
  readonly recordCount: number;
  readonly recordPaths: readonly string[];
  readonly recordPathsTruncated: boolean;
} {
  const paths = [...(pathsByScope.get(scope) ?? [])]
    .toSorted((left, right) => left.localeCompare(right));
  const recordPaths = paths.slice(0, MAX_REPOSITORY_MEMORY_STATE_RECORD_PATHS);
  return {
    recordCount: paths.length,
    recordPaths,
    recordPathsTruncated: recordPaths.length < paths.length,
  };
}

/**
 * Audit every authored repository-memory scope against one repository snapshot.
 *
 * This whole-vault lane is read-only. It reports malformed declarations,
 * cross-record case collisions, invalid classifications, and unsafe filesystem
 * states as bounded errors. Absent paths remain valid authored history: only
 * current records receive an advisory, while terminal plans remain silent.
 */
export async function auditRepositoryMemoryScopes(
  notes: readonly Note[],
  options: AuditRepositoryMemoryScopesOptions,
): Promise<RepositoryMemoryScopeAudit> {
  const detailLimit = checkedLimit(
    options.detailLimit,
    DEFAULT_REPOSITORY_MEMORY_DETAIL_LIMIT,
    MAX_REPOSITORY_MEMORY_DETAIL_LIMIT,
    "Repository-memory audit detail limit",
  );
  const repositoryRoot = await canonicalRepositoryRoot(options.repositoryRoot);
  const scoped = analyzeScopedRepositoryMemory(notes);
  const pathsByScope = new Map<string, Set<string>>();
  for (const entry of scoped.entries) {
    for (const scope of entry.scopes) {
      const paths = pathsByScope.get(scope) ?? new Set<string>();
      paths.add(entry.note.path);
      pathsByScope.set(scope, paths);
    }
  }
  const statesByScope = await inspectRepositoryScopesAtRoot(
    repositoryRoot,
    [...pathsByScope.keys()],
  );
  const states = [...statesByScope]
    .map(([scope, state]): RepositoryMemoryScopeAuditState => ({
      scope,
      state,
      ...scopeRecordPaths(pathsByScope, scope),
    }))
    .toSorted((left, right) => left.scope.localeCompare(right.scope));

  const errors: RepositoryMemoryScopeAuditError[] = scoped.invalid.map((record) => ({
    kind: "invalid-record",
    path: record.path,
    issues: record.issues,
  }));
  for (const detail of states) {
    if (detail.state.status !== "invalid") continue;
    errors.push({
      kind: "invalid-scope-state",
      scope: detail.scope,
      state: detail.state,
      recordCount: detail.recordCount,
      recordPaths: detail.recordPaths,
      recordPathsTruncated: detail.recordPathsTruncated,
    });
  }
  errors.sort((left, right) => {
    const leftPath = left.kind === "invalid-record" ? left.path : left.scope;
    const rightPath = right.kind === "invalid-record" ? right.path : right.scope;
    return left.kind.localeCompare(right.kind) || leftPath.localeCompare(rightPath);
  });

  const advisories: RepositoryMemoryAdvisory[] = [];
  for (const entry of scoped.records) {
    if (!entry.classification.current) continue;
    for (const scope of entry.scopes) {
      const state = statesByScope.get(scope);
      if (state?.status !== "absent") continue;
      advisories.push({
        kind: "absent-current-scope",
        path: entry.note.path,
        scope,
        message: `Current repository memory ${entry.note.path} declares absent scope ${scope}.`,
      });
    }
  }
  advisories.sort((left, right) =>
    left.path.localeCompare(right.path) || left.scope.localeCompare(right.scope));

  const groupCounts = Object.create(null) as Record<RepositoryMemoryGroupKey, number>;
  for (const key of repositoryMemoryGroupKeys) {
    groupCounts[key] = scoped.entries.filter(({ classification }) =>
      classification.kind === "record" && classification.group === key).length;
  }
  const records = scoped.entries
    .map((entry): RepositoryMemoryScopeAuditRecord => ({
      path: entry.note.path,
      repositoryScopes: entry.scopes,
      classification: entry.classification,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const classifications = scoped.entries.map(({ classification }) => classification);
  const classified = classifications.filter((classification) => classification.kind === "record");
  const presentScopes = states.filter(({ state }) => state.status === "present").length;
  const absentScopes = states.filter(({ state }) => state.status === "absent").length;
  const invalidScopes = states.filter(({ state }) => state.status === "invalid").length;
  return {
    repositoryRoot,
    counts: {
      authoredRecords: scoped.authoredRecords,
      validDeclarationRecords: scoped.entries.length,
      classifiedRecords: classified.length,
      currentRecords: classified.filter(({ current }) => current).length,
      terminalRecords: classified.filter(({ current }) => !current).length,
      ignoredRecords: classifications.filter(({ kind }) => kind === "ignored").length,
      invalidRecords: scoped.invalid.length,
      distinctScopes: states.length,
      presentScopes,
      absentScopes,
      invalidScopes,
      errors: errors.length,
      advisories: advisories.length,
    },
    groups: groupCounts,
    records: boundedDetails(records, detailLimit),
    states: boundedDetails(states, detailLimit),
    errors: boundedDetails(errors, detailLimit),
    advisories: boundedDetails(advisories, detailLimit),
  };
}
