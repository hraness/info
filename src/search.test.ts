import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { analyzeVault, parseNote } from "./graph.js";
import {
  buildGraphContext,
  fuseRankedCandidates,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_QUERY_TERMS,
  searchExactVault,
  validateSearchQuery,
} from "./search.js";

function fixture() {
  const notes = [
    parseNote("notes/write-path.md", [
      "---",
      "title: Durable write path",
      "aliases: [Agent memory]",
      "tags: [agents, retrieval]",
      "status: current",
      "repository_scopes: [packages/kb]",
      "relations:",
      "  supports: notes/evidence",
      "---",
      "# Durable write path",
      "",
      "A coding agent writes durable memory before the chat disappears.",
      "",
      "See [[notes/shared-context]].",
    ].join("\n")),
    parseNote("notes/repository-context.md", [
      "---",
      "tags: [agents, context]",
      "status: current",
      "repository_scopes: [packages/KB]",
      "---",
      "# Repository context",
      "",
      "Repository guides route an agent to current rationale.",
      "",
      "See [[notes/shared-context]] and [[notes/secondary]].",
    ].join("\n")),
    parseNote("notes/shared-context.md", [
      "---",
      "type: concept",
      "tags: [context]",
      "---",
      "# Shared context",
      "",
      "Shared evidence links repository work to durable memory.",
    ].join("\n")),
    parseNote("notes/evidence.md", "# Evidence\n\nReviewed source material.\n"),
    parseNote("notes/secondary.md", "# Secondary\n\nA weaker neighbor.\n"),
  ];
  return { notes, analysis: analyzeVault(notes) };
}

