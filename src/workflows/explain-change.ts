import type { GitHistorySearchResult } from "../git.js";
import type { LinkNeighborhood } from "../navigation.js";
import {
  type KnowledgeBaseSearchResult,
  type KnowledgeBaseSession,
} from "../sdk.js";
import { defineWorkflow } from "../workflow.js";

export type ExplainChangeInput = {
  readonly query: string;
  readonly historyQuery?: string;
  readonly note?: string;
  readonly resultLimit?: number;
  readonly historyLimit?: number;
};

export type ExplainChangeOutput = {
  readonly rationale: KnowledgeBaseSearchResult;
  readonly evolution: GitHistorySearchResult;
  readonly neighborhood: LinkNeighborhood | null;
};

type ExplainChangeResults = {
  readonly rationale: KnowledgeBaseSearchResult;
  readonly evolution: GitHistorySearchResult;
  readonly neighborhood: LinkNeighborhood | null;
  readonly assemble: ExplainChangeOutput;
};

/** Search authored rationale and repository evolution concurrently. */
export const explainChangeWorkflow = defineWorkflow<
  ExplainChangeInput,
  KnowledgeBaseSession,
  ExplainChangeResults,
  "assemble"
>({
  id: "explain-change",
  nodes: [
    {
      id: "rationale",
      resource: "qmd",
      run: ({ input, kb }) => kb.search({
        query: input.query,
        history: false,
        ...(input.resultLimit === undefined ? {} : { limit: input.resultLimit }),
      }),
    },
    {
      id: "evolution",
      resource: "git",
      run: ({ input, kb }) => kb.searchHistory({
        query: input.historyQuery ?? input.query,
        ...(input.historyLimit === undefined ? {} : { limit: input.historyLimit }),
      }),
    },
    {
      id: "neighborhood",
      run: ({ input, kb }) => input.note === undefined
        ? null
        : kb.links(input.note, { direction: "both", depth: 1, limit: 20 }),
    },
    {
      id: "assemble",
      needs: ["rationale", "evolution", "neighborhood"],
      run: ({ result }): ExplainChangeOutput => ({
        rationale: result("rationale"),
        evolution: result("evolution"),
        neighborhood: result("neighborhood"),
      }),
    },
  ],
  output: "assemble",
});
