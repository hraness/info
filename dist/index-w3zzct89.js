// @bun
import {
  defineWorkflow
} from "./index-3v2z4f0q.js";
import {
  packSearchContext
} from "./index-e2p9924f.js";

// src/workflows/decision-context.ts
var decisionContextWorkflow = defineWorkflow({
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
        ...input.resultLimit === undefined ? {} : { limit: input.resultLimit }
      })
    },
    {
      id: "history",
      resource: "git",
      needs: ["search"],
      run: async ({ kb, result }) => {
        const search = result("search");
        return await kb.history(search.results.slice(0, 5).map(({ id }) => id), {
          commitsPerNote: 3,
          cochangedPathsPerCommit: 8
        });
      }
    },
    {
      id: "pack",
      needs: ["search", "history"],
      run: ({ input, result }) => {
        const search = result("search");
        const enriched = {
          ...search,
          history: result("history")
        };
        const packed = packSearchContext(enriched, {
          ...input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }
        });
        return { search: enriched, context: packed.content, truncated: packed.truncated };
      }
    }
  ],
  output: "pack"
});

export { decisionContextWorkflow };
