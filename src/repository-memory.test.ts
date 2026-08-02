import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNote } from "./graph.js";
import {
  activePlanStatuses,
  analyzeAuthoredRepositoryScopes,
  auditRepositoryMemoryScopes,
  buildRepositoryMemoryContext,
  canonicalRepositoryPath,
  classifyRepositoryMemoryRecord,
  deepestRepositoryScopeMatch,
  inspectRepositoryScopeState,
  MAX_REPOSITORY_SCOPES,
  MAX_REPOSITORY_SCOPES_UTF8_BYTES,
  MAX_REPOSITORY_SCOPE_UTF8_BYTES,
  metadataMatchesExactRepositoryScopes,
  repositoryScopeMatchesPath,
  terminalPlanStatuses,
  validateRepositoryScopeSelection,
} from "./repository-memory.js";

function record(
  path: string,
  metadata: readonly string[],
  body = "Durable memory for a repository path.",
) {
  return parseNote(path, [
    "---",
    ...metadata,
    "---",
    `# ${path}`,
    "",
    body,
  ].join("\n"));
}

describe("repository scope declarations", () => {
  test("accepts only bounded canonical authored arrays", () => {
    const valid = record("notes/current.md", [
      "type: note",
      "repository_scopes:",
      "  - packages/kb",
      "  - packages/kb/src/query.ts",
    ]);
    expect(analyzeAuthoredRepositoryScopes(valid.metadata)).toEqual({
      present: true,
      valid: true,
      scopes: ["packages/kb", "packages/kb/src/query.ts"],
      issues: [],
    });

    for (const candidate of ["packages//kb", "./packages/kb", "packages\\kb", "e\u0301"] as const) {
      expect(() => canonicalRepositoryPath(candidate)).toThrow("exact NFC-normalized POSIX form");
    }
    for (const candidate of ["", "/tmp/kb", "../kb", "packages/*"] as const) {
      expect(() => canonicalRepositoryPath(candidate)).toThrow();
    }
    expect(() => validateRepositoryScopeSelection(["packages/KB", "packages/kb"]))
      .toThrow("case folding");
    expect(analyzeAuthoredRepositoryScopes({ repository_scopes: "packages/kb" }))
      .toMatchObject({ present: true, valid: false });
    expect(analyzeAuthoredRepositoryScopes({ Repository_Scopes: ["packages/kb"] }))
      .toMatchObject({ present: true, valid: false });
    expect(() => validateRepositoryScopeSelection(
      Array.from({ length: MAX_REPOSITORY_SCOPES + 1 }, (_, index) => `scope-${index}`),
    )).toThrow(`at most ${MAX_REPOSITORY_SCOPES} paths`);
    expect(() => validateRepositoryScopeSelection([
      "x".repeat(MAX_REPOSITORY_SCOPE_UTF8_BYTES + 1),
    ])).toThrow(`${MAX_REPOSITORY_SCOPE_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    expect(() => validateRepositoryScopeSelection(
      Array.from(
        { length: MAX_REPOSITORY_SCOPES },
        (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(
          Math.floor(MAX_REPOSITORY_SCOPES_UTF8_BYTES / MAX_REPOSITORY_SCOPES),
        )}`,
      ),
    )).toThrow(`${MAX_REPOSITORY_SCOPES_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes in total`);
  });

  test("matches a full path lexically and keeps exact selection case-sensitive", () => {
    expect(repositoryScopeMatchesPath("packages/kb", "packages/kb/src/query.ts")).toBe(true);
    expect(repositoryScopeMatchesPath("packages/kb", "packages/kb-other/src/query.ts")).toBe(false);
    expect(deepestRepositoryScopeMatch(
      [".", "packages", "packages/kb", "packages/kb/src/query.ts"],
      "packages/kb/src/query.ts",
    )).toEqual({
      scope: "packages/kb/src/query.ts",
      kind: "exact",
      depth: 4,
    });

    const metadata = { repository_scopes: ["packages/KB", "docs"] };
    expect(metadataMatchesExactRepositoryScopes(metadata, ["packages/KB"])).toBe(true);
    expect(metadataMatchesExactRepositoryScopes(metadata, ["packages/kb"])).toBe(false);
    expect(metadataMatchesExactRepositoryScopes(metadata, ["docs", "elsewhere"])).toBe(true);
  });
});

