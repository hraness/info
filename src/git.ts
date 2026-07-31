import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Note } from "./graph.js";

export const MAX_GIT_HISTORY_COMMITS = 1_000;
export const MAX_GIT_HISTORY_NOTES = 10_000;
export const MAX_GIT_HISTORY_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_GIT_HISTORY_TIMEOUT_MS = 30_000;
export const MAX_GIT_PATHS_PER_COMMIT = 2_000;
export const MAX_GIT_PATH_OBSERVATIONS = 100_000;
export const MAX_GIT_NOTE_ID_UTF8_BYTES = 16 * 1_024;
export const MAX_GIT_NOTE_IDS_UTF8_BYTES = 16 * 1_024 * 1_024;

const DEFAULT_COMMITS = 200;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMITS_PER_NOTE = 5;
const DEFAULT_COCHANGED_PATHS = 20;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_COMMITS_PER_NOTE = 50;
const MAX_COCHANGED_PATHS = 100;
const MAX_SEARCH_LIMIT = 100;
const MAX_QUERY_LENGTH = 500;
const commitMarker = "KB-GIT-HISTORY-V1";
const objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export type GitCommandRequest = {
  /** Git argv only. Providers must execute these arguments without a shell. */
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type GitCommandResult =
  | {
      readonly status: "ok";
      readonly stdout: string | Uint8Array;
      readonly stderr?: string | Uint8Array;
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly exitCode?: number;
      readonly stderr?: string | Uint8Array;
      readonly reason?: "exit" | "timeout" | "output-limit";
    };

export type GitCommandProvider = (
  request: GitCommandRequest,
) => Promise<GitCommandResult>;

export type GitHistoryDependencies = {
  readonly runGit?: GitCommandProvider;
};

export type IndexGitHistoryOptions = {
  /** Repository working tree containing the vault. */
  readonly repository: string;
  /** Vault root, which must resolve inside repository. */
  readonly root: string;
  /** Live vault notes. IDs are extensionless vault-relative paths. */
  readonly notes: readonly Pick<Note, "id" | "path">[];
  readonly maxCommits?: number;
  /** Aggregate stdout and stderr budget across all Git commands. */
  readonly maxOutputBytes?: number;
  /** Aggregate wall-clock budget across all Git commands. */
  readonly timeoutMs?: number;
  /** Turn an absent Git executable into a typed error instead of an optional result. */
  readonly required?: boolean;
};

export type GitHistoryCommit = {
  readonly hash: string;
  readonly committedAt: string;
  readonly subject: string;
  /** Repository-relative paths, including the note itself. */
  readonly changedPaths: readonly string[];
  /** Present only when changedPaths retains current live-note paths after a detail limit. */
  readonly changedPathDetailsLimited?: true;
};

export type GitHistoryLimitedCommit = {
  readonly hash: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly reason: "changed-path-limit";
  readonly pathLimit: number;
  /** Number of path records Git emitted for this commit. */
  readonly observedPathRecords: number;
  readonly affectedNoteIds: readonly string[];
};

export type GitIndexedNote = {
  readonly id: string;
  readonly path: string;
  readonly repositoryPath: string;
  /** Newest first. */
  readonly commits: readonly GitHistoryCommit[];
};

export type GitHistoryIndex = {
  readonly status: "ready";
  readonly repository: string;
  readonly root: string;
  /** POSIX repository-relative vault path, or the empty string for repository root. */
  readonly vaultPrefix: string;
  readonly head: string;
  readonly scannedCommits: number;
  readonly notes: readonly GitIndexedNote[];
  /** Additive coverage detail for commits whose full co-change set was not retained. */
  readonly limitedCommits?: readonly GitHistoryLimitedCommit[];
};

export type GitHistoryUnavailable = {
  readonly status: "unavailable";
  readonly repository: string;
  readonly root: string;
  readonly vaultPrefix: string;
  readonly reason: string;
};

export type GitHistoryIndexResult = GitHistoryIndex | GitHistoryUnavailable;

export type GitHistoryErrorKind =
  | "budget"
  | "confinement"
  | "failed"
  | "malformed"
  | "unavailable";

export class GitHistoryError extends Error {
  readonly kind: GitHistoryErrorKind;

  constructor(kind: GitHistoryErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHistoryError";
    this.kind = kind;
  }
}

export type GitHistoryNoteCommit = {
  readonly hash: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly cochangedPaths: readonly string[];
  /** Present only when the source commit's complete co-change set was not indexed. */
  readonly cochangeDetailsLimited?: true;
};

export type GitHistoryNoteProvenance = {
  readonly id: string;
  readonly path: string;
  readonly commits: readonly GitHistoryNoteCommit[];
};

export type GitHistoryForNotesOptions = {
  readonly commitsPerNote?: number;
  readonly cochangedPathsPerCommit?: number;
};

export type ValidatedGitHistoryForNotesOptions = Required<GitHistoryForNotesOptions>;

export type ValidatedGitHistoryForNotesRequest = {
  readonly noteIds: readonly string[];
  readonly options: ValidatedGitHistoryForNotesOptions;
};

export type GitHistoryForNotesResult =
  | {
      readonly status: "ready";
      readonly head: string;
      readonly notes: readonly GitHistoryNoteProvenance[];
      readonly limitedCommits?: readonly GitHistoryLimitedCommit[];
    }
  | GitHistoryUnavailable;

export type SearchGitHistoryOptions = {
  readonly query: string;
  readonly allowedNoteIds?: readonly string[] | ReadonlySet<string>;
  readonly limit?: number;
  readonly commitsPerHit?: number;
  readonly cochangedPathsPerCommit?: number;
};

export type ValidatedSearchGitHistoryOptions = {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
  readonly allowedNoteIds: ReadonlySet<string> | null;
  readonly limit: number;
  readonly commitsPerHit: number;
  readonly cochangedPathsPerCommit: number;
};

export type GitHistorySearchCommit = GitHistoryNoteCommit & {
  readonly matchedSubject: boolean;
  readonly matchedPaths: readonly string[];
};

export type GitHistorySearchHit = {
  readonly id: string;
  readonly path: string;
  /** Stable score local to the Git lane. */
  readonly score: number;
  readonly commits: readonly GitHistorySearchCommit[];
};

export type GitHistorySearchResult =
  | {
      readonly status: "ready";
      readonly head: string;
      readonly query: string;
      readonly hits: readonly GitHistorySearchHit[];
      readonly limitedCommits?: readonly GitHistoryLimitedCommit[];
    }
  | GitHistoryUnavailable;

type MutableBytes = {
  stdout: Buffer[];
  stderr: Buffer[];
  total: number;
  exceeded: boolean;
};

/** Default direct-argv provider. It never invokes a shell. */
export const runGitCommand: GitCommandProvider = (request) =>
  new Promise((resolveResult) => {
    let settled = false;
    const bytes: MutableBytes = { stdout: [], stderr: [], total: 0, exceeded: false };
    let child;
    try {
      child = spawn("git", [...request.arguments], {
        cwd: request.cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const code = errorCode(error);
      resolveResult(code === "ENOENT"
        ? { status: "unavailable", message: "Git is not installed or is not on PATH." }
        : { status: "failed", message: errorMessage(error), reason: "exit" });
      return;
    }

    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled || bytes.exceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes.total += buffer.byteLength;
      if (bytes.total > request.maxOutputBytes) {
        bytes.exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      bytes[target].push(buffer);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT"
        ? { status: "unavailable", message: "Git is not installed or is not on PATH." }
        : { status: "failed", message: error.message, reason: "exit" });
    });
    child.once("close", (exitCode) => {
      const stdout = Buffer.concat(bytes.stdout);
      const stderr = Buffer.concat(bytes.stderr);
      if (bytes.exceeded) {
        finish({
          status: "failed",
          message: `Git output exceeded ${request.maxOutputBytes} bytes.`,
          reason: "output-limit",
          stderr,
        });
      } else if (exitCode === 0) {
        finish({ status: "ok", stdout, stderr });
      } else {
        const failed: GitCommandResult = {
          status: "failed",
          message: `Git exited with code ${exitCode ?? "unknown"}.`,
          reason: "exit",
          stderr,
          ...(exitCode === null ? {} : { exitCode }),
        };
        finish(failed);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        status: "failed",
        message: `Git exceeded the ${request.timeoutMs}ms timeout.`,
        reason: "timeout",
      });
    }, request.timeoutMs);
  });

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new GitHistoryError(
      "budget",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return selected;
}

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function posixRelative(parent: string, candidate: string): string {
  return relative(parent, candidate).split(sep).join("/");
}

