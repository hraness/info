import { describe, expect, test } from "bun:test";

import {
  buildDatalogSnapshot,
  datalogWorkerUrl,
  DatalogBudgetError,
  MAX_DATALOG_FACTS,
  MAX_DATALOG_INPUT_BYTES,
  MAX_DATALOG_INPUT_VALUES,
  MAX_DATALOG_RESULT_BYTES,
  MAX_DATALOG_RESULT_VALUES,
  MAX_DATALOG_SCALAR_BYTES,
  MAX_DATALOG_SNAPSHOT_BYTES,
  queryDatalog,
  type DatalogSnapshot,
} from "./datalog.js";
import { noteFactEntityId } from "./facts.js";
import { analyzeVault, parseNote } from "./graph.js";

function fixture() {
  const notes = [
    parseNote("notes/a.md", [
      "---",
      "tags: [ai]",
      "priority: 3",
      "owner:",
      "  name: Alice",
      "---",
      "# Alpha",
      "",
      "[[notes/b]]",
    ].join("\n")),
    parseNote("notes/b.md", [
      "---",
      "tags: [ai]",
      "---",
      "# Beta",
      "",
      "[[notes/c]]",
    ].join("\n")),
    parseNote("notes/c.md", "# Gamma\n"),
  ];
  return { notes, analysis: analyzeVault(notes) };
}