describe("repository memory classification", () => {
  test("shares active and terminal lifecycle semantics", () => {
    expect(activePlanStatuses).toEqual(["proposed", "accepted", "in-progress", "blocked"]);
    expect(terminalPlanStatuses).toEqual(["completed", "superseded", "cancelled"]);
    for (const status of activePlanStatuses) {
      expect(classifyRepositoryMemoryRecord(record(`plans/${status}.md`, [
        "type: plan",
        `status: ${status}`,
      ]))).toMatchObject({ kind: "record", group: "activePlans", status });
    }
    for (const status of terminalPlanStatuses) {
      expect(classifyRepositoryMemoryRecord(record(`plans/${status}.md`, [
        "type: plan",
        `status: ${status}`,
      ]))).toMatchObject({ kind: "record", group: "historicalPlans", status });
    }
  });

  test("requires dated research and report contracts", () => {
    expect(classifyRepositoryMemoryRecord(record(
      "projects/example.com/market/current.md",
      ["type: market-research", "status: snapshot", "as_of: 2026-08-02"],
    ))).toMatchObject({ kind: "record", group: "datedResearch", date: "2026-08-02" });
    expect(classifyRepositoryMemoryRecord(record(
      "projects/example.com/market/invalid.md",
      ["type: market-research", "status: current", "as_of: 2026-02-30"],
    ))).toMatchObject({ kind: "invalid" });
    expect(classifyRepositoryMemoryRecord(record(
      "reports/current.md",
      ["type: report", "generated: 2026-08-02"],
    ))).toMatchObject({ kind: "record", group: "reports", date: "2026-08-02" });
  });
});