describe("live exact search", () => {
  test("pins note identities and returns line-oriented live Markdown evidence", () => {
    const { notes, analysis } = fixture();
    const identity = searchExactVault(notes, analysis, {
      query: "Agent memory",
    });
    expect(identity[0]).toMatchObject({ id: "notes/write-path", identity: true });
    expect(identity[0]?.matches).toContainEqual({
      kind: "identity",
      field: "alias",
      value: "Agent memory",
    });

    const prose = searchExactVault(notes, analysis, {
      query: "chat disappears",
    });
    expect(prose[0]).toMatchObject({
      id: "notes/write-path",
      identity: false,
      line: 12,
    });
    expect(prose[0]?.snippet).toContain("chat disappears");
  });

  test("maps normalized Unicode matches back to the original Markdown line", () => {
    const notes = [
      parseNote("notes/unicode.md", "# Unicode\n\ne\u0301\nneedle\n"),
    ];
    const results = searchExactVault(notes, analyzeVault(notes), {
      query: "needle",
    });
    expect(results[0]).toMatchObject({
      id: "notes/unicode",
      line: 4,
    });
    expect(results[0]?.snippet).toContain("needle");
  });

  test("applies authored metadata and tag filters before ranking", () => {
    const { notes, analysis } = fixture();
    const results = searchExactVault(notes, analysis, {
      query: "agent",
      tags: ["retrieval"],
      filters: [{ kind: "equals", path: "status", value: "current" }],
    });
    expect(results.map(({ id }) => id)).toEqual(["notes/write-path"]);
  });

  test("applies exact repository-scope filtering before ranking", () => {
    const { notes, analysis } = fixture();
    expect(searchExactVault(notes, analysis, {
      query: "agent",
      repositoryScopes: ["packages/kb"],
    }).map(({ id }) => id)).toEqual(["notes/write-path"]);
    expect(searchExactVault(notes, analysis, {
      query: "agent",
      repositoryScopes: ["packages/KB"],
    }).map(({ id }) => id)).toEqual(["notes/repository-context"]);
    expect(() => searchExactVault(notes, analysis, {
      query: "agent",
      repositoryScopes: ["packages//kb"],
    })).toThrow("exact NFC-normalized POSIX form");
  });

  test("requires useful query coverage and does not reward repetition in long notes", () => {
    const notes = [
      parseNote(
        "notes/focused.md",
        "# Focused\n\nAgent memory survives a conversation and remains available later.\n",
      ),
      parseNote(
        "notes/repetitive.md",
        `# Repetitive\n\n${"agent ".repeat(200)}\n`,
      ),
    ];
    const results = searchExactVault(notes, analyzeVault(notes), {
      query: "memory survives agent conversation",
    });
    expect(results.map(({ id }) => id)).toEqual(["notes/focused"]);
  });

  test("rejects empty queries and unbounded result requests", () => {
    const { notes, analysis } = fixture();
    expect(() => searchExactVault(notes, analysis, { query: " " }))
      .toThrow("must not be empty");
    expect(() => searchExactVault(notes, analysis, { query: "memory", limit: 501 }))
      .toThrow("1 through 500");
  });

  test("bounds UTF-8 query bytes and unique normalized terms before scanning notes", () => {
    expect(validateSearchQuery("  CAFÉ cafe\u0301  ")).toEqual({
      query: "CAFÉ cafe\u0301",
      normalized: "café café",
      terms: ["café"],
    });

    let noteReads = 0;
    const unreadNotes = new Proxy([] as ReturnType<typeof fixture>["notes"], {
      get(target, property, receiver): unknown {
        noteReads += 1;
        const reflected: unknown = Reflect.get(target, property, receiver);
        return reflected;
      },
    });
    expect(() => searchExactVault(unreadNotes, analyzeVault([]), {
      query: "🧠".repeat(Math.floor(MAX_SEARCH_QUERY_BYTES / 4) + 1),
    })).toThrow(`${MAX_SEARCH_QUERY_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    expect(() => validateSearchQuery(
      Array.from({ length: MAX_SEARCH_QUERY_TERMS + 1 }, (_, index) => `term${index}`).join(" "),
    )).toThrow(`${MAX_SEARCH_QUERY_TERMS} unique normalized terms`);
    expect(noteReads).toBe(0);
  });
});

describe("rank fusion", () => {
  test("combines incomparable lanes by rank with stable explanations", () => {
    const fused = fuseRankedCandidates([
      { name: "exact", weight: 2, ids: ["a", "b", "b"] },
      { name: "text", weight: 1, ids: ["b", "c"] },
    ]);
    expect(fused.map(({ id }) => id)).toEqual(["b", "a", "c"]);
    expect(fused[0]).toMatchObject({
      id: "b",
      rank: 1,
      contributions: [
        expect.objectContaining({ lane: "exact", rank: 2, weight: 2 }),
        expect.objectContaining({ lane: "text", rank: 1, weight: 1 }),
      ],
    });
    expect(fused.every(({ score }) => score > 0 && score <= 1)).toBeTrue();
  });

  test("validates lane identities, weights, and the reciprocal-rank constant", () => {
    expect(() => fuseRankedCandidates([])).toThrow("from 1 through");
    expect(() => fuseRankedCandidates([
      { name: "same", weight: 1, ids: [] },
      { name: "same", weight: 1, ids: [] },
    ])).toThrow("unique");
    expect(() => fuseRankedCandidates([
      { name: "bad", weight: 0, ids: [] },
    ])).toThrow("weights");
    expect(() => fuseRankedCandidates([
      { name: "ok", weight: 1, ids: [] },
    ], 0)).toThrow("Fusion k");
  });

  test("preserves single-lane order and bounded unique ranks for arbitrary IDs", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), { maxLength: 100 }),
      (ids) => {
        const fused = fuseRankedCandidates([{ name: "exact", weight: 2, ids }]);
        expect(fused.map(({ id }) => id)).toEqual(ids);
        expect(fused.map(({ rank }) => rank)).toEqual(ids.map((_, index) => index + 1));
        expect(fused.every(({ score }) => score > 0 && score <= 1)).toBeTrue();
      },
    ));
  });

  test("is independent of lane declaration order", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), { maxLength: 40 }),
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), { maxLength: 40 }),
      (exact, qmd) => {
        const forward = fuseRankedCandidates([
          { name: "exact", weight: 2, ids: exact },
          { name: "qmd", weight: 1, ids: qmd },
        ]);
        const reversed = fuseRankedCandidates([
          { name: "qmd", weight: 1, ids: qmd },
          { name: "exact", weight: 2, ids: exact },
        ]);
        expect(reversed).toEqual(forward);
      },
    ));
  });

  test("lets cross-lane agreement win and breaks equal-rank ties by canonical id", () => {
    const fused = fuseRankedCandidates([
      { name: "exact", weight: 1, ids: ["z-exact", "shared"] },
      { name: "qmd", weight: 1, ids: ["a-semantic", "shared"] },
    ]);
    expect(fused.map(({ id }) => id)).toEqual([
      "shared",
      "a-semantic",
      "z-exact",
    ]);
  });
});

describe("explicit graph context", () => {
  test("keeps graph-only neighbors separate and prioritizes shared or typed evidence", () => {
    const { notes, analysis } = fixture();
    const context = buildGraphContext(notes, analysis, {
      seeds: ["notes/write-path", "notes/repository-context"],
      primaryIds: ["notes/write-path", "notes/repository-context"],
      neighborsPerSeed: 3,
      limit: 3,
    });
    expect(context.seeds).toEqual([
      "notes/write-path",
      "notes/repository-context",
    ]);
    expect(context.related.map(({ id }) => id)).toEqual([
      "notes/shared-context",
      "notes/evidence",
      "notes/secondary",
    ]);
    expect(context.related[0]?.evidence.map(({ seed }) => seed)).toContainAllValues([
      "notes/write-path",
      "notes/repository-context",
    ]);
    expect(context.related[1]?.evidence[0]).toMatchObject({
      kind: "relation",
      predicate: "supports",
    });
    expect(context.related.some(({ id }) => id === "notes/write-path")).toBeFalse();
  });

  test("rejects missing and ambiguous seeds instead of returning incomplete context", () => {
    const notes = [
      parseNote("notes/one/shared.md", "# Shared one\n"),
      parseNote("notes/two/shared.md", "# Shared two\n"),
    ];
    const analysis = analyzeVault(notes);

    expect(() => buildGraphContext(notes, analysis, {
      seeds: ["missing"],
      primaryIds: [],
    })).toThrow('Graph context seed "missing" was not found.');
    expect(() => buildGraphContext(notes, analysis, {
      seeds: ["shared"],
      primaryIds: [],
    })).toThrow(
      'Graph context seed "shared" is ambiguous: notes/one/shared.md, notes/two/shared.md',
    );
  });

  test("returns authored connections among primary results", () => {
    const notes = [
      parseNote("notes/a.md", "# A\n\n[[notes/b]]\n"),
      parseNote("notes/b.md", "# B\n"),
    ];
    const context = buildGraphContext(notes, analyzeVault(notes), {
      seeds: ["notes/a"],
      primaryIds: ["notes/a", "notes/b"],
    });
    expect(context.linksAmongResults).toEqual([
      { source: "notes/a.md", target: "notes/b.md", line: 3 },
    ]);
    expect(context.related).toEqual([]);
  });

  test("budgets excluded primary nodes without hiding a later related neighbor", () => {
    const primaryIds = ["notes/seed"];
    const primaryLinks: string[] = [];
    const notes = [
      parseNote(
        "notes/seed.md",
        [
          "# Seed",
          "",
          ...Array.from({ length: 5 }, (_, index) => {
            const id = `notes/primary-${index}`;
            primaryIds.push(id);
            primaryLinks.push(`[[${id}]]`);
            return `[[${id}]]`;
          }),
          "[[notes/z-related]]",
        ].join("\n"),
      ),
      ...primaryLinks.map((_, index) =>
        parseNote(`notes/primary-${index}.md`, `# Primary ${index}\n`)),
      parseNote("notes/z-related.md", "# Related\n"),
    ];
    const context = buildGraphContext(notes, analyzeVault(notes), {
      seeds: ["notes/seed"],
      primaryIds,
      neighborsPerSeed: 1,
      limit: 1,
    });
    expect(context.related.map(({ id }) => id)).toEqual(["notes/z-related"]);
  });

  test("caps primary connections and per-result evidence", () => {
    const repeatedLinks = Array.from({ length: 250 }, () => "[[notes/b]]").join("\n");
    const notes = [
      parseNote("notes/a.md", `# A\n\n${repeatedLinks}\n`),
      parseNote("notes/b.md", "# B\n"),
    ];
    const baseAnalysis = analyzeVault(notes);
    const exemplar = baseAnalysis.contextualLinks[0];
    expect(exemplar).toBeDefined();
    const analysis = {
      ...baseAnalysis,
      contextualLinks: Array.from({ length: 250 }, (_, index) => ({
        ...exemplar!,
        line: index + 1,
      })),
    };
    const related = buildGraphContext(notes, analysis, {
      seeds: ["notes/a"],
      primaryIds: ["notes/a"],
    });
    expect(related.related[0]?.evidence).toHaveLength(40);
    expect(related.truncated).toBe(true);

    const primary = buildGraphContext(notes, analysis, {
      seeds: [],
      primaryIds: ["notes/a", "notes/b"],
    });
    expect(primary.linksAmongResults).toHaveLength(200);
    expect(primary.truncated).toBe(true);
  });
});