function hasControlCharacter(value: string, allowTab: boolean): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && !(allowTab && code === 9)) || code === 127;
  });
}

function checkedRepositoryPath(value: string, label: string): string {
  if (value === "" || hasControlCharacter(value, false) || value.includes("\\")) {
    throw new GitHistoryError("malformed", `${label} is not a safe repository-relative path.`);
  }
  if (value.startsWith("/") || value.endsWith("/") || value.split("/").some(
    (segment) => segment === "" || segment === "." || segment === "..",
  )) {
    throw new GitHistoryError("malformed", `${label} is not a normalized repository-relative path.`);
  }
  return value;
}

function checkedNoteIdentity(note: Pick<Note, "id" | "path">): void {
  const path = checkedRepositoryPath(note.path, `Note path ${JSON.stringify(note.path)}`);
  const id = checkedRepositoryPath(note.id, `Note ID ${JSON.stringify(note.id)}`);
  if (!path.endsWith(".md") || path.slice(0, -3) !== id) {
    throw new GitHistoryError(
      "malformed",
      `Note ${JSON.stringify(note.id)} must use its extensionless Markdown path as its ID.`,
    );
  }
}

function decodeOutput(value: string | Uint8Array | undefined, label: string): string {
  if (value === undefined) return "";
  try {
    return typeof value === "string"
      ? value
      : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new GitHistoryError("malformed", `${label} was not valid UTF-8.`, { cause: error });
  }
}