describe("repository filesystem state", () => {
  test("distinguishes files, directories, absence, and symlinks without rewriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-memory-state-"));
    try {
      await mkdir(join(root, "packages", "kb"), { recursive: true });
      await writeFile(join(root, "packages", "kb", "query.ts"), "export {};\n", "utf8");
      await symlink(join(root, "packages", "kb"), join(root, "linked-kb"));
      expect(await inspectRepositoryScopeState(root, "packages/kb"))
        .toEqual({ status: "present", scope: "packages/kb", kind: "directory" });
      expect(await inspectRepositoryScopeState(root, "packages/kb/query.ts"))
        .toEqual({ status: "present", scope: "packages/kb/query.ts", kind: "file" });
      expect(await inspectRepositoryScopeState(root, "projects/future/app"))
        .toEqual({
          status: "absent",
          scope: "projects/future/app",
          firstMissingPath: "projects",
        });
      expect(await inspectRepositoryScopeState(root, "linked-kb"))
        .toEqual({ status: "invalid", scope: "linked-kb", path: "linked-kb", reason: "symlink" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bounded repository memory context", () => {
  test("groups current and historical records, reports match state, and bounds details", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-memory-context-"));
    try {
      await mkdir(join(root, "packages", "kb", "src"), { recursive: true });
      await writeFile(join(root, "packages", "kb", "src", "query.ts"), "export {};\n", "utf8");
      const scope = ["repository_scopes:", "  - packages/kb"];
      const notes = [
        record("notes/retrieval.md", ["type: concept", ...scope]),
        record("plans/proposed.md", ["type: plan", "status: proposed", ...scope]),
        record("plans/accepted.md", ["type: plan", "status: accepted", ...scope]),
        record("plans/completed.md", ["type: plan", "status: completed", ...scope]),
        record("projects/example.com/market/research.md", [
          "type: market-research",
          "status: snapshot",
          "as_of: 2026-08-01",
          ...scope,
        ]),
        record("reports/audit.md", ["type: report", "generated: 2026-08-02", ...scope]),
        record("plans/invalid.md", [
          "type: plan",
          "status: unknown",
          "repository_scopes: packages/kb",
        ]),
        record("plans/future.md", [
          "type: plan",
          "status: proposed",
          "repository_scopes:",
          "  - projects/example/future-app",
        ]),
        record("plans/retired.md", [
          "type: plan",
          "status: completed",
          "repository_scopes:",
          "  - projects/example/retired-app",
        ]),
      ];
      const context = await buildRepositoryMemoryContext(notes, {
        repositoryRoot: root,
        target: "packages/kb/src/query.ts",
        groupLimit: 1,
        detailLimit: 1,
      });
      expect(context.targetState).toEqual({
        status: "present",
        scope: "packages/kb/src/query.ts",
        kind: "file",
      });
      expect(context.groups.maintainedKnowledge.records[0]).toMatchObject({
        path: "notes/retrieval.md",
        matchedScope: "packages/kb",
        match: "ancestor",
        scopeState: { status: "present", kind: "directory" },
      });
      expect(context.groups.activePlans).toMatchObject({ total: 2, returned: 1, truncated: true });
      expect(context.groups.historicalPlans.records.map(({ path }) => path))
        .toEqual(["plans/completed.md"]);
      expect(context.groups.datedResearch.total).toBe(1);
      expect(context.groups.reports.total).toBe(1);
      expect(context.invalidRecords).toMatchObject({ total: 1, returned: 1, truncated: false });
      expect(context.counts).toEqual({ matched: 6, returned: 5, invalid: 1, advisories: 0 });

      const future = await buildRepositoryMemoryContext(notes, {
        repositoryRoot: root,
        target: "projects/example/future-app",
      });
      expect(future.groups.activePlans.records[0]).toMatchObject({
        path: "plans/future.md",
        scopeState: { status: "absent" },
      });
      expect(future.advisories.details).toEqual([
        expect.objectContaining({
          kind: "absent-current-scope",
          path: "plans/future.md",
          scope: "projects/example/future-app",
        }),
      ]);

      const retired = await buildRepositoryMemoryContext(notes, {
        repositoryRoot: root,
        target: "projects/example/retired-app",
      });
      expect(retired.groups.historicalPlans.records[0]).toMatchObject({
        path: "plans/retired.md",
        scopeState: { status: "absent" },
      });
      expect(retired.advisories.total).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects cross-record case-fold collisions and symlink scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-memory-invalid-"));
    try {
      await mkdir(join(root, "packages", "KB"), { recursive: true });
      await symlink(join(root, "packages", "KB"), join(root, "linked"));
      const notes = [
        record("notes/upper.md", [
          "type: note",
          "repository_scopes:",
          "  - packages/KB",
        ]),
        record("notes/lower.md", [
          "type: note",
          "repository_scopes:",
          "  - packages/kb",
        ]),
        record("notes/link.md", [
          "type: note",
          "repository_scopes:",
          "  - linked",
        ]),
      ];
      const collision = await buildRepositoryMemoryContext(notes, {
        repositoryRoot: root,
        target: "packages/KB",
      });
      expect(collision.groups.maintainedKnowledge.total).toBe(0);
      expect(collision.invalidRecords.details.map(({ path }) => path))
        .toEqual(["notes/lower.md", "notes/upper.md"]);

      const linked = await buildRepositoryMemoryContext(notes.slice(2), {
        repositoryRoot: root,
        target: "linked",
      });
      expect(linked.groups.maintainedKnowledge.total).toBe(0);
      expect(linked.invalidRecords.details[0]?.issues[0]).toContain("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("whole-vault repository memory audit", () => {
  test("inspects every valid declaration while separating errors, absence, and history", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-memory-audit-"));
    try {
      await mkdir(join(root, "packages", "kb"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "report.md"), "# Report\n", "utf8");
      await symlink(join(root, "packages", "kb"), join(root, "linked"));
      const notes = [
        record("notes/current.md", [
          "type: note",
          "repository_scopes:",
          "  - packages/kb",
          "  - projects/future",
        ]),
        record("plans/future.md", [
          "type: plan",
          "status: proposed",
          "repository_scopes: [projects/future]",
        ]),
        record("plans/retired.md", [
          "type: plan",
          "status: completed",
          "repository_scopes: [projects/retired]",
        ]),
        record("plans/malformed.md", [
          "type: plan",
          "status: proposed",
          "repository_scopes: packages/kb",
        ]),
        record("plans/status.md", [
          "type: plan",
          "status: unknown",
          "repository_scopes: [packages/kb]",
        ]),
        record("sources/ignored.md", [
          "type: source",
          "repository_scopes: [sources/future]",
        ]),
        record("notes/upper.md", [
          "type: note",
          "repository_scopes: [Products/App]",
        ]),
        record("notes/lower.md", [
          "type: note",
          "repository_scopes: [products/app]",
        ]),
        record("notes/link.md", [
          "type: note",
          "repository_scopes: [linked]",
        ]),
        record("artifacts/report.md", [
          "type: report",
          "generated: 2026-08-02",
          "repository_scopes: [docs/report.md]",
        ]),
      ];

      const audit = await auditRepositoryMemoryScopes(notes, {
        repositoryRoot: root,
        detailLimit: 100,
      });
      expect(audit.counts).toEqual({
        authoredRecords: 10,
        validDeclarationRecords: 9,
        classifiedRecords: 7,
        currentRecords: 6,
        terminalRecords: 1,
        ignoredRecords: 1,
        invalidRecords: 4,
        distinctScopes: 8,
        presentScopes: 2,
        absentScopes: 5,
        invalidScopes: 1,
        errors: 5,
        advisories: 2,
      });
      expect(audit.groups).toEqual({
        maintainedKnowledge: 4,
        activePlans: 1,
        datedResearch: 0,
        reports: 1,
        historicalPlans: 1,
      });
      expect(audit.states.details.find(({ scope }) => scope === "linked"))
        .toMatchObject({
          state: { status: "invalid", reason: "symlink" },
          recordCount: 1,
          recordPaths: ["notes/link.md"],
          recordPathsTruncated: false,
        });
      expect(audit.states.details.find(({ scope }) => scope === "packages/kb"))
        .toMatchObject({
          state: { status: "present", kind: "directory" },
          recordCount: 2,
        });
      expect(audit.errors.details.some((error) =>
        error.kind === "invalid-scope-state" && error.scope === "linked"))
        .toBe(true);
      expect(audit.errors.details.flatMap((error) =>
        error.kind === "invalid-record" ? [error.path] : [])).toEqual([
          "notes/lower.md",
          "notes/upper.md",
          "plans/malformed.md",
          "plans/status.md",
        ]);
      expect(audit.advisories.details.map(({ path, scope }) => ({ path, scope })))
        .toEqual([
          { path: "notes/current.md", scope: "projects/future" },
          { path: "plans/future.md", scope: "projects/future" },
        ]);
      expect(audit.advisories.details.some(({ path }) => path === "plans/retired.md"))
        .toBe(false);

      const bounded = await auditRepositoryMemoryScopes(notes, {
        repositoryRoot: root,
        detailLimit: 1,
      });
      expect(bounded.records).toMatchObject({ total: 9, returned: 1, truncated: true });
      expect(bounded.states).toMatchObject({ total: 8, returned: 1, truncated: true });
      expect(bounded.errors).toMatchObject({ total: 5, returned: 1, truncated: true });
      expect(bounded.advisories).toMatchObject({ total: 2, returned: 1, truncated: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
