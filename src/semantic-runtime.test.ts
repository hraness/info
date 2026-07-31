import { describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  describeSemanticProjection,
  prepareSemanticProjection,
  resolveSemanticDatabase,
  semanticWriterLeasePath,
  withSemanticGenerationWriterLease,
  withSemanticWriterLease,
  type SemanticIndexIdentity,
} from "./semantic-runtime.js";
import type { Note } from "./graph.js";
import { scanVault } from "./vault.js";

function note(path: string, content = `# ${path}\n`): Note {
  return {
    path,
    id: path.slice(0, -3),
    title: path,
    aliases: [],
    tags: [],
    properties: {},
    metadata: {},
    content,
    summary: "",
    searchableText: content,
    links: [],
  };
}

function indexIdentity(model = "hf:example/model.gguf#revision-a"): SemanticIndexIdentity {
  return {
    producer: { package: "@hraness/kb", schema: 1 },
    indexer: { package: "@tobilu/qmd", version: "2.5.3" },
    collection: {
      name: "kb",
      pattern: "**/*.md",
      ignore: ["index.md", "**/AGENTS.md"],
      globalContext: "A Markdown knowledge base.",
      pathContexts: [{ path: "/notes", context: "Maintained synthesis." }],
    },
    embedding: { model, chunkStrategy: "regex" },
  };
}

