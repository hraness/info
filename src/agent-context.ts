import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Note } from "./graph.js";

export const agentContextType = "agent-context";
export const agentContextDirectory = "scopes";
export const agentContextSlugMaximumLength = 48;
export const agentContextHashLength = 12;

const drivePathPattern = /^[A-Za-z]:/u;
const globCharacterPattern = /[*?[\]{}]/u;
const canonicalContextIdPattern =
  /^scopes\/([a-z0-9]+(?:-[a-z0-9]+)*)--([0-9a-f]{12})$/u;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined
      && (
        codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    ) {
      return true;
    }
  }
  return false;
}

export type RepositoryScopeErrorCode =
  | "empty"
  | "absolute"
  | "traversal"
  | "control-character"
  | "glob";

/** A caller supplied a value that cannot name one exact repository directory. */
export class RepositoryScopeError extends Error {
  readonly code: RepositoryScopeErrorCode;
  readonly input: string;

  constructor(code: RepositoryScopeErrorCode, input: string, message: string) {
    super(message);
    this.name = "RepositoryScopeError";
    this.code = code;
    this.input = input;
  }
}

function normalizedRepositoryPath(
  input: string,
  unicodeForm: "NFC" | null,
): string {
  if (input === "" || input.trim() === "") {
    throw new RepositoryScopeError(
      "empty",
      input,
      "A repository scope must not be empty.",
    );
  }
  if (hasControlCharacter(input)) {
    throw new RepositoryScopeError(
      "control-character",
      input,
      "A repository scope must not contain control characters.",
    );
  }
  if (/^[\\/]/u.test(input) || drivePathPattern.test(input)) {
    throw new RepositoryScopeError(
      "absolute",
      input,
      "A repository scope must be relative, not absolute, UNC, or drive-qualified.",
    );
  }
  if (globCharacterPattern.test(input)) {
    throw new RepositoryScopeError(
      "glob",
      input,
      "A repository scope must name one exact directory, not a glob.",
    );
  }

  const separated = input.replaceAll("\\", "/");
  if (separated.split("/").includes("..")) {
    throw new RepositoryScopeError(
      "traversal",
      input,
      "A repository scope must not contain parent traversal.",
    );
  }
  const unicodeNormalized = unicodeForm === null
    ? separated
    : separated.normalize(unicodeForm);
  const normalized = posix.normalize(unicodeNormalized).replace(/^\.\//u, "");
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
  ) {
    throw new RepositoryScopeError(
      "traversal",
      input,
      "A repository scope must stay within the repository.",
    );
  }
  return normalized === "" ? "." : normalized;
}

/**
 * Normalize a POSIX or backslash-delimited repository directory to NFC.
 *
 * The repository root is always represented by `.`. Absolute paths, parent
 * traversal, controls, globs, and empty inputs are rejected.
 */
export function normalizeRepositoryScope(input: string): string {
  return normalizedRepositoryPath(input, "NFC");
}

function readableScopeSlug(scope: string): string {
  if (scope === ".") return "repository";
  const readable = scope
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{ASCII}]/gu, "-")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  const fallback = readable === "" ? "scope" : readable;
  return fallback
    .slice(0, agentContextSlugMaximumLength)
    .replace(/-+$/gu, "") || "scope";
}

function scopeHash(scope: string): string {
  return createHash("sha256")
    .update(scope, "utf8")
    .digest("hex")
    .slice(0, agentContextHashLength);
}

/** Return the canonical vault note ID for one repository scope. */
export function agentContextNoteId(scopeInput: string): string {
  const scope = normalizeRepositoryScope(scopeInput);
  return `${agentContextDirectory}/${readableScopeSlug(scope)}--${scopeHash(scope)}`;
}

/** Return the canonical vault-relative Markdown path for one repository scope. */
export function agentContextNotePath(scopeInput: string): string {
  return `${agentContextNoteId(scopeInput)}.md`;
}

/** Return the repository-relative guide path owned by one repository scope. */
export function agentContextGuidePath(scopeInput: string): string {
  const scope = normalizeRepositoryScope(scopeInput);
  return scope === "." ? "AGENTS.md" : `${scope}/AGENTS.md`;
}

