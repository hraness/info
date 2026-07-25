// @bun
// src/agent-context.ts
import { createHash } from "crypto";
import { constants } from "fs";
import {
  lstat,
  open,
  realpath
} from "fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from "path";
var agentContextType = "agent-context";
var agentContextDirectory = "scopes";
var agentContextSlugMaximumLength = 48;
var agentContextHashLength = 12;
var drivePathPattern = /^[A-Za-z]:/u;
var globCharacterPattern = /[*?[\]{}]/u;
var canonicalContextIdPattern = /^scopes\/([a-z0-9]+(?:-[a-z0-9]+)*)--([0-9a-f]{12})$/u;
function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint >= 127 && codePoint <= 159)) {
      return true;
    }
  }
  return false;
}

class RepositoryScopeError extends Error {
  code;
  input;
  constructor(code, input, message) {
    super(message);
    this.name = "RepositoryScopeError";
    this.code = code;
    this.input = input;
  }
}
function normalizedRepositoryPath(input, unicodeForm) {
  if (input === "" || input.trim() === "") {
    throw new RepositoryScopeError("empty", input, "A repository scope must not be empty.");
  }
  if (hasControlCharacter(input)) {
    throw new RepositoryScopeError("control-character", input, "A repository scope must not contain control characters.");
  }
  if (/^[\\/]/u.test(input) || drivePathPattern.test(input)) {
    throw new RepositoryScopeError("absolute", input, "A repository scope must be relative, not absolute, UNC, or drive-qualified.");
  }
  if (globCharacterPattern.test(input)) {
    throw new RepositoryScopeError("glob", input, "A repository scope must name one exact directory, not a glob.");
  }
  const separated = input.replaceAll("\\", "/");
  if (separated.split("/").includes("..")) {
    throw new RepositoryScopeError("traversal", input, "A repository scope must not contain parent traversal.");
  }
  const unicodeNormalized = unicodeForm === null ? separated : separated.normalize(unicodeForm);
  const normalized = posix.normalize(unicodeNormalized).replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new RepositoryScopeError("traversal", input, "A repository scope must stay within the repository.");
  }
  return normalized === "" ? "." : normalized;
}
function normalizeRepositoryScope(input) {
  return normalizedRepositoryPath(input, "NFC");
}
function readableScopeSlug(scope) {
  if (scope === ".")
    return "repository";
  const readable = scope.normalize("NFKD").replace(/\p{Mark}+/gu, "").replace(/[^\p{ASCII}]/gu, "-").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-+/gu, "-");
  const fallback = readable === "" ? "scope" : readable;
  return fallback.slice(0, agentContextSlugMaximumLength).replace(/-+$/gu, "") || "scope";
}
function scopeHash(scope) {
  return createHash("sha256").update(scope, "utf8").digest("hex").slice(0, agentContextHashLength);
}
function agentContextNoteId(scopeInput) {
  const scope = normalizeRepositoryScope(scopeInput);
  return `${agentContextDirectory}/${readableScopeSlug(scope)}--${scopeHash(scope)}`;
}
function agentContextNotePath(scopeInput) {
  return `${agentContextNoteId(scopeInput)}.md`;
}
function agentContextGuidePath(scopeInput) {
  const scope = normalizeRepositoryScope(scopeInput);
  return scope === "." ? "AGENTS.md" : `${scope}/AGENTS.md`;
}
function isCanonicalContextId(value) {
  const match = canonicalContextIdPattern.exec(value);
  const slug = match?.[1];
  return slug !== undefined && slug.length <= agentContextSlugMaximumLength;
}
function formatAgentContextMarker(noteId) {
  if (!isCanonicalContextId(noteId)) {
    throw new TypeError("An agent-context marker requires a canonical context note ID.");
  }
  return `<!-- info:context ${noteId} -->`;
}
function agentContextMarkerForScope(scopeInput) {
  return formatAgentContextMarker(agentContextNoteId(scopeInput));
}
function fenceDelimiter(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  const delimiter = match?.[1];
  if (delimiter === undefined)
    return null;
  const character = delimiter[0];
  return character === "`" || character === "~" ? { character, length: delimiter.length } : null;
}
function parseAgentContextMarker(source) {
  const markers = [];
  const malformed = [];
  let firstHeadingLine = null;
  let fence = null;
  const lines = source.split(/\r?\n/u);
  for (let index = 0;index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const delimiter = fenceDelimiter(line);
    if (fence !== null) {
      if (delimiter?.character === fence.character && delimiter.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (delimiter !== null) {
      fence = delimiter;
      continue;
    }
    const lineNumber = index + 1;
    if (firstHeadingLine === null && /^\s{0,3}#{1,6}(?:\s+|$)/u.test(line)) {
      firstHeadingLine = lineNumber;
    }
    if (!/<!--[^>]*\binfo:context\b/u.test(line))
      continue;
    const match = /^<!-- info:context (scopes\/[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{12}) -->$/u.exec(line);
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
  const kind = malformed.length > 0 ? "malformed" : markers.length === 0 ? "missing" : markers.length === 1 ? "found" : "multiple";
  return { kind, markers, malformed };
}
function noteIsUnderContextDirectory(note) {
  return note.path.startsWith(`${agentContextDirectory}/`);
}
function normalizedGuideSource(guide) {
  const path = normalizeRepositoryScope(guide.path);
  if (posix.basename(path) !== "AGENTS.md") {
    throw new TypeError("An agent guide source path must end in AGENTS.md.");
  }
  const parent = posix.dirname(path);
  return {
    path,
    scope: parent === "" ? "." : normalizeRepositoryScope(parent),
    source: guide.source
  };
}
function issueSortKey(issue) {
  const record = issue;
  return [
    issue.kind,
    typeof record.notePath === "string" ? record.notePath : "",
    typeof record.guidePath === "string" ? record.guidePath : "",
    typeof record.scope === "string" ? record.scope : "",
    issue.message
  ].join("\x00");
}
function sortedIssues(issues) {
  return [...issues].toSorted((left, right) => issueSortKey(left).localeCompare(issueSortKey(right)));
}
function sortedUnique(values) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function groupBy(values, keyOf) {
  const groups = new Map;
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
function scopeDepth(scope) {
  return scope === "." ? 0 : scope.split("/").length;
}
function scopeIsAncestor(ancestor, descendant) {
  return ancestor === "." || ancestor === descendant || descendant.startsWith(`${ancestor}/`);
}
function analyzeAgentContexts(notes, guideSources = []) {
  const issues = [];
  const candidates = [];
  for (const [index, note] of notes.entries()) {
    const underScopes = noteIsUnderContextDirectory(note);
    const hasType = Object.hasOwn(note.metadata, "type");
    const type = note.metadata.type;
    if (underScopes && type !== agentContextType) {
      issues.push({
        kind: "non-context-note-under-scopes",
        notePath: note.path,
        message: `The note ${note.path} is under scopes/ but is not an agent-context note.`
      });
      if (hasType) {
        issues.push({
          kind: "malformed-context-type",
          notePath: note.path,
          actual: type,
          message: `The note ${note.path} has an invalid agent-context type.`
        });
      }
      continue;
    }
    if (type !== agentContextType)
      continue;
    if (!underScopes) {
      issues.push({
        kind: "context-note-outside-scopes",
        notePath: note.path,
        message: `The agent-context note ${note.path} must live under scopes/.`
      });
    }
    const rawScope = note.metadata.scope;
    if (typeof rawScope !== "string") {
      issues.push({
        kind: "malformed-context-scope",
        notePath: note.path,
        actual: rawScope,
        reason: "The scope must be one string.",
        message: `The agent-context note ${note.path} must declare one string scope.`
      });
      continue;
    }
    let scope;
    let preNfcScope;
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
        message: `The agent-context note ${note.path} has an invalid repository scope.`
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
        message: `The agent-context note for ${scope} must be ${canonicalPath}.`
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
      canonical
    });
  }
  const conflictedCandidateIndexes = new Set;
  const byScope = groupBy(candidates, (candidate) => candidate.scope);
  for (const [scope, matches] of byScope) {
    if (matches.length < 2)
      continue;
    for (const match of matches)
      conflictedCandidateIndexes.add(match.index);
    const preNfcScopes = sortedUnique(matches.map((match) => match.preNfcScope));
    const notePaths = matches.map((match) => match.note.path).toSorted((left, right) => left.localeCompare(right));
    if (preNfcScopes.length > 1) {
      issues.push({
        kind: "nfc-context-scope-collision",
        scope,
        rawScopes: sortedUnique(matches.map((match) => match.rawScope)),
        notePaths,
        message: `Multiple context scopes normalize to the same NFC directory ${scope}.`
      });
    } else {
      issues.push({
        kind: "duplicate-context-scope",
        scope,
        notePaths,
        message: `The repository scope ${scope} has more than one context note.`
      });
    }
  }
  const byCaseFoldedScope = groupBy(candidates, (candidate) => candidate.scope.toLocaleLowerCase("en-US"));
  for (const matches of byCaseFoldedScope.values()) {
    const scopes = sortedUnique(matches.map((match) => match.scope));
    if (scopes.length < 2)
      continue;
    for (const match of matches)
      conflictedCandidateIndexes.add(match.index);
    issues.push({
      kind: "case-fold-context-scope-collision",
      scopes,
      notePaths: matches.map((match) => match.note.path).toSorted((left, right) => left.localeCompare(right)),
      message: `Context scopes ${scopes.join(", ")} collide under case folding.`
    });
  }
  const guides = [];
  for (const guideSource of guideSources) {
    try {
      const guide = normalizedGuideSource(guideSource);
      guides.push({ ...guide, marker: parseAgentContextMarker(guide.source) });
    } catch (error) {
      issues.push({
        kind: "invalid-guide-path",
        guidePath: guideSource.path,
        reason: error instanceof Error ? error.message : "The guide path is invalid.",
        message: `The guide source path ${guideSource.path} is invalid.`
      });
    }
  }
  guides.sort((left, right) => left.path.localeCompare(right.path));
  const mappableCandidates = candidates.filter((candidate) => candidate.underScopes && candidate.canonical);
  const mappableByScope = groupBy(mappableCandidates, (candidate) => candidate.scope);
  const notesById = groupBy(notes, (note) => note.id);
  const reciprocalCandidateIndexes = new Set;
  for (const guide of guides) {
    const scopedCandidates = mappableByScope.get(guide.scope) ?? [];
    if (guide.marker.kind === "missing" && scopedCandidates.length > 0) {
      issues.push({
        kind: "guide-marker-missing",
        guidePath: guide.path,
        scope: guide.scope,
        message: `The mapped guide ${guide.path} is missing its info:context marker.`
      });
    }
    if (guide.marker.markers.length > 1) {
      issues.push({
        kind: "guide-marker-multiple",
        guidePath: guide.path,
        lines: guide.marker.markers.map((marker2) => marker2.line),
        message: `The guide ${guide.path} has more than one info:context marker.`
      });
    }
    if (guide.marker.malformed.length > 0) {
      issues.push({
        kind: "guide-marker-malformed",
        guidePath: guide.path,
        lines: guide.marker.malformed.map((marker2) => marker2.line),
        message: `The guide ${guide.path} has a malformed info:context marker.`
      });
    }
    if (guide.marker.markers.length !== 1 || guide.marker.malformed.length !== 0) {
      continue;
    }
    const marker = guide.marker.markers[0];
    if (marker === undefined)
      continue;
    const pointedNotes = notesById.get(marker.noteId) ?? [];
    if (pointedNotes.length === 0) {
      issues.push({
        kind: "guide-pointer-missing",
        guidePath: guide.path,
        noteId: marker.noteId,
        message: `The guide ${guide.path} points to missing note ${marker.noteId}.`
      });
      continue;
    }
    const pointedCandidates = mappableCandidates.filter((candidate) => candidate.canonicalId === marker.noteId && pointedNotes.includes(candidate.note));
    const reciprocal = pointedCandidates.filter((candidate) => candidate.scope === guide.scope && candidate.canonicalId === agentContextNoteId(guide.scope));
    if (reciprocal.length === 0) {
      issues.push({
        kind: "guide-pointer-mismatch",
        guidePath: guide.path,
        scope: guide.scope,
        noteId: marker.noteId,
        expectedId: agentContextNoteId(guide.scope),
        actualNotePaths: pointedNotes.map((note) => note.path).toSorted((left, right) => left.localeCompare(right)),
        message: `The guide ${guide.path} does not point to the context note for ${guide.scope}.`
      });
      continue;
    }
    for (const candidate of reciprocal) {
      reciprocalCandidateIndexes.add(candidate.index);
    }
  }
  for (const candidate of mappableCandidates) {
    if (reciprocalCandidateIndexes.has(candidate.index))
      continue;
    issues.push({
      kind: "context-note-missing-reciprocal-marker",
      notePath: candidate.note.path,
      scope: candidate.scope,
      guidePath: candidate.guidePath,
      expectedMarker: candidate.marker,
      message: `The context note ${candidate.note.path} is missing a reciprocal marker in ${candidate.guidePath}.`
    });
  }
  const contexts = candidates.map((candidate) => {
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
      valid: canonical && reciprocal && !conflictedCandidateIndexes.has(candidate.index)
    };
  }).toSorted((left, right) => left.scope.localeCompare(right.scope) || left.note.path.localeCompare(right.note.path));
  return {
    contexts,
    guides,
    issues: sortedIssues(issues)
  };
}

class AgentContextRepositoryPathError extends Error {
  code;
  path;
  constructor(code, path, message) {
    super(message);
    this.name = "AgentContextRepositoryPathError";
    this.code = code;
    this.path = path;
  }
}
function isMissingFileError(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function isUnresolvableSymlinkError(error) {
  return isMissingFileError(error) || error !== null && typeof error === "object" && "code" in error && error.code === "ELOOP";
}
async function realpathIfPresent(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (isUnresolvableSymlinkError(error))
      return null;
    throw error;
  }
}
function pathIsWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
function repositoryPath(root, scope) {
  return scope === "." ? root : join(root, ...scope.split("/"));
}
function repositoryRelativePath(root, path) {
  const fromRoot = relative(root, path).split(sep).join("/");
  return fromRoot === "" ? "." : fromRoot;
}
async function assertTargetPrefixConfined(root, normalizedTarget) {
  if (normalizedTarget === ".")
    return;
  const segments = normalizedTarget.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if (isMissingFileError(error))
        return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      const resolvedPath = await realpathIfPresent(next);
      if (resolvedPath !== null && !pathIsWithin(root, resolvedPath)) {
        throw new AgentContextRepositoryPathError("target-symlink-escape", repositoryRelativePath(root, next), `The target traverses a symbolic link outside the repository: ${next}.`);
      }
      throw new AgentContextRepositoryPathError("target-symlink", repositoryRelativePath(root, next), `The target traverses a symbolic link: ${next}.`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new AgentContextRepositoryPathError("target-parent-not-directory", repositoryRelativePath(root, next), `A target parent is not a directory: ${next}.`);
    }
    current = next;
  }
}
async function targetScope(root, target, kind, directoryHint) {
  if (kind === "directory")
    return target;
  if (kind === "file") {
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  }
  const absoluteTarget = repositoryPath(root, target);
  try {
    const metadata = await lstat(absoluteTarget);
    if (metadata.isDirectory())
      return target;
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  } catch (error) {
    if (!isMissingFileError(error))
      throw error;
  }
  if (directoryHint)
    return target;
  const basename = posix.basename(target);
  if (basename.includes(".")) {
    const parent = posix.dirname(target);
    return parent === "" ? "." : parent;
  }
  return target;
}
function scopeAncestors(scope) {
  if (scope === ".")
    return ["."];
  const segments = scope.split("/");
  const ancestors = ["."];
  for (let length = 1;length <= segments.length; length += 1) {
    ancestors.push(segments.slice(0, length).join("/"));
  }
  return ancestors;
}
async function inspectScopeDirectory(root, scope) {
  const path = repositoryPath(root, scope);
  const issues = [];
  if (scope === ".")
    return { path, issues };
  let current = root;
  for (const segment of scope.split("/")) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissingFileError(error))
        throw error;
      issues.push({
        kind: "scope-directory-missing",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope directory ${repositoryRelativePath(root, current)} does not exist.`
      });
      return { path, issues };
    }
    if (metadata.isSymbolicLink()) {
      issues.push({
        kind: "scope-directory-symlink",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope directory ${repositoryRelativePath(root, current)} is a symbolic link.`
      });
      const resolvedPath2 = await realpathIfPresent(current);
      if (resolvedPath2 !== null && !pathIsWithin(root, resolvedPath2)) {
        issues.push({
          kind: "repository-symlink-escape",
          scope,
          repositoryPath: repositoryRelativePath(root, current),
          resolvedPath: resolvedPath2,
          message: `The mapped scope directory ${repositoryRelativePath(root, current)} resolves outside the repository.`
        });
      }
      return { path, issues };
    }
    if (!metadata.isDirectory()) {
      issues.push({
        kind: "scope-directory-not-directory",
        scope,
        repositoryPath: repositoryRelativePath(root, current),
        message: `The mapped scope path ${repositoryRelativePath(root, current)} is not a directory.`
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
      message: `The mapped scope directory ${repositoryRelativePath(root, path)} resolves outside the repository.`
    });
  }
  return { path, issues };
}
async function readGuide(root, scope, required) {
  const absolutePath = join(repositoryPath(root, scope), "AGENTS.md");
  const path = agentContextGuidePath(scope);
  const issues = [];
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (!isMissingFileError(error))
      throw error;
    if (required) {
      issues.push({
        kind: "guide-file-missing",
        scope,
        repositoryPath: path,
        message: `The mapped guide ${path} does not exist.`
      });
    }
    return { absolutePath, issues };
  }
  if (metadata.isSymbolicLink()) {
    issues.push({
      kind: "guide-file-symlink",
      scope,
      repositoryPath: path,
      message: `The mapped guide ${path} is a symbolic link.`
    });
    const resolvedPath = await realpathIfPresent(absolutePath);
    if (resolvedPath !== null && !pathIsWithin(root, resolvedPath)) {
      issues.push({
        kind: "repository-symlink-escape",
        scope,
        repositoryPath: path,
        resolvedPath,
        message: `The mapped guide ${path} resolves outside the repository.`
      });
    }
    return { absolutePath, issues };
  }
  if (!metadata.isFile()) {
    issues.push({
      kind: "guide-file-not-regular",
      scope,
      repositoryPath: path,
      message: `The mapped guide ${path} is not a regular file.`
    });
    return { absolutePath, issues };
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      issues.push({
        kind: "guide-file-not-regular",
        scope,
        repositoryPath: path,
        message: `The mapped guide ${path} is not a regular file.`
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
        message: `The mapped guide ${path} resolves outside the repository.`
      });
      return { absolutePath, issues };
    }
    return {
      absolutePath,
      guide: {
        path,
        source: await handle.readFile({ encoding: "utf8" })
      },
      issues
    };
  } finally {
    await handle.close();
  }
}
function uniqueIssues(issues) {
  const unique = new Map;
  for (const issue of issues) {
    unique.set(JSON.stringify(issue), issue);
  }
  return sortedIssues([...unique.values()]);
}
async function inspectAgentContextRepository(notes, options) {
  const requestedRoot = resolve(options.repositoryRoot);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new AgentContextRepositoryPathError("root-not-directory", options.repositoryRoot, "The repository root must be a directory.");
  }
  const target = normalizeRepositoryScope(options.target ?? ".");
  await assertTargetPrefixConfined(root, target);
  const resolvedTargetScope = await targetScope(root, target, options.targetKind ?? "auto", /[\\/]$/u.test(options.target ?? "."));
  const preliminary = analyzeAgentContexts(notes);
  const validateAllMappings = options.validationMode === "all";
  const applicableCaseFoldedScopes = new Set(preliminary.contexts.filter((context) => scopeIsAncestor(context.scope, resolvedTargetScope)).map((context) => context.scope.toLocaleLowerCase("en-US")));
  const contextsToValidate = preliminary.contexts.filter((context) => validateAllMappings || applicableCaseFoldedScopes.has(context.scope.toLocaleLowerCase("en-US")));
  const notesToAnalyze = validateAllMappings ? notes : contextsToValidate.map(({ note }) => note);
  const scopesToInspect = sortedUnique(contextsToValidate.filter((context) => context.canonical).map((context) => context.scope));
  const filesystemIssues = [];
  const guidesByPath = new Map;
  for (const scope of scopesToInspect) {
    const directory = await inspectScopeDirectory(root, scope);
    filesystemIssues.push(...directory.issues);
    if (directory.issues.length > 0)
      continue;
    const read = await readGuide(root, scope, true);
    filesystemIssues.push(...read.issues);
    if (read.guide !== undefined) {
      guidesByPath.set(read.guide.path, {
        guide: read.guide,
        absolutePath: read.absolutePath
      });
    }
  }
  const inheritedGuidePaths = [];
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
    if (entry !== undefined)
      inheritedGuidePaths.push(guidePath);
  }
  const analysis = analyzeAgentContexts(notesToAnalyze, [...guidesByPath.values()].map((entry) => entry.guide));
  const guidesByAnalyzedPath = new Map(analysis.guides.map((guide) => [guide.path, guide]));
  const inheritedGuides = inheritedGuidePaths.map((path) => {
    const entry = guidesByPath.get(path);
    const guide = guidesByAnalyzedPath.get(path);
    return entry === undefined || guide === undefined ? null : { ...guide, absolutePath: entry.absolutePath };
  }).filter((guide) => guide !== null);
  const matchingContexts = analysis.contexts.filter((context) => context.valid && scopeIsAncestor(context.scope, resolvedTargetScope)).toSorted((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope) || left.scope.localeCompare(right.scope));
  return {
    repositoryRoot: root,
    target,
    targetScope: resolvedTargetScope,
    contexts: analysis.contexts,
    guides: analysis.guides,
    inheritedGuides,
    matchingContexts,
    issues: uniqueIssues([...analysis.issues, ...filesystemIssues])
  };
}

export { agentContextType, agentContextDirectory, agentContextSlugMaximumLength, agentContextHashLength, RepositoryScopeError, normalizeRepositoryScope, agentContextNoteId, agentContextNotePath, agentContextGuidePath, formatAgentContextMarker, agentContextMarkerForScope, parseAgentContextMarker, analyzeAgentContexts, AgentContextRepositoryPathError, inspectAgentContextRepository };