async function fileText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function waitForText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await fileText(path)).includes(expected)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}.`);
}

function workerSource(options: {
  readonly database: string;
  readonly events: string;
  readonly id: string;
  readonly holdMs: number;
  readonly crash?: boolean;
}): string {
  const module = pathToFileURL(join(import.meta.dir, "semantic-runtime.ts")).href;
  return `
    import { appendFile } from "node:fs/promises";
    const { withSemanticWriterLease } = await import(${JSON.stringify(module)});
    await withSemanticWriterLease(
      ${JSON.stringify(options.database)},
      async () => {
        await appendFile(${JSON.stringify(options.events)}, ${JSON.stringify(`${options.id}:enter\n`)}, "utf8");
        ${options.crash
          ? "process.kill(process.pid, \"SIGKILL\");"
          : `await Bun.sleep(${options.holdMs});\n        await appendFile(${JSON.stringify(options.events)}, ${JSON.stringify(`${options.id}:exit\n`)}, "utf8");`}
      },
      { waitMs: 2_000, pollMs: 5 },
    );
  `;
}

function spawnWorker(source: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "-e", source], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function makeFifo(path: string): Promise<boolean> {
  const executable = Bun.which("mkfifo");
  if (executable === null) return false;
  const process = Bun.spawn([executable, path], { stdout: "pipe", stderr: "pipe" });
  if (await process.exited !== 0) {
    throw new Error(`mkfifo failed: ${await new Response(process.stderr).text()}`);
  }
  return true;
}

describe("semantic writer lease", () => {
  test("serializes fresh and warm writers across real processes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-lease-"));
    const database = join(temporary, "index.sqlite");
    const events = join(temporary, "events.txt");
    try {
      const first = spawnWorker(workerSource({
        database,
        events,
        id: "first",
        holdMs: 120,
      }));
      await waitForText(events, "first:enter");
      const second = spawnWorker(workerSource({
        database,
        events,
        id: "second",
        holdMs: 10,
      }));
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      expect((await readFile(events, "utf8")).trim().split("\n")).toEqual([
        "first:enter",
        "first:exit",
        "second:enter",
        "second:exit",
      ]);

      let warm = false;
      await withSemanticWriterLease(database, async () => {
        await Promise.resolve();
        warm = true;
      }, { waitMs: 500, pollMs: 5 });
      expect(warm).toBe(true);
      expect(stat(semanticWriterLeasePath(database))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 10_000);

  test("recovers a real dead owner and releases after an operation error", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-lease-"));
    const database = join(temporary, "index.sqlite");
    const events = join(temporary, "events.txt");
    try {
      const crashed = spawnWorker(workerSource({
        database,
        events,
        id: "crashed",
        holdMs: 0,
        crash: true,
      }));
      await waitForText(events, "crashed:enter");
      expect(await crashed.exited).not.toBe(0);
      expect((await stat(semanticWriterLeasePath(database))).isDirectory()).toBe(true);

      let recovered = false;
      await withSemanticWriterLease(database, async () => {
        await Promise.resolve();
        recovered = true;
      }, { waitMs: 1_000, pollMs: 5 });
      expect(recovered).toBe(true);
      expect(withSemanticWriterLease(database, async () => {
        await Promise.resolve();
        throw new Error("operation failed");
      }, { waitMs: 500, pollMs: 5 })).rejects.toThrow("operation failed");
      expect(stat(semanticWriterLeasePath(database))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 10_000);

  test("bounds malformed owner metadata and rejects a symlinked lease target", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-lease-"));
    const database = join(temporary, "index.sqlite");
    const lease = semanticWriterLeasePath(database);
    const outside = join(temporary, "outside");
    try {
      await mkdir(lease);
      await writeFile(join(lease, "owner.json"), "x".repeat(4 * 1_024 + 1), "utf8");
      expect(withSemanticWriterLease(database, async () => {
        await Promise.resolve();
      }, { waitMs: 100, pollMs: 5 })).rejects.toThrow("4,096-byte metadata limit");

      await writeFile(join(lease, "owner.json"), "{malformed", "utf8");
      expect(withSemanticWriterLease(database, async () => {
        await Promise.resolve();
      }, { waitMs: 30, pollMs: 5 })).rejects.toThrow("Timed out after 30ms");

      await rm(lease, { recursive: true, force: true });
      await mkdir(outside);
      await writeFile(join(outside, "marker"), "outside stays untouched", "utf8");
      await symlink(outside, lease, "dir");
      expect(withSemanticWriterLease(database, async () => {
        await Promise.resolve();
      }, { waitMs: 100, pollMs: 5 })).rejects.toThrow("must not be a symbolic link");
      expect(await readFile(join(outside, "marker"), "utf8")).toBe("outside stays untouched");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("canonicalizes parent aliases and rejects linked database files", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-lease-alias-"));
    const realDirectory = join(temporary, "real");
    const aliasDirectory = join(temporary, "alias");
    const database = join(realDirectory, "index.sqlite");
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory, "dir");
    let active = 0;
    let maximumActive = 0;
    const operation = async (): Promise<void> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(30);
      active -= 1;
    };
    try {
      await Promise.all([
        withSemanticWriterLease(database, operation, { waitMs: 1_000, pollMs: 5 }),
        withSemanticWriterLease(
          join(aliasDirectory, "index.sqlite"),
          operation,
          { waitMs: 1_000, pollMs: 5 },
        ),
      ]);
      expect(maximumActive).toBe(1);

      await writeFile(database, "database", "utf8");
      const hardLink = join(realDirectory, "hard-linked.sqlite");
      await link(database, hardLink);
      expect(withSemanticWriterLease(database, async () => {
        await Promise.resolve();
      })).rejects.toThrow("regular, singly linked file");
      await rm(hardLink);

      const symbolicLink = join(realDirectory, "symbolic.sqlite");
      await symlink(database, symbolicLink);
      expect(withSemanticWriterLease(symbolicLink, async () => {
        await Promise.resolve();
      })).rejects.toThrow("must not be a symbolic link");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("serializes existing and fresh database basename case aliases", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-case-alias-"));
    const lower = join(temporary, "index.sqlite");
    const upper = join(temporary, "INDEX.sqlite");
    const root = join(temporary, "vault");
    await mkdir(root);
    await writeFile(lower, "database", "utf8");
    try {
      let lowerMetadata: Awaited<ReturnType<typeof stat>>;
      let upperMetadata: Awaited<ReturnType<typeof stat>>;
      try {
        [lowerMetadata, upperMetadata] = await Promise.all([stat(lower), stat(upper)]);
      } catch {
        return;
      }
      if (lowerMetadata.dev !== upperMetadata.dev || lowerMetadata.ino !== upperMetadata.ino) {
        return;
      }
      expect(await resolveSemanticDatabase(lower, root))
        .toBe(await resolveSemanticDatabase(upper, root));

      let active = 0;
      let maximumActive = 0;
      const operation = async (): Promise<void> => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(25);
        active -= 1;
      };
      await Promise.all([
        withSemanticWriterLease(lower, operation, { waitMs: 1_000, pollMs: 5 }),
        withSemanticWriterLease(upper, operation, { waitMs: 1_000, pollMs: 5 }),
      ]);
      expect(maximumActive).toBe(1);

      await rm(lower);
      maximumActive = 0;
      const freshOperation = async (path: string): Promise<void> => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await writeFile(path, "database", "utf8");
        await Bun.sleep(25);
        active -= 1;
      };
      await Promise.all([
        withSemanticWriterLease(
          lower,
          () => freshOperation(lower),
          { waitMs: 1_000, pollMs: 5 },
        ),
        withSemanticWriterLease(
          upper,
          () => freshOperation(upper),
          { waitMs: 1_000, pollMs: 5 },
        ),
      ]);
      expect(maximumActive).toBe(1);
      expect(await resolveSemanticDatabase(lower, root))
        .toBe(await resolveSemanticDatabase(upper, root));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects database and cache metadata FIFOs without waiting for a writer", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-fifo-"));
    const databaseFifo = join(temporary, "database.sqlite");
    try {
      if (!await makeFifo(databaseFifo)) return;
      const databaseStartedAt = Date.now();
      expect(withSemanticWriterLease(databaseFifo, async () => {
        await Promise.resolve();
      })).rejects.toThrow("regular, singly linked file");
      expect(Date.now() - databaseStartedAt).toBeLessThan(500);

      const root = join(temporary, "vault");
      const database = join(temporary, "metadata.sqlite");
      const notes = [note("note.md")];
      await mkdir(root);
      const description = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity(),
      );
      await mkdir(description.snapshotDirectory);
      expect(await makeFifo(join(
        description.snapshotDirectory,
        ".hraness-kb-semantic-cache.json",
      ))).toBe(true);
      const metadataStartedAt = Date.now();
      expect(withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
        { waitMs: 100, pollMs: 5 },
      )).rejects.toThrow("unowned or has an incompatible ownership marker");
      expect(Date.now() - metadataStartedAt).toBeLessThan(500);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects cache and vault overlap in either direction", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-overlap-"));
    const root = join(temporary, "vault");
    await mkdir(root);
    try {
      expect(resolveSemanticDatabase(join(root, "cache.sqlite"), root))
        .rejects.toThrow("must not overlap the vault root");

      const database = join(temporary, "outside.sqlite");
      const nestedRoot = `${database}.snapshot/vault`;
      await mkdir(nestedRoot, { recursive: true });
      expect(resolveSemanticDatabase(database, nestedRoot))
        .rejects.toThrow("must not overlap the vault root");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("keeps incompatible semantic index identities in different reader generations", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-identity-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    const notes = [note("note.md", "# Stable source\n")];
    await mkdir(root);
    let first: Awaited<ReturnType<typeof prepareSemanticProjection>> | undefined;
    try {
      const original = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity("hf:example/model.gguf#revision-a"),
      );
      const incompatible = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity("hf:example/model.gguf#revision-b"),
      );
      expect(original.manifest.version).toBe(2);
      expect(original.manifest.indexIdentity.embedding.model).toEndWith("revision-a");
      expect(incompatible.manifest.generation).not.toBe(original.manifest.generation);

      first = await withSemanticGenerationWriterLease(
        database,
        original.manifest.generation,
        () => prepareSemanticProjection(original, notes),
        { waitMs: 500, pollMs: 5 },
      );
      let entered = false;
      expect(withSemanticGenerationWriterLease(
        database,
        incompatible.manifest.generation,
        async () => {
          await Promise.resolve();
          entered = true;
        },
        { waitMs: 30, pollMs: 5 },
      )).rejects.toThrow("readers of an older semantic projection");
      expect(entered).toBe(false);
      await first.release();
      first = undefined;
      await withSemanticGenerationWriterLease(
        database,
        incompatible.manifest.generation,
        async () => {
          await Promise.resolve();
          entered = true;
        },
        { waitMs: 500, pollMs: 5 },
      );
      expect(entered).toBe(true);
    } finally {
      await first?.release();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("refuses an unowned snapshot directory before recursive cleanup", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-owner-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    const notes = [note("note.md")];
    await mkdir(root);
    try {
      const description = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity(),
      );
      const unrelated = join(description.snapshotDirectory, "generation-unrelated");
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, "keep.txt"), "do not delete", "utf8");
      expect(withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
        { waitMs: 100, pollMs: 5 },
      )).rejects.toThrow("unowned or has an incompatible ownership marker");
      expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("do not delete");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("verifies every cached note and refuses repair while that generation is read", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-verify-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    const notes = [note("notes/note.md", "# Verified source\n")];
    await mkdir(root);
    let reader: Awaited<ReturnType<typeof prepareSemanticProjection>> | undefined;
    let repaired: Awaited<ReturnType<typeof prepareSemanticProjection>> | undefined;
    try {
      const description = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity(),
      );
      reader = await withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
      );
      const cachedNote = join(description.generationPath, "notes", "note.md");
      await writeFile(cachedNote, "# Tampered source\n", "utf8");
      expect(withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
        { waitMs: 100, pollMs: 5 },
      )).rejects.toThrow("still has active readers");
      expect(await readFile(cachedNote, "utf8")).toBe("# Tampered source\n");

      await reader.release();
      reader = undefined;
      repaired = await withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
      );
      expect(await readFile(cachedNote, "utf8")).toBe("# Verified source\n");
      await repaired.release();
      repaired = undefined;

      await writeFile(join(description.generationPath, "unexpected.md"), "# Unexpected\n");
      repaired = await withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
      );
      expect(stat(join(description.generationPath, "unexpected.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await reader?.release();
      await repaired?.release();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked projection cache before materializing notes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    const outside = join(temporary, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "index.md"), "# Knowledge base\n", "utf8");
    await writeFile(join(root, "note.md"), "# Confined projection\n", "utf8");
    await writeFile(join(outside, "marker"), "outside stays untouched", "utf8");
    try {
      const snapshot = await scanVault(root, { mentionScope: false });
      const description = await describeSemanticProjection(
        database,
        root,
        snapshot.notes,
        indexIdentity(),
      );
      await symlink(outside, description.snapshotDirectory, "dir");
      expect(withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, snapshot.notes),
        { waitMs: 100, pollMs: 5 },
      )).rejects.toThrow("must not be a symbolic link");
      expect(await readFile(join(outside, "marker"), "utf8")).toBe("outside stays untouched");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("rejects notes that changed after projection validation before writing cache state", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    await mkdir(root);
    try {
      const original = [note("note.md", "# Original\n")];
      const description = await describeSemanticProjection(
        database,
        root,
        original,
        indexIdentity(),
      );
      expect(prepareSemanticProjection(
        description,
        [note("note.md", "# Changed\n")],
      )).rejects.toThrow("changed after validation");
      expect(stat(description.snapshotDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("counts reader metadata without imposing that cap on top-level notes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-projection-"));
    const root = join(temporary, "vault");
    const database = join(temporary, "index.sqlite");
    await mkdir(root);
    const notes = Array.from({ length: 1_025 }, (_, index) => note(`note-${index}.md`));
    let projection: Awaited<ReturnType<typeof prepareSemanticProjection>> | undefined;
    try {
      const description = await describeSemanticProjection(
        database,
        root,
        notes,
        indexIdentity(),
      );
      projection = await withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        () => prepareSemanticProjection(description, notes),
        { waitMs: 1_000, pollMs: 5 },
      );
      let entered = false;
      await withSemanticGenerationWriterLease(
        database,
        description.manifest.generation,
        async () => {
          await Promise.resolve();
          entered = true;
        },
        { waitMs: 1_000, pollMs: 5 },
      );
      expect(entered).toBe(true);
    } finally {
      await projection?.release();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 10_000);
});
