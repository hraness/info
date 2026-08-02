import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditAgentGuides,
  auditAgentGuideSource,
  compareAgentGuideAudits,
  discoverAgentGuides,
} from "./agent-guide-audit.js";

function guide(
  path: string,
  contents: readonly string[],
  guidelines: readonly string[],
  marker?: string,
): { readonly path: string; readonly source: string } {
  return {
    path,
    source: [
      ...(marker === undefined ? [] : [marker]),
      "# Contents",
      "",
      ...contents.map((value) => `- ${value}`),
      "",
      "# Guidelines",
      "",
      ...guidelines.map((value) => `- ${value}`),
      "",
    ].join("\n"),
  };
}

describe("agent guide audit", () => {
  test("measures sections and accepts a reciprocal marker before the headings", () => {
    const audited = auditAgentGuideSource(guide(
      "packages/kb/AGENTS.md",
      ["`src/` – implementation"],
      ["Keep the public boundary self-contained."],
      "<!-- kb:context scopes/packages-kb--669faffd20af -->",
    ));

    expect(audited).toMatchObject({
      path: "packages/kb/AGENTS.md",
      scope: "packages/kb",
      contents: { bullets: [{ text: "`src/` – implementation" }] },
      guidelines: {
        bullets: [{ text: "Keep the public boundary self-contained." }],
      },
      marker: { kind: "found" },
      shapeIssues: [],
    });
  });

  test("reports extra headings and empty required sections", () => {
    const audited = auditAgentGuideSource({
      path: "AGENTS.md",
      source: "# Contents\n\n# Extra\n\nText\n\n# Guidelines\n",
    });

    expect(audited.shapeIssues.map(({ kind }) => kind)).toEqual([
      "headings",
      "empty-guidelines",
    ]);
  });

  test("calculates inherited context root to leaf rather than summing unrelated guides", () => {
    const report = auditAgentGuides([
      guide("AGENTS.md", ["root"], ["root rule"]),
      guide("packages/AGENTS.md", ["packages"], ["package rule"]),
      guide("packages/kb/AGENTS.md", ["kb"], ["kb rule"]),
      guide("projects/AGENTS.md", ["projects"], ["project rule"]),
    ]);

    const kb = report.guides.find(({ path }) => path === "packages/kb/AGENTS.md");
    expect(kb?.inheritedGuidePaths).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
      "packages/kb/AGENTS.md",
    ]);
    expect(kb?.inheritedWords).toBe(
      report.guides
        .filter(({ path }) => [
          "AGENTS.md",
          "packages/AGENTS.md",
          "packages/kb/AGENTS.md",
        ].includes(path))
        .reduce((total, candidate) => total + candidate.words, 0),
    );
  });

  test("ranks exact duplicate rules and treats size thresholds as advisories", () => {
    const repeated = "Keep one exact source of truth for the boundary.";
    const report = auditAgentGuides([
      guide("AGENTS.md", ["root"], [repeated]),
      guide("a/AGENTS.md", ["a"], [repeated, "A deliberately long local explanation."]),
      guide("b/AGENTS.md", ["b"], [repeated]),
    ], {
      contentsWords: 0,
      contentsBullets: 0,
      guidelineWords: 1,
      guidelineBullets: 1,
      guidelineBulletWords: 3,
      inheritedWords: 1,
    });

    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]?.text).toBe(repeated);
    expect(report.duplicates[0]?.guides.map(({ path }) => path).toSorted()).toEqual([
      "a/AGENTS.md",
      "AGENTS.md",
      "b/AGENTS.md",
    ].toSorted());
    expect(new Set(report.advisories.map(({ kind }) => kind))).toEqual(new Set([
      "contents-budget",
      "duplicate-guideline",
      "guidelines-budget",
      "inherited-budget",
      "long-guideline",
    ]));
  });

  test("combines wrapped guideline prose into one measured bullet", () => {
    const audited = auditAgentGuideSource({
      path: "AGENTS.md",
      source: [
        "# Contents",
        "",
        "- `src/` – code",
        "",
        "# Guidelines",
        "",
        "- Keep the first line",
        "  attached to its continuation.",
        "- Keep the second rule.",
        "",
      ].join("\n"),
    });

    expect(audited.guidelines.bullets).toMatchObject([
      { line: 7, text: "Keep the first line attached to its continuation." },
      { line: 9, text: "Keep the second rule." },
    ]);
  });

  test("ranks the largest threshold excess before smaller advisories", () => {
    const report = auditAgentGuides([
      guide(
        "AGENTS.md",
        ["root source"],
        ["one two three four five six seven eight nine ten"],
      ),
    ], {
      contentsWords: 1,
      contentsBullets: 10,
      guidelineWords: 5,
      guidelineBullets: 10,
      guidelineBulletWords: 2,
      inheritedWords: 10_000,
    });

    expect(report.advisories[0]?.kind).toBe("long-guideline");
  });

  test("reports only positive guide regressions and compares long bullets by text", () => {
    const existingLong = "Keep this established long guideline stable across harmless line movement.";
    const repeated = "Keep one exact rule shared by both guide scopes.";
    const options = {
      guidelineBulletWords: 5,
      inheritedWords: 10_000,
    } as const;
    const base = auditAgentGuides([
      guide("AGENTS.md", ["root"], [existingLong, repeated]),
      guide("packages/AGENTS.md", ["packages"], ["A compact package rule."]),
      guide(
        "projects/AGENTS.md",
        ["projects with an intentionally longer baseline description"],
        ["A deliberately verbose project guideline that becomes shorter later."],
      ),
    ], options);
    const current = auditAgentGuides([
      guide(
        "AGENTS.md",
        ["root with added context"],
        ["A short inserted rule.", existingLong, repeated],
      ),
      guide("packages/AGENTS.md", ["packages"], [
        repeated,
        "Document this newly introduced guideline with enough detail to cross the threshold.",
      ]),
      guide("projects/AGENTS.md", ["projects"], ["Short project rule."]),
    ], options);

    expect(current.guides.find(({ path }) => path === "AGENTS.md")
      ?.guidelines.bullets.find(({ text }) => text === existingLong)?.line)
      .not.toBe(base.guides.find(({ path }) => path === "AGENTS.md")
        ?.guidelines.bullets.find(({ text }) => text === existingLong)?.line);

    const comparison = compareAgentGuideAudits(base, current);
    expect(comparison.guideWordRegressions.map(({ path }) => path)).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
    ]);
    expect(comparison.guideWordRegressions.some(({ path }) =>
      path === "projects/AGENTS.md")).toBe(false);
    expect(comparison.inheritedWordRegressions.map(({ path }) => path)).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
    ]);
    expect(comparison.newlyLongGuidelines).toEqual([{
      path: "packages/AGENTS.md",
      line: 8,
      text: "Document this newly introduced guideline with enough detail to cross the threshold.",
      words: 12,
      suggestedWords: 5,
    }]);
    expect(comparison.newlyLongGuidelines.some(({ text }) => text === existingLong)).toBe(false);
    expect(comparison.expandedDuplicateGuidelines).toEqual([{
      text: repeated,
      words: 9,
      baseGuides: ["AGENTS.md"],
      currentGuides: ["AGENTS.md", "packages/AGENTS.md"],
      addedGuides: ["packages/AGENTS.md"],
    }]);
  });

  test("treats a new guide as positive growth and ignores removed duplicate occurrences", () => {
    const repeated = "Keep this exact shared rule unchanged.";
    const base = auditAgentGuides([
      guide("AGENTS.md", ["root"], [repeated]),
      guide("old/AGENTS.md", ["old"], [repeated]),
    ]);
    const current = auditAgentGuides([
      guide("AGENTS.md", ["root"], [repeated]),
      guide("new/AGENTS.md", ["new"], ["A new scoped rule."]),
    ]);

    const comparison = compareAgentGuideAudits(base, current);
    expect(comparison.guideWordRegressions.map(({ path, baseWords }) => ({
      path,
      baseWords,
    }))).toEqual([{ path: "new/AGENTS.md", baseWords: 0 }]);
    expect(comparison.inheritedWordRegressions.some(({ path }) =>
      path === "new/AGENTS.md")).toBe(true);
    expect(comparison.expandedDuplicateGuidelines).toEqual([]);
  });
});

