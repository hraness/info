import { describe, expect, test } from "bun:test";

import { analyzeVault, parseNote } from "./graph.js";
import {
  MAX_NAVIGATION_INDEXED_CONNECTIONS,
  MAX_NAVIGATION_RETURNED_CONNECTIONS,
  NavigationBudgetError,
  navigateLinks,
} from "./navigation.js";

const notes = [
  parseNote("notes/a.md", "# A\n\n[[notes/b]]\n"),
  parseNote("notes/b.md", "# B\n\n[[notes/c]]\n"),
  parseNote("notes/c.md", "# C\n\n[[notes/a]]\n"),
  parseNote("notes/d.md", "# D\n\n[[notes/b]]\n"),
];
const analysis = analyzeVault(notes);

describe("structural link navigation", () => {
  test("traverses inbound, outbound, or both directions to a bounded depth", () => {
    expect(navigateLinks(notes, analysis, notes[1]!, { direction: "in" }).nodes.map(({ path }) => path))
      .toEqual(["notes/b.md", "notes/a.md", "notes/d.md"]);
    expect(navigateLinks(notes, analysis, notes[1]!, { direction: "out" }).nodes.map(({ path }) => path))
      .toEqual(["notes/b.md", "notes/c.md"]);
    expect(navigateLinks(notes, analysis, notes[1]!, { direction: "both", depth: 2 }).nodes)
      .toEqual([
        expect.objectContaining({ path: "notes/b.md", distance: 0 }),
        expect.objectContaining({ path: "notes/a.md", distance: 1 }),
        expect.objectContaining({ path: "notes/c.md", distance: 1 }),
        expect.objectContaining({ path: "notes/d.md", distance: 1 }),
      ]);
  });

  test("deduplicates cycles and returns only edges encountered within the traversal", () => {
    const neighborhood = navigateLinks(notes, analysis, notes[0]!, { direction: "out", depth: 3 });
    expect(neighborhood.nodes.map(({ path, distance }) => ({ path, distance }))).toEqual([
      { path: "notes/a.md", distance: 0 },
      { path: "notes/b.md", distance: 1 },
      { path: "notes/c.md", distance: 2 },
    ]);
    expect(neighborhood.edges).toHaveLength(3);
  });

  test("rejects unbounded depths", () => {
    expect(() => navigateLinks(notes, analysis, notes[0]!, { depth: 0 })).toThrow("1 through 10");
    expect(() => navigateLinks(notes, analysis, notes[0]!, { depth: 11 })).toThrow("1 through 10");
  });

  test("caps high-degree neighborhoods deterministically and reports truncation", () => {
    const hub = parseNote(
      "notes/hub.md",
      `# Hub\n\n${Array.from({ length: 100 }, (_, index) => `[[notes/leaf-${String(index).padStart(3, "0")}]]`).join("\n")}\n`,
    );
    const leaves = Array.from({ length: 100 }, (_, index) =>
      parseNote(`notes/leaf-${String(index).padStart(3, "0")}.md`, `# Leaf ${index}\n`));
    const crowded = [hub, ...leaves];
    const neighborhood = navigateLinks(crowded, analyzeVault(crowded), hub, {
      direction: "out",
      depth: 1,
      limit: 5,
    });

    expect(neighborhood.truncated).toBeTrue();
    expect(neighborhood.limit).toBe(5);
    expect(neighborhood.nodes.map(({ path }) => path)).toEqual([
      "notes/hub.md",
      "notes/leaf-000.md",
      "notes/leaf-001.md",
      "notes/leaf-002.md",
      "notes/leaf-003.md",
    ]);
    expect(neighborhood.edges).toHaveLength(4);
    expect(() => navigateLinks(crowded, analyzeVault(crowded), hub, { limit: 0 }))
      .toThrow("1 through 1000");
  });

  test("traverses authored relation cycles without changing wikilink edge results", () => {
    const related = [
      parseNote("concepts/a.md", [
        "---",
        "relations:",
        "  supports: concepts/b",
        "---",
        "# A",
      ].join("\n")),
      parseNote("concepts/b.md", [
        "---",
        "relations:",
        "  supports: concepts/c",
        "---",
        "# B",
      ].join("\n")),
      parseNote("concepts/c.md", [
        "---",
        "relations:",
        "  supports: concepts/a",
        "---",
        "# C",
      ].join("\n")),
    ];
    const relationAnalysis = analyzeVault(related);
    const neighborhood = navigateLinks(
      related,
      relationAnalysis,
      related[0]!,
      { direction: "out", depth: 3 },
    );

    expect(neighborhood.nodes.map(({ path, distance }) => ({ path, distance }))).toEqual([
      { path: "concepts/a.md", distance: 0 },
      { path: "concepts/b.md", distance: 1 },
      { path: "concepts/c.md", distance: 2 },
    ]);
    expect(neighborhood.edges).toEqual([]);
    expect(neighborhood.relations.map(({ source, target, predicate }) => ({
      source,
      target,
      predicate,
    }))).toEqual([
      { source: "concepts/a", target: "concepts/b", predicate: "supports" },
      { source: "concepts/b", target: "concepts/c", predicate: "supports" },
      { source: "concepts/c", target: "concepts/a", predicate: "supports" },
    ]);
  });

  test("returns typed and wikilink edges separately while traversing both", () => {
    const mixed = [
      parseNote("notes/a.md", [
        "---",
        "relations:",
        "  supports: notes/c",
        "---",
        "# A",
        "",
        "[[notes/b]]",
      ].join("\n")),
      parseNote("notes/b.md", "# B\n"),
      parseNote("notes/c.md", "# C\n"),
    ];
    const mixedAnalysis = analyzeVault(mixed);
    const neighborhood = navigateLinks(mixed, mixedAnalysis, mixed[0]!, {
      direction: "out",
      depth: 1,
    });

    expect(neighborhood.nodes.map(({ path }) => path)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes/c.md",
    ]);
    expect(neighborhood.edges).toEqual([
      { source: "notes/a.md", target: "notes/b.md", line: 7 },
    ]);
    expect(neighborhood.relations).toEqual(mixedAnalysis.authoredRelations);
    expect(neighborhood.nodes[0]).toMatchObject({
      inboundRelationCount: 0,
      outboundRelationCount: 1,
    });
  });

  test("bounds parallel predicates with the square of the node limit after deterministic sorting", () => {
    const predicateCount = 24;
    const related = [
      parseNote("notes/a.md", [
        "---",
        "relations:",
        ...Array.from(
          { length: predicateCount },
          (_, index) => `  predicate-${String(index).padStart(3, "0")}: notes/b`,
        ),
        "---",
        "# A",
        "",
        "[[notes/b]]",
      ].join("\n")),
      parseNote("notes/b.md", "# B\n"),
    ];
    const forwardAnalysis = analyzeVault(related);
    const reversedAnalysis = {
      ...forwardAnalysis,
      contextualLinks: forwardAnalysis.contextualLinks.toReversed(),
      authoredRelations: forwardAnalysis.authoredRelations.toReversed(),
    };
    const eligibleConnectionCount = forwardAnalysis.contextualLinks.length
      + forwardAnalysis.authoredRelations.length;

    for (const limit of [2, 3, 4, 5, 7]) {
      const neighborhood = navigateLinks(related, reversedAnalysis, related[0]!, {
        direction: "out",
        depth: 1,
        limit,
      });
      const expectedConnectionCount = Math.min(
        eligibleConnectionCount,
        MAX_NAVIGATION_RETURNED_CONNECTIONS,
        limit ** 2,
      );

      expect(neighborhood.nodes.map(({ path }) => path)).toEqual([
        "notes/a.md",
        "notes/b.md",
      ]);
      expect(neighborhood.edges.length + neighborhood.relations.length)
        .toBe(expectedConnectionCount);
      expect(neighborhood.truncated).toBe(eligibleConnectionCount > expectedConnectionCount);
    }

    const limited = navigateLinks(related, reversedAnalysis, related[0]!, {
      direction: "out",
      depth: 1,
      limit: 2,
    });
    const forwardLimited = navigateLinks(related, forwardAnalysis, related[0]!, {
      direction: "out",
      depth: 1,
      limit: 2,
    });
    expect(limited.edges).toEqual(forwardLimited.edges);
    expect(limited.relations).toEqual(forwardLimited.relations);
    expect(limited.edges).toHaveLength(1);
    expect(limited.relations.map(({ predicate }) => predicate)).toEqual([
      "predicate-000",
      "predicate-001",
      "predicate-002",
    ]);
    expect(limited.truncated).toBeTrue();
  });

  test("applies the hard combined connection result ceiling", () => {
    const related = [
      parseNote("notes/a.md", [
        "---",
        "relations:",
        "  supports: notes/b",
        "---",
        "# A",
        "",
        "[[notes/b]]",
      ].join("\n")),
      parseNote("notes/b.md", "# B\n"),
    ];
    const baseline = analyzeVault(related);
    const template = baseline.authoredRelations[0]!;
    const authoredRelations = Array.from(
      { length: MAX_NAVIGATION_RETURNED_CONNECTIONS + 1 },
      (_, index) => ({
        ...template,
        predicate: `predicate-${String(index).padStart(5, "0")}`,
      }),
    );
    const neighborhood = navigateLinks(
      related,
      { ...baseline, authoredRelations },
      related[0]!,
      { direction: "out", depth: 1, limit: 1_000 },
    );

    expect(neighborhood.edges.length + neighborhood.relations.length)
      .toBe(MAX_NAVIGATION_RETURNED_CONNECTIONS);
    expect(neighborhood.truncated).toBeTrue();
  });

  test("rejects oversized combined connection inputs before indexing them", () => {
    const related = [
      parseNote("notes/a.md", "# A\n\n[[notes/b]]\n"),
      parseNote("notes/b.md", "# B\n"),
    ];
    const baseline = analyzeVault(related);
    const template = baseline.contextualLinks[0]!;
    let indexingStarted = false;
    const contextualLinks = new Proxy(
      Array.from(
        { length: MAX_NAVIGATION_INDEXED_CONNECTIONS + 1 },
        () => template,
      ),
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) indexingStarted = true;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    let thrown: unknown;

    try {
      navigateLinks(
        related,
        { ...baseline, contextualLinks, authoredRelations: [] },
        related[0]!,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NavigationBudgetError);
    expect(thrown).toMatchObject({
      kind: "connection-work-limit",
      limit: MAX_NAVIGATION_INDEXED_CONNECTIONS,
    });
    expect(indexingStarted).toBeFalse();
  });
});
