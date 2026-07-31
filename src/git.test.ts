import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseNote } from "./graph.js";
import {
  GitHistoryError,
  gitHistoryForNotes,
  indexGitHistory,
  MAX_GIT_HISTORY_COMMITS,
  MAX_GIT_PATH_OBSERVATIONS,
  MAX_GIT_PATHS_PER_COMMIT,
  parseGitHistoryOutput,
  searchGitHistory,
  type GitCommandProvider,
} from "./git.js";

const temporaryRoots: string[] = [];
const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const hashC = "c".repeat(40);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const resolved = realpathSync(root);
  temporaryRoots.push(resolved);
  return resolved;
}

function git(repository: string, ...arguments_: readonly string[]): string {
  const result = spawnSync("git", [...arguments_], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

type InjectedHistoryRecord = {
  readonly hash: string;
  readonly subject: string;
  readonly paths: readonly string[];
};

function historyOutput(marker: string, records: readonly InjectedHistoryRecord[]): string {
  return `${records.flatMap((record) => [
    marker,
    record.hash,
    "1600000000",
    record.subject,
    ...record.paths,
  ]).join("\0")}\0`;
}

function historyMarker(arguments_: readonly string[]): string {
  const format = arguments_.find((argument) => argument.startsWith("--format="));
  const marker = format?.slice("--format=".length).split("%x00")[0];
  if (marker === undefined || marker === "") throw new Error("Missing injected history marker.");
  return marker;
}

function injectedHistoryProvider(
  repository: string,
  head: string,
  vaultRecords: readonly InjectedHistoryRecord[],
  detailRecords: readonly InjectedHistoryRecord[],
): GitCommandProvider {
  return (request) => {
    if (request.arguments.includes("--show-toplevel")) {
      return Promise.resolve({ status: "ok", stdout: `${repository}\n` });
    }
    if (request.arguments.includes("--verify")) {
      return Promise.resolve({ status: "ok", stdout: `${head}\n` });
    }
    const marker = historyMarker(request.arguments);
    return Promise.resolve({
      status: "ok",
      stdout: historyOutput(
        marker,
        request.arguments.includes("log") ? vaultRecords : detailRecords,
      ),
    });
  };
}

function initializeRepository(): {
  readonly repository: string;
  readonly root: string;
  readonly notes: readonly ReturnType<typeof parseNote>[];
} {
  const repository = temporary("kb-git-history");
  git(repository, "init", "--quiet");
  git(repository, "config", "user.email", "kb@example.test");
  git(repository, "config", "user.name", "KB Test");
  const root = join(repository, "kb");

  write(repository, "kb/notes/memory.md", "# Durable memory\n");
  write(repository, "src/authentication.ts", "export const authenticate = true;\n");
  git(repository, "add", "--", "kb/notes/memory.md", "src/authentication.ts");
  git(repository, "commit", "--quiet", "-m", "Preserve authentication decisions");

  write(repository, "kb/notes/retrieval.md", "# Retrieval\n");
  write(repository, "src/semantic-engine.ts", "export const rank = true;\n");
  git(repository, "add", "--", "kb/notes/retrieval.md", "src/semantic-engine.ts");
  git(repository, "commit", "--quiet", "-m", "Add hybrid retrieval lane");

  write(repository, "kb/notes/memory.md", "# Durable memory\n\nLinked to retrieval.\n");
  write(repository, "src/graph-walk.ts", "export const walk = true;\n");
  git(repository, "add", "--", "kb/notes/memory.md", "src/graph-walk.ts");
  git(repository, "commit", "--quiet", "-m", "Connect memory graph traversal");

  return {
    repository,
    root,
    notes: [
      parseNote("notes/memory.md", "# Durable memory\n\nLinked to retrieval.\n"),
      parseNote("notes/retrieval.md", "# Retrieval\n"),
    ],
  };
}

describe("Git history indexing", () => {
  test("indexes real note-touch history and repository paths changed beside each note", async () => {
    const fixture = initializeRepository();
    const indexed = await indexGitHistory(fixture);

    expect(indexed.status).toBe("ready");
    if (indexed.status !== "ready") return;
    expect(indexed.repository).toBe(fixture.repository);
    expect(indexed.root).toBe(fixture.root);
    expect(indexed.vaultPrefix).toBe("kb");
    expect(indexed.head).toBe(git(fixture.repository, "rev-parse", "HEAD"));
    expect(indexed.scannedCommits).toBe(3);
    expect(indexed.notes.map(({ id }) => id)).toEqual(["notes/memory", "notes/retrieval"]);
    expect(indexed.notes[0]?.commits.map(({ subject }) => subject)).toEqual([
      "Connect memory graph traversal",
      "Preserve authentication decisions",
    ]);
    expect(indexed.notes[0]?.commits[0]?.changedPaths).toEqual([
      "kb/notes/memory.md",
      "src/graph-walk.ts",
    ]);
    expect(indexed.notes[1]?.commits[0]?.changedPaths).toContain("src/semantic-engine.ts");
    expect(Object.isFrozen(indexed)).toBeTrue();
    expect(Object.isFrozen(indexed.notes[0]?.commits)).toBeTrue();
  });

  test("treats a vault directory with Git pathspec magic as a literal path", async () => {
    const repository = temporary("kb-git-literal-pathspec");
    git(repository, "init", "--quiet");
    git(repository, "config", "user.email", "kb@example.test");
    git(repository, "config", "user.name", "KB Test");
    write(repository, "outside.md", "# Outside\n");
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "Unrelated repository history");

    const vaultPrefix = ":(exclude)kb";
    const root = join(repository, vaultPrefix);
    const content = "# Literal pathspec vault\n";
    write(repository, `${vaultPrefix}/note.md`, content);
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "Add the literal vault note");

    const indexed = await indexGitHistory({
      repository,
      root,
      notes: [parseNote("note.md", content)],
    });
    expect(indexed.status).toBe("ready");
    if (indexed.status !== "ready") return;
    expect(indexed.vaultPrefix).toBe(vaultPrefix);
    expect(indexed.scannedCommits).toBe(1);
    expect(indexed.notes[0]?.commits.map(({ subject }) => subject)).toEqual([
      "Add the literal vault note",
    ]);
  });

  test("ranks notes from commit subjects and cochanged code paths with bounded provenance", async () => {
    const fixture = initializeRepository();
    const indexed = await indexGitHistory(fixture);

    const bySubject = searchGitHistory(indexed, { query: "authentication" });
    expect(bySubject.status).toBe("ready");
    if (bySubject.status !== "ready") return;
    expect(bySubject.hits.map(({ id }) => id)).toEqual(["notes/memory"]);
    expect(bySubject.hits[0]?.commits[0]).toMatchObject({
      subject: "Preserve authentication decisions",
      matchedSubject: true,
    });

    const byCodePath = searchGitHistory(indexed, {
      query: "semantic-engine",
      allowedNoteIds: new Set(["notes/retrieval"]),
      commitsPerHit: 1,
      cochangedPathsPerCommit: 1,
    });
    expect(byCodePath.status).toBe("ready");
    if (byCodePath.status !== "ready") return;
    expect(byCodePath.hits).toEqual([
      expect.objectContaining({
        id: "notes/retrieval",
        commits: [expect.objectContaining({
          matchedSubject: false,
          matchedPaths: ["src/semantic-engine.ts"],
          cochangedPaths: ["src/semantic-engine.ts"],
        })],
      }),
    ]);
  });

  test("returns only requested note IDs and enforces per-note provenance bounds", async () => {
    const fixture = initializeRepository();
    const indexed = await indexGitHistory(fixture);
    const provenance = gitHistoryForNotes(indexed, ["notes/memory", "missing"], {
      commitsPerNote: 1,
      cochangedPathsPerCommit: 1,
    });

    expect(provenance.status).toBe("ready");
    if (provenance.status !== "ready") return;
    expect(provenance.notes).toHaveLength(1);
    expect(provenance.notes[0]?.id).toBe("notes/memory");
    expect(provenance.notes[0]?.path).toBe("notes/memory.md");
    expect(provenance.notes[0]?.commits).toHaveLength(1);
    expect(provenance.notes[0]?.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/u);
    expect(provenance.notes[0]?.commits[0]?.committedAt).toMatch(/^\d{4}-/u);
    expect(provenance.notes[0]?.commits[0]?.subject).toBe("Connect memory graph traversal");
    expect(provenance.notes[0]?.commits[0]?.cochangedPaths).toEqual(["src/graph-walk.ts"]);
  });

  test("limits the commit window before loading cochanged paths", async () => {
    const fixture = initializeRepository();
    const indexed = await indexGitHistory({ ...fixture, maxCommits: 1 });
    expect(indexed.status).toBe("ready");
    if (indexed.status !== "ready") return;
    expect(indexed.scannedCommits).toBe(1);
    expect(indexed.notes[0]?.commits).toHaveLength(1);
    expect(indexed.notes[1]?.commits).toEqual([]);
  });

  test("localizes an oversized commit while preserving its note provenance and later commits", async () => {
    const fixture = initializeRepository();
    const unaffectedContent = "# Unaffected\n";
    write(fixture.repository, "kb/notes/unaffected.md", unaffectedContent);
    const options = {
      ...fixture,
      notes: [...fixture.notes, parseNote("notes/unaffected.md", unaffectedContent)],
    };
    const vaultRecords = [
      {
        hash: hashC,
        subject: "Normal memory follow-up",
        paths: ["kb/notes/memory.md"],
      },
      {
        hash: hashA,
        subject: "Large repository rename",
        paths: [
          ...Array.from(
            { length: MAX_GIT_PATHS_PER_COMMIT },
            (_, index) => `kb/removed/note-${index}.md`,
          ),
          "kb/notes/memory.md",
          "kb/notes/retrieval.md",
        ],
      },
      {
        hash: hashB,
        subject: "Normal retrieval update",
        paths: ["kb/notes/retrieval.md"],
      },
    ];
    const detailRecords = [
      {
        ...vaultRecords[0]!,
        paths: ["kb/notes/memory.md", "src/memory.ts"],
      },
      {
        ...vaultRecords[1]!,
        paths: vaultRecords[1]!.paths,
      },
      {
        ...vaultRecords[2]!,
        paths: ["kb/notes/retrieval.md", "src/retrieval.ts"],
      },
    ];
    const indexed = await indexGitHistory(options, {
      runGit: injectedHistoryProvider(
        fixture.repository,
        hashC,
        vaultRecords,
        detailRecords,
      ),
    });

    expect(indexed.status).toBe("ready");
    if (indexed.status !== "ready") return;
    expect(indexed.scannedCommits).toBe(3);
    expect(indexed.limitedCommits).toEqual([{
      hash: hashA,
      committedAt: "2020-09-13T12:26:40.000Z",
      subject: "Large repository rename",
      reason: "changed-path-limit",
      pathLimit: MAX_GIT_PATHS_PER_COMMIT,
      observedPathRecords: MAX_GIT_PATHS_PER_COMMIT + 2,
      affectedNoteIds: ["notes/memory", "notes/retrieval"],
    }]);
    expect(indexed.notes[0]?.commits[1]).toMatchObject({
      hash: hashA,
      changedPaths: ["kb/notes/memory.md", "kb/notes/retrieval.md"],
      changedPathDetailsLimited: true,
    });
    expect(indexed.notes[0]?.commits[0]).not.toHaveProperty("changedPathDetailsLimited");

    const memory = gitHistoryForNotes(indexed, ["notes/memory"]);
    expect(memory).toMatchObject({
      status: "ready",
      notes: [{
        id: "notes/memory",
        commits: [
          { hash: hashC },
          { hash: hashA, cochangeDetailsLimited: true },
        ],
      }],
      limitedCommits: [{ hash: hashA, affectedNoteIds: ["notes/memory"] }],
    });
    const newestMemory = gitHistoryForNotes(indexed, ["notes/memory"], {
      commitsPerNote: 1,
    });
    expect(newestMemory).toMatchObject({ status: "ready", notes: [{ commits: [{ hash: hashC }] }] });
    expect(newestMemory).not.toHaveProperty("limitedCommits");
    const unaffected = gitHistoryForNotes(indexed, ["notes/unaffected"]);
    expect(unaffected).not.toHaveProperty("limitedCommits");
    expect(searchGitHistory(indexed, {
      query: "anything",
      allowedNoteIds: ["notes/unaffected"],
    })).not.toHaveProperty("limitedCommits");
    expect(Object.isFrozen(indexed.limitedCommits)).toBeTrue();
    expect(Object.isFrozen(indexed.limitedCommits?.[0]?.affectedNoteIds)).toBeTrue();
  });

  test("keeps the aggregate path-observation budget hard after localizing a commit", async () => {
    const fixture = initializeRepository();
    const halfBudget = MAX_GIT_PATH_OBSERVATIONS / 2;
    const vaultRecords = [{
      hash: hashA,
      subject: "Unbounded repository rewrite",
      paths: [
        "kb/notes/memory.md",
        ...Array.from(
          { length: halfBudget - 1 },
          (_, index) => `kb/removed/path-${index}.md`,
        ),
      ],
    }];
    const detailRecords = [{
      ...vaultRecords[0]!,
      paths: [
        "kb/notes/memory.md",
        ...Array.from(
          { length: halfBudget },
          (_, index) => `bulk/path-${index}`,
        ),
      ],
    }];

    expect(await rejected(indexGitHistory(fixture, {
      runGit: injectedHistoryProvider(
        fixture.repository,
        hashA,
        vaultRecords,
        detailRecords,
      ),
    }))).toMatchObject({ kind: "budget" });
  });

  test("keeps validating paths after a commit crosses its local detail limit", async () => {
    const fixture = initializeRepository();
    const vaultRecords = [{
      hash: hashA,
      subject: "Malformed repository rewrite",
      paths: ["kb/notes/memory.md"],
    }];
    const detailRecords = [{
      ...vaultRecords[0]!,
      paths: [
        "kb/notes/memory.md",
        ...Array.from(
          { length: MAX_GIT_PATHS_PER_COMMIT },
          (_, index) => `bulk/path-${index}`,
        ),
        "../escape.md",
      ],
    }];

    expect(await rejected(indexGitHistory(fixture, {
      runGit: injectedHistoryProvider(
        fixture.repository,
        hashA,
        vaultRecords,
        detailRecords,
      ),
    }))).toMatchObject({ kind: "malformed" });
  });

  test("passes direct bounded argv to an injectable provider", async () => {
    const fixture = initializeRepository();
    const requests: Parameters<GitCommandProvider>[0][] = [];
    const provider: GitCommandProvider = (request) => {
      requests.push(request);
      const result = spawnSync("git", [...request.arguments], {
        cwd: request.cwd,
        encoding: "buffer",
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
      });
      if (result.status !== 0) {
        return Promise.resolve({
          status: "failed",
          message: "injected Git failed",
          exitCode: result.status ?? 1,
        });
      }
      return Promise.resolve({ status: "ok", stdout: result.stdout, stderr: result.stderr });
    };

    const indexed = await indexGitHistory(fixture, { runGit: provider });
    expect(indexed.status).toBe("ready");
    if (indexed.status !== "ready") return;
    expect(requests.length).toBe(4);
    expect(requests.every(({ cwd, timeoutMs, maxOutputBytes }) =>
      cwd === fixture.repository && timeoutMs > 0 && maxOutputBytes > 0)).toBeTrue();
    expect(requests[2]?.arguments).toContain("--");
    expect(requests[2]?.arguments[0]).toBe("--literal-pathspecs");
    expect(requests[2]?.arguments).toContain(indexed.head);
    expect(requests[2]?.arguments).not.toContain("HEAD");
    expect(requests[3]?.arguments.at(-1)).toBe("--");
    expect(requests.flatMap(({ arguments: argv }) => argv)).not.toContain("sh");
  });

  test("returns optional unavailability but fails required mode distinctly", async () => {
    const fixture = initializeRepository();
    const unavailable: GitCommandProvider = () => Promise.resolve({
      status: "unavailable",
      message: "git executable missing",
    });

    const optional = await indexGitHistory(fixture, { runGit: unavailable });
    expect(optional).toMatchObject({
      status: "unavailable",
      repository: fixture.repository,
      root: fixture.root,
      vaultPrefix: "kb",
      reason: "git executable missing",
    });
    if (optional.status !== "unavailable") throw new Error("Expected unavailable Git history.");
    expect(searchGitHistory(optional, { query: "anything" })).toBe(optional);
    expect(gitHistoryForNotes(optional, ["notes/memory"])).toBe(optional);

    expect(await rejected(indexGitHistory({ ...fixture, required: true }, { runGit: unavailable })))
      .toMatchObject({ name: "GitHistoryError", kind: "unavailable" });
  });

  test("distinguishes command failure and malformed provider output", async () => {
    const fixture = initializeRepository();
    const failed: GitCommandProvider = () => Promise.resolve({
      status: "failed",
      message: "repository read failed",
      exitCode: 128,
      reason: "exit",
    });
    expect(await rejected(indexGitHistory({ ...fixture, required: true }, { runGit: failed })))
      .toMatchObject({ kind: "failed" });

    let call = 0;
    const malformed: GitCommandProvider = () => {
      call += 1;
      if (call === 1) return Promise.resolve({ status: "ok", stdout: `${fixture.repository}\n` });
      if (call === 2) return Promise.resolve({ status: "ok", stdout: `${hashA}\n` });
      return Promise.resolve({ status: "ok", stdout: "unexpected history" });
    };
    expect(await rejected(indexGitHistory({ ...fixture, required: true }, { runGit: malformed })))
      .toMatchObject({ kind: "malformed" });
  });

  test("enforces aggregate output and provider timeout failures", async () => {
    const fixture = initializeRepository();
    const oversized: GitCommandProvider = () => Promise.resolve({
      status: "ok",
      stdout: "x".repeat(2_000),
    });
    expect(await rejected(indexGitHistory(
      { ...fixture, maxOutputBytes: 1_024 },
      { runGit: oversized },
    ))).toMatchObject({ kind: "budget" });

    const timedOut: GitCommandProvider = () => Promise.resolve({
      status: "failed",
      message: "deadline reached",
      reason: "timeout",
    });
    expect(await rejected(indexGitHistory(fixture, { runGit: timedOut })))
      .toMatchObject({ kind: "budget" });
  });

  test("confines the vault and each real note before invoking history", async () => {
    const fixture = initializeRepository();
    const outside = temporary("kb-outside-vault");
    expect(await rejected(indexGitHistory({ ...fixture, root: outside })))
      .toMatchObject({ kind: "confinement" });

    write(outside, "escape.md", "# Escape\n");
    symlinkSync(join(outside, "escape.md"), join(fixture.root, "escape.md"));
    expect(await rejected(indexGitHistory({
      ...fixture,
      notes: [...fixture.notes, parseNote("escape.md", "# Escape\n")],
    }))).toMatchObject({ kind: "confinement" });
  });

  test("rejects malformed records, traversal paths, and unbounded options", async () => {
    const atPathLimit = historyOutput("KB-GIT-HISTORY-V1", [{
      hash: hashA,
      subject: "At the boundary",
      paths: Array.from(
        { length: MAX_GIT_PATHS_PER_COMMIT },
        (_, index) => `paths/${index}`,
      ),
    }]);
    expect(parseGitHistoryOutput(atPathLimit)[0]?.changedPaths).toHaveLength(
      MAX_GIT_PATHS_PER_COMMIT,
    );
    const repeatedPathRecords = historyOutput("KB-GIT-HISTORY-V1", [{
      hash: hashA,
      subject: "Repeated paths",
      paths: Array.from(
        { length: MAX_GIT_PATH_OBSERVATIONS + 1 },
        () => "paths/repeated.md",
      ),
    }]);
    expect(() => parseGitHistoryOutput(repeatedPathRecords)).toThrow(
      `${MAX_GIT_PATH_OBSERVATIONS} changed-path observation limit`,
    );
    expect(() => parseGitHistoryOutput(
      ["KB-GIT-HISTORY-V1", hashA, "1600000000", "subject", "\n../escape.md", ""].join("\0"),
    )).toThrow(GitHistoryError);
    expect(() => parseGitHistoryOutput("unknown\0record\0")).toThrow("record marker");
    expect(() => searchGitHistory({
      status: "ready",
      repository: "/repo",
      root: "/repo/kb",
      vaultPrefix: "kb",
      head: hashA,
      scannedCommits: 0,
      notes: [],
    }, { query: "\n" })).toThrow("one to 500");
    expect(() => parseGitHistoryOutput("anything", "")).toThrow("record marker is invalid");
    const fixture = initializeRepository();
    expect(await rejected(indexGitHistory({
      ...fixture,
      maxCommits: MAX_GIT_HISTORY_COMMITS + 1,
    }))).toMatchObject({ kind: "budget" });
  });
});
