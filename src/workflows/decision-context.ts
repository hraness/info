import type { GitHistoryForNotesResult } from "../git.js";
import type { MetadataFilter } from "../query.js";
import {
  packSearchContext,
  type KnowledgeBaseSearchResult,
  type KnowledgeBaseSession,
} from "../sdk.js";
import { defineWorkflow } from "../workflow.js";

export type DecisionContextInput = {
  readonly query: string;
  readonly filters?: readonly MetadataFilter[];
  readonly tags?: readonly string[];
  readonly related?: readonly string[];
  readonly resultLimit?: number;
  readonly maxBytes?: number;
};

export type DecisionContextOutput = {
  readonly search: KnowledgeBaseSearchResult;
  readonly context: string;
  readonly truncated: boolean;
};

type DecisionContextResults = {
  readonly search: KnowledgeBaseSearchResult;
  readonly history: GitHistoryForNotesResult;
  readonly pack: DecisionContextOutput;
};

/** Retrieve current rationale, explicit neighbors, and note history as one bounded handoff. */
export const decisionContextWorkflow = defineWorkflow<
  DecisionContextInput,
  KnowledgeBaseSession,
  DecisionContextResults,
  "pack"
>({
  id: "decision-context",
  nodes: [
    {
      id: "search",
      resource: "qmd",
      run: ({ input, kb }) => kb.search({
        query: input.query,
        filters: input.filters ?? [],
        tags: input.tags ?? [],
        graph: { related: input.related ?? [] },
        history: false,
        ...(input.resultLimit === undefined ? {} : { limit: input.resultLimit }),
      }),
    },
    {
      id: "history",
      resource: "git",
      needs: ["search"],
      run: async ({ kb, result }) => {
        const search = result("search");
        return await kb.history(search.results.slice(0, 5).map(({ id }) => id), {
          commitsPerNote: 3,
          cochangedPathsPerCommit: 8,
        });
      },
    },
    {
      id: "pack",
      needs: ["search", "history"],
      run: ({ input, result }): DecisionContextOutput => {
        const search = result("search");
        const enriched: KnowledgeBaseSearchResult = {
          ...search,
          history: result("history"),
        };
        const packed = packSearchContext(enriched, {
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        });
        return { search: enriched, context: packed.content, truncated: packed.truncated };
      },
    },
  ],
  output: "pack",
});