type CommandBudget = {
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  outputBytes: number;
};

async function checkedCommand(
  provider: GitCommandProvider,
  cwd: string,
  arguments_: readonly string[],
  budget: CommandBudget,
  required: boolean,
  label: string,
): Promise<{ readonly status: "ok"; readonly stdout: string } | GitHistoryUnavailable> {
  const timeoutMs = budget.timeoutMs - (Date.now() - budget.startedAt);
  const maxOutputBytes = budget.outputLimit - budget.outputBytes;
  if (timeoutMs <= 0) throw new GitHistoryError("budget", "Git history indexing exceeded its timeout.");
  if (maxOutputBytes <= 0) {
    throw new GitHistoryError("budget", "Git history indexing exceeded its output budget.");
  }

  let result: GitCommandResult;
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
    if (required) throw new GitHistoryError("unavailable", result.message);
    return {
      status: "unavailable",
      repository: cwd,
      root: cwd,
      vaultPrefix: "",
      reason: result.message,
    };
  }
  if (result.status === "failed") {
    const stderr = decodeOutput(result.stderr, "Git stderr").trim();
    const detail = stderr === "" ? result.message : `${result.message} ${stderr}`;
    throw new GitHistoryError(
      result.reason === "timeout" || result.reason === "output-limit" ? "budget" : "failed",
      `${label} failed: ${detail}`,
    );
  }
  const stdoutBytes = typeof result.stdout === "string"
    ? Buffer.byteLength(result.stdout)
    : result.stdout.byteLength;
  const stderrBytes = typeof result.stderr === "string"
    ? Buffer.byteLength(result.stderr)
    : result.stderr?.byteLength ?? 0;
  budget.outputBytes += stdoutBytes + stderrBytes;
  if (budget.outputBytes > budget.outputLimit) {
    throw new GitHistoryError("budget", "Git history indexing exceeded its output budget.");
  }
  return { status: "ok", stdout: decodeOutput(result.stdout, label) };
}

function singleLine(value: string, label: string): string {
  const normalized = value.replace(/\r?\n$/u, "");
  if (normalized === "" || /[\r\n\0]/u.test(normalized)) {
    throw new GitHistoryError("malformed", `${label} was not one non-empty line.`);
  }
  return normalized;
}

type ParsedCommit = {
  readonly hash: string;
  readonly timestamp: number;
  readonly subject: string;
  readonly changedPaths: readonly string[];
};

type ParsedCommitLimit = Omit<ParsedCommit, "changedPaths"> & {
  readonly reason: "changed-path-limit";
  readonly pathLimit: number;
  readonly observedPathRecords: number;
};

type ParsedCommitRecord =
  | { readonly status: "complete"; readonly commit: ParsedCommit }
  | { readonly status: "limited"; readonly limit: ParsedCommitLimit };

type ChangedPathPolicy =
  | { readonly kind: "reject" }
  | { readonly kind: "limit" }
  | { readonly kind: "select"; readonly paths: ReadonlySet<string> };

type PathObservationBudget = { observed: number };

function commitTime(timestamp: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(timestamp)) {
    throw new GitHistoryError("malformed", "Git returned a malformed commit timestamp.");
  }
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GitHistoryError("malformed", "Git returned an out-of-range commit timestamp.");
  }
  return value;
}

function normalizedSubject(value: string): string {
  if (value.includes("\uFFFD") || hasControlCharacter(value, true)) {
    throw new GitHistoryError("malformed", "Git returned a malformed commit subject.");
  }
  return [...value.normalize("NFC").trim()].slice(0, 1_000).join("");
}

