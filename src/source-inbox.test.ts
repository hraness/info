import { describe, expect, test } from "bun:test";

import type { Note, VaultAnalysis } from "./graph.js";
import { sourceInbox } from "./source-inbox.js";

function note(
  id: string,
  metadata: Note["metadata"] = {},
): Note {
  return {
    id,
    path: `${id}.md`,
    title: id.split("/").at(-1) ?? id,
    aliases: [],
    tags: [],
    properties: {},
    metadata,
    content: "",
    summary: "",
    searchableText: "",
    links: [],
  };
}

function analysis(
  contextualLinks: VaultAnalysis["contextualLinks"] = [],
  authoredRelations: VaultAnalysis["authoredRelations"] = [],
): VaultAnalysis {
  return {
    noteCount: 0,
    contextualLinks,
    backlinks: [],
    authoredRelations,
    noteConnections: [],
    issues: [],
    relationIssues: [],
    orphans: [],
    mentions: [],
  };
}

describe("source inbox", () => {
  test("sorts valid captures newest first and retains explicit advisory reasons", () => {
    const notes = [
      note("articles/old/old", { clipped: "2026-07-02" }),
      note("articles/new/new", { clipped: "2026-08-01" }),
      note("articles/invalid/invalid", { clipped: "2026-02-31" }),
      note("articles/missing/missing"),
      note("notes/synthesis", { type: "note" }),
    ];
    const report = sourceInbox(notes, analysis());

    expect(report).toMatchObject({
      advisory: true,
      sourcePrefixes: ["articles/"],
      totalSources: 4,
      disposedSources: 0,
      pendingSources: 4,
      returnedSources: 4,
      truncated: false,
    });
    expect(report.items.map(({ id, clipped, reason }) => ({ id, clipped, reason })))
      .toEqual([
        {
          id: "articles/new/new",
          clipped: "2026-08-01",
          reason: "no-maintained-disposition",
        },
        {
          id: "articles/old/old",
          clipped: "2026-07-02",
          reason: "no-maintained-disposition",
        },
        {
          id: "articles/invalid/invalid",
          clipped: null,
          reason: "invalid-clipped-date",
        },
        {
          id: "articles/missing/missing",
          clipped: null,
          reason: "missing-clipped-date",
        },
      ]);
  });

  test("counts only maintained non-source inbound links and relations as disposition", () => {
    const notes = [
      note("articles/linked/linked", { clipped: "2026-08-01" }),
      note("articles/related/related", { clipped: "2026-07-31" }),
      note("articles/source-only/source-only", { clipped: "2026-07-30" }),
      note("articles/catalog-only/catalog-only", { clipped: "2026-07-29" }),
      note("articles/plan-only/plan-only", { clipped: "2026-07-28" }),
      note("notes/synthesis", { type: "note" }),
      note("concepts/retrieval", { type: "concept" }),
      note("plans/work", { type: "plan", status: "in-progress" }),
      note("index"),
    ];
    const report = sourceInbox(notes, analysis(
      [
        { source: "notes/synthesis", target: "articles/linked/linked", line: 12 },
        {
          source: "articles/linked/linked",
          target: "articles/source-only/source-only",
          line: 4,
        },
        { source: "index", target: "articles/catalog-only/catalog-only", line: 8 },
        { source: "plans/work", target: "articles/plan-only/plan-only", line: 20 },
      ],
      [{
        source: "concepts/retrieval",
        target: "articles/related/related",
        predicate: "supported-by",
        provenance: {
          kind: "frontmatter",
          source: "concepts/retrieval.md",
          line: 7,
          authoredTarget: "articles/related/related",
        },
      }],
    ));

    expect(report.disposedSources).toBe(2);
    expect(report.pendingSources).toBe(3);
    expect(report.items.map(({ id }) => id)).toEqual([
      "articles/source-only/source-only",
      "articles/catalog-only/catalog-only",
      "articles/plan-only/plan-only",
    ]);
    expect(report.dispositions).toEqual([
      {
        id: "articles/linked/linked",
        path: "articles/linked/linked.md",
        evidence: [{ kind: "link", source: "notes/synthesis", line: 12 }],
      },
      {
        id: "articles/related/related",
        path: "articles/related/related.md",
        evidence: [{
          kind: "relation",
          source: "concepts/retrieval",
          line: 7,
          predicate: "supported-by",
        }],
      },
    ]);
  });

  test("applies stable result and corpus bounds without changing disposition", () => {
    const notes = [
      note("articles/a/a", { clipped: "2026-08-01" }),
      note("articles/b/b", { clipped: "2026-07-31" }),
      note("articles/c/c", { clipped: "2026-07-30" }),
    ];
    const report = sourceInbox(notes, analysis(), { limit: 2 });
    expect(report.items.map(({ id }) => id)).toEqual(["articles/a/a", "articles/b/b"]);
    expect(report).toMatchObject({
      pendingSources: 3,
      returnedSources: 2,
      truncated: true,
    });
    expect(() => sourceInbox(notes, analysis(), { maxNotes: 2 })).toThrow(
      "above its 2-note limit",
    );
    expect(() => sourceInbox(notes, analysis(), { limit: 1_001 })).toThrow(
      "from 0 through 1000",
    );
    expect(() => sourceInbox(
      notes,
      analysis([{ source: "notes/a", target: "articles/a/a", line: 1 }]),
      { maxConnections: 0 },
    )).toThrow("above its 0-connection limit");
  });

  test("supports bounded custom source prefixes without requiring authored links", () => {
    const report = sourceInbox(
      [
        note("sources/paper", { clipped: "2026-08-01" }),
        note("articles/article", { clipped: "2026-08-02" }),
      ],
      analysis(),
      { sourcePrefixes: ["sources"] },
    );
    expect(report.sourcePrefixes).toEqual(["sources/"]);
    expect(report.items.map(({ id }) => id)).toEqual(["sources/paper"]);
    expect(() => sourceInbox([], analysis(), { sourcePrefixes: ["C:\\vault"] }))
      .toThrow("confined vault-relative directories");
  });
});
