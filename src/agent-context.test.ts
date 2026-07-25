import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentContextGuidePath,
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextNotePath,
  analyzeAgentContexts,
  formatAgentContextMarker,
  inspectAgentContextRepository,
  normalizeRepositoryScope,
  parseAgentContextMarker,
  RepositoryScopeError,
  type AgentContextIssue,
  type AgentGuideSource,
} from "./agent-context.js";
import type { MetadataObject, Note } from "./graph.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function note(
  path: string,
  metadata: MetadataObject,
  content = "# Context\n",
): Note {
  const id = path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
  return {
    path,
    id,
    title: "Context",
    aliases: [],
    tags: [],
    properties: {},
    metadata,
    content,
    summary: "",
    searchableText: content,
    links: [],
  };
}

function contextNote(
  scope: string,
  overrides: {
    readonly path?: string;
    readonly metadata?: MetadataObject;
  } = {},
): Note {
  return note(
    overrides.path ?? agentContextNotePath(scope),
    overrides.metadata ?? { type: "agent-context", scope },
  );
}

function guide(scope: string, source = agentContextMarkerForScope(scope)): AgentGuideSource {
  return {
    path: agentContextGuidePath(scope),
    source: `${source}\n# Contents\n\n# Guidelines\n`,
  };
}

function issueKinds(issues: readonly AgentContextIssue[]): string[] {
  return issues.map((issue) => issue.kind);
}

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "cclrte-oh-agent-context-"));
  temporaryRoots.push(root);
  return root;
}

