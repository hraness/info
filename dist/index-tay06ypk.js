// @bun
import {
  defineWorkflow
} from "./index-3v2z4f0q.js";

// src/workflows/plan-radar.ts
var planRadarWorkflow = defineWorkflow({
  id: "plan-radar",
  nodes: [
    {
      id: "plans",
      run: ({ input, kb }) => kb.list({
        filters: [
          { kind: "equals", path: "type", value: "plan" },
          { kind: "equals", path: "status", value: input.status ?? "in-progress" }
        ],
        sort: { kind: "builtin", field: "inbound" },
        direction: "desc",
        limit: 100
      })
    },
    {
      id: "matches",
      resource: "qmd",
      run: ({ input, kb }) => kb.search({
        query: input.query,
        filters: [{ kind: "equals", path: "type", value: "plan" }],
        history: false,
        ...input.resultLimit === undefined ? {} : { limit: input.resultLimit }
      })
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
          ...plans.slice(0, 10).map(({ id }) => id)
        ])].slice(0, 15);
        return await kb.history(noteIds, {
          commitsPerNote: 2,
          cochangedPathsPerCommit: 5
        });
      }
    },
    {
      id: "assemble",
      needs: ["plans", "matches", "history"],
      run: ({ result }) => ({
        plans: result("plans"),
        matches: result("matches"),
        history: result("history")
      })
    }
  ],
  output: "assemble"
});

export { planRadarWorkflow };