describe("DataScript boundary", () => {
  test("resolves the source and built query subprocess beside the adapter", () => {
    expect(datalogWorkerUrl("file:///project/src/datalog.ts").href).toBe(
      "file:///project/src/datalog-worker.ts",
    );
    expect(datalogWorkerUrl("file:///project/dist/datalog.js").href).toBe(
      "file:///project/dist/datalog-worker.js",
    );
  });

  test("supports joins, inputs, aggregates, and scalar metadata leaves", async () => {
    const { notes, analysis } = fixture();
    const result = await queryDatalog({
      notes,
      analysis,
      query: [
        "[:find ?id ?owner",
        " :in $ ?tag",
        " :where",
        " [?note :note/id ?id]",
        " [?note :note/tag ?tag]",
        " [?metadata :metadata/note ?note]",
        ' [?metadata :metadata/path "/owner/name"]',
        " [?metadata :metadata/value ?owner]]",
      ].join(""),
      inputs: ["ai"],
    });

    expect(result.columns).toEqual(["?id", "?owner"]);
    expect(result.rows).toEqual([["notes/a", "Alice"]]);
    expect(result.truncated).toBe(false);
    expect(result.factCount).toBeGreaterThan(0);

    const aggregate = await queryDatalog({
      snapshot: buildDatalogSnapshot(notes, analysis),
      query: '[:find (count ?note) :where [?note ":note/tag" "ai"]]',
    });
    expect(aggregate).toMatchObject({
      columns: ["(count ?note)"],
      rows: [[2]],
      truncated: false,
    });

    const numeric = await queryDatalog({
      notes,
      analysis,
      query: [
        "[:find ?value",
        " :where",
        ' [?metadata ":metadata/path" "/priority"]',
        ' [?metadata ":metadata/value" ?value]]',
      ].join(""),
    });
    expect(numeric.rows).toEqual([[3]]);
  });

  test("distinguishes an authored null scalar from no matching scalar row", async () => {
    const snapshot: DatalogSnapshot = {
      version: 1,
      facts: [{
        kind: "scalar",
        entity: "metadata:authored-null",
        attribute: ":metadata/value",
        value: null,
      }],
      factCount: 1,
    };
    const authoredNull = await queryDatalog(snapshot, {
      query: [
        "[:find ?value",
        " ; the scalar marker is intentionally separated by a comment\n",
        " . :where [?entity :metadata/value ?value]]",
      ].join(""),
    });
    const noRow = await queryDatalog(snapshot, {
      query: '[:find ?value . :where [?entity ":note/id" ?value]]',
    });

    expect(authoredNull).toMatchObject({
      columns: ["?value"],
      rows: [[null]],
      truncated: false,
    });
    expect(noRow).toMatchObject({
      columns: ["?value"],
      rows: [],
      truncated: false,
    });
  });

  test("evaluates recursive EDN rules and returns stable semantic references", async () => {
    const { notes, analysis } = fixture();
    const rules = [
      "[",
      " [(direct ?source ?target)",
      '  [?edge :edge/kind "wikilink"]',
      "  [?edge :edge/source ?source]",
      "  [?edge :edge/target ?target]]",
      " [(reachable ?source ?target)",
      "  (direct ?source ?target)]",
      " [(reachable ?source ?target)",
      "  (direct ?source ?middle)",
      "  (reachable ?middle ?target)]",
      "]",
    ].join("");
    const result = await queryDatalog({
      notes,
      analysis,
      query: "[:find ?source ?target :in $ % :where (reachable ?source ?target)]",
      rules,
    });

    expect(result.rows).toEqual([
      [noteFactEntityId("notes/a"), noteFactEntityId("notes/b")],
      [noteFactEntityId("notes/a"), noteFactEntityId("notes/c")],
      [noteFactEntityId("notes/b"), noteFactEntityId("notes/c")],
    ]);
    expect(result.rows.flat().every((value) => typeof value === "string")).toBe(
      true,
    );
  });

  test("bounds recursive relation paths across concept cycles", async () => {
    const notes = [
      parseNote("concepts/a.md", [
        "---",
        "type: concept",
        "relations:",
        "  supports:",
        "    - concepts/b",
        "---",
        "# A",
      ].join("\n")),
      parseNote("concepts/b.md", [
        "---",
        "type: concept",
        "relations:",
        "  supports:",
        "    - concepts/a",
        "---",
        "# B",
      ].join("\n")),
    ];
    const rules = [
      "[",
      " [(direct ?source ?target)",
      '  [?edge :edge/kind "relation"]',
      '  [?edge :edge/predicate "supports"]',
      "  [?edge :edge/source ?source]",
      "  [?edge :edge/target ?target]]",
      " [(reachable ?source ?target ?remaining)",
      "  [(> ?remaining 0)]",
      "  (direct ?source ?target)]",
      " [(reachable ?source ?target ?remaining)",
      "  [(> ?remaining 1)]",
      "  [(- ?remaining 1) ?next]",
      "  (direct ?source ?middle)",
      "  (reachable ?middle ?target ?next)]",
      "]",
    ].join("");
    const result = await queryDatalog({
      notes,
      analysis: analyzeVault(notes),
      query: [
        "[:find ?source-id ?target-id",
        " :in $ % ?depth",
        " :where",
        " (reachable ?source ?target ?depth)",
        " [?source :note/concept true]",
        " [?target :note/concept true]",
        " [?source :note/id ?source-id]",
        " [?target :note/id ?target-id]]",
      ].join(""),
      rules,
      inputs: [2],
      timeoutMs: 1_000,
    });

    expect(result.rows).toEqual([
      ["concepts/a", "concepts/a"],
      ["concepts/a", "concepts/b"],
      ["concepts/b", "concepts/a"],
      ["concepts/b", "concepts/b"],
    ]);
    expect(result.truncated).toBe(false);
  });

  test("matches the canonical contextual link graph", async () => {
    const { notes, analysis } = fixture();
    const result = await queryDatalog({
      notes,
      analysis,
      query: [
        "[:find ?source ?target",
        " :where",
        ' [?edge ":edge/kind" "wikilink"]',
        ' [?edge ":edge/source" ?source]',
        ' [?edge ":edge/target" ?target]]',
      ].join(""),
    });
    const expected = analysis.contextualLinks.map((link) => [
      noteFactEntityId(link.source.slice(0, -3)),
      noteFactEntityId(link.target.slice(0, -3)),
    ]);

    expect(result.rows).toEqual(expected);
  });

  test("sorts before applying the caller-visible result limit", async () => {
    const { notes, analysis } = fixture();
    const result = await queryDatalog({
      notes: [...notes].reverse(),
      analysis,
      query: '[:find ?id :where [?note ":note/id" ?id]]',
      limit: 2,
    });

    expect(result.rows).toEqual([["notes/a"], ["notes/b"]]);
    expect(result.truncated).toBe(true);
    try {
      await queryDatalog({
        notes,
        analysis,
        query: '[:find ?id :where [?note ":note/id" ?id]]',
        limit: 1_001,
      });
      throw new Error("invalid Datalog limit unexpectedly completed");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("from 0 to 1000");
    }

    const numericNotes = [
      parseNote("notes/ten.md", "---\npriority: 10\n---\n# Ten\n"),
      parseNote("notes/two.md", "---\npriority: 2\n---\n# Two\n"),
    ];
    expect((await queryDatalog({
      notes: numericNotes,
      analysis: analyzeVault(numericNotes),
      query: [
        "[:find ?value",
        " :where",
        ' [?metadata ":metadata/path" "/priority"]',
        ' [?metadata ":metadata/value" ?value]]',
      ].join(""),
    })).rows).toEqual([[2], [10]]);
  });

  test("rejects non-scalar foreign results and forged facts at the boundary", async () => {
    const { notes, analysis } = fixture();
    const snapshot = buildDatalogSnapshot(notes, analysis);
    const forged = {
      version: 1,
      factCount: 1,
      facts: [{
        kind: "scalar",
        entity: "note:forged",
        attribute: ":note/id",
        value: { engine: "object" },
      }],
    } as unknown as DatalogSnapshot;

    try {
      await queryDatalog(forged, {
        query: '[:find ?id :where [?note ":note/id" ?id]]',
      });
      throw new Error("forged Datalog snapshot unexpectedly completed");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("owned Datalog scalar");
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.facts)).toBe(true);
  });

  test("rejects oversized snapshots and inputs before enumerating them", async () => {
    const sentinel = new Error("oversized collection was enumerated");
    const neverEnumerate = <T extends unknown[]>(value: T): T =>
      new Proxy(value, {
        ownKeys: () => {
          throw sentinel;
        },
      });
    const query = '[:find ?id :where [?note ":note/id" ?id]]';

    for (const snapshot of [
      {
        version: 1,
        factCount: MAX_DATALOG_FACTS + 1,
        facts: neverEnumerate([]),
      },
      {
        version: 1,
        factCount: 0,
        facts: neverEnumerate(new Array(MAX_DATALOG_FACTS + 1)),
      },
    ]) {
      try {
        await queryDatalog(snapshot as unknown as DatalogSnapshot, { query });
        throw new Error("oversized Datalog snapshot unexpectedly completed");
      } catch (error) {
        expect(error).not.toBe(sentinel);
        expect(error).toBeInstanceOf(DatalogBudgetError);
        expect(error).toMatchObject({
          kind: "fact-limit",
          limit: MAX_DATALOG_FACTS,
        });
      }
    }

    const { notes, analysis } = fixture();
    try {
      await queryDatalog({
        notes,
        analysis,
        query: "[:find ?input :in $ ?input :where]",
        inputs: neverEnumerate(new Array(MAX_DATALOG_INPUT_VALUES + 1)),
      });
      throw new Error("oversized Datalog inputs unexpectedly completed");
    } catch (error) {
      expect(error).not.toBe(sentinel);
      expect(error).toBeInstanceOf(RangeError);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain(
        `${MAX_DATALOG_INPUT_VALUES} value limit`,
      );
    }
  });

  test("bounds per-scalar and cumulative UTF-8 bytes before relation IPC", async () => {
    const query = '[:find ?id :where [?note ":note/id" ?id]]';
    const multibyteOversize = "\u{1f9e0}".repeat(
      Math.floor(MAX_DATALOG_SCALAR_BYTES / 4) + 1,
    );
    const scalarAtLimit = "a".repeat(MAX_DATALOG_SCALAR_BYTES);
    const sentinel = new Error("snapshot was enumerated before input preflight");
    const unenumerableEmptyFacts = new Proxy([], {
      ownKeys: () => {
        throw sentinel;
      },
    });

    const cases: readonly {
      readonly expectedKind: "input-byte-limit" | "snapshot-byte-limit";
      readonly expectedLimit: number;
      readonly run: () => Promise<unknown>;
    }[] = [
      {
        expectedKind: "snapshot-byte-limit",
        expectedLimit: MAX_DATALOG_SCALAR_BYTES,
        run: () => Promise.resolve().then(() => {
          const notes = [parseNote(
            "notes/large.md",
            `# ${multibyteOversize}\n`,
          )];
          return buildDatalogSnapshot(notes, analyzeVault(notes));
        }),
      },
      {
        expectedKind: "snapshot-byte-limit",
        expectedLimit: MAX_DATALOG_SCALAR_BYTES,
        run: () => queryDatalog({
          version: 1,
          factCount: 1,
          facts: [{
            kind: "scalar",
            entity: "note:large",
            attribute: ":note/id",
            value: multibyteOversize,
          }],
        }, { query }),
      },
      {
        expectedKind: "snapshot-byte-limit",
        expectedLimit: MAX_DATALOG_SNAPSHOT_BYTES,
        run: () => {
          const count = Math.floor(
            MAX_DATALOG_SNAPSHOT_BYTES / MAX_DATALOG_SCALAR_BYTES,
          ) + 1;
          const facts = Array.from({ length: count }, () => ({
            kind: "scalar" as const,
            entity: "note:large",
            attribute: ":note/id" as const,
            value: scalarAtLimit,
          }));
          return queryDatalog({
            version: 1,
            facts,
            factCount: facts.length,
          }, { query });
        },
      },
      {
        expectedKind: "input-byte-limit",
        expectedLimit: MAX_DATALOG_SCALAR_BYTES,
        run: () => queryDatalog({
          version: 1,
          factCount: 0,
          facts: unenumerableEmptyFacts,
        } as unknown as DatalogSnapshot, {
          query: "[:find ?input . :in $ ?input :where]",
          inputs: [multibyteOversize],
        }),
      },
      {
        expectedKind: "input-byte-limit",
        expectedLimit: MAX_DATALOG_INPUT_BYTES,
        run: () => queryDatalog({
          version: 1,
          factCount: 0,
          facts: unenumerableEmptyFacts,
        } as unknown as DatalogSnapshot, {
          query: "[:find [?input ...] :in $ [?input ...] :where]",
          inputs: [Array.from(
            {
              length: Math.floor(
                MAX_DATALOG_INPUT_BYTES / MAX_DATALOG_SCALAR_BYTES,
              ) + 1,
            },
            () => scalarAtLimit,
          )],
        }),
      },
    ];

    for (const candidate of cases) {
      try {
        await candidate.run();
        throw new Error("oversized Datalog byte payload unexpectedly completed");
      } catch (error) {
        expect(error).not.toBe(sentinel);
        expect(error).toBeInstanceOf(DatalogBudgetError);
        expect(error).toMatchObject({
          kind: candidate.expectedKind,
          limit: candidate.expectedLimit,
        });
      }
    }
  });

  test("terminates a Cartesian result explosion at the subprocess deadline", async () => {
    const facts = Array.from({ length: 400 }, (_, index) => ({
      kind: "scalar" as const,
      entity: `note:n-${index}`,
      attribute: ":note/id" as const,
      value: `n-${index}`,
    }));
    const snapshot: DatalogSnapshot = {
      version: 1,
      facts,
      factCount: facts.length,
    };
    const started = performance.now();

    try {
      await queryDatalog(snapshot, {
        query: [
          "[:find ?left ?right",
          " :where",
          " [?left-note :note/id ?left]",
          " [?right-note :note/id ?right]]",
        ].join(""),
        timeoutMs: 50,
      });
      throw new Error("Cartesian query unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(DatalogBudgetError);
      expect(error).toMatchObject({ kind: "timeout", limit: 50 });
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("execution deadline");
    }
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("reports the post-evaluation row threshold as a structured budget error", async () => {
    const facts = Array.from({ length: 101 }, (_, index) => ({
      kind: "scalar" as const,
      entity: `note:n-${index}`,
      attribute: ":note/id" as const,
      value: `n-${index}`,
    }));
    const snapshot: DatalogSnapshot = {
      version: 1,
      facts,
      factCount: facts.length,
    };

    try {
      await queryDatalog(snapshot, {
        query: [
          "[:find ?left ?right",
          " :where",
          " [?left-note :note/id ?left]",
          " [?right-note :note/id ?right]]",
        ].join(""),
      });
      throw new Error("oversized Datalog result unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(DatalogBudgetError);
      expect(error).toMatchObject({
        kind: "result-limit",
        limit: 10_000,
      });
    }
  });

  test("rejects per-scalar and cumulative result bytes before subprocess IPC", async () => {
    const oversizedScalar = "\u{1f9e0}".repeat(
      Math.floor(MAX_DATALOG_SCALAR_BYTES / 4) + 1,
    );
    try {
      await queryDatalog({
        version: 1,
        facts: [{
          kind: "scalar",
          entity: "note:anchor",
          attribute: ":note/id",
          value: "anchor",
        }],
        factCount: 1,
      }, {
        query: [
          "[:find ?value . :where [?note :note/id ?id]",
          ` [(identity ${JSON.stringify(oversizedScalar)}) ?value]]`,
        ].join(""),
      });
      throw new Error("oversized Datalog result scalar unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(DatalogBudgetError);
      expect(error).toMatchObject({
        kind: "result-byte-limit",
        limit: MAX_DATALOG_SCALAR_BYTES,
      });
    }

    const largeValue = "v".repeat(MAX_DATALOG_SCALAR_BYTES);
    const rowCount = Math.floor(
      MAX_DATALOG_RESULT_BYTES / MAX_DATALOG_SCALAR_BYTES,
    ) + 1;
    const facts = Array.from({ length: rowCount }, (_, index) => [
      {
        kind: "scalar" as const,
        entity: `note:n-${index}`,
        attribute: ":note/id" as const,
        value: `n-${index}`,
      },
      {
        kind: "scalar" as const,
        entity: `note:n-${index}`,
        attribute: ":metadata/value" as const,
        value: largeValue,
      },
    ]).flat();

    try {
      await queryDatalog({ version: 1, facts, factCount: facts.length }, {
        query: [
          "[:find ?id ?value",
          " :where",
          " [?note :note/id ?id]",
          " [?note :metadata/value ?value]]",
        ].join(""),
      });
      throw new Error("oversized Datalog result bytes unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(DatalogBudgetError);
      expect(error).toMatchObject({
        kind: "result-byte-limit",
        limit: MAX_DATALOG_RESULT_BYTES,
      });
    }
  });

  test("bounds cumulative result values independently of row count", async () => {
    const rowCount = 1_000;
    const columnCount = Math.floor(
      MAX_DATALOG_RESULT_VALUES / rowCount,
    ) + 1;
    const facts = Array.from({ length: rowCount }, (_, index) => ({
      kind: "scalar" as const,
      entity: `note:n-${index}`,
      attribute: ":note/id" as const,
      value: `n-${index}`,
    }));

    try {
      await queryDatalog({ version: 1, facts, factCount: facts.length }, {
        query: [
          `[:find ${Array.from({ length: columnCount }, () => "?id").join(" ")}`,
          " :where [?note :note/id ?id]]",
        ].join(""),
      });
      throw new Error("oversized Datalog result values unexpectedly completed");
    } catch (error) {
      expect(error).toBeInstanceOf(DatalogBudgetError);
      expect(error).toMatchObject({
        kind: "result-value-limit",
        limit: MAX_DATALOG_RESULT_VALUES,
      });
    }
  });
});
