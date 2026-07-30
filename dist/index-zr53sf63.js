// @bun
import {
  defineWorkflow
} from "./index-3v2z4f0q.js";

// src/workflows/explain-change.ts
var explainChangeWorkflow = defineWorkflow({
  id: "explain-change",
  nodes: [
    {
      id: "rationale",
      resource: "qmd",
      run: ({ input, kb }) => kb.search({
        query: input.query,
        history: false,
        ...input.resultLimit === undefined ? {} : { limit: input.resultLimit }
      })
    },
    {
      id: "evolution",
      resource: "git",
      run: ({ input, kb }) => kb.searchHistory({
        query: input.historyQuery ?? input.query,
        ...input.historyLimit === undefined ? {} : { limit: input.historyLimit }
      })
    },
    {
      id: "neighborhood",
      run: ({ input, kb }) => input.note === undefined ? null : kb.links(input.note, { direction: "both", depth: 1, limit: 20 })
    },
    {
      id: "assemble",
      needs: ["rationale", "evolution", "neighborhood"],
      run: ({ result }) => ({
        rationale: result("rationale"),
        evolution: result("evolution"),
        neighborhood: result("neighborhood")
      })
    }
  ],
  output: "assemble"
});

export { explainChangeWorkflow };
