import { describe, expect, test } from "bun:test";

import { analyzeVault, parseNote } from "./graph.js";
import {
  MAX_QUERY_FILTERS,
  MAX_QUERY_FILTER_VALUES,
  MAX_QUERY_METADATA_PATH_SEGMENTS,
  MAX_QUERY_METADATA_PATH_UTF8_BYTES,
  MAX_QUERY_ONE_OF_VALUES,
  MAX_QUERY_OPTIONS_UTF8_BYTES,
  MAX_QUERY_TAGS,
  MAX_QUERY_TEXT_UTF8_BYTES,
  metadataAtPath,
  queryVault,
  validateQueryOptions,
} from "./query.js";

function fixture() {
  const notes = [
    parseNote("index.md", "# Index\n\n[[notes/alpha]]\n"),
    parseNote("notes/alpha.md", [
      "---",
      "title: Alpha",
      "tags: [Knowledge, Tools]",
      "status: Active",
      "priority: 2",
      "owner:",
      "  name: Alice",
      "  teams: [Research, Platform]",
      "metrics:",
      "  score: 10",
      "repository_scopes: [packages/kb, packages/kb/src/query.ts]",
      "---",
      "# Alpha",
      "",
      "See [[notes/beta]].",
    ].join("\n")),
    parseNote("notes/beta.md", [
      "---",
      "title: beta",
      "tags:",
      "  - knowledge",
      "  - archive",
      "status: active",
      "priority: 1",
      "owner:",
      "  name: Bob",
      "  teams: [Operations]",
      "repository_scopes: [packages/KB]",
      "---",
      "# Beta",
      "",
      "See [[notes/gamma]].",
    ].join("\n")),
    parseNote("notes/gamma.md", [
      "---",
      "title: Gamma",
      "tags: [Archive]",
      "status: parked",
      "owner:",
      "  name: Alice",
      "  teams: [Platform]",
      "metrics:",
      "  score: 10",
      "---",
      "# Gamma",
    ].join("\n")),
  ];
  return { notes, analysis: analyzeVault(notes) };
}

describe("metadata lookup", () => {
  test("resolves nested fields, arrays, and unambiguous key casing", () => {
    const { notes } = fixture();
    const alpha = notes[1];
    if (alpha === undefined) throw new Error("fixture is missing Alpha");

    expect(metadataAtPath(alpha.metadata, "OWNER.name")).toEqual({
      found: true,
      value: "Alice",
    });
    expect(metadataAtPath(alpha.metadata, ["owner", "teams", "1"])).toEqual({
      found: true,
      value: "Platform",
    });
    expect(metadataAtPath(alpha.metadata, "owner.missing")).toEqual({ found: false });
    expect(metadataAtPath(alpha.metadata, "owner..name")).toEqual({ found: false });
  });

  test("preserves exact-key precedence while rejecting ambiguous normalized keys", () => {
    const metadata = { Owner: "Alice", owner: "Bob" };

    expect(metadataAtPath(metadata, "owner")).toEqual({ found: true, value: "Bob" });
    expect(metadataAtPath(metadata, "OWNER")).toEqual({ found: false });
  });
});

