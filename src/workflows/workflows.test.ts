import { describe, expect, expectTypeOf, test } from "bun:test";

import type { GitHistoryForNotesResult, GitHistorySearchResult } from "../git.js";
import type { LinkNeighborhood } from "../navigation.js";
import type { QueryOptions, QueryRow } from "../query.js";
import type {
  KnowledgeBaseSearchOptions,
  KnowledgeBaseSearchResult,
  KnowledgeBaseSession,
} from "../sdk.js";
import { runWorkflow } from "../workflow.js";
import {
  decisionContextWorkflow,
  type DecisionContextOutput,
} from "./decision-context.js";
import { explainChangeWorkflow } from "./explain-change.js";
import { planRadarWorkflow } from "./plan-radar.js";

const unavailableHistory: GitHistoryForNotesResult = {
  status: "unavailable",
  repository: "",
  root: "/kb",
  vaultPrefix: "",
  reason: "fixture",
};

const emptySearch: KnowledgeBaseSearchResult = {
  query: "context",
  mode: "hybrid",
  results: [],
  graph: null,
  history: null,
  partial: false,
  diagnostics: {
    notes: 0,
    model: "fixture",
    elapsedMs: 1,
    lanes: [
      { lane: "exact", status: "ready", results: 0 },
      { lane: "qmd", status: "ready", results: 0 },
    ],
  },
};

const emptyNeighborhood: LinkNeighborhood = {
  note: "notes/context",
  direction: "both",
  depth: 1,
  limit: 20,
  truncated: false,
  nodes: [],
  edges: [],
  relations: [],
};

function fakeSession(overrides: Partial<KnowledgeBaseSession> = {}): KnowledgeBaseSession {
  const unused = (): never => {
    throw new Error("Unexpected fake session call.");
  };
  return {
    root: "/kb",
    noteCount: 0,
    grep: unused,
    list: unused,
    read: unused,
    links: unused,
    backlinks: unused,
    search: () => Promise.resolve(emptySearch),
    history: () => Promise.resolve(unavailableHistory),
    searchHistory: unused,
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe("bundled knowledge-base workflows", () => {
  test("declares finite resource-aware graphs", () => {
    expect(decisionContextWorkflow.nodes.map(({ id, resource, needs }) => ({ id, resource, needs })))
      .toEqual([
        { id: "search", resource: "qmd", needs: undefined },
        { id: "history", resource: "git", needs: ["search"] },
        { id: "pack", resource: undefined, needs: ["search", "history"] },
      ]);
    expect(explainChangeWorkflow.nodes.map(({ id }) => id)).toEqual([
      "rationale",
      "evolution",
      "neighborhood",
      "assemble",
    ]);
    expect(planRadarWorkflow.output).toBe("assemble");
  });

  test("runs rationale and Git evolution in parallel before assembling", async () => {
    const starts: string[] = [];
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = (): void => {
      if (starts.length === 2) release?.();
    };
    const evolution: GitHistorySearchResult = {
      status: "ready",
      head: "a".repeat(40),
      query: "why capture changed",
      hits: [],
    };
    const kb = fakeSession({
      search: async () => {
        starts.push("qmd");
        started();
        await barrier;
        return emptySearch;
      },
      searchHistory: async () => {
        starts.push("git");
        started();
        await barrier;
        return evolution;
      },
      links: () => emptyNeighborhood,
    });
    const result = await runWorkflow(explainChangeWorkflow, {
      kb,
      input: { query: "why capture changed", note: "notes/context" },
      concurrency: 3,
    });
    expect(new Set(starts)).toEqual(new Set(["qmd", "git"]));
    expect(result.output).toEqual({
      rationale: emptySearch,
      evolution,
      neighborhood: emptyNeighborhood,
    });
  });

  test("packs decision context after attaching bounded note provenance", async () => {
    const history: GitHistoryForNotesResult = {
      status: "ready",
      head: "b".repeat(40),
      notes: [],
    };
    const kb = fakeSession({ history: () => Promise.resolve(history) });
    const result = await runWorkflow(decisionContextWorkflow, {
      kb,
      input: { query: "context", maxBytes: 512 },
    });
    expectTypeOf(result.output).toEqualTypeOf<DecisionContextOutput>();
    const output = result.output;
    expect(output.search.history).toEqual(history);
    expect(output.context).toContain("Knowledge-base context");
    expect(output.truncated).toBe(false);
  });

  test("joins exact plan state, semantic matches, and deduplicated history IDs", async () => {
    const plan: QueryRow = {
      id: "plans/search",
      path: "plans/search.md",
      title: "Search plan",
      aliases: [],
      tags: [],
      properties: {},
      metadata: { type: "plan", status: "in-progress" },
      summary: "",
      inboundContextualCount: 0,
      outboundContextualCount: 0,
      backlinks: [],
    };
    let requestedIds: readonly string[] = [];
    let listedWith: QueryOptions | undefined;
    let searchedWith: KnowledgeBaseSearchOptions | undefined;
    const matched: KnowledgeBaseSearchResult = {
      ...emptySearch,
      results: [{
        id: plan.id,
        path: plan.path,
        title: plan.title,
        rank: 1,
        score: 1,
        identity: true,
        snippet: "Search plan",
        tags: [],
        metadata: plan.metadata,
        evidence: [{ kind: "exact", rank: 1, identity: true, matches: [] }],
        contributions: [{ lane: "exact", rank: 1, weight: 2, value: 2 / 61 }],
      }],
    };
    const kb = fakeSession({
      list: (options) => {
        listedWith = options;
        return [plan];
      },
      search: (options) => {
        searchedWith = options;
        return Promise.resolve(matched);
      },
      history: (ids) => {
        requestedIds = ids;
        return Promise.resolve(unavailableHistory);
      },
    });
    const result = await runWorkflow(planRadarWorkflow, {
      kb,
      input: { query: "hybrid search", repositoryScopes: ["packages/kb"] },
    });
    const activeFilter = {
      kind: "one-of",
      path: "status",
      values: ["proposed", "accepted", "in-progress", "blocked"],
    };
    expect(listedWith).toMatchObject({
      filters: [
        { kind: "equals", path: "type", value: "plan" },
        activeFilter,
      ],
      repositoryScopes: ["packages/kb"],
    });
    expect(searchedWith).toMatchObject({
      filters: [
        { kind: "equals", path: "type", value: "plan" },
        activeFilter,
      ],
      repositoryScopes: ["packages/kb"],
    });
    expect(requestedIds).toEqual(["plans/search"]);
    expect(result.output).toEqual({
      plans: [plan],
      matches: matched,
      history: unavailableHistory,
    });
  });

  test("lets plan radar request terminal history with the same constraints in both lanes", async () => {
    const requests: {
      list: QueryOptions | undefined;
      search: KnowledgeBaseSearchOptions | undefined;
    } = { list: undefined, search: undefined };
    const kb = fakeSession({
      list: (options) => {
        requests.list = options;
        return [];
      },
      search: (options) => {
        requests.search = options;
        return Promise.resolve(emptySearch);
      },
    });
    await runWorkflow(planRadarWorkflow, {
      kb,
      input: {
        query: "retired plan",
        status: "superseded",
        repositoryScopes: ["projects/example"],
      },
    });
    const expected = [
      { kind: "equals", path: "type", value: "plan" },
      { kind: "equals", path: "status", value: "superseded" },
    ];
    expect(requests.list).toMatchObject({
      filters: expected,
      repositoryScopes: ["projects/example"],
    });
    expect(requests.search).toMatchObject({
      filters: expected,
      repositoryScopes: ["projects/example"],
    });
  });
});
