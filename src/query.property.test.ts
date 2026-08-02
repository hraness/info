import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { analyzeVault, parseNote } from "./graph.js";
import { queryVault } from "./query.js";

describe("vault query properties", () => {
  test("metadata sorting is stable and keeps missing values last in both directions", () => {
    fc.assert(fc.property(
      fc.array(fc.option(fc.integer({ min: -20, max: 20 }), { nil: undefined }), {
        maxLength: 60,
      }),
      (ranks) => {
        const notes = ranks.map((rank, index) => parseNote(
          `notes/note-${index.toString().padStart(3, "0")}.md`,
          rank === undefined ? `# Note ${index}\n` : `---\nrank: ${rank}\n---\n# Note ${index}\n`,
        ));
        const analysis = analyzeVault(notes);

        for (const direction of ["asc", "desc"] as const) {
          const rows = queryVault(notes, analysis, {
            sort: { kind: "metadata", path: "rank" },
            direction,
          });
          const expected = ranks
            .map((rank, index) => ({ index, rank }))
            .toSorted((left, right) => {
              if (left.rank === undefined && right.rank === undefined) return left.index - right.index;
              if (left.rank === undefined) return 1;
              if (right.rank === undefined) return -1;
              const compared = left.rank - right.rank;
              return (direction === "desc" ? -compared : compared) || left.index - right.index;
            })
            .map(({ index }) => `notes/note-${index.toString().padStart(3, "0")}.md`);

          expect(rows.map(({ path }) => path)).toEqual(expected);
        }
      },
    ));
  });

  test("string equality, list membership, and tags are case-insensitive", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,16}$/u),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,16}$/u),
      (owner, team) => {
        const note = parseNote("notes/match.md", [
          "---",
          `tags: [${team.toUpperCase()}]`,
          "owner:",
          `  name: ${owner.toUpperCase()}`,
          `  teams: [${team.toUpperCase()}]`,
          "---",
          "# Match",
        ].join("\n"));
        const rows = queryVault([note], analyzeVault([note]), {
          filters: [
            { kind: "equals", path: "owner.name", value: owner },
            { kind: "equals", path: "owner.teams", value: team },
          ],
          tags: [team],
        });

        expect(rows.map(({ path }) => path)).toEqual(["notes/match.md"]);
      },
    ));
  });

  test("one-of equals the union of scalar equality while repository scopes remain exact", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/u), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.subarray(["proposed", "accepted", "in-progress", "blocked"], {
        minLength: 1,
      }),
      (names, statuses) => {
        const notes = names.map((name, index) => parseNote(`notes/${name}.md`, [
          "---",
          `status: ${statuses[index % statuses.length]}`,
          "repository_scopes:",
          `  - packages/${index % 2 === 0 ? "kb" : "KB"}`,
          "---",
          `# ${name}`,
        ].join("\n")));
        const analysis = analyzeVault(notes);
        const selected = statuses.slice(0, Math.max(1, Math.floor(statuses.length / 2)));
        const oneOf = queryVault(notes, analysis, {
          filters: [{ kind: "one-of", path: "status", values: selected }],
          repositoryScopes: ["packages/kb"],
        }).map(({ path }) => path);
        const equalityUnion = new Set(selected.flatMap((status) =>
          queryVault(notes, analysis, {
            filters: [{ kind: "equals", path: "status", value: status }],
            repositoryScopes: ["packages/kb"],
          }).map(({ path }) => path)));

        expect(oneOf).toEqual([...equalityUnion].toSorted());
        expect(oneOf.every((path) => {
          const index = names.findIndex((name) => path === `notes/${name}.md`);
          return index % 2 === 0;
        })).toBe(true);
      },
    ));
  });
});