function parseGitHistoryRecords(
  output: string,
  expectedMarker: string,
  changedPathPolicy: ChangedPathPolicy,
  pathBudget: PathObservationBudget,
): readonly ParsedCommitRecord[] {
  if (output === "") return Object.freeze([]);
  if (expectedMarker === "" || expectedMarker.includes("\0")) {
    throw new GitHistoryError("malformed", "Git history record marker is invalid.");
  }
  if (output.includes("\uFFFD")) {
    throw new GitHistoryError("malformed", "Git history output was not valid UTF-8.");
  }
  const tokens = output.split("\0");
  const records: ParsedCommitRecord[] = [];
  let index = 0;
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
    const parsedTimestamp = commitTime(timestamp);
    const parsedSubject = normalizedSubject(subject);
    const changedPaths: string[] = [];
    const seenPaths = new Set<string>();
    let firstPath = true;
    let limited = false;
    let observedPathRecords = 0;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const possibleMarker = token.replace(/^\r?\n/u, "");
      if (possibleMarker === expectedMarker) break;
      index += 1;
      if (token === "" || token === "\n" || token === "\r\n") continue;
      // Git inserts one formatting newline before the first -z name-only path.
      const rawPath = firstPath ? token.replace(/^\r?\n/u, "") : token;
      if (rawPath === "") continue;
      firstPath = false;
      const path = checkedRepositoryPath(rawPath, "Git changed path");
      observedPathRecords += 1;
      pathBudget.observed += 1;
      if (pathBudget.observed > MAX_GIT_PATH_OBSERVATIONS) {
        throw new GitHistoryError(
          "budget",
          `Git history exceeded the ${MAX_GIT_PATH_OBSERVATIONS} changed-path observation limit.`,
        );
      }
      if (changedPathPolicy.kind === "select") {
        if (!changedPathPolicy.paths.has(path) || seenPaths.has(path)) continue;
        seenPaths.add(path);
        changedPaths.push(path);
        if (changedPaths.length > MAX_GIT_HISTORY_NOTES) {
          throw new GitHistoryError(
            "budget",
            `Git history selected more than ${MAX_GIT_HISTORY_NOTES} live-note paths in one commit.`,
          );
        }
        continue;
      }
      if (!limited && seenPaths.has(path)) continue;
      if (limited) continue;
      seenPaths.add(path);
      changedPaths.push(path);
      if (changedPaths.length > MAX_GIT_PATHS_PER_COMMIT) {
        if (changedPathPolicy.kind === "reject") {
          throw new GitHistoryError(
            "budget",
            `A Git commit exceeded the ${MAX_GIT_PATHS_PER_COMMIT} changed-path limit.`,
          );
        }
        limited = true;
        changedPaths.length = 0;
        seenPaths.clear();
      }
    }
    records.push(limited
      ? {
          status: "limited",
          limit: Object.freeze({
            hash,
            timestamp: parsedTimestamp,
            subject: parsedSubject,
            reason: "changed-path-limit",
            pathLimit: MAX_GIT_PATHS_PER_COMMIT,
            observedPathRecords,
          }),
        }
      : {
          status: "complete",
          commit: Object.freeze({
            hash,
            timestamp: parsedTimestamp,
            subject: parsedSubject,
            changedPaths: Object.freeze(changedPaths),
          }),
        });
    if (records.length > MAX_GIT_HISTORY_COMMITS) {
      throw new GitHistoryError(
        "budget",
        `Git history exceeded the ${MAX_GIT_HISTORY_COMMITS} commit limit.`,
      );
    }
  }
  return Object.freeze(records);
}

/** Parse the NUL-delimited output emitted by historyArguments. */
export function parseGitHistoryOutput(
  output: string,
  expectedMarker = commitMarker,
): readonly ParsedCommit[] {
  return Object.freeze(parseGitHistoryRecords(
    output,
    expectedMarker,
    { kind: "reject" },
    { observed: 0 },
  ).map((record) => {
    if (record.status === "limited") {
      throw new GitHistoryError(
        "budget",
        `A Git commit exceeded the ${MAX_GIT_PATHS_PER_COMMIT} changed-path limit.`,
      );
    }
    return record.commit;
  }));
}

function parseSelectedGitHistoryOutput(
  output: string,
  expectedMarker: string,
  paths: ReadonlySet<string>,
  pathBudget: PathObservationBudget,
): readonly ParsedCommit[] {
  return Object.freeze(parseGitHistoryRecords(
    output,
    expectedMarker,
    { kind: "select", paths },
    pathBudget,
  ).map((record) => {
    if (record.status === "limited") {
      throw new GitHistoryError("malformed", "Git live-note history was unexpectedly limited.");
    }
    return record.commit;
  }));
}

function historyArguments(
  hashes: readonly string[],
  marker: string,
): readonly string[] {
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
    "--",
  ];
}

function logArguments(
  maxCommits: number,
  vaultPrefix: string,
  marker: string,
  revision: string,
): readonly string[] {
  return [
    "--literal-pathspecs",
    "log",
    "--no-color",
    "--no-decorate",
    "--no-renames",
    "--diff-merges=first-parent",
    "--first-parent",
    `--max-count=${maxCommits}`,
    `--format=${marker}%x00%H%x00%ct%x00%s%x00`,
    "--name-only",
    "-z",
    revision,
    "--",
    vaultPrefix === "" ? "." : vaultPrefix,
  ];
}

function freezeCommit(commit: ParsedCommit, changedPathDetailsLimited: boolean): GitHistoryCommit {
  return Object.freeze({
    hash: commit.hash,
    committedAt: new Date(commit.timestamp * 1_000).toISOString(),
    subject: commit.subject,
    changedPaths: commit.changedPaths,
    ...(changedPathDetailsLimited ? { changedPathDetailsLimited: true as const } : {}),
  });
}

