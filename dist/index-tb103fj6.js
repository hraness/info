// @bun
// src/git.ts
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";
var MAX_GIT_HISTORY_COMMITS = 1000;
var MAX_GIT_HISTORY_NOTES = 1e4;
var MAX_GIT_HISTORY_OUTPUT_BYTES = 32 * 1024 * 1024;
var MAX_GIT_HISTORY_TIMEOUT_MS = 30000;
var MAX_GIT_PATHS_PER_COMMIT = 2000;
var MAX_GIT_PATH_OBSERVATIONS = 1e5;
var DEFAULT_COMMITS = 200;
var DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_COMMITS_PER_NOTE = 5;
var DEFAULT_COCHANGED_PATHS = 20;
var DEFAULT_SEARCH_LIMIT = 20;
var MAX_COMMITS_PER_NOTE = 50;
var MAX_COCHANGED_PATHS = 100;
var MAX_SEARCH_LIMIT = 100;
var MAX_QUERY_LENGTH = 500;
var commitMarker = "KB-GIT-HISTORY-V1";
var objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

class GitHistoryError extends Error {
  kind;
  constructor(kind, message, options) {
    super(message, options);
    this.name = "GitHistoryError";
    this.kind = kind;
  }
}
var runGitCommand = (request) => new Promise((resolveResult) => {
  let settled = false;
  const bytes = { stdout: [], stderr: [], total: 0, exceeded: false };
  let child;
  try {
    child = spawn("git", [...request.arguments], {
      cwd: request.cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C"
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const code = errorCode(error);
    resolveResult(code === "ENOENT" ? { status: "unavailable", message: "Git is not installed or is not on PATH." } : { status: "failed", message: errorMessage(error), reason: "exit" });
    return;
  }
  const finish = (result) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    resolveResult(result);
  };
  const append = (target, chunk) => {
    if (settled || bytes.exceeded)
      return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes.total += buffer.byteLength;
    if (bytes.total > request.maxOutputBytes) {
      bytes.exceeded = true;
      child.kill("SIGKILL");
      return;
    }
    bytes[target].push(buffer);
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.once("error", (error) => {
    finish(error.code === "ENOENT" ? { status: "unavailable", message: "Git is not installed or is not on PATH." } : { status: "failed", message: error.message, reason: "exit" });
  });
  child.once("close", (exitCode) => {
    const stdout = Buffer.concat(bytes.stdout);
    const stderr = Buffer.concat(bytes.stderr);
    if (bytes.exceeded) {
      finish({
        status: "failed",
        message: `Git output exceeded ${request.maxOutputBytes} bytes.`,
        reason: "output-limit",
        stderr
      });
    } else if (exitCode === 0) {
      finish({ status: "ok", stdout, stderr });
    } else {
      const failed = {
        status: "failed",
        message: `Git exited with code ${exitCode ?? "unknown"}.`,
        reason: "exit",
        stderr,
        ...exitCode === null ? {} : { exitCode }
      };
      finish(failed);
    }
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({
      status: "failed",
      message: `Git exceeded the ${request.timeoutMs}ms timeout.`,
      reason: "timeout"
    });
  }, request.timeoutMs);
});
function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function checkedInteger(value, fallback, minimum, maximum, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new GitHistoryError("budget", `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}
function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}
function posixRelative(parent, candidate) {
  return relative(parent, candidate).split(sep).join("/");
}
function hasControlCharacter(value, allowTab) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && !(allowTab && code === 9) || code === 127;
  });
}
function checkedRepositoryPath(value, label) {
  if (value === "" || hasControlCharacter(value, false) || value.includes("\\")) {
    throw new GitHistoryError("malformed", `${label} is not a safe repository-relative path.`);
  }
  if (value.startsWith("/") || value.endsWith("/") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new GitHistoryError("malformed", `${label} is not a normalized repository-relative path.`);
  }
  return value;
}
function checkedNoteIdentity(note) {
  const path = checkedRepositoryPath(note.path, `Note path ${JSON.stringify(note.path)}`);
  const id = checkedRepositoryPath(note.id, `Note ID ${JSON.stringify(note.id)}`);
  if (!path.endsWith(".md") || path.slice(0, -3) !== id) {
    throw new GitHistoryError("malformed", `Note ${JSON.stringify(note.id)} must use its extensionless Markdown path as its ID.`);
  }
}
function decodeOutput(value, label) {
  if (value === undefined)
    return "";
  try {
    return typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new GitHistoryError("malformed", `${label} was not valid UTF-8.`, { cause: error });
  }
}
async function checkedCommand(provider, cwd, arguments_, budget, required, label) {
  const timeoutMs = budget.timeoutMs - (Date.now() - budget.startedAt);
  const maxOutputBytes = budget.outputLimit - budget.outputBytes;
  if (timeoutMs <= 0)
    throw new GitHistoryError("budget", "Git history indexing exceeded its timeout.");
  if (maxOutputBytes <= 0) {
    throw new GitHistoryError("budget", "Git history indexing exceeded its output budget.");
  }
  let result;
  try {
    result = await provider({ cwd, arguments: arguments_, timeoutMs, maxOutputBytes });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      result = { status: "unavailable", message: "Git is not installed or is not on PATH." };
    } else {
      throw new GitHistoryError("failed", `${label} failed: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (result.status === "unavailable") {
    if (required)
      throw new GitHistoryError("unavailable", result.message);
    return {
      status: "unavailable",
      repository: cwd,
      root: cwd,
      vaultPrefix: "",
      reason: result.message
    };
  }
  if (result.status === "failed") {
    const stderr = decodeOutput(result.stderr, "Git stderr").trim();
    const detail = stderr === "" ? result.message : `${result.message} ${stderr}`;
    throw new GitHistoryError(result.reason === "timeout" || result.reason === "output-limit" ? "budget" : "failed", `${label} failed: ${detail}`);
  }
  const stdoutBytes = typeof result.stdout === "string" ? Buffer.byteLength(result.stdout) : result.stdout.byteLength;
  const stderrBytes = typeof result.stderr === "string" ? Buffer.byteLength(result.stderr) : result.stderr?.byteLength ?? 0;
  budget.outputBytes += stdoutBytes + stderrBytes;
  if (budget.outputBytes > budget.outputLimit) {
    throw new GitHistoryError("budget", "Git history indexing exceeded its output budget.");
  }
  return { status: "ok", stdout: decodeOutput(result.stdout, label) };
}
function singleLine(value, label) {
  const normalized = value.replace(/\r?\n$/u, "");
  if (normalized === "" || /[\r\n\0]/u.test(normalized)) {
    throw new GitHistoryError("malformed", `${label} was not one non-empty line.`);
  }
  return normalized;
}
function commitTime(timestamp) {
  if (!/^(?:0|[1-9]\d*)$/u.test(timestamp)) {
    throw new GitHistoryError("malformed", "Git returned a malformed commit timestamp.");
  }
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GitHistoryError("malformed", "Git returned an out-of-range commit timestamp.");
  }
  return value;
}
function normalizedSubject(value) {
  if (value.includes("\uFFFD") || hasControlCharacter(value, true)) {
    throw new GitHistoryError("malformed", "Git returned a malformed commit subject.");
  }
  return [...value.normalize("NFC").trim()].slice(0, 1000).join("");
}
function parseGitHistoryOutput(output, expectedMarker = commitMarker) {
  if (output === "")
    return [];
  if (expectedMarker === "" || expectedMarker.includes("\x00")) {
    throw new GitHistoryError("malformed", "Git history record marker is invalid.");
  }
  if (output.includes("\uFFFD")) {
    throw new GitHistoryError("malformed", "Git history output was not valid UTF-8.");
  }
  const tokens = output.split("\x00");
  const commits = [];
  let index = 0;
  let pathObservations = 0;
  while (index < tokens.length) {
    let marker = tokens[index] ?? "";
    marker = marker.replace(/^\r?\n/u, "");
    if (marker === "") {
      index += 1;
      continue;
    }
    if (marker !== expectedMarker) {
      throw new GitHistoryError("malformed", "Git history output contained an unexpected record marker.");
    }
    const hash = tokens[index + 1];
    const timestamp = tokens[index + 2];
    const subject = tokens[index + 3];
    if (hash === undefined || timestamp === undefined || subject === undefined || !objectIdPattern.test(hash)) {
      throw new GitHistoryError("malformed", "Git history output contained an incomplete commit record.");
    }
    index += 4;
    const changedPaths = [];
    const seenPaths = new Set;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const possibleMarker = token.replace(/^\r?\n/u, "");
      if (possibleMarker === expectedMarker)
        break;
      index += 1;
      if (token === "" || token === `
` || token === `\r
`)
        continue;
      const rawPath = changedPaths.length === 0 ? token.replace(/^\r?\n/u, "") : token;
      if (rawPath === "")
        continue;
      const path = checkedRepositoryPath(rawPath, "Git changed path");
      if (seenPaths.has(path))
        continue;
      seenPaths.add(path);
      changedPaths.push(path);
      pathObservations += 1;
      if (changedPaths.length > MAX_GIT_PATHS_PER_COMMIT) {
        throw new GitHistoryError("budget", `A Git commit exceeded the ${MAX_GIT_PATHS_PER_COMMIT} changed-path limit.`);
      }
      if (pathObservations > MAX_GIT_PATH_OBSERVATIONS) {
        throw new GitHistoryError("budget", `Git history exceeded the ${MAX_GIT_PATH_OBSERVATIONS} changed-path observation limit.`);
      }
    }
    commits.push({
      hash,
      timestamp: commitTime(timestamp),
      subject: normalizedSubject(subject),
      changedPaths: Object.freeze(changedPaths)
    });
    if (commits.length > MAX_GIT_HISTORY_COMMITS) {
      throw new GitHistoryError("budget", `Git history exceeded the ${MAX_GIT_HISTORY_COMMITS} commit limit.`);
    }
  }
  return Object.freeze(commits);
}
function historyArguments(hashes, marker) {
  return [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--diff-merges=first-parent",
    `--format=${marker}%x00%H%x00%ct%x00%s%x00`,
    "--name-only",
    "-z",
    ...hashes,
    "--"
  ];
}
function logArguments(maxCommits, vaultPrefix, marker) {
  return [
    "--literal-pathspecs",
    "log",
    "--no-color",
    "--no-decorate",
    "--first-parent",
    `--max-count=${maxCommits}`,
    `--format=${marker}%x00%H%x00%ct%x00%s%x00`,
    "-z",
    "HEAD",
    "--",
    vaultPrefix === "" ? "." : vaultPrefix
  ];
}
function parseCommitMetadata(output, marker) {
  return parseGitHistoryOutput(output, marker).map(({ hash, timestamp, subject }) => ({
    hash,
    timestamp,
    subject
  }));
}
function freezeCommit(commit) {
  return Object.freeze({
    hash: commit.hash,
    committedAt: new Date(commit.timestamp * 1000).toISOString(),
    subject: commit.subject,
    changedPaths: commit.changedPaths
  });
}
async function confinedNotes(notes, repository, root, vaultPrefix) {
  if (notes.length > MAX_GIT_HISTORY_NOTES) {
    throw new GitHistoryError("budget", `Git history accepts at most ${MAX_GIT_HISTORY_NOTES} live notes.`);
  }
  const seenIds = new Set;
  const seenPaths = new Set;
  const confined = [];
  for (const note of notes) {
    checkedNoteIdentity(note);
    if (seenIds.has(note.id) || seenPaths.has(note.path)) {
      throw new GitHistoryError("malformed", `Duplicate live note identity ${JSON.stringify(note.id)}.`);
    }
    seenIds.add(note.id);
    seenPaths.add(note.path);
    let resolvedNote;
    try {
      resolvedNote = await realpath(resolve(root, note.path));
    } catch (error) {
      throw new GitHistoryError("confinement", `Live note ${JSON.stringify(note.path)} could not be resolved.`, { cause: error });
    }
    if (!inside(root, resolvedNote) || !inside(repository, resolvedNote)) {
      throw new GitHistoryError("confinement", `Live note ${JSON.stringify(note.path)} resolves outside the vault or repository.`);
    }
    if (!(await stat(resolvedNote)).isFile()) {
      throw new GitHistoryError("confinement", `Live note ${JSON.stringify(note.path)} is not a file.`);
    }
    confined.push(Object.freeze({
      id: note.id,
      path: note.path,
      repositoryPath: vaultPrefix === "" ? note.path : `${vaultPrefix}/${note.path}`
    }));
  }
  return Object.freeze(confined.toSorted((left, right) => left.id.localeCompare(right.id)));
}
async function indexGitHistory(options, dependencies = {}) {
  const maxCommits = checkedInteger(options.maxCommits, DEFAULT_COMMITS, 1, MAX_GIT_HISTORY_COMMITS, "Git commit limit");
  const timeoutMs = checkedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_GIT_HISTORY_TIMEOUT_MS, "Git timeout");
  const outputLimit = checkedInteger(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1024, MAX_GIT_HISTORY_OUTPUT_BYTES, "Git output limit");
  let repository;
  let root;
  try {
    repository = await realpath(resolve(options.repository));
    root = await realpath(resolve(options.root));
  } catch (error) {
    throw new GitHistoryError("confinement", "Repository and vault roots must resolve.", { cause: error });
  }
  if (!(await stat(repository)).isDirectory() || !(await stat(root)).isDirectory()) {
    throw new GitHistoryError("confinement", "Repository and vault roots must be directories.");
  }
  if (!inside(repository, root)) {
    throw new GitHistoryError("confinement", "Knowledge-base root must resolve inside the repository.");
  }
  const vaultPrefix = posixRelative(repository, root);
  const provider = dependencies.runGit ?? runGitCommand;
  const budget = {
    startedAt: Date.now(),
    timeoutMs,
    outputLimit,
    outputBytes: 0
  };
  const topLevel = await checkedCommand(provider, repository, ["rev-parse", "--show-toplevel"], budget, options.required ?? false, "Git repository discovery");
  if (topLevel.status === "unavailable") {
    return Object.freeze({ ...topLevel, repository, root, vaultPrefix });
  }
  let actualTopLevel;
  try {
    actualTopLevel = await realpath(singleLine(topLevel.stdout, "Git repository root"));
  } catch (error) {
    if (error instanceof GitHistoryError)
      throw error;
    throw new GitHistoryError("malformed", "Git returned an unresolved repository root.", { cause: error });
  }
  if (actualTopLevel !== repository) {
    throw new GitHistoryError("confinement", `Git resolved ${JSON.stringify(actualTopLevel)} instead of the requested repository.`);
  }
  const headResult = await checkedCommand(provider, repository, ["rev-parse", "--verify", "HEAD"], budget, true, "Git HEAD discovery");
  if (headResult.status === "unavailable") {
    throw new GitHistoryError("unavailable", headResult.reason);
  }
  const head = singleLine(headResult.stdout, "Git HEAD");
  if (!objectIdPattern.test(head)) {
    throw new GitHistoryError("malformed", "Git returned a malformed HEAD object ID.");
  }
  const liveNotes = await confinedNotes(options.notes, repository, root, vaultPrefix);
  if (liveNotes.length === 0) {
    return Object.freeze({
      status: "ready",
      repository,
      root,
      vaultPrefix,
      head,
      scannedCommits: 0,
      notes: Object.freeze([])
    });
  }
  const marker = `${commitMarker}-${randomUUID()}`;
  const metadataResult = await checkedCommand(provider, repository, logArguments(maxCommits, vaultPrefix, marker), budget, true, "Git vault history");
  if (metadataResult.status === "unavailable") {
    throw new GitHistoryError("unavailable", metadataResult.reason);
  }
  const metadata = parseCommitMetadata(metadataResult.stdout, marker);
  const detailsResult = metadata.length === 0 ? null : await checkedCommand(provider, repository, historyArguments(metadata.map(({ hash }) => hash), marker), budget, true, "Git commit path history");
  if (detailsResult?.status === "unavailable") {
    throw new GitHistoryError("unavailable", detailsResult.reason);
  }
  const details = detailsResult === null ? [] : parseGitHistoryOutput(detailsResult.stdout, marker);
  if (details.length !== metadata.length || details.some((commit, index) => commit.hash !== metadata[index]?.hash)) {
    throw new GitHistoryError("malformed", "Git returned inconsistent vault and changed-path histories.");
  }
  const commits = details.map(freezeCommit);
  const commitsByPath = new Map;
  for (const commit of commits) {
    for (const path of commit.changedPaths) {
      const existing = commitsByPath.get(path);
      if (existing === undefined)
        commitsByPath.set(path, [commit]);
      else
        existing.push(commit);
    }
  }
  const indexedNotes = liveNotes.map((note) => Object.freeze({
    ...note,
    commits: Object.freeze([...commitsByPath.get(note.repositoryPath) ?? []])
  }));
  return Object.freeze({
    status: "ready",
    repository,
    root,
    vaultPrefix,
    head,
    scannedCommits: commits.length,
    notes: Object.freeze(indexedNotes)
  });
}
function noteOptions(options) {
  return {
    commitsPerNote: checkedInteger(options.commitsPerNote, DEFAULT_COMMITS_PER_NOTE, 1, MAX_COMMITS_PER_NOTE, "Per-note commit limit"),
    cochangedPathsPerCommit: checkedInteger(options.cochangedPathsPerCommit, DEFAULT_COCHANGED_PATHS, 0, MAX_COCHANGED_PATHS, "Cochanged-path limit")
  };
}
function noteCommit(commit, notePath, cochangedPathsPerCommit) {
  return Object.freeze({
    hash: commit.hash,
    committedAt: commit.committedAt,
    subject: commit.subject,
    cochangedPaths: Object.freeze(commit.changedPaths.filter((path) => path !== notePath).slice(0, cochangedPathsPerCommit))
  });
}
function gitHistoryForNotes(index, noteIds, options = {}) {
  if (index.status === "unavailable")
    return index;
  if (noteIds.length > MAX_GIT_HISTORY_NOTES) {
    throw new GitHistoryError("budget", `At most ${MAX_GIT_HISTORY_NOTES} note IDs may be requested.`);
  }
  const selected = noteOptions(options);
  const allowed = new Set(noteIds);
  const notes = index.notes.filter((note) => allowed.has(note.id)).map((note) => Object.freeze({
    id: note.id,
    path: note.path,
    commits: Object.freeze(note.commits.slice(0, selected.commitsPerNote).map((commit) => noteCommit(commit, note.repositoryPath, selected.cochangedPathsPerCommit)))
  }));
  return Object.freeze({ status: "ready", head: index.head, notes: Object.freeze(notes) });
}
function normalizedSearch(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
function queryTerms(query) {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed.length > MAX_QUERY_LENGTH || /[\0\r\n]/u.test(trimmed)) {
    throw new GitHistoryError("malformed", `Git history query must be one to ${MAX_QUERY_LENGTH} characters on one line.`);
  }
  const normalized = normalizedSearch(trimmed);
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_./-]+/u).filter(Boolean))].slice(0, 20);
  return { normalized, terms: Object.freeze(terms) };
}
function matchStrength(value, normalizedQuery, terms) {
  const normalized = normalizedSearch(value);
  if (normalized.includes(normalizedQuery))
    return 2 + normalizedQuery.length / 1000;
  if (terms.length === 0)
    return 0;
  const matched = terms.filter((term) => normalized.includes(term)).length;
  return matched / terms.length;
}
function scoredCommits(note, normalizedQuery, terms) {
  const matches = [];
  note.commits.forEach((commit, index) => {
    const subjectStrength = matchStrength(commit.subject, normalizedQuery, terms);
    const matchingPaths = commit.changedPaths.map((path) => ({ path, strength: matchStrength(path, normalizedQuery, terms) })).filter(({ strength }) => strength > 0).toSorted((left, right) => right.strength - left.strength || left.path.localeCompare(right.path));
    const bestPath = matchingPaths[0]?.strength ?? 0;
    if (subjectStrength === 0 && bestPath === 0)
      return;
    const recency = 1 / (100 + index);
    matches.push({
      score: subjectStrength * 4 + bestPath * 2 + recency,
      commit,
      matchedSubject: subjectStrength > 0,
      matchedPaths: Object.freeze(matchingPaths.map(({ path }) => path))
    });
  });
  return Object.freeze(matches.toSorted((left, right) => right.score - left.score || left.commit.hash.localeCompare(right.commit.hash)));
}
function searchGitHistory(index, options) {
  if (index.status === "unavailable")
    return index;
  const limit = checkedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT, "Git search limit");
  const provenance = noteOptions({
    ...options.commitsPerHit === undefined ? {} : { commitsPerNote: options.commitsPerHit },
    ...options.cochangedPathsPerCommit === undefined ? {} : { cochangedPathsPerCommit: options.cochangedPathsPerCommit }
  });
  const { normalized, terms } = queryTerms(options.query);
  const allowed = options.allowedNoteIds === undefined ? null : new Set(options.allowedNoteIds);
  if (allowed !== null && allowed.size > MAX_GIT_HISTORY_NOTES) {
    throw new GitHistoryError("budget", `Git search accepts at most ${MAX_GIT_HISTORY_NOTES} allowed note IDs.`);
  }
  const hits = [];
  for (const note of index.notes) {
    if (allowed !== null && !allowed.has(note.id))
      continue;
    const matches = scoredCommits(note, normalized, terms);
    if (matches.length === 0)
      continue;
    const score = matches.reduce((total, match, matchIndex) => total + match.score / (matchIndex + 1), 0);
    hits.push(Object.freeze({
      id: note.id,
      path: note.path,
      score: Number(score.toFixed(6)),
      commits: Object.freeze(matches.slice(0, provenance.commitsPerNote).map((match) => Object.freeze({
        ...noteCommit(match.commit, note.repositoryPath, provenance.cochangedPathsPerCommit),
        matchedSubject: match.matchedSubject,
        matchedPaths: Object.freeze(match.matchedPaths.slice(0, provenance.cochangedPathsPerCommit))
      })))
    }));
  }
  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return Object.freeze({
    status: "ready",
    head: index.head,
    query: options.query.trim(),
    hits: Object.freeze(hits.slice(0, limit))
  });
}

export { MAX_GIT_HISTORY_COMMITS, MAX_GIT_HISTORY_NOTES, MAX_GIT_HISTORY_OUTPUT_BYTES, MAX_GIT_HISTORY_TIMEOUT_MS, MAX_GIT_PATHS_PER_COMMIT, MAX_GIT_PATH_OBSERVATIONS, GitHistoryError, runGitCommand, parseGitHistoryOutput, indexGitHistory, gitHistoryForNotes, searchGitHistory };