describe("repository scope identity", () => {
  test("normalizes POSIX and backslash scopes to one NFC identity", () => {
    expect(normalizeRepositoryScope(".")).toBe(".");
    expect(normalizeRepositoryScope("./")).toBe(".");
    expect(normalizeRepositoryScope("packages\\oh//src/.")).
      toBe("packages/oh/src");
    expect(normalizeRepositoryScope("caf\u0065\u0301/components")).
      toBe("café/components");
  });

  test("uses the reserved root ID and bounded full-scope slugs", () => {
    expect(agentContextNoteId(".")).toBe(
      "scopes/repository--cdb4ee2aea69",
    );
    expect(agentContextNotePath(".")).toBe(
      "scopes/repository--cdb4ee2aea69.md",
    );

    const first = agentContextNoteId("products/alpha/shared/component");
    const second = agentContextNoteId("products/beta/shared/component");
    expect(first).not.toBe(second);
    expect(first).toStartWith("scopes/products-alpha-shared-component--");
    expect(second).toStartWith("scopes/products-beta-shared-component--");

    const long = agentContextNoteId(
      "packages/a-very-long-directory-name/with-another-long-directory-name/source",
    );
    const basename = long.slice("scopes/".length);
    const separator = basename.lastIndexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(basename.slice(0, separator)).toHaveLength(48);
    expect(basename.slice(separator + 2)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("rejects empty, absolute, drive, traversal, control, and glob scopes", () => {
    const invalid = [
      "",
      " ",
      "/packages/oh",
      "\\\\server\\share",
      "C:\\packages\\oh",
      "../packages",
      "packages/../oh",
      "packages/\u0000/oh",
      "packages/**/oh",
    ];
    for (const input of invalid) {
      expect(() => normalizeRepositoryScope(input)).toThrow(RepositoryScopeError);
    }
  });
});

describe("agent-context markers", () => {
  test("round-trips the exact marker before headings", () => {
    const noteId = agentContextNoteId("packages/oh");
    const marker = formatAgentContextMarker(noteId);
    const parsed = parseAgentContextMarker(`${marker}\n# Contents\n`);

    expect(parsed.kind).toBe("found");
    expect(parsed.markers).toEqual([
      { noteId, line: 1, source: marker },
    ]);
    expect(parsed.malformed).toEqual([]);
  });

  test("ignores unrelated comments and fenced examples", () => {
    const marker = agentContextMarkerForScope(".");
    const parsed = parseAgentContextMarker(
      [
        "<!-- ordinary comment -->",
        "```md",
        marker,
        "```",
        marker,
        "# Contents",
      ].join("\n"),
    );

    expect(parsed.kind).toBe("found");
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0]?.line).toBe(5);
  });

  test("distinguishes malformed, misplaced, and multiple markers", () => {
    const marker = agentContextMarkerForScope(".");
    const malformed = parseAgentContextMarker(
      "<!--oh:context scopes/not-canonical -->\n# Contents\n",
    );
    const misplaced = parseAgentContextMarker(`# Contents\n${marker}\n`);
    const multiple = parseAgentContextMarker(`${marker}\n${marker}\n# Contents\n`);

    expect(malformed.kind).toBe("malformed");
    expect(malformed.malformed[0]?.reason).toBe("syntax");
    expect(misplaced.kind).toBe("malformed");
    expect(misplaced.malformed[0]?.reason).toBe("after-heading");
    expect(multiple.kind).toBe("multiple");
    expect(multiple.markers).toHaveLength(2);
  });
});

describe("agent-context analysis", () => {
  test("accepts a canonical reciprocal mapping and an unmapped guide", () => {
    const analysis = analyzeAgentContexts(
      [contextNote("."), contextNote("packages/oh")],
      [
        guide("."),
        guide("packages/oh"),
        {
          path: "packages/AGENTS.md",
          source: "# Contents\n\n# Guidelines\n",
        },
      ],
    );

    expect(analysis.issues).toEqual([]);
    expect(analysis.contexts.map((context) => [context.scope, context.valid])).
      toEqual([
        [".", true],
        ["packages/oh", true],
      ]);
  });

  test("reports malformed, misplaced, and noncanonical context notes", () => {
    const outside = note(
      "notes/context.md",
      { type: "agent-context", scope: "packages/oh" },
    );
    const nonContext = note(
      "scopes/ordinary.md",
      { type: "plan", scope: "packages/oh" },
    );
    const malformedScope = note(
      "scopes/malformed.md",
      { type: "agent-context", scope: ["packages/oh"] },
    );
    const noncanonical = contextNote("packages/oh", {
      path: "scopes/oh.md",
    });
    const analysis = analyzeAgentContexts([
      outside,
      nonContext,
      malformedScope,
      noncanonical,
    ]);

    expect(issueKinds(analysis.issues)).toContain(
      "context-note-outside-scopes",
    );
    expect(issueKinds(analysis.issues)).toContain(
      "non-context-note-under-scopes",
    );
    expect(issueKinds(analysis.issues)).toContain("malformed-context-type");
    expect(issueKinds(analysis.issues)).toContain("malformed-context-scope");
    expect(issueKinds(analysis.issues)).toContain(
      "noncanonical-context-note",
    );
  });

  test("distinguishes duplicate, case-fold, and NFC scope collisions", () => {
    const duplicate = analyzeAgentContexts([
      contextNote("packages/oh"),
      contextNote("packages/oh"),
    ]);
    const caseFold = analyzeAgentContexts([
      contextNote("Packages/Oh"),
      contextNote("packages/oh"),
    ]);
    const nfc = analyzeAgentContexts([
      contextNote("café"),
      contextNote("cafe\u0301"),
    ]);

    expect(issueKinds(duplicate.issues)).toContain("duplicate-context-scope");
    expect(issueKinds(caseFold.issues)).toContain(
      "case-fold-context-scope-collision",
    );
    expect(issueKinds(nfc.issues)).toContain(
      "nfc-context-scope-collision",
    );
  });

  test("reports marker absence, malformed multiplicity, and pointer failures", () => {
    const root = contextNote(".");
    const missingMarker = analyzeAgentContexts(
      [root],
      [{ path: "AGENTS.md", source: "# Contents\n" }],
    );
    expect(issueKinds(missingMarker.issues)).toContain("guide-marker-missing");
    expect(issueKinds(missingMarker.issues)).toContain(
      "context-note-missing-reciprocal-marker",
    );

    const marker = agentContextMarkerForScope(".");
    const multiple = analyzeAgentContexts(
      [root],
      [{ path: "AGENTS.md", source: `${marker}\n${marker}\n# Contents\n` }],
    );
    expect(issueKinds(multiple.issues)).toContain("guide-marker-multiple");

    const malformed = analyzeAgentContexts(
      [root],
      [{
        path: "AGENTS.md",
        source: "<!-- oh:context scopes/not-canonical -->\n# Contents\n",
      }],
    );
    expect(issueKinds(malformed.issues)).toContain("guide-marker-malformed");

    const missingPointer = analyzeAgentContexts(
      [root],
      [{
        path: "AGENTS.md",
        source: `${formatAgentContextMarker(
          "scopes/missing--0123456789ab",
        )}\n# Contents\n`,
      }],
    );
    expect(issueKinds(missingPointer.issues)).toContain(
      "guide-pointer-missing",
    );

    const packageContext = contextNote("packages");
    const mismatched = analyzeAgentContexts(
      [root, packageContext],
      [{
        path: "AGENTS.md",
        source: `${agentContextMarkerForScope("packages")}\n# Contents\n`,
      }],
    );
    expect(issueKinds(mismatched.issues)).toContain(
      "guide-pointer-mismatch",
    );
  });
});

describe("repository inspection", () => {
  test("returns guides root-to-nearest and verified hubs nearest-to-root", async () => {
    const root = temporaryRepository();
    mkdirSync(join(root, "apps", "web", "src"), { recursive: true });
    const scopes = [".", "apps", "apps/web"] as const;
    for (const scope of scopes) {
      writeFileSync(
        join(root, agentContextGuidePath(scope)),
        `${agentContextMarkerForScope(scope)}\n# Contents\n\n# Guidelines\n`,
      );
    }

    const inspection = await inspectAgentContextRepository(
      scopes.map((scope) => contextNote(scope)),
      {
        repositoryRoot: root,
        target: "apps/web/src/new-screen.ts",
        targetKind: "file",
      },
    );

    expect(inspection.issues).toEqual([]);
    expect(inspection.targetScope).toBe("apps/web/src");
    expect(inspection.inheritedGuides.map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "apps/AGENTS.md",
      "apps/web/AGENTS.md",
    ]);
    expect(inspection.matchingContexts.map((context) => context.scope)).toEqual([
      "apps/web",
      "apps",
      ".",
    ]);
  });

  test("reports a missing derived guide without inventing a mapping", async () => {
    const root = temporaryRepository();
    mkdirSync(join(root, "packages", "oh"), { recursive: true });

    const inspection = await inspectAgentContextRepository(
      [contextNote("packages/oh")],
      {
        repositoryRoot: root,
        target: "packages/oh",
        targetKind: "directory",
      },
    );

    expect(issueKinds(inspection.issues)).toContain("guide-file-missing");
    expect(issueKinds(inspection.issues)).toContain(
      "context-note-missing-reciprocal-marker",
    );
    expect(inspection.matchingContexts).toEqual([]);
  });

  test("rejects a mapped scope symlink that escapes the repository", async () => {
    const parent = temporaryRepository();
    const root = join(parent, "repository");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));

    const inspection = await inspectAgentContextRepository(
      [contextNote("linked")],
      {
        repositoryRoot: root,
        target: ".",
        targetKind: "directory",
        validationMode: "all",
      },
    );

    expect(issueKinds(inspection.issues)).toContain(
      "scope-directory-symlink",
    );
    expect(issueKinds(inspection.issues)).toContain(
      "repository-symlink-escape",
    );
    expect(inspection.guides).toEqual([]);
  });

  test("confines lookup diagnostics to applicable scopes while exhaustive checks see all mappings", async () => {
    const root = temporaryRepository();
    mkdirSync(join(root, "a"));
    writeFileSync(
      join(root, "a", "AGENTS.md"),
      `${agentContextMarkerForScope("a")}\n# Contents\n\n- source\n\n# Guidelines\n\n- rule\n`,
    );

    const notes = [contextNote("a"), contextNote("missing")];
    const applicable = await inspectAgentContextRepository(notes, {
      repositoryRoot: root,
      target: "a",
      targetKind: "directory",
    });
    expect(applicable.issues).toEqual([]);
    expect(applicable.matchingContexts.map(({ scope }) => scope)).toEqual(["a"]);

    const exhaustive = await inspectAgentContextRepository(notes, {
      repositoryRoot: root,
      target: "a",
      targetKind: "directory",
      validationMode: "all",
    });
    expect(issueKinds(exhaustive.issues)).toContain("scope-directory-missing");
  });

  test("keeps case-fold collision peers invalid in scoped lookup", async () => {
    const root = temporaryRepository();
    mkdirSync(join(root, "a"));
    writeFileSync(
      join(root, "a", "AGENTS.md"),
      `${agentContextMarkerForScope("a")}\n# Contents\n\n- source\n\n# Guidelines\n\n- rule\n`,
    );

    const inspection = await inspectAgentContextRepository(
      [contextNote("a"), contextNote("A")],
      {
        repositoryRoot: root,
        target: "a",
        targetKind: "directory",
      },
    );

    expect(inspection.matchingContexts).toEqual([]);
    expect(issueKinds(inspection.issues)).toContain(
      "case-fold-context-scope-collision",
    );
  });

  test("reports broken mapped symlinks without discarding other diagnostics", async () => {
    const root = temporaryRepository();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "missing-scope"), join(root, "linked"));
    symlinkSync(join(root, "missing-guide"), join(root, "real", "AGENTS.md"));

    const inspection = await inspectAgentContextRepository(
      [contextNote("linked"), contextNote("real")],
      {
        repositoryRoot: root,
        target: ".",
        targetKind: "directory",
        validationMode: "all",
      },
    );

    expect(issueKinds(inspection.issues)).toContain("scope-directory-symlink");
    expect(issueKinds(inspection.issues)).toContain("guide-file-symlink");
    expect(issueKinds(inspection.issues)).not.toContain(
      "repository-symlink-escape",
    );
  });

  test("reports mapped symlink loops without aborting the audit", async () => {
    const root = temporaryRepository();
    symlinkSync(join(root, "loop"), join(root, "loop"));

    const inspection = await inspectAgentContextRepository(
      [contextNote("loop")],
      {
        repositoryRoot: root,
        target: ".",
        targetKind: "directory",
        validationMode: "all",
      },
    );

    expect(issueKinds(inspection.issues)).toContain("scope-directory-symlink");
    expect(issueKinds(inspection.issues)).not.toContain(
      "repository-symlink-escape",
    );
  });

  test("rejects target traversal and a target symlink escape", async () => {
    const parent = temporaryRepository();
    const root = join(parent, "repository");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));

    let traversalError: unknown;
    try {
      await inspectAgentContextRepository([], {
        repositoryRoot: root,
        target: "../outside",
      });
    } catch (error) {
      traversalError = error;
    }
    expect(traversalError).toBeInstanceOf(RepositoryScopeError);

    let symlinkError: unknown;
    try {
      await inspectAgentContextRepository([], {
        repositoryRoot: root,
        target: "linked/file.ts",
        targetKind: "file",
      });
    } catch (error) {
      symlinkError = error;
    }
    expect(symlinkError).toMatchObject({ code: "target-symlink-escape" });

    symlinkSync(join(root, "missing"), join(root, "broken"));
    let brokenSymlinkError: unknown;
    try {
      await inspectAgentContextRepository([], {
        repositoryRoot: root,
        target: "broken/file.ts",
        targetKind: "file",
      });
    } catch (error) {
      brokenSymlinkError = error;
    }
    expect(brokenSymlinkError).toMatchObject({ code: "target-symlink" });
  });
});