function recordHash(record: ParsedCommitRecord): string {
  return record.status === "complete" ? record.commit.hash : record.limit.hash;
}

async function confinedNotes(
  notes: readonly Pick<Note, "id" | "path">[],
  repository: string,
  root: string,
  vaultPrefix: string,
): Promise<readonly { readonly id: string; readonly path: string; readonly repositoryPath: string }[]> {
  if (notes.length > MAX_GIT_HISTORY_NOTES) {
    throw new GitHistoryError(
      "budget",
      `Git history accepts at most ${MAX_GIT_HISTORY_NOTES} live notes.`,
    );
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const confined = [];
  for (const note of notes) {
    checkedNoteIdentity(note);
    if (seenIds.has(note.id) || seenPaths.has(note.path)) {
      throw new GitHistoryError("malformed", `Duplicate live note identity ${JSON.stringify(note.id)}.`);
    }
    seenIds.add(note.id);
    seenPaths.add(note.path);
    let resolvedNote: string;
    try {
      resolvedNote = await realpath(resolve(root, note.path));
    } catch (error) {
      throw new GitHistoryError(
        "confinement",
        `Live note ${JSON.stringify(note.path)} could not be resolved.`,
        { cause: error },
      );
    }
    if (!inside(root, resolvedNote) || !inside(repository, resolvedNote)) {
      throw new GitHistoryError(
        "confinement",
        `Live note ${JSON.stringify(note.path)} resolves outside the vault or repository.`,
      );
    }
    if (!(await stat(resolvedNote)).isFile()) {
      throw new GitHistoryError("confinement", `Live note ${JSON.stringify(note.path)} is not a file.`);
    }
    confined.push(Object.freeze({
      id: note.id,
      path: note.path,
      repositoryPath: vaultPrefix === "" ? note.path : `${vaultPrefix}/${note.path}`,
    }));
  }
  return Object.freeze(confined.toSorted((left, right) => left.id.localeCompare(right.id)));
}

/** Build a bounded, read-only projection of commits that touched live vault notes. */
export async function indexGitHistory(
  options: IndexGitHistoryOptions,
  dependencies: GitHistoryDependencies = {},
): Promise<GitHistoryIndexResult> {
  const maxCommits = checkedInteger(
    options.maxCommits,
    DEFAULT_COMMITS,
    1,
    MAX_GIT_HISTORY_COMMITS,
    "Git commit limit",
  );
  const timeoutMs = checkedInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1,
    MAX_GIT_HISTORY_TIMEOUT_MS,
    "Git timeout",
  );
  const outputLimit = checkedInteger(
    options.maxOutputBytes,
    DEFAULT_OUTPUT_BYTES,
    1_024,
    MAX_GIT_HISTORY_OUTPUT_BYTES,
    "Git output limit",
  );
  let repository: string;
  let root: string;
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
  const budget: CommandBudget = {
    startedAt: Date.now(),
    timeoutMs,
    outputLimit,
    outputBytes: 0,
  };
  const topLevel = await checkedCommand(
    provider,
    repository,
    ["rev-parse", "--show-toplevel"],
    budget,
    options.required ?? false,
    "Git repository discovery",
  );
  if (topLevel.status === "unavailable") {
    return Object.freeze({ ...topLevel, repository, root, vaultPrefix });
  }
  let actualTopLevel: string;
  try {
    actualTopLevel = await realpath(singleLine(topLevel.stdout, "Git repository root"));
  } catch (error) {
    if (error instanceof GitHistoryError) throw error;
    throw new GitHistoryError("malformed", "Git returned an unresolved repository root.", { cause: error });
  }
  if (actualTopLevel !== repository) {
    throw new GitHistoryError(
      "confinement",
      `Git resolved ${JSON.stringify(actualTopLevel)} instead of the requested repository.`,
    );
  }
  const headResult = await checkedCommand(
    provider,
    repository,
    ["rev-parse", "--verify", "HEAD"],
    budget,
    true,
    "Git HEAD discovery",
  );
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
      notes: Object.freeze([]),
    });
  }
  // A per-index nonce prevents a repository path from being confused with a
  // framing record while retaining one bounded bulk Git invocation.
  const marker = `${commitMarker}-${randomUUID()}`;
  const pathBudget: PathObservationBudget = { observed: 0 };
  const metadataResult = await checkedCommand(
    provider,
    repository,
    logArguments(maxCommits, vaultPrefix, marker, head),
    budget,
    true,
    "Git vault history",
  );
  if (metadataResult.status === "unavailable") {
    throw new GitHistoryError("unavailable", metadataResult.reason);
  }
  const noteIdByRepositoryPath = new Map<string, string>(
    liveNotes.map(({ id, repositoryPath }) => [repositoryPath, id] as const),
  );
  const vaultCommits = parseSelectedGitHistoryOutput(
    metadataResult.stdout,
    marker,
    new Set(noteIdByRepositoryPath.keys()),
    pathBudget,
  );
  const detailsResult = vaultCommits.length === 0
    ? null
    : await checkedCommand(
      provider,
      repository,
      historyArguments(vaultCommits.map(({ hash }) => hash), marker),
      budget,
      true,
      "Git commit path history",
    );
  if (detailsResult?.status === "unavailable") {
    throw new GitHistoryError("unavailable", detailsResult.reason);
  }
  const detailRecords = detailsResult === null
    ? []
    : parseGitHistoryRecords(
        detailsResult.stdout,
        marker,
        { kind: "limit" },
        pathBudget,
      );
  if (
    detailRecords.length !== vaultCommits.length
    || detailRecords.some((record, index) => recordHash(record) !== vaultCommits[index]?.hash)
  ) {
    throw new GitHistoryError("malformed", "Git returned inconsistent vault and changed-path histories.");
  }
  const commits: GitHistoryCommit[] = [];
  const limitedCommits: GitHistoryLimitedCommit[] = [];
  detailRecords.forEach((detailRecord, index) => {
    const vaultCommit = vaultCommits[index]!;
    if (detailRecord.status === "complete") {
      commits.push(freezeCommit(detailRecord.commit, false));
      return;
    }
    const affectedNoteIds = Object.freeze(vaultCommit.changedPaths.map((path) => {
      const noteId = noteIdByRepositoryPath.get(path);
      if (noteId === undefined) {
        throw new GitHistoryError("malformed", "Git selected a path outside the live-note set.");
      }
      return noteId;
    }));
    commits.push(freezeCommit({
      hash: detailRecord.limit.hash,
      timestamp: detailRecord.limit.timestamp,
      subject: detailRecord.limit.subject,
      changedPaths: vaultCommit.changedPaths,
    }, true));
    limitedCommits.push(Object.freeze({
      hash: detailRecord.limit.hash,
      committedAt: new Date(detailRecord.limit.timestamp * 1_000).toISOString(),
      subject: detailRecord.limit.subject,
      reason: detailRecord.limit.reason,
      pathLimit: detailRecord.limit.pathLimit,
      observedPathRecords: detailRecord.limit.observedPathRecords,
      affectedNoteIds,
    }));
  });
  const commitsByPath = new Map<string, GitHistoryCommit[]>();
  for (const commit of commits) {
    for (const path of commit.changedPaths) {
      const existing = commitsByPath.get(path);
      if (existing === undefined) commitsByPath.set(path, [commit]);
      else existing.push(commit);
    }
  }
  const indexedNotes = liveNotes.map((note): GitIndexedNote => Object.freeze({
    ...note,
    commits: Object.freeze([...(commitsByPath.get(note.repositoryPath) ?? [])]),
  }));
  return Object.freeze({
    status: "ready",
    repository,
    root,
    vaultPrefix,
    head,
    scannedCommits: detailRecords.length,
    notes: Object.freeze(indexedNotes),
    ...(limitedCommits.length === 0
      ? {}
      : { limitedCommits: Object.freeze(limitedCommits) }),
  });
}

