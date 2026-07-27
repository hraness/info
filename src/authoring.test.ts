import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

import {
  InvalidCanonicalNoteIdError,
  NoteAlreadyExistsError,
  NoteRecoveryRequiredError,
  NoteRevisionConflictError,
  addNoteRelation,
  canonicalNoteId,
  createConceptNote,
  createNote,
  listNoteRelations,
  normalizeRelationPredicate,
  noteRevision,
  removeNoteRelation,
  type AuthoringDependencies,
  type AuthoringOptions,
} from "./authoring.js";
import { analyzeVault, parseNote } from "./graph.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function fixture(): Promise<{
  readonly base: string;
  readonly root: string;
  readonly cache: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "kb-authoring-test-"));
  fixtures.push(base);
  const root = join(base, "vault");
  const cache = join(base, "cache");
  await Promise.all([
    mkdir(join(root, "notes"), { recursive: true }),
    mkdir(cache),
  ]);
  return { base, root, cache };
}

function lockOptions(cache: string): AuthoringOptions {
  return { lock: { cacheHome: cache, waitTimeoutMs: 2_000 } };
}

async function writeNote(
  root: string,
  id: string,
  content = `---\ntype: concept\ntitle: ${id}\n---\n\n# ${id}\n`,
): Promise<string> {
  const path = join(root, `${id}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

describe("single-note authoring", () => {
  test("creates ordinary concept and generic notes idempotently", async () => {
    const { root, cache } = await fixture();
    const options = lockOptions(cache);
    const created = await createConceptNote(root, {
      id: "notes/durable-memory",
      title: "Durable memory",
      tags: ["agents", "#Local-First", "agents"],
    }, options);
    expect(created).toMatchObject({
      changed: true,
      path: "notes/durable-memory.md",
      relations: [],
    });
    expect(created.revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    const content = await readFile(join(root, created.path), "utf8");
    expect(parse(content.split("---\n")[1] ?? "")).toMatchObject({
      type: "concept",
      title: "Durable memory",
      tags: ["agents", "Local-First"],
    });
    expect(content).toEndWith("# Durable memory\n");

    const repeated = await createConceptNote(root, {
      id: "notes/durable-memory",
      title: "Durable memory",
      tags: ["agents"],
    }, options);
    expect(repeated.changed).toBeFalse();
    expect(repeated.revision).toBe(created.revision);
    expect(await readFile(join(root, created.path), "utf8")).toBe(content);

    const generic = await createNote(root, {
      id: "notes/decision",
      title: "A decision",
      type: "decision",
      body: "The body is caller-owned.",
    }, options);
    expect(generic.changed).toBeTrue();
    expect(await readFile(join(root, generic.path), "utf8"))
      .toEndWith("The body is caller-owned.\n");
    const sameBody = await createNote(root, {
      id: "notes/decision",
      title: "A decision",
      type: "decision",
      body: "The body is caller-owned.",
    }, options);
    expect(sameBody.changed).toBeFalse();
    const metadataOnly = await createNote(root, {
      id: "notes/decision",
      title: "A decision",
      type: "decision",
    }, options);
    expect(metadataOnly.changed).toBeFalse();
    expect(createNote(root, {
      id: "notes/decision",
      title: "A decision",
      type: "decision",
      body: "A different body.",
    }, options)).rejects.toThrow("body differs");

    expect(createConceptNote(root, {
      id: "notes/decision",
      title: "A decision",
    }, options)).rejects.toBeInstanceOf(NoteAlreadyExistsError);
  });

  test("adds, lists, and removes compact relations while preserving prose and comments", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source", [
      "---",
      "# keep this frontmatter comment",
      "type: concept",
      "title: Source # keep this inline comment",
      "custom:",
      "  nested: true # keep this nested comment",
      "---",
      "",
      "# Source",
      "",
      "Body punctuation, spacing, and `code` stay byte-for-byte.",
      "",
    ].join("\n"));
    await writeNote(root, "notes/target");
    const options = lockOptions(cache);
    const body = (await readFile(sourcePath, "utf8")).slice(
      (await readFile(sourcePath, "utf8")).indexOf("\n---\n", 4) + 5,
    );

    const added = await addNoteRelation(
      root,
      "notes/source",
      "Supports Idea",
      "notes/target",
      options,
    );
    expect(added).toMatchObject({
      changed: true,
      path: "notes/source.md",
      relations: [{ predicate: "supports-idea", target: "notes/target" }],
    });
    const afterAdd = await readFile(sourcePath, "utf8");
    expect(afterAdd).toContain("# keep this frontmatter comment");
    expect(afterAdd).toContain("# keep this inline comment");
    expect(afterAdd).toContain("# keep this nested comment");
    expect(afterAdd).toContain("supports-idea: [ notes/target ]");
    expect(afterAdd.slice(afterAdd.indexOf("\n---\n", 4) + 5)).toBe(body);
    expect(await listNoteRelations(root, "notes/source")).toEqual([
      { predicate: "supports-idea", target: "notes/target" },
    ]);
    const parsedSource = parseNote("notes/source.md", afterAdd);
    const analyzed = analyzeVault([
      parsedSource,
      parseNote("notes/target.md", await readFile(join(root, "notes/target.md"), "utf8")),
    ]);
    expect(parsedSource.relationIssues).toEqual([]);
    expect(analyzed.relationIssues).toEqual([]);
    expect(analyzed.authoredRelations[0]).toMatchObject({
      source: "notes/source",
      predicate: "supports-idea",
      target: "notes/target",
    });

    const repeated = await addNoteRelation(
      root,
      "notes/source",
      "supports-idea",
      "notes/target",
      options,
    );
    expect(repeated.changed).toBeFalse();
    expect(repeated.revision).toBe(added.revision);
    expect(await readFile(sourcePath, "utf8")).toBe(afterAdd);

    const absent = await removeNoteRelation(
      root,
      "notes/source",
      "contradicts",
      "notes/target",
      options,
    );
    expect(absent.changed).toBeFalse();
    expect(await readFile(sourcePath, "utf8")).toBe(afterAdd);

    const removed = await removeNoteRelation(
      root,
      "notes/source",
      "Supports Idea",
      "notes/target",
      options,
    );
    expect(removed.changed).toBeTrue();
    expect(removed.relations).toEqual([]);
    const afterRemove = await readFile(sourcePath, "utf8");
    expect(afterRemove).not.toContain("relations:");
    expect(afterRemove.slice(afterRemove.indexOf("\n---\n", 4) + 5)).toBe(body);
  });

  test("edits a case-insensitive Relations key without creating a duplicate", async () => {
    const { root, cache } = await fixture();
    await writeNote(root, "notes/source", [
      "---",
      "type: concept",
      "title: Source",
      "Relations:",
      "  supports: [notes/target]",
      "---",
      "",
      "# Source",
      "",
    ].join("\n"));
    await Promise.all([
      writeNote(root, "notes/target"),
      writeNote(root, "notes/other"),
    ]);

    await addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/other",
      lockOptions(cache),
    );

    const authored = await readFile(join(root, "notes/source.md"), "utf8");
    expect(authored).toContain("Relations:");
    expect(authored).not.toContain("\nrelations:");
    expect(await listNoteRelations(root, "notes/source")).toEqual([
      { predicate: "supports", target: "notes/other" },
      { predicate: "supports", target: "notes/target" },
    ]);
  });

  test("preserves existing relation collection style and returns a stable set view", async () => {
    const { root, cache } = await fixture();
    await writeNote(root, "notes/source", [
      "---",
      "type: concept",
      "title: Source",
      "relations:",
      "  supports:",
      "    - notes/zeta # retain item comment",
      "    - notes/zeta",
      "  depends-on: [notes/alpha]",
      "  references: notes/alpha",
      "---",
      "",
      "# Source",
      "",
    ].join("\n"));
    await Promise.all([
      writeNote(root, "notes/alpha"),
      writeNote(root, "notes/beta"),
      writeNote(root, "notes/zeta"),
    ]);
    expect(await listNoteRelations(root, "notes/source")).toEqual([
      { predicate: "depends-on", target: "notes/alpha" },
      { predicate: "references", target: "notes/alpha" },
      { predicate: "supports", target: "notes/zeta" },
    ]);

    const beforeScalarNoOp = await readFile(join(root, "notes/source.md"), "utf8");
    const scalarNoOp = await addNoteRelation(
      root,
      "notes/source",
      "references",
      "notes/alpha",
      lockOptions(cache),
    );
    expect(scalarNoOp.changed).toBeFalse();
    expect(await readFile(join(root, "notes/source.md"), "utf8")).toBe(beforeScalarNoOp);

    await addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/beta",
      lockOptions(cache),
    );
    await addNoteRelation(
      root,
      "notes/source",
      "references",
      "notes/beta",
      lockOptions(cache),
    );
    const content = await readFile(join(root, "notes/source.md"), "utf8");
    expect(content).toContain("    - notes/beta");
    expect(content).toContain("    - notes/zeta # retain item comment");
    expect(content).toContain("depends-on: [ notes/alpha ]");
    expect(content).toContain("references: [ notes/alpha, notes/beta ]");
  });

  test("preserves CRLF delimiters and body bytes without doubled carriage returns", async () => {
    const { root, cache } = await fixture();
    const body = "# Source\r\n\r\nBody stays CRLF.\r\n";
    const sourcePath = await writeNote(
      root,
      "notes/source",
      `---\r\ntype: concept\r\ntitle: Source\r\n---\r\n${body}`,
    );
    await writeNote(root, "notes/target");
    await addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      lockOptions(cache),
    );
    const content = await readFile(sourcePath, "utf8");
    expect(content).not.toContain("\r\r\n");
    expect(content).toContain("supports: [ notes/target ]\r\n");
    expect(content.slice(content.indexOf("\r\n---\r\n", 4) + 7)).toBe(body);
  });

  test("requires exact IDs and confines source, target, and parents", async () => {
    const { base, root, cache } = await fixture();
    await writeNote(root, "notes/source");
    await writeNote(root, "notes/target");
    const options = lockOptions(cache);
    for (const invalid of [
      "../outside",
      "/absolute",
      "notes/../outside",
      "notes/source.md",
      "notes\\source",
      "notes//source",
      ".hidden/source",
    ]) {
      expect(() => canonicalNoteId(invalid)).toThrow(InvalidCanonicalNoteIdError);
      expect(addNoteRelation(
        root,
        invalid,
        "supports",
        "notes/target",
        options,
      )).rejects.toBeInstanceOf(InvalidCanonicalNoteIdError);
    }
    expect(addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/missing",
      options,
    )).rejects.toThrow();
    expect(addNoteRelation(
      root,
      "notes/source",
      "supports",
      "NOTES/target",
      options,
    )).rejects.toThrow();

    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "escaped.md"), "caller-owned\n");
    await symlink(outside, join(root, "linked"));
    expect(createConceptNote(root, {
      id: "linked/escaped",
      title: "Escaped",
    }, options)).rejects.toThrow("symbolic link");
    expect(await readFile(join(outside, "escaped.md"), "utf8")).toBe("caller-owned\n");

    const symlinkTarget = join(root, "notes/symlink.md");
    await symlink(join(root, "notes/target.md"), symlinkTarget);
    expect(addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/symlink",
      options,
    )).rejects.toThrow("regular file");

    const hardTarget = join(root, "notes/hard.md");
    await link(join(root, "notes/target.md"), hardTarget);
    expect(addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/hard",
      options,
    )).rejects.toThrow("hard-linked");
  });

  test("uses optimistic revisions and cleans temporary files after a race", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source");
    await writeNote(root, "notes/target");
    const expectedRevision = await noteRevision(root, "notes/source");
    await writeFile(sourcePath, [
      "---",
      "type: concept",
      "title: Source",
      "---",
      "",
      "# Source",
      "",
      "An editor changed this.",
      "",
    ].join("\n"));
    const editorContent = await readFile(sourcePath, "utf8");
    expect(addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      {
        ...lockOptions(cache),
        expectedRevision,
      },
    )).rejects.toBeInstanceOf(NoteRevisionConflictError);
    expect(await readFile(sourcePath, "utf8")).toBe(editorContent);

    const reached = deferred();
    const release = deferred();
    const operation = addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      {
        ...lockOptions(cache),
        dependencies: {
          beforeInstall: async () => {
            reached.resolve();
            await release.promise;
          },
        },
      },
    );
    await reached.promise;
    await writeFile(sourcePath, `${editorContent}A second editor change.\n`);
    release.resolve();
    expect(operation).rejects.toBeInstanceOf(NoteRevisionConflictError);
    expect(await readFile(sourcePath, "utf8")).toEndWith("A second editor change.\n");
    expect((await readdir(dirname(sourcePath)))
      .filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("installs by replacement, preserves mode, and cleans a failed create temp", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source");
    await writeNote(root, "notes/target");
    await chmod(sourcePath, 0o640);
    const before = await stat(sourcePath);
    await addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      lockOptions(cache),
    );
    const after = await stat(sourcePath);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);

    const createReached = deferred();
    const createRelease = deferred();
    const create = createConceptNote(root, {
      id: "notes/raced",
      title: "Raced",
    }, {
      ...lockOptions(cache),
      dependencies: {
        beforeCommit: async () => {
          createReached.resolve();
          await createRelease.promise;
        },
      },
    });
    await createReached.promise;
    const external = "external creator wins\n";
    await writeFile(join(root, "notes/raced.md"), external, { flag: "wx" });
    createRelease.resolve();
    expect(create).rejects.toBeInstanceOf(NoteRevisionConflictError);
    expect(await readFile(join(root, "notes/raced.md"), "utf8")).toBe(external);
    expect((await readdir(join(root, "notes")))
      .filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("does not overwrite a non-KB replacement after the final optimistic read", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source");
    await writeNote(root, "notes/target");
    const external = [
      "---",
      "type: concept",
      "title: Source",
      "---",
      "",
      "# Source",
      "",
      "An external atomic-save replacement wins.",
      "",
    ].join("\n");
    const externalPath = join(root, "notes/.external-source.md");

    const operation = addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      {
        ...lockOptions(cache),
        dependencies: {
          beforeCommit: async () => {
            await writeFile(externalPath, external, { flag: "wx" });
            await rename(externalPath, sourcePath);
          },
        },
      },
    );
    expect(operation).rejects.toBeInstanceOf(NoteRevisionConflictError);
    expect(await readFile(sourcePath, "utf8")).toBe(external);
    expect((await readdir(dirname(sourcePath))).filter((name) =>
      name.endsWith(".tmp") || name.endsWith(".recovery"))).toEqual([]);
  });

  test("preserves displaced bytes when another writer recreates a quarantined path", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source");
    const original = await readFile(sourcePath, "utf8");
    await writeNote(root, "notes/target");
    const external = "external writer owns the canonical path\n";
    let recoveryPath: string | undefined;

    let caught: unknown;
    try {
      await addNoteRelation(
        root,
        "notes/source",
        "supports",
        "notes/target",
        {
          ...lockOptions(cache),
          dependencies: {
            afterSourceQuarantined: async (context) => {
              recoveryPath = context.recoveryPath;
              await writeFile(context.path, external, { flag: "wx" });
            },
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoteRevisionConflictError);
    if (!(caught instanceof NoteRevisionConflictError)) {
      throw new Error("expected a revision conflict");
    }
    expect(caught.recoveryPath).toContain(".recovery/source.md");
    expect(await readFile(sourcePath, "utf8")).toBe(external);
    expect(recoveryPath).toBeDefined();
    expect(await readFile(recoveryPath ?? "", "utf8")).toBe(original);
    expect(listNoteRelations(root, "notes/source"))
      .rejects.toBeInstanceOf(NoteRecoveryRequiredError);
  });

  test("restores one safe interrupted quarantine before the next write", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source");
    await writeNote(root, "notes/target");
    const recoveryDirectory = join(
      root,
      "notes/.source.md.999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.recovery",
    );
    await mkdir(recoveryDirectory);
    await rename(sourcePath, join(recoveryDirectory, "source.md"));

    const result = await addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      lockOptions(cache),
    );
    expect(result.changed).toBeTrue();
    expect(await listNoteRelations(root, "notes/source")).toEqual([
      { predicate: "supports", target: "notes/target" },
    ]);
    expect(readdir(join(root, "notes"))).resolves.not.toContain(
      ".source.md.999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.recovery",
    );
  });

  test("rechecks the parent identity after a final-check seam", async () => {
    const { base, root, cache } = await fixture();
    const outside = join(base, "outside");
    const movedNotes = join(root, "notes-moved-by-editor");
    await mkdir(outside);

    const operation = createConceptNote(root, {
      id: "notes/escaped",
      title: "Escaped",
    }, {
      ...lockOptions(cache),
      dependencies: {
        beforeCommit: async () => {
          await rename(join(root, "notes"), movedNotes);
          await symlink(outside, join(root, "notes"));
        },
      },
    });
    expect(operation).rejects.toThrow("symbolic link");
    expect(readdir(outside)).resolves.not.toContain("escaped.md");
  });

  test("rejects a rendered note larger than the bounded read limit", async () => {
    const { root, cache } = await fixture();
    expect(createConceptNote(root, {
      id: "notes/oversized",
      title: "Oversized",
      body: "x".repeat((16 * 1024 * 1024) + 1),
    }, lockOptions(cache))).rejects.toThrow("too large");
    expect(readdir(join(root, "notes"))).resolves.not.toContain("oversized.md");
    expect((await readdir(join(root, "notes")))
      .filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("serializes same-note writers without losing either relation", async () => {
    const { root, cache } = await fixture();
    await Promise.all([
      writeNote(root, "notes/source"),
      writeNote(root, "notes/alpha"),
      writeNote(root, "notes/beta"),
    ]);
    const firstReached = deferred();
    const releaseFirst = deferred();
    let installs = 0;
    const dependencies: Partial<AuthoringDependencies> = {
      beforeInstall: async () => {
        installs += 1;
        if (installs === 1) {
          firstReached.resolve();
          await releaseFirst.promise;
        }
      },
    };
    const options: AuthoringOptions = {
      lock: { cacheHome: cache, waitTimeoutMs: 2_000 },
      dependencies,
    };
    const first = addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/alpha",
      options,
    );
    await firstReached.promise;
    const second = addNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/beta",
      options,
    );
    await Bun.sleep(50);
    expect(installs).toBe(1);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(await listNoteRelations(root, "notes/source")).toEqual([
      { predicate: "supports", target: "notes/alpha" },
      { predicate: "supports", target: "notes/beta" },
    ]);
  });

  test("lets different-note writers enter installation independently", async () => {
    const { root, cache } = await fixture();
    await Promise.all([
      writeNote(root, "notes/first"),
      writeNote(root, "notes/second"),
      writeNote(root, "notes/target"),
    ]);
    const bothReached = deferred();
    const releaseBoth = deferred();
    const reached = new Set<string>();
    const dependencies: Partial<AuthoringDependencies> = {
      beforeInstall: async ({ path }) => {
        reached.add(path);
        if (reached.size === 2) bothReached.resolve();
        await releaseBoth.promise;
      },
    };
    const options: AuthoringOptions = {
      lock: { cacheHome: cache, waitTimeoutMs: 2_000 },
      dependencies,
    };
    const first = addNoteRelation(
      root,
      "notes/first",
      "supports",
      "notes/target",
      options,
    );
    const second = addNoteRelation(
      root,
      "notes/second",
      "supports",
      "notes/target",
      options,
    );
    await Promise.race([
      bothReached.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("different-note writers contended on one lock");
      }),
    ]);
    expect(reached.size).toBe(2);
    releaseBoth.resolve();
    await Promise.all([first, second]);
  });

  test("can remove a dangling exact target and rejects malformed relation YAML", async () => {
    const { root, cache } = await fixture();
    const sourcePath = await writeNote(root, "notes/source", [
      "---",
      "type: concept",
      "title: Source",
      "relations:",
      "  supports: [notes/renamed-away]",
      "---",
      "",
      "# Source",
      "",
    ].join("\n"));
    const removed = await removeNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/renamed-away",
      lockOptions(cache),
    );
    expect(removed).toMatchObject({ changed: true, relations: [] });

    await writeNote(root, "notes/target");
    await writeFile(sourcePath, [
      "---",
      "type: concept",
      "title: Source",
      "relations:",
      "  supports: [./target.md]",
      "---",
      "",
      "# Source",
      "",
    ].join("\n"));
    expect(parseNote(
      "notes/source.md",
      await readFile(sourcePath, "utf8"),
    ).relationIssues).toHaveLength(1);
    const repaired = await removeNoteRelation(
      root,
      "notes/source",
      "supports",
      "notes/target",
      lockOptions(cache),
    );
    expect(repaired).toMatchObject({ changed: true, relations: [] });
    expect(parseNote(
      "notes/source.md",
      await readFile(sourcePath, "utf8"),
    ).relationIssues).toEqual([]);

    await writeFile(sourcePath, [
      "---",
      "type: concept",
      "relations:",
      "  Not Canonical: [notes/target]",
      "---",
      "",
    ].join("\n"));
    expect(listNoteRelations(root, "notes/source"))
      .rejects.toThrow("canonical kebab-case");
    expect(normalizeRelationPredicate(" Depends_On ")).toBe("depends-on");
  });
});
