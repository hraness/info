import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { VaultAnalysisBudgetError } from "./graph.js";
import {
  MAX_NOTE_UTF8_BYTES,
  refreshVault,
  scanVault,
  VaultScanBudgetError,
} from "./vault.js";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hraness-oh-vault-test-"));
  roots.push(root);
  mkdirSync(join(root, "notes"));
  writeFileSync(
    join(root, "index.md"),
    "# Knowledge base\n\n<!-- oh:catalog:start -->\n<!-- oh:catalog:end -->\n",
  );
  writeFileSync(join(root, "notes", "alpha.md"), "# Alpha\n\nSee [[notes/beta|Beta]].\n");
  writeFileSync(join(root, "notes", "beta.md"), "---\naliases: [Second note]\n---\n# Beta\n\nA maintained note.\n");
  writeFileSync(join(root, "notes", "AGENTS.md"), "# Ignored\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("vault scan and refresh", () => {
  test("rejects the discovered note count before reading or parsing notes", async () => {
    const root = fixture();
    writeFileSync(join(root, "index.md"), "---\nmalformed: [\n---\n", "utf8");

    let rejection: unknown;
    try {
      await scanVault(root, { maxNotes: 2 });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultScanBudgetError);
    expect(rejection).toMatchObject({ kind: "notes", limit: 2 });
  });

  test("rejects raw paths before parsing and reports normalization collisions", async () => {
    const root = fixture();
    writeFileSync(join(root, "index.md"), "---\nmalformed: [\n---\n", "utf8");
    writeFileSync(join(root, "notes\\alpha.md"), "---\nalso: [\n---\n", "utf8");

    let rejection: unknown;
    try {
      await scanVault(root);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("scan unexpectedly succeeded");
    expect(rejection.message).toContain("normalize to the same note ID");
    expect(rejection.message).toContain("notes/alpha");
    expect(rejection.message).not.toContain("YAML");
  });

  test("rejects standalone backslash and non-extensionless note identities", async () => {
    const backslashRoot = fixture();
    writeFileSync(join(backslashRoot, "back\\slash.md"), "# Backslash\n", "utf8");
    let backslashRejection: unknown;
    try {
      await scanVault(backslashRoot);
    } catch (error) {
      backslashRejection = error;
    }
    expect(backslashRejection).toBeInstanceOf(Error);
    if (!(backslashRejection instanceof Error)) {
      throw new Error("backslash scan unexpectedly succeeded");
    }
    expect(backslashRejection.message).toContain("contains a backslash");

    const extensionRoot = fixture();
    writeFileSync(join(extensionRoot, "index.md"), "---\nmalformed: [\n---\n", "utf8");
    writeFileSync(join(extensionRoot, "extra.md.md"), "# Extra\n", "utf8");
    let extensionRejection: unknown;
    try {
      await scanVault(extensionRoot);
    } catch (error) {
      extensionRejection = error;
    }
    expect(extensionRejection).toBeInstanceOf(Error);
    if (!(extensionRejection instanceof Error)) {
      throw new Error("extension scan unexpectedly succeeded");
    }
    expect(extensionRejection.message).toContain("canonical extensionless");
    expect(extensionRejection.message).not.toContain("YAML");
  });

  test("rejects non-NFC disk identities with an actionable diagnostic", async () => {
    const root = fixture();
    const decomposedName = `caf${"e\u0301"}.md`;
    writeFileSync(join(root, decomposedName), "# Cafe\n", "utf8");

    let rejection: unknown;
    try {
      await scanVault(root);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("scan unexpectedly succeeded");
    expect(rejection.message).toContain("is not NFC");
    expect(rejection.message).toContain("café");
  });

  test("rejects a sparse oversized note from metadata before reading it", async () => {
    const root = fixture();
    truncateSync(join(root, "notes", "alpha.md"), MAX_NOTE_UTF8_BYTES + 1);

    let rejection: unknown;
    try {
      await scanVault(root);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultScanBudgetError);
    expect(rejection).toMatchObject({
      kind: "note-bytes",
      limit: MAX_NOTE_UTF8_BYTES,
    });
  });

  test("rejects cumulative bytes before parsing any preflighted note", async () => {
    const root = fixture();
    writeFileSync(join(root, "index.md"), "---\nmalformed: [\n---\n", "utf8");

    let rejection: unknown;
    try {
      await scanVault(root, { maxTotalBytes: 1 });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultScanBudgetError);
    expect(rejection).toMatchObject({ kind: "total-bytes", limit: 1 });
  });

  test("forwards a lowered aggregate connection-observation bound", async () => {
    const root = fixture();

    let rejection: unknown;
    try {
      await scanVault(root, {
        maxConnectionObservations: 0,
        mentionScope: false,
        maxMentionPairs: 0,
        maxMentions: 0,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultAnalysisBudgetError);
    expect(rejection).toMatchObject({
      kind: "connection-observations",
      limit: 0,
    });
  });

  test("reports a stale catalog without changing the index", async () => {
    const root = fixture();
    const before = readFileSync(join(root, "index.md"), "utf8");
    const result = await scanVault(root);

    expect(result.index).toBe("stale");
    expect(result.notes.map(({ path }) => path)).toEqual([
      "index.md",
      "notes/alpha.md",
      "notes/beta.md",
    ]);
    expect(result.analysis.contextualLinks).toEqual([
      { source: "notes/alpha.md", target: "notes/beta.md", line: 3 },
    ]);
    expect(readFileSync(join(root, "index.md"), "utf8")).toBe(before);
  });

  test("includes scope hubs as ordinary Markdown while excluding their AGENTS guide", async () => {
    const root = fixture();
    mkdirSync(join(root, "scopes"));
    writeFileSync(join(root, "scopes", "AGENTS.md"), "# Contents\n\n- hubs\n\n# Guidelines\n\n- rules\n");
    writeFileSync(join(root, "scopes", "src--25a6634263c1.md"), [
      "---",
      "title: Source context",
      "type: agent-context",
      "scope: src",
      "---",
      "",
      "# Source context",
      "",
      "Pull-based rationale.",
      "",
    ].join("\n"));

    const result = await scanVault(root);
    expect(result.notes.map(({ path }) => path)).toContain("scopes/src--25a6634263c1.md");
    expect(result.notes.map(({ path }) => path)).not.toContain("scopes/AGENTS.md");
  });

  test("atomically refreshes only the managed catalog", async () => {
    const root = fixture();
    const refreshed = await refreshVault(root);
    const current = await scanVault(root);
    const index = readFileSync(join(root, "index.md"), "utf8");

    expect(refreshed.index).toBe("updated");
    expect(current.index).toBe("current");
    expect(index).toContain("- [[notes/alpha|Alpha]]");
    expect(index).toContain("- [[notes/beta|Beta]] — A maintained note.");
    expect(readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("keeps orphans and mention candidates advisory in the analysis", async () => {
    const root = fixture();
    writeFileSync(join(root, "notes", "gamma.md"), "# Gamma\n\nSecond note appears here without a link.\n");
    const result = await refreshVault(root);

    expect(result.analysis.orphans).toEqual(["notes/gamma.md"]);
    expect(result.analysis.mentions).toContainEqual({
      source: "notes/gamma.md",
      line: 3,
      target: "notes/beta.md",
      phrase: "Second note",
    });
  });

  test("supports a nested managed index without cataloging or counting it", async () => {
    const root = fixture();
    mkdirSync(join(root, "navigation"));
    writeFileSync(
      join(root, "navigation", "catalog.md"),
      "# Catalog\n\n<!-- oh:catalog:start -->\n<!-- oh:catalog:end -->\n",
    );

    const result = await refreshVault(root, { index: "navigation/catalog.md" });
    const catalog = readFileSync(join(root, "navigation", "catalog.md"), "utf8");

    expect(result.analysis.noteCount).toBe(3);
    expect(result.analysis.noteConnections.map(({ path }) => path).sort()).toEqual([
      "index.md",
      "notes/alpha.md",
      "notes/beta.md",
    ]);
    expect(catalog).not.toContain("[[navigation/catalog|Catalog]]");
  });

  test("rejects a symlinked index without copying outside content into the vault", async () => {
    const root = fixture();
    const outside = join(dirname(root), `${basename(root)}-outside.md`);
    writeFileSync(outside, "TOP-SECRET-OUTSIDE-VAULT\n", "utf8");
    roots.push(outside);
    unlinkSync(join(root, "index.md"));
    symlinkSync(outside, join(root, "index.md"));

    let rejection: unknown;
    try {
      await refreshVault(root);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(readFileSync(outside, "utf8")).toBe("TOP-SECRET-OUTSIDE-VAULT\n");
  });

  test("rejects a symlinked index parent without writing outside the vault", async () => {
    const root = fixture();
    const outside = `${root}-outside-directory`;
    mkdirSync(outside);
    roots.push(outside);
    writeFileSync(join(outside, "index.md"), "# Outside\n", "utf8");
    symlinkSync(outside, join(root, "navigation"));

    let rejection: unknown;
    try {
      await refreshVault(root, { index: "navigation/index.md" });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("refresh unexpectedly succeeded");
    expect(rejection.message).toContain("must not traverse a symbolic link");
    expect(readFileSync(join(outside, "index.md"), "utf8")).toBe("# Outside\n");
  });
});