function limitedCommitsForNotes(
  limitedCommits: readonly GitHistoryLimitedCommit[] | undefined,
  noteIds: ReadonlySet<string>,
  commitHashes: ReadonlySet<string> | null,
): readonly GitHistoryLimitedCommit[] {
  if (limitedCommits === undefined || limitedCommits.length === 0) return Object.freeze([]);
  return Object.freeze(limitedCommits.flatMap((commit) => {
    if (commitHashes !== null && !commitHashes.has(commit.hash)) return [];
    const affectedNoteIds = Object.freeze(commit.affectedNoteIds.filter((id) => noteIds.has(id)));
    return affectedNoteIds.length === 0
      ? []
      : [Object.freeze({ ...commit, affectedNoteIds })];
  }));
}

/** Validate and normalize bounded per-note provenance options without opening Git. */
export function validateGitHistoryForNotesOptions(
  options: GitHistoryForNotesOptions = {},
): ValidatedGitHistoryForNotesOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitHistoryError("malformed", "Git history options must be an object.");
  }
  return Object.freeze({
    commitsPerNote: checkedInteger(
      options.commitsPerNote,
      DEFAULT_COMMITS_PER_NOTE,
      1,
      MAX_COMMITS_PER_NOTE,
      "Per-note commit limit",
    ),
    cochangedPathsPerCommit: checkedInteger(
      options.cochangedPathsPerCommit,
      DEFAULT_COCHANGED_PATHS,
      0,
      MAX_COCHANGED_PATHS,
      "Cochanged-path limit",
    ),
  });
}

function isIterableObject(value: unknown): value is Iterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.iterator in value
    && typeof value[Symbol.iterator] === "function";
}