describe("agent guide discovery", () => {
  test("discovers regular guides, ignores build directories, and refuses symlink traversal", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "kb-agent-audit-"));
    try {
      await writeFile(join(temporary, "AGENTS.md"), "# Contents\n\n- root\n\n# Guidelines\n\n- rule\n");
      await mkdir(join(temporary, "src"));
      await writeFile(join(temporary, "src", "AGENTS.md"), "# Contents\n\n- src\n\n# Guidelines\n\n- rule\n");
      await mkdir(join(temporary, "node_modules"));
      await writeFile(join(temporary, "node_modules", "AGENTS.md"), "# ignored");
      await mkdir(join(temporary, "vendor"));
      await writeFile(join(temporary, "vendor", "AGENTS.md"), "# ignored");
      await mkdir(join(temporary, "build"));
      await writeFile(join(temporary, "build", "AGENTS.md"), "# ignored");
      await mkdir(join(temporary, "outside"));
      await writeFile(join(temporary, "outside", "AGENTS.md"), "# Contents\n\n- out\n\n# Guidelines\n\n- rule\n");
      await mkdir(join(temporary, "odd"));
      await mkdir(join(temporary, "odd", "AGENTS.md"));
      await symlink(join(temporary, "outside"), join(temporary, "linked"));
      await symlink(join(temporary, "outside", "AGENTS.md"), join(temporary, "src", "linked-AGENTS.md"));

      const discovery = await discoverAgentGuides(temporary);
      expect(discovery.guides.map(({ path }) => path)).toEqual([
        "AGENTS.md",
        "outside/AGENTS.md",
        "src/AGENTS.md",
      ]);
      expect(discovery.issues).toEqual([
        {
          kind: "symlink-directory",
          path: "linked",
          message: "Agent-guide discovery does not traverse the symbolic-link directory linked.",
        },
        {
          kind: "non-regular-guide",
          path: "odd/AGENTS.md",
          message: "The agent guide odd/AGENTS.md must be a regular file.",
        },
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
