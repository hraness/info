import type { GitHistoryForNotesResult } from "../git.js";
import type { QueryRow } from "../query.js";
import {
  type KnowledgeBaseSearchResult,
  type KnowledgeBaseSession,
} from "../sdk.js";
import { defineWorkflow } from "../workflow.js";

export type PlanRadarInput = {
  readonly query: string;
  readonly status?: string;
  readonly resultLimit?: number;
};

export type PlanRadarOutput = {
  readonly plans: readonly QueryRow[];
  readonly matches: KnowledgeBaseSearchResult;
  readonly history: GitHistoryForNotesResult;
};

type PlanRadarResults = {
  readonly plans: readonly QueryRow[];
  readonly matches: KnowledgeBaseSearchResult;
  readonly history: GitHistoryForNotesResult;
  readonly assemble: PlanRadarOutput;
};

/** Combine exact plan state with semantic matches, backlinks, and recent provenance. */
export const planRadarWorkflow = defineWorkflow<
  PlanRadarInput,
  KnowledgeBaseSession,
  PlanRadarResults,
  "assemble"
>({
  id: "plan-radar",
  nodes: [
    {
      id: "plans",
      run: ({ input, kb }) => kb.list({
        filters: [
          { kind: "equals", path: "type", value: "plan" },
          { kind: "equals", path: "status", value: input.status ?? "in-progress" },
        ],
        sort: { kind: "builtin", field: "inbound" },
        direction: "desc",
        limit: 100,
      }),
    },
    {
      id: "matches",
      resource: "qmd",
      run: ({ input, kb }) => kb.search({
        query: input.query,
        filters: [{ kind: "equals", path: "type", value: "plan" }],
        history: false,
        ...(input.resultLimit === undefined ? {} : { limit: input.resultLimit }),
      }),
    },
    {
      id: "history",
      resource: "git",
      needs: ["plans", "matches"],
      run: async ({ kb, result }) => {
        const plans = result("plans");
        const matches = result("matches");
        const noteIds = [...new Set([
          ...matches.results.map(({ id }) => id),
          ...plans.slice(0, 10).map(({ id }) => id),
        ])].slice(0, 15);
        return await kb.history(noteIds, {
          commitsPerNote: 2,
          cochangedPathsPerCommit: 5,
        });
      },
    },
    {
      id: "assemble",
      needs: ["plans", "matches", "history"],
      run: ({ result }): PlanRadarOutput => ({
        plans: result("plans"),
        matches: result("matches"),
        history: result("history"),
      }),
    },
  ],
  output: "assemble",
});