function checkedNoteIds(
  value: unknown,
  label: string,
  countMessage: string,
): readonly string[] {
  if (!Array.isArray(value) && !isIterableObject(value)) {
    throw new GitHistoryError("malformed", `${label}s must be provided as an array or set.`);
  }
  const noteIds: string[] = [];
  let noteIdBytes = 0;
  for (const noteId of value) {
    if (noteIds.length >= MAX_GIT_HISTORY_NOTES) {
      throw new GitHistoryError("budget", countMessage);
    }
    if (typeof noteId !== "string") {
      throw new GitHistoryError(
        "malformed",
        `${label} ${noteIds.length + 1} must be a string.`,
      );
    }
    const noteIdByteLength = Buffer.byteLength(noteId, "utf8");
    if (noteIdByteLength > MAX_GIT_NOTE_ID_UTF8_BYTES) {
      throw new GitHistoryError(
        "budget",
        `${label} ${noteIds.length + 1} must be at most `
          + `${MAX_GIT_NOTE_ID_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
      );
    }
    noteIdBytes += noteIdByteLength;
    if (noteIdBytes > MAX_GIT_NOTE_IDS_UTF8_BYTES) {
      throw new GitHistoryError(
        "budget",
        `${label}s must total at most `
          + `${MAX_GIT_NOTE_IDS_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
      );
    }
    noteIds.push(noteId);
  }
  return Object.freeze(noteIds);
}

/** Validate a direct note-provenance request before opening or indexing Git. */
export function validateGitHistoryForNotesRequest(
  noteIds: readonly string[],
  options: GitHistoryForNotesOptions = {},
): ValidatedGitHistoryForNotesRequest {
  return Object.freeze({
    noteIds: checkedNoteIds(
      noteIds,
      "Git history note ID",
      `At most ${MAX_GIT_HISTORY_NOTES} note IDs may be requested.`,
    ),
    options: validateGitHistoryForNotesOptions(options),
  });
}

function noteCommit(
  commit: GitHistoryCommit,
  notePath: string,
  cochangedPathsPerCommit: number,
): GitHistoryNoteCommit {
  return Object.freeze({
    hash: commit.hash,
    committedAt: commit.committedAt,
    subject: commit.subject,
    cochangedPaths: Object.freeze(commit.changedPaths
      .filter((path) => path !== notePath)
      .slice(0, cochangedPathsPerCommit)),
    ...(commit.changedPathDetailsLimited === true
      ? { cochangeDetailsLimited: true as const }
      : {}),
  });
}

/** Return bounded provenance for final note IDs without exposing the whole index. */
export function gitHistoryForNotes(
  index: GitHistoryIndexResult,
  noteIds: readonly string[],
  options: GitHistoryForNotesOptions = {},
): GitHistoryForNotesResult {
  const request = validateGitHistoryForNotesRequest(noteIds, options);
  if (index.status === "unavailable") return index;
  const allowed = new Set(request.noteIds);
  const notes = index.notes
    .filter((note) => allowed.has(note.id))
    .map((note): GitHistoryNoteProvenance => Object.freeze({
      id: note.id,
      path: note.path,
      commits: Object.freeze(note.commits.slice(0, request.options.commitsPerNote).map((commit) =>
        noteCommit(commit, note.repositoryPath, request.options.cochangedPathsPerCommit))),
    }));
  const returnedNoteIds = new Set(notes.map(({ id }) => id));
  const returnedCommitHashes = new Set(notes.flatMap(({ commits }) =>
    commits.map(({ hash }) => hash)));
  const limitedCommits = limitedCommitsForNotes(
    index.limitedCommits,
    returnedNoteIds,
    returnedCommitHashes,
  );
  return Object.freeze({
    status: "ready",
    head: index.head,
    notes: Object.freeze(notes),
    ...(limitedCommits.length === 0 ? {} : { limitedCommits }),
  });
}

function normalizedSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function queryTerms(query: unknown): { readonly normalized: string; readonly terms: readonly string[] } {
  if (typeof query !== "string") {
    throw new GitHistoryError(
      "malformed",
      `Git history query must be one to ${MAX_QUERY_LENGTH} characters on one line.`,
    );
  }
  const trimmed = query.trim();
  if (trimmed === "" || trimmed.length > MAX_QUERY_LENGTH || /[\0\r\n]/u.test(trimmed)) {
    throw new GitHistoryError(
      "malformed",
      `Git history query must be one to ${MAX_QUERY_LENGTH} characters on one line.`,
    );
  }
  const normalized = normalizedSearch(trimmed);
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_./-]+/u).filter(Boolean))].slice(0, 20);
  return { normalized, terms: Object.freeze(terms) };
}