describe("vault metadata queries", () => {
  test("combines repeated nested filters and list membership case-insensitively", () => {
    const { notes, analysis } = fixture();
    const rows = queryVault(notes, analysis, {
      filters: [
        { kind: "equals", path: "owner.name", value: "ALICE" },
        { kind: "equals", path: "owner.teams", value: "platform" },
        { kind: "exists", path: "metrics.score" },
      ],
    });

    expect(rows.map(({ path }) => path)).toEqual(["notes/alpha.md", "notes/gamma.md"]);
  });

  test("supports bounded one-of filters without changing repeated-filter AND semantics", () => {
    const { notes, analysis } = fixture();
    expect(queryVault(notes, analysis, {
      filters: [
        { kind: "one-of", path: "status", values: ["parked", "ACTIVE"] },
        { kind: "one-of", path: "owner.name", values: ["Alice"] },
      ],
    }).map(({ path }) => path)).toEqual(["notes/alpha.md", "notes/gamma.md"]);

    expect(() => validateQueryOptions({
      filters: [{ kind: "one-of", path: "status", values: [] }],
    })).toThrow(`1 through ${MAX_QUERY_ONE_OF_VALUES}`);
    expect(() => validateQueryOptions({
      filters: [{
        kind: "one-of",
        path: "status",
        values: Array.from({ length: MAX_QUERY_ONE_OF_VALUES + 1 }, () => "active"),
      }],
    })).toThrow(`1 through ${MAX_QUERY_ONE_OF_VALUES}`);
    expect(() => validateQueryOptions({
      filters: [{
        kind: "one-of",
        path: "status",
        values: ["x".repeat(MAX_QUERY_TEXT_UTF8_BYTES + 1)],
      }],
    })).toThrow(`${MAX_QUERY_TEXT_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    const invalidOneOfValues: ("active" | null)[] = [];
    Reflect.set(invalidOneOfValues, 0, {});
    expect(() => validateQueryOptions({
      filters: [{
        kind: "one-of",
        path: "status",
        values: invalidOneOfValues,
      }],
    })).toThrow("must be a metadata scalar");
    expect(() => validateQueryOptions({
      filters: [{
        kind: "one-of",
        path: "status",
        values: Array.from(
          { length: Math.floor(MAX_QUERY_OPTIONS_UTF8_BYTES / MAX_QUERY_TEXT_UTF8_BYTES) + 1 },
          () => "x".repeat(MAX_QUERY_TEXT_UTF8_BYTES),
        ),
      }],
    })).toThrow(`${MAX_QUERY_OPTIONS_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    expect(() => validateQueryOptions({
      filters: Array.from(
        { length: Math.ceil(MAX_QUERY_FILTER_VALUES / MAX_QUERY_ONE_OF_VALUES) + 1 },
        () => ({
          kind: "one-of" as const,
          path: "status",
          values: Array.from({ length: MAX_QUERY_ONE_OF_VALUES }, () => "active"),
        }),
      ),
    })).toThrow(`at most ${MAX_QUERY_FILTER_VALUES} scalar values`);
  });

  test("filters repository scopes exactly and case-sensitively", () => {
    const { notes, analysis } = fixture();
    expect(queryVault(notes, analysis, { repositoryScopes: ["packages/kb"] })
      .map(({ path }) => path)).toEqual(["notes/alpha.md"]);
    expect(queryVault(notes, analysis, { repositoryScopes: ["packages/KB"] })
      .map(({ path }) => path)).toEqual(["notes/beta.md"]);
    expect(queryVault(notes, analysis, { repositoryScopes: ["packages/kb/src"] }))
      .toEqual([]);
    expect(() => validateQueryOptions({ repositoryScopes: ["packages//kb"] }))
      .toThrow("exact NFC-normalized POSIX form");
  });

  test("requires every repeated tag and enriches rows with graph counts", () => {
    const { notes, analysis } = fixture();
    const rows = queryVault(notes, analysis, { tags: ["#KNOWLEDGE", "tools"] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: "notes/alpha.md",
      tags: ["knowledge", "tools"],
      inboundContextualCount: 0,
      outboundContextualCount: 1,
      backlinks: [],
    });
  });

  test("sorts nested metadata in either direction while keeping missing values last", () => {
    const { notes, analysis } = fixture();

    expect(queryVault(notes, analysis, {
      sort: { kind: "metadata", path: "priority" },
    }).map(({ path }) => path)).toEqual([
      "notes/beta.md",
      "notes/alpha.md",
      "notes/gamma.md",
    ]);
    expect(queryVault(notes, analysis, {
      sort: { kind: "metadata", path: "priority" },
      direction: "desc",
    }).map(({ path }) => path)).toEqual([
      "notes/alpha.md",
      "notes/beta.md",
      "notes/gamma.md",
    ]);
  });

  test("supports stable built-in graph sorting and a bounded result", () => {
    const { notes, analysis } = fixture();
    const rows = queryVault(notes, analysis, {
      sort: { kind: "builtin", field: "inbound" },
      direction: "desc",
      limit: 2,
    });

    expect(rows.map(({ path }) => path)).toEqual(["notes/beta.md", "notes/gamma.md"]);
    expect(() => queryVault(notes, analysis, { limit: -1 })).toThrow(
      "non-negative safe integer",
    );
  });

  test("uses path as the deterministic tie-breaker for equal metadata values", () => {
    const first = parseNote("notes/zeta.md", "---\nrank: 1\n---\n# Zeta\n");
    const second = parseNote("notes/alpha.md", "---\nrank: 1\n---\n# Alpha\n");
    const missing = parseNote("notes/missing.md", "# Missing\n");
    const notes = [first, second, missing];
    const rows = queryVault(notes, analyzeVault(notes), {
      sort: { kind: "metadata", path: "rank" },
      direction: "desc",
    });

    expect(rows.map(({ path }) => path)).toEqual([
      "notes/alpha.md",
      "notes/zeta.md",
      "notes/missing.md",
    ]);
  });

  test("prepares compound metadata sort values once per row", () => {
    let reads = 0;
    const notes = ["delta", "alpha", "charlie", "bravo"].map((name, index) => {
      const note = parseNote(`notes/${name}.md`, `# ${name}\n`);
      const sortable: Record<string, string> = {};
      Object.defineProperty(sortable, "value", {
        enumerable: true,
        get: () => {
          reads += 1;
          return String(4 - index);
        },
      });
      return { ...note, metadata: { sortable } };
    });

    const rows = queryVault(notes, analyzeVault(notes), {
      sort: { kind: "metadata", path: "sortable" },
    });

    expect(rows).toHaveLength(notes.length);
    expect(reads).toBe(notes.length);
  });

  test("rejects metadata query work outside fixed count, path, and text budgets", () => {
    const exists = { kind: "exists", path: "status" } as const;
    expect(() => validateQueryOptions({
      filters: Array.from({ length: MAX_QUERY_FILTERS + 1 }, () => exists),
    })).toThrow(`at most ${MAX_QUERY_FILTERS} entries`);
    expect(() => validateQueryOptions({
      tags: Array.from({ length: MAX_QUERY_TAGS + 1 }, () => "tag"),
    })).toThrow(`at most ${MAX_QUERY_TAGS} entries`);
    expect(() => validateQueryOptions({
      filters: [{ kind: "exists", path: "x".repeat(MAX_QUERY_METADATA_PATH_UTF8_BYTES + 1) }],
    })).toThrow(`${MAX_QUERY_METADATA_PATH_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    expect(() => validateQueryOptions({
      sort: {
        kind: "metadata",
        path: "x".repeat(MAX_QUERY_METADATA_PATH_UTF8_BYTES + 1),
      },
    })).toThrow("Query sort metadata path");
    expect(() => validateQueryOptions({
      filters: [{
        kind: "exists",
        path: Array.from({ length: MAX_QUERY_METADATA_PATH_SEGMENTS + 1 }, () => "x"),
      }],
    })).toThrow(`at most ${MAX_QUERY_METADATA_PATH_SEGMENTS} segments`);
    expect(() => validateQueryOptions({
      filters: [{
        kind: "equals",
        path: "status",
        value: "x".repeat(MAX_QUERY_TEXT_UTF8_BYTES + 1),
      }],
    })).toThrow(`${MAX_QUERY_TEXT_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
    expect(() => validateQueryOptions({
      tags: Array.from(
        { length: Math.floor(MAX_QUERY_OPTIONS_UTF8_BYTES / MAX_QUERY_TEXT_UTF8_BYTES) + 1 },
        () => "x".repeat(MAX_QUERY_TEXT_UTF8_BYTES),
      ),
    })).toThrow(`${MAX_QUERY_OPTIONS_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes`);
  });

  test("rejects oversized options before inspecting graph or note data", () => {
    const notes = [parseNote("notes/alpha.md", "# Alpha\n")];
    const analysis = analyzeVault(notes);
    const guardedAnalysis = {
      ...analysis,
      get noteConnections(): never {
        throw new Error("query inspected the graph before validating options");
      },
    };

    expect(() => queryVault(notes, guardedAnalysis, {
      tags: Array.from({ length: MAX_QUERY_TAGS + 1 }, () => "tag"),
    })).toThrow(`at most ${MAX_QUERY_TAGS} entries`);
    expect(() => queryVault(notes, guardedAnalysis, {
      repositoryScopes: ["packages//kb"],
    })).toThrow("exact NFC-normalized POSIX form");
  });
});
