import { describe, expect, test } from "bun:test";

import {
  FACT_ATTRIBUTES,
  FactProjectionBudgetError,
  linkFactEntityId,
  MAX_METADATA_PROJECTION_DEPTH,
  metadataFactEntityId,
  noteFactEntityId,
  projectVaultFacts,
  relationFactEntityId,
  type VaultFact,
} from "./facts.js";
import { analyzeVault, parseNote } from "./graph.js";

function values(
  facts: readonly VaultFact[],
  entity: string,
  attribute: string,
): readonly unknown[] {
  return facts
    .filter((fact) => fact.entity === entity && fact.attribute === attribute)
    .map((fact) => fact.value);
}

describe("vault fact projection", () => {
  test("projects notes, scalar metadata leaves, links, and authored relationships", () => {
    const notes = [
      parseNote("notes/alpha.md", [
        "---",
        "tags: [AI, local-first]",
        "priority: 3",
        "published: false",
        "owner:",
        "  teams: [Research, Platform]",
        '"a/b":',
        '  "~key": null',
        "relations:",
        "  supports:",
        "    - concepts/memory",
        "---",
        "# Alpha",
        "",
        "See [[notes/beta]].",
      ].join("\n")),
      parseNote("notes/beta.md", "# Beta\n"),
      parseNote("concepts/memory.md", [
        "---",
        "type: concept",
        "aliases: [Durable memory]",
        "---",
        "# Memory",
      ].join("\n")),
    ];
    const analysis = analyzeVault(notes);
    const facts = projectVaultFacts(notes, analysis);
    const alpha = noteFactEntityId("notes/alpha");

    expect(values(facts, alpha, FACT_ATTRIBUTES.noteTag)).toEqual([
      "ai",
      "local-first",
    ]);
    expect(values(
      facts,
      noteFactEntityId("concepts/memory"),
      FACT_ATTRIBUTES.noteConcept,
    )).toEqual([true]);
    expect(values(
      facts,
      metadataFactEntityId("notes/alpha", "/owner/teams/1"),
      FACT_ATTRIBUTES.metadataValue,
    )).toEqual(["Platform"]);
    expect(values(
      facts,
      metadataFactEntityId("notes/alpha", "/a~1b/~0key"),
      FACT_ATTRIBUTES.metadataValue,
    )).toEqual([null]);

    const link = linkFactEntityId("notes/alpha", "notes/beta");
    expect(values(facts, link, FACT_ATTRIBUTES.edgeSource)).toEqual([alpha]);
    expect(values(facts, link, FACT_ATTRIBUTES.edgeTarget)).toEqual([
      noteFactEntityId("notes/beta"),
    ]);
    expect(values(facts, link, FACT_ATTRIBUTES.edgeProvenance)).toEqual([
      "wikilink",
    ]);

    const relation = relationFactEntityId(
      "notes/alpha",
      "supports",
      "concepts/memory",
    );
    expect(values(facts, relation, FACT_ATTRIBUTES.edgePredicate)).toEqual([
      "supports",
    ]);
    expect(values(facts, relation, FACT_ATTRIBUTES.edgeAuthoredTarget)).toEqual([
      "concepts/memory",
    ]);
    expect(facts.every((fact) =>
      typeof fact.entity === "string"
      && (fact.kind === "scalar" || typeof fact.value === "string"))).toBe(true);
  });

  test("is independent of note and analysis ordering", () => {
    const notes = [
      parseNote(
        "notes/a.md",
        "---\ntags: [shared]\nrelations:\n  supports: [notes/c]\n---\n# A\n\n[[notes/b]]\n",
      ),
      parseNote("notes/b.md", "---\ntags: [shared]\n---\n# B\n"),
      parseNote("notes/c.md", "# C\n"),
    ];
    const forward = projectVaultFacts(notes, analyzeVault(notes));
    const reversedNotes = [...notes].reverse();
    const reversedAnalysis = analyzeVault(reversedNotes);
    const permutedAnalysis = {
      ...reversedAnalysis,
      contextualLinks: [...reversedAnalysis.contextualLinks].reverse(),
      authoredRelations: [...reversedAnalysis.authoredRelations].reverse(),
      noteConnections: [...reversedAnalysis.noteConnections].reverse(),
    };

    expect(projectVaultFacts(reversedNotes, permutedAnalysis)).toEqual(forward);
    expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
  });

  test("rejects duplicate note identities instead of choosing one", () => {
    const note = parseNote("notes/a.md", "# A\n");
    const analysis = analyzeVault([note]);
    expect(() =>
      projectVaultFacts(
        [note, { ...note, path: "notes/duplicate.md" }],
        analysis,
      )).toThrow("Duplicate note identity");
  });

  test("has linear cardinality for notes without metadata or edges", () => {
    for (const count of [0, 1, 10, 50]) {
      const notes = Array.from({ length: count }, (_, index) =>
        parseNote(`notes/n-${index}.md`, `# Note ${index}\n`));
      const facts = projectVaultFacts(notes, analyzeVault(notes));
      expect(facts).toHaveLength(count * 6);
    }
  });

  test("stops nested metadata traversal as soon as the fact budget is spent", () => {
    const note = parseNote("notes/a.md", "# A\n");
    let inspectedLateProperty = false;
    const metadata: Record<string, number> = {};
    Object.defineProperties(metadata, {
      a: { enumerable: true, value: 1 },
      z: {
        enumerable: true,
        get: () => {
          inspectedLateProperty = true;
          throw new Error("late metadata must not be inspected");
        },
      },
    });
    const forged = { ...note, metadata };
    const analysis = analyzeVault([forged]);

    try {
      projectVaultFacts([forged], analysis, { maxFacts: 7 });
      throw new Error("bounded projection unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(FactProjectionBudgetError);
      expect(error).toMatchObject({ kind: "fact-limit", limit: 7 });
    }
    expect(inspectedLateProperty).toBe(false);
    expect(() => projectVaultFacts([forged], analysis, { maxFacts: 250_001 }))
      .toThrow("safe integer from 0 to 250000");
  });

  test("bounds non-emitting metadata container traversal", () => {
    const note = parseNote("notes/a.md", [
      "---",
      ...Array.from({ length: 7 }, (_, index) => `empty-${index}: {}`),
      "---",
      "# A",
    ].join("\n"));

    try {
      projectVaultFacts([note], analyzeVault([note]), { maxFacts: 7 });
      throw new Error("metadata value traversal unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(FactProjectionBudgetError);
      expect(error).toMatchObject({ kind: "metadata-value-limit", limit: 7 });
    }
  });

  test("bounds metadata depth before descending further", () => {
    const nested = Array.from(
      { length: MAX_METADATA_PROJECTION_DEPTH + 1 },
      (_, index) =>
        `${"  ".repeat(index)}level-${index}:${
          index === MAX_METADATA_PROJECTION_DEPTH ? " {}" : ""
        }`,
    );
    const note = parseNote("notes/deep.md", [
      "---",
      ...nested,
      "---",
      "# Deep",
    ].join("\n"));

    try {
      projectVaultFacts([note], analyzeVault([note]));
      throw new Error("metadata depth traversal unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(FactProjectionBudgetError);
      expect(error).toMatchObject({
        kind: "metadata-depth-limit",
        limit: MAX_METADATA_PROJECTION_DEPTH,
      });
    }
  });
});
