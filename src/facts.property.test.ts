import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { projectVaultFacts } from "./facts.js";
import { analyzeVault, parseNote } from "./graph.js";

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u);
const identity = fc
  .tuple(segment, segment)
  .map(([directory, name]) => `${directory}/${name}`);

describe("vault fact projection properties", () => {
  test("projection is invariant under note and derived-view permutations", () => {
    fc.assert(fc.property(
      fc.uniqueArray(identity, { maxLength: 20 }),
      fc.array(fc.nat(), { maxLength: 20 }),
      (identities, weights) => {
        const notes = identities.map((id, index) => {
          const target = identities[(index + 1) % identities.length];
          const edges = target === undefined || target === id
            ? ""
            : [
                "relations:",
                `  supports: [${target}]`,
                "---",
                `# ${id}`,
                "",
                `[[${target}]]`,
              ].join("\n");
          return parseNote(`${id}.md`, [
            "---",
            `tags: [tag-${index % 4}]`,
            `priority: ${index}`,
            ...(edges === "" ? ["---", `# ${id}`] : [edges]),
          ].join("\n"));
        });
        const expected = projectVaultFacts(notes, analyzeVault(notes));
        const permuted = [...notes].toSorted((left, right) => {
          const leftIndex = identities.indexOf(left.id);
          const rightIndex = identities.indexOf(right.id);
          return (weights[leftIndex] ?? leftIndex)
            - (weights[rightIndex] ?? rightIndex)
            || left.id.localeCompare(right.id);
        });
        const analysis = analyzeVault(permuted);
        const permutedAnalysis = {
          ...analysis,
          contextualLinks: [...analysis.contextualLinks].reverse(),
          authoredRelations: [...analysis.authoredRelations].reverse(),
          noteConnections: [...analysis.noteConnections].reverse(),
        };

        expect(projectVaultFacts(permuted, permutedAnalysis)).toEqual(expected);
      },
    ));
  });
});