function isCanonicalContextId(value: string): boolean {
  const match = canonicalContextIdPattern.exec(value);
  const slug = match?.[1];
  return slug !== undefined && slug.length <= agentContextSlugMaximumLength;
}

/** Format the exact reciprocal guide marker for a canonical context note ID. */
export function formatAgentContextMarker(noteId: string): string {
  if (!isCanonicalContextId(noteId)) {
    throw new TypeError("An agent-context marker requires a canonical context note ID.");
  }
  return `<!-- info:context ${noteId} -->`;
}

/** Return the reciprocal guide marker for one repository scope. */
export function agentContextMarkerForScope(scopeInput: string): string {
  return formatAgentContextMarker(agentContextNoteId(scopeInput));
}

export type AgentContextMarker = {
  readonly noteId: string;
  readonly line: number;
  readonly source: string;
};

export type MalformedAgentContextMarker = {
  readonly line: number;
  readonly source: string;
  readonly reason: "syntax" | "after-heading";
};

export type AgentContextMarkerParseResult = {
  readonly kind: "missing" | "found" | "multiple" | "malformed";
  readonly markers: readonly AgentContextMarker[];
  readonly malformed: readonly MalformedAgentContextMarker[];
};

function fenceDelimiter(line: string): { character: "`" | "~"; length: number } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  const delimiter = match?.[1];
  if (delimiter === undefined) return null;
  const character = delimiter[0];
  return character === "`" || character === "~"
    ? { character, length: delimiter.length }
    : null;
}

/**
 * Parse the reserved `info:context` guide comment.
 *
 * Other HTML comments and marker examples inside fenced code are ignored.
 * Marker-like comments with non-exact syntax or placement are reported.
 */