/** Validate and normalize a history-search request before opening or indexing Git. */
export function validateSearchGitHistoryOptions(
  options: SearchGitHistoryOptions,
): ValidatedSearchGitHistoryOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitHistoryError("malformed", "Git history search options must be an object.");
  }
  const limit = checkedInteger(
    options.limit,
    DEFAULT_SEARCH_LIMIT,
    1,
    MAX_SEARCH_LIMIT,
    "Git search limit",
  );
  const provenance = validateGitHistoryForNotesOptions({
    ...(options.commitsPerHit === undefined ? {} : { commitsPerNote: options.commitsPerHit }),
    ...(options.cochangedPathsPerCommit === undefined
      ? {}
      : { cochangedPathsPerCommit: options.cochangedPathsPerCommit }),
  });
  const { normalized, terms } = queryTerms(options.query);
  const checkedAllowed = options.allowedNoteIds === undefined
    ? null
    : checkedNoteIds(
        options.allowedNoteIds,
        "Git search allowed note ID",
        `Git search accepts at most ${MAX_GIT_HISTORY_NOTES} allowed note IDs.`,
      );
  return Object.freeze({
    query: options.query.trim(),
    normalizedQuery: normalized,
    terms,
    allowedNoteIds: checkedAllowed === null ? null : new Set(checkedAllowed),
    limit,
    commitsPerHit: provenance.commitsPerNote,
    cochangedPathsPerCommit: provenance.cochangedPathsPerCommit,
  });
}

function matchStrength(value: string, normalizedQuery: string, terms: readonly string[]): number {
  const normalized = normalizedSearch(value);
  if (normalized.includes(normalizedQuery)) return 2 + normalizedQuery.length / 1_000;
  if (terms.length === 0) return 0;
  const matched = terms.filter((term) => normalized.includes(term)).length;
  return matched / terms.length;
}

type ScoredCommit = {
  readonly score: number;
  readonly commit: GitHistoryCommit;
  readonly matchedSubject: boolean;
  readonly matchedPaths: readonly string[];
};

function scoredCommits(
  note: GitIndexedNote,
  normalizedQuery: string,
  terms: readonly string[],
): readonly ScoredCommit[] {
  const matches: ScoredCommit[] = [];
  note.commits.forEach((commit, index) => {
    const subjectStrength = matchStrength(commit.subject, normalizedQuery, terms);
    const matchingPaths = commit.changedPaths
      .map((path) => ({ path, strength: matchStrength(path, normalizedQuery, terms) }))
      .filter(({ strength }) => strength > 0)
      .toSorted((left, right) => right.strength - left.strength || left.path.localeCompare(right.path));
    const bestPath = matchingPaths[0]?.strength ?? 0;
    if (subjectStrength === 0 && bestPath === 0) return;
    const recency = 1 / (100 + index);
    matches.push({
      score: subjectStrength * 4 + bestPath * 2 + recency,
      commit,
      matchedSubject: subjectStrength > 0,
      matchedPaths: Object.freeze(matchingPaths.map(({ path }) => path)),
    });
  });
  return Object.freeze(matches.toSorted((left, right) =>
    right.score - left.score || left.commit.hash.localeCompare(right.commit.hash)));
}

/** Rank notes by matching commit subjects and paths changed in the same commits. */
export function searchGitHistory(
  index: GitHistoryIndexResult,
  options: SearchGitHistoryOptions,
): GitHistorySearchResult {
  const request = validateSearchGitHistoryOptions(options);
  if (index.status === "unavailable") return index;
  const hits: GitHistorySearchHit[] = [];
  for (const note of index.notes) {
    if (request.allowedNoteIds !== null && !request.allowedNoteIds.has(note.id)) continue;
    const matches = scoredCommits(note, request.normalizedQuery, request.terms);
    if (matches.length === 0) continue;
    const score = matches.reduce((total, match, matchIndex) =>
      total + match.score / (matchIndex + 1), 0);
    hits.push(Object.freeze({
      id: note.id,
      path: note.path,
      score: Number(score.toFixed(6)),
      commits: Object.freeze(matches.slice(0, request.commitsPerHit).map((match) => Object.freeze({
        ...noteCommit(match.commit, note.repositoryPath, request.cochangedPathsPerCommit),
        matchedSubject: match.matchedSubject,
        matchedPaths: Object.freeze(match.matchedPaths.slice(0, request.cochangedPathsPerCommit)),
      }))),
    }));
  }
  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const searchableNoteIds = new Set(index.notes.flatMap(({ id }) =>
    request.allowedNoteIds === null || request.allowedNoteIds.has(id) ? [id] : []));
  const limitedCommits = limitedCommitsForNotes(
    index.limitedCommits,
    searchableNoteIds,
    null,
  );
  return Object.freeze({
    status: "ready",
    head: index.head,
    query: request.query,
    hits: Object.freeze(hits.slice(0, request.limit)),
    ...(limitedCommits.length === 0 ? {} : { limitedCommits }),
  });
}