export function parseAgentContextMarker(source: string): AgentContextMarkerParseResult {
  const markers: AgentContextMarker[] = [];
  const malformed: MalformedAgentContextMarker[] = [];
  let firstHeadingLine: number | null = null;
  let fence: { character: "`" | "~"; length: number } | null = null;

  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const delimiter = fenceDelimiter(line);
    if (fence !== null) {
      if (
        delimiter?.character === fence.character
        && delimiter.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (delimiter !== null) {
      fence = delimiter;
      continue;
    }

    const lineNumber = index + 1;
    if (
      firstHeadingLine === null
      && /^\s{0,3}#{1,6}(?:\s+|$)/u.test(line)
    ) {
      firstHeadingLine = lineNumber;
    }
    if (!/<!--[^>]*\binfo:context\b/u.test(line)) continue;

    const match = /^<!-- info:context (scopes\/[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{12}) -->$/u
      .exec(line);
    const noteId = match?.[1];
    if (noteId === undefined || !isCanonicalContextId(noteId)) {
      malformed.push({ line: lineNumber, source: line, reason: "syntax" });
      continue;
    }
    if (firstHeadingLine !== null && lineNumber > firstHeadingLine) {
      malformed.push({ line: lineNumber, source: line, reason: "after-heading" });
      continue;
    }
    markers.push({ noteId, line: lineNumber, source: line });
  }

  const kind = malformed.length > 0
    ? "malformed"
    : markers.length === 0
      ? "missing"
      : markers.length === 1
        ? "found"
        : "multiple";
  return { kind, markers, malformed };
}

export type AgentGuideSource = {
  readonly path: string;
  readonly source: string;
};

export type AgentContextHub = {
  readonly note: Note;
  readonly rawScope: string;
  readonly scope: string;
  readonly canonicalId: string;
  readonly canonicalPath: string;
  readonly guidePath: string;
  readonly marker: string;
  readonly canonical: boolean;
  readonly reciprocal: boolean;
  readonly valid: boolean;
};

export type AgentContextGuide = {
  readonly path: string;
  readonly scope: string;
  readonly source: string;
  readonly marker: AgentContextMarkerParseResult;
};

type Issue<K extends string, D extends object> = Readonly<{
  kind: K;
  message: string;
} & D>;

export type AgentContextIssue =
  | Issue<"malformed-context-type", {
      notePath: string;
      actual: unknown;
    }>
  | Issue<"malformed-context-scope", {
      notePath: string;
      actual: unknown;
      reason: string;
    }>
  | Issue<"context-note-outside-scopes", {
      notePath: string;
    }>
  | Issue<"non-context-note-under-scopes", {
      notePath: string;
    }>
  | Issue<"noncanonical-context-note", {
      notePath: string;
      noteId: string;
      scope: string;
      expectedPath: string;
      expectedId: string;
    }>
  | Issue<"duplicate-context-scope", {
      scope: string;
      notePaths: readonly string[];
    }>
  | Issue<"nfc-context-scope-collision", {
      scope: string;
      rawScopes: readonly string[];
      notePaths: readonly string[];
    }>
  | Issue<"case-fold-context-scope-collision", {
      scopes: readonly string[];
      notePaths: readonly string[];
    }>
  | Issue<"invalid-guide-path", {
      guidePath: string;
      reason: string;
    }>
  | Issue<"guide-marker-missing", {
      guidePath: string;
      scope: string;
    }>
  | Issue<"guide-marker-multiple", {
      guidePath: string;
      lines: readonly number[];
    }>
  | Issue<"guide-marker-malformed", {
      guidePath: string;
      lines: readonly number[];
    }>
  | Issue<"guide-pointer-missing", {
      guidePath: string;
      noteId: string;
    }>
  | Issue<"guide-pointer-mismatch", {
      guidePath: string;
      scope: string;
      noteId: string;
      expectedId: string;
      actualNotePaths: readonly string[];
    }>
  | Issue<"context-note-missing-reciprocal-marker", {
      notePath: string;
      scope: string;
      guidePath: string;
      expectedMarker: string;
    }>
  | Issue<"scope-directory-missing", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"scope-directory-not-directory", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"scope-directory-symlink", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"guide-file-missing", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"guide-file-not-regular", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"guide-file-symlink", {
      scope: string;
      repositoryPath: string;
    }>
  | Issue<"repository-symlink-escape", {
      scope: string;
      repositoryPath: string;
      resolvedPath: string;
    }>;

export type AgentContextAnalysis = {
  readonly contexts: readonly AgentContextHub[];
  readonly guides: readonly AgentContextGuide[];
  readonly issues: readonly AgentContextIssue[];
};

type ContextCandidate = {
  readonly index: number;
  readonly note: Note;
  readonly rawScope: string;
  readonly preNfcScope: string;
  readonly scope: string;
  readonly canonicalId: string;
  readonly canonicalPath: string;
  readonly guidePath: string;
  readonly marker: string;
  readonly underScopes: boolean;
  readonly canonical: boolean;
};

function noteIsUnderContextDirectory(note: Note): boolean {
  return note.path.startsWith(`${agentContextDirectory}/`);
}

function normalizedGuideSource(
  guide: AgentGuideSource,
): { path: string; scope: string; source: string } {
  const path = normalizeRepositoryScope(guide.path);
  if (posix.basename(path) !== "AGENTS.md") {
    throw new TypeError("An agent guide source path must end in AGENTS.md.");
  }
  const parent = posix.dirname(path);
  return {
    path,
    scope: parent === "" ? "." : normalizeRepositoryScope(parent),
    source: guide.source,
  };
}

function issueSortKey(issue: AgentContextIssue): string {
  const record = issue as Readonly<Record<string, unknown>>;
  return [
    issue.kind,
    typeof record.notePath === "string" ? record.notePath : "",
    typeof record.guidePath === "string" ? record.guidePath : "",
    typeof record.scope === "string" ? record.scope : "",
    issue.message,
  ].join("\0");
}

function sortedIssues(issues: readonly AgentContextIssue[]): AgentContextIssue[] {
  return [...issues].toSorted((left, right) =>
    issueSortKey(left).localeCompare(issueSortKey(right)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

function scopeIsAncestor(ancestor: string, descendant: string): boolean {
  return ancestor === "."
    || ancestor === descendant
    || descendant.startsWith(`${ancestor}/`);
}

/**
 * Analyze typed context notes and already-read guide sources without filesystem
 * access. Unmapped guides are valid; every context mapping must be reciprocal.
 */
export function analyzeAgentContexts(
  notes: readonly Note[],
  guideSources: readonly AgentGuideSource[] = [],
): AgentContextAnalysis {
  const issues: AgentContextIssue[] = [];
  const candidates: ContextCandidate[] = [];

  for (const [index, note] of notes.entries()) {
    const underScopes = noteIsUnderContextDirectory(note);
    const hasType = Object.hasOwn(note.metadata, "type");
    const type = note.metadata.type;
    if (underScopes && type !== agentContextType) {
      issues.push({
        kind: "non-context-note-under-scopes",
        notePath: note.path,
        message: `The note ${note.path} is under scopes/ but is not an agent-context note.`,
      });
      if (hasType) {
        issues.push({
          kind: "malformed-context-type",
          notePath: note.path,
          actual: type,
          message: `The note ${note.path} has an invalid agent-context type.`,
        });
      }
      continue;
    }
    if (type !== agentContextType) continue;

    if (!underScopes) {
      issues.push({
        kind: "context-note-outside-scopes",
        notePath: note.path,
        message: `The agent-context note ${note.path} must live under scopes/.`,
      });
    }
    const rawScope = note.metadata.scope;
    if (typeof rawScope !== "string") {
      issues.push({
        kind: "malformed-context-scope",
        notePath: note.path,
        actual: rawScope,
        reason: "The scope must be one string.",
        message: `The agent-context note ${note.path} must declare one string scope.`,
      });
      continue;
    }

    let scope: string;
    let preNfcScope: string;
    try {
      scope = normalizeRepositoryScope(rawScope);
      preNfcScope = normalizedRepositoryPath(rawScope, null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The scope is invalid.";
      issues.push({
        kind: "malformed-context-scope",
        notePath: note.path,
        actual: rawScope,
        reason,
        message: `The agent-context note ${note.path} has an invalid repository scope.`,
      });
      continue;
    }

    const canonicalId = agentContextNoteId(scope);
    const canonicalPath = `${canonicalId}.md`;
    const canonical = note.id === canonicalId && note.path === canonicalPath;
    if (!canonical) {
      issues.push({
        kind: "noncanonical-context-note",
        notePath: note.path,
        noteId: note.id,
        scope,
        expectedPath: canonicalPath,
        expectedId: canonicalId,
        message: `The agent-context note for ${scope} must be ${canonicalPath}.`,
      });
    }
    candidates.push({
      index,
      note,
      rawScope,
      preNfcScope,
      scope,
      canonicalId,
      canonicalPath,
      guidePath: agentContextGuidePath(scope),
      marker: formatAgentContextMarker(canonicalId),
      underScopes,
      canonical,
    });
  }

  const conflictedCandidateIndexes = new Set<number>();
  const byScope = groupBy(candidates, (candidate) => candidate.scope);
  for (const [scope, matches] of byScope) {
    if (matches.length < 2) continue;
    for (const match of matches) conflictedCandidateIndexes.add(match.index);
    const preNfcScopes = sortedUnique(matches.map((match) => match.preNfcScope));
    const notePaths = matches
      .map((match) => match.note.path)
      .toSorted((left, right) => left.localeCompare(right));
    if (preNfcScopes.length > 1) {
      issues.push({
        kind: "nfc-context-scope-collision",
        scope,
        rawScopes: sortedUnique(matches.map((match) => match.rawScope)),
        notePaths,
        message: `Multiple context scopes normalize to the same NFC directory ${scope}.`,
      });
    } else {
      issues.push({
        kind: "duplicate-context-scope",
        scope,
        notePaths,
        message: `The repository scope ${scope} has more than one context note.`,
      });
    }
  }

  const byCaseFoldedScope = groupBy(
    candidates,
    (candidate) => candidate.scope.toLocaleLowerCase("en-US"),
  );
  for (const matches of byCaseFoldedScope.values()) {
    const scopes = sortedUnique(matches.map((match) => match.scope));
    if (scopes.length < 2) continue;
    for (const match of matches) conflictedCandidateIndexes.add(match.index);
    issues.push({
      kind: "case-fold-context-scope-collision",
      scopes,
      notePaths: matches
        .map((match) => match.note.path)
        .toSorted((left, right) => left.localeCompare(right)),
      message: `Context scopes ${scopes.join(", ")} collide under case folding.`,
    });
  }

  const guides: AgentContextGuide[] = [];
  for (const guideSource of guideSources) {
    try {
      const guide = normalizedGuideSource(guideSource);
      guides.push({ ...guide, marker: parseAgentContextMarker(guide.source) });
    } catch (error) {
      issues.push({
        kind: "invalid-guide-path",
        guidePath: guideSource.path,
        reason: error instanceof Error ? error.message : "The guide path is invalid.",
        message: `The guide source path ${guideSource.path} is invalid.`,
      });
    }
  }
  guides.sort((left, right) => left.path.localeCompare(right.path));

  const mappableCandidates = candidates.filter((candidate) =>
    candidate.underScopes && candidate.canonical);
  const mappableByScope = groupBy(
    mappableCandidates,
    (candidate) => candidate.scope,
  );
  const notesById = groupBy(notes, (note) => note.id);
  const reciprocalCandidateIndexes = new Set<number>();

  for (const guide of guides) {
    const scopedCandidates = mappableByScope.get(guide.scope) ?? [];
    if (guide.marker.kind === "missing" && scopedCandidates.length > 0) {
      issues.push({
        kind: "guide-marker-missing",
        guidePath: guide.path,
        scope: guide.scope,
        message: `The mapped guide ${guide.path} is missing its info:context marker.`,
      });
    }
    if (guide.marker.markers.length > 1) {
      issues.push({
        kind: "guide-marker-multiple",
        guidePath: guide.path,
        lines: guide.marker.markers.map((marker) => marker.line),
        message: `The guide ${guide.path} has more than one info:context marker.`,
      });
    }
    if (guide.marker.malformed.length > 0) {
      issues.push({
        kind: "guide-marker-malformed",
        guidePath: guide.path,
        lines: guide.marker.malformed.map((marker) => marker.line),
        message: `The guide ${guide.path} has a malformed info:context marker.`,
      });
    }

    if (
      guide.marker.markers.length !== 1
      || guide.marker.malformed.length !== 0
    ) {
      continue;
    }
    const marker = guide.marker.markers[0];
    if (marker === undefined) continue;
    const pointedNotes = notesById.get(marker.noteId) ?? [];
    if (pointedNotes.length === 0) {
      issues.push({
        kind: "guide-pointer-missing",
        guidePath: guide.path,
        noteId: marker.noteId,
        message: `The guide ${guide.path} points to missing note ${marker.noteId}.`,
      });
      continue;
    }

    const pointedCandidates = mappableCandidates.filter((candidate) =>
      candidate.canonicalId === marker.noteId
      && pointedNotes.includes(candidate.note));
    const reciprocal = pointedCandidates.filter((candidate) =>
      candidate.scope === guide.scope
      && candidate.canonicalId === agentContextNoteId(guide.scope));
    if (reciprocal.length === 0) {
      issues.push({
        kind: "guide-pointer-mismatch",
        guidePath: guide.path,
        scope: guide.scope,
        noteId: marker.noteId,
        expectedId: agentContextNoteId(guide.scope),
        actualNotePaths: pointedNotes
          .map((note) => note.path)
          .toSorted((left, right) => left.localeCompare(right)),
        message: `The guide ${guide.path} does not point to the context note for ${guide.scope}.`,
      });
      continue;
    }
    for (const candidate of reciprocal) {
      reciprocalCandidateIndexes.add(candidate.index);
    }
  }

  for (const candidate of mappableCandidates) {
    if (reciprocalCandidateIndexes.has(candidate.index)) continue;
    issues.push({
      kind: "context-note-missing-reciprocal-marker",
      notePath: candidate.note.path,
      scope: candidate.scope,
      guidePath: candidate.guidePath,
      expectedMarker: candidate.marker,
      message: `The context note ${candidate.note.path} is missing a reciprocal marker in ${candidate.guidePath}.`,
    });
  }

  const contexts = candidates
    .map((candidate): AgentContextHub => {
      const reciprocal = reciprocalCandidateIndexes.has(candidate.index);
      const canonical = candidate.underScopes && candidate.canonical;
      return {
        note: candidate.note,
        rawScope: candidate.rawScope,
        scope: candidate.scope,
        canonicalId: candidate.canonicalId,
        canonicalPath: candidate.canonicalPath,
        guidePath: candidate.guidePath,
        marker: candidate.marker,
        canonical,
        reciprocal,
        valid: canonical
          && reciprocal
          && !conflictedCandidateIndexes.has(candidate.index),
      };
    })
    .toSorted((left, right) =>
      left.scope.localeCompare(right.scope)
      || left.note.path.localeCompare(right.note.path));

  return {
    contexts,
    guides,
    issues: sortedIssues(issues),
  };
}

export type AgentContextTargetKind = "auto" | "file" | "directory";

export type InspectAgentContextRepositoryOptions = {
  readonly repositoryRoot: string;
  readonly target?: string;
  readonly targetKind?: AgentContextTargetKind;
  readonly validationMode?: "applicable" | "all";
};

export type InheritedAgentGuide = AgentContextGuide & {
  readonly absolutePath: string;
};

export type AgentContextRepositoryInspection = AgentContextAnalysis & {
  readonly repositoryRoot: string;
  readonly target: string;
  readonly targetScope: string;
  readonly inheritedGuides: readonly InheritedAgentGuide[];
  readonly matchingContexts: readonly AgentContextHub[];
};

export type AgentContextRepositoryPathErrorCode =
  | "root-not-directory"
  | "target-symlink"
  | "target-symlink-escape"
  | "target-parent-not-directory";

/** Repository state made a requested target unsafe or ambiguous to inspect. */
export class AgentContextRepositoryPathError extends Error {
  readonly code: AgentContextRepositoryPathErrorCode;
  readonly path: string;

  constructor(
    code: AgentContextRepositoryPathErrorCode,
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentContextRepositoryPathError";
    this.code = code;
    this.path = path;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

function isUnresolvableSymlinkError(error: unknown): boolean {
  return isMissingFileError(error)
    || (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ELOOP"
    );
}

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isUnresolvableSymlinkError(error)) return null;
    throw error;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function repositoryPath(root: string, scope: string): string {
  return scope === "." ? root : join(root, ...scope.split("/"));
}

function repositoryRelativePath(root: string, path: string): string {
  const fromRoot = relative(root, path).split(sep).join("/");
  return fromRoot === "" ? "." : fromRoot;
}

async function assertTargetPrefixConfined(
  root: string,
  normalizedTarget: string,
): Promise<void> {
  if (normalizedTarget === ".") return;
  const segments = normalizedTarget.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      const resolvedPath = await realpathIfPresent(next);
      if (resolvedPath !== null && !pathIsWithin(root, resolvedPath)) {
        throw new AgentContextRepositoryPathError(
          "target-symlink-escape",
          repositoryRelativePath(root, next),
          `The target traverses a symbolic link outside the repository: ${next}.`,
        );
      }
      throw new AgentContextRepositoryPathError(
        "target-symlink",
        repositoryRelativePath(root, next),
        `The target traverses a symbolic link: ${next}.`,
      );
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new AgentContextRepositoryPathError(
        "target-parent-not-directory",
        repositoryRelativePath(root, next),
        `A target parent is not a directory: ${next}.`,
      );
    }
    current = next;
  }
}

async function targetScope(
  root: string,
  target: string,
  kind: AgentContextTargetKind,
  directoryHint: boolean,
): Promise<string> {
  if (kind === "directory") return target;
  if (kind === "file") {
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  }

  const absoluteTarget = repositoryPath(root, target);
  try {
    const metadata = await lstat(absoluteTarget);
    if (metadata.isDirectory()) return target;
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  if (directoryHint) return target;
  const basename = posix.basename(target);
  if (basename.includes(".")) {
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  }
  return target;
}

function scopeAncestors(scope: string): string[] {
  if (scope === ".") return ["."];
  const segments = scope.split("/");
  const ancestors = ["."];
  for (let length = 1; length <= segments.length; length += 1) {
    ancestors.push(segments.slice(0, length).join("/"));
  }
  return ancestors;
}

async function inspectScopeDirectory(
  root: string,
  scope: string,
): Promise<{ readonly path: string; readonly issues: readonly AgentContextIssue[] }> {
  const path = repositoryPath(root, scope);
  const issues: AgentContextIssue[] = [];
  if (scope === ".") return { path, issues };

  let current = root;
  for (const segment of scope.split("/")) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      issues.push({
        kind: "scope-directory-missing",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope directory ${repositoryRelativePath(root, current)} does not exist.`,
      });
      return { path, issues };
    }
    if (metadata.isSymbolicLink()) {
      issues.push({
        kind: "scope-directory-symlink",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope directory ${repositoryRelativePath(root, current)} is a symbolic link.`,
      });
      const resolvedPath = await realpathIfPresent(current);
      if (resolvedPath !== null && !pathIsWithin(root, resolvedPath)) {
        issues.push({
          kind: "repository-symlink-escape",
          scope,
          repositoryPath: repositoryRelativePath(root, current),
          resolvedPath,
          message: `The mapped scope directory ${repositoryRelativePath(root, current)} resolves outside the repository.`,
        });
      }
      return { path, issues };
    }
    if (!metadata.isDirectory()) {
      issues.push({
        kind: "scope-directory-not-directory",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope path ${repositoryRelativePath(root, current)} is not a directory.`,
      });
      return { path, issues };
    }
  }

  const resolvedPath = await realpath(path);
  if (!pathIsWithin(root, resolvedPath)) {
    issues.push({
      kind: "repository-symlink-escape",
      scope,
      repositoryPath: repositoryRelativePath(root, path),
      resolvedPath,
      message: `The mapped scope directory ${repositoryRelativePath(root, path)} resolves outside the repository.`,
    });
  }
  return { path, issues };
}

type ReadGuideResult = {
  readonly guide?: AgentGuideSource;
  readonly absolutePath: string;
  readonly issues: readonly AgentContextIssue[];
};

async function readGuide(
  root: string,
  scope: string,
  required: boolean,
): Promise<ReadGuideResult> {
  const absolutePath = join(repositoryPath(root, scope), "AGENTS.md");
  const path = agentContextGuidePath(scope);
  const issues: AgentContextIssue[] = [];
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    if (required) {
      issues.push({
        kind: "guide-file-missing",
        scope,
        repositoryPath: path,
        message: `The mapped guide ${path} does not exist.`,
      });
    }
    return { absolutePath, issues };
  }

  if (metadata.isSymbolicLink()) {
    issues.push({
      kind: "guide-file-symlink",
      scope,
      repositoryPath: path,
      message: `The mapped guide ${path} is a symbolic link.`,
    });
    const resolvedPath = await realpathIfPresent(absolutePath);
    if (resolvedPath !== null && !pathIsWithin(root, resolvedPath)) {
      issues.push({
        kind: "repository-symlink-escape",
        scope,
        repositoryPath: path,
        resolvedPath,
        message: `The mapped guide ${path} resolves outside the repository.`,
      });
    }
    return { absolutePath, issues };
  }
  if (!metadata.isFile()) {
    issues.push({
      kind: "guide-file-not-regular",
      scope,
      repositoryPath: path,
      message: `The mapped guide ${path} is not a regular file.`,
    });
    return { absolutePath, issues };
  }

  const handle = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      issues.push({
        kind: "guide-file-not-regular",
        scope,
        repositoryPath: path,
        message: `The mapped guide ${path} is not a regular file.`,
      });
      return { absolutePath, issues };
    }
    const resolvedPath = await realpath(absolutePath);
    if (!pathIsWithin(root, resolvedPath)) {
      issues.push({
        kind: "repository-symlink-escape",
        scope,
        repositoryPath: path,
        resolvedPath,
        message: `The mapped guide ${path} resolves outside the repository.`,
      });
      return { absolutePath, issues };
    }
    return {
      absolutePath,
      guide: {
        path,
        source: await handle.readFile({ encoding: "utf8" }),
      },
      issues,
    };
  } finally {
    await handle.close();
  }
}

function uniqueIssues(issues: readonly AgentContextIssue[]): AgentContextIssue[] {
  const unique = new Map<string, AgentContextIssue>();
  for (const issue of issues) {
    unique.set(JSON.stringify(issue), issue);
  }
  return sortedIssues([...unique.values()]);
}

/**
 * Inspect repository state for context mappings and one target path.
 *
 * Context scope directories and mapped guides must be real, confined filesystem
 * entries. The inherited guide chain is root-to-nearest; verified matching
 * context hubs are nearest-to-root. Validation is confined to applicable
 * ancestors by default; repository-wide gates opt into `validationMode: "all"`.
 */
export async function inspectAgentContextRepository(
  notes: readonly Note[],
  options: InspectAgentContextRepositoryOptions,
): Promise<AgentContextRepositoryInspection> {
  const requestedRoot = resolve(options.repositoryRoot);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new AgentContextRepositoryPathError(
      "root-not-directory",
      options.repositoryRoot,
      "The repository root must be a directory.",
    );
  }

  const target = normalizeRepositoryScope(options.target ?? ".");
  await assertTargetPrefixConfined(root, target);
  const resolvedTargetScope = await targetScope(
    root,
    target,
    options.targetKind ?? "auto",
    /[\\/]$/u.test(options.target ?? "."),
  );
  const preliminary = analyzeAgentContexts(notes);
  const validateAllMappings = options.validationMode === "all";
  const applicableCaseFoldedScopes = new Set(
    preliminary.contexts
      .filter((context) =>
        scopeIsAncestor(context.scope, resolvedTargetScope))
      .map((context) => context.scope.toLocaleLowerCase("en-US")),
  );
  const contextsToValidate = preliminary.contexts.filter((context) =>
    validateAllMappings
    || applicableCaseFoldedScopes.has(
      context.scope.toLocaleLowerCase("en-US"),
    ));
  const notesToAnalyze = validateAllMappings
    ? notes
    : contextsToValidate.map(({ note }) => note);
  const scopesToInspect = sortedUnique(
    contextsToValidate
      .filter((context) => context.canonical)
      .map((context) => context.scope),
  );
  const filesystemIssues: AgentContextIssue[] = [];
  const guidesByPath = new Map<string, {
    readonly guide: AgentGuideSource;
    readonly absolutePath: string;
  }>();

  for (const scope of scopesToInspect) {
    const directory = await inspectScopeDirectory(root, scope);
    filesystemIssues.push(...directory.issues);
    if (directory.issues.length > 0) continue;
    const read = await readGuide(root, scope, true);
    filesystemIssues.push(...read.issues);
    if (read.guide !== undefined) {
      guidesByPath.set(read.guide.path, {
        guide: read.guide,
        absolutePath: read.absolutePath,
      });
    }
  }

  const inheritedGuidePaths: string[] = [];
  for (const scope of scopeAncestors(resolvedTargetScope)) {
    const guidePath = agentContextGuidePath(scope);
    let entry = guidesByPath.get(guidePath);
    if (entry === undefined) {
      const read = await readGuide(root, scope, false);
      filesystemIssues.push(...read.issues);
      if (read.guide !== undefined) {
        entry = { guide: read.guide, absolutePath: read.absolutePath };
        guidesByPath.set(guidePath, entry);
      }
    }
    if (entry !== undefined) inheritedGuidePaths.push(guidePath);
  }

  const analysis = analyzeAgentContexts(
    notesToAnalyze,
    [...guidesByPath.values()].map((entry) => entry.guide),
  );
  const guidesByAnalyzedPath = new Map(
    analysis.guides.map((guide) => [guide.path, guide]),
  );
  const inheritedGuides = inheritedGuidePaths
    .map((path): InheritedAgentGuide | null => {
      const entry = guidesByPath.get(path);
      const guide = guidesByAnalyzedPath.get(path);
      return entry === undefined || guide === undefined
        ? null
        : { ...guide, absolutePath: entry.absolutePath };
    })
    .filter((guide): guide is InheritedAgentGuide => guide !== null);
  const matchingContexts = analysis.contexts
    .filter((context) =>
      context.valid && scopeIsAncestor(context.scope, resolvedTargetScope))
    .toSorted((left, right) =>
      scopeDepth(right.scope) - scopeDepth(left.scope)
      || left.scope.localeCompare(right.scope));

  return {
    repositoryRoot: root,
    target,
    targetScope: resolvedTargetScope,
    contexts: analysis.contexts,
    guides: analysis.guides,
    inheritedGuides,
    matchingContexts,
    issues: uniqueIssues([...analysis.issues, ...filesystemIssues]),
  };
}
