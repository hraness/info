import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  analyzeVault,
  catalogEnd,
  catalogStart,
  isCanonicalNoteId,
  parseNote,
  renderCatalog,
  replaceCatalog,
} from "./graph.js";

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,18}$/);
const noteIdentity = fc
  .tuple(segment, segment)
  .map(([directory, name]) => `${directory}/${name}`);
const relationPredicate = fc.constantFrom("depends-on", "related-to", "supports");
const predicateCandidate = fc.array(
  fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ ",
  ),
  { maxLength: 24 },
).map((characters) => characters.join(""));

describe("vault graph properties", () => {
  test("canonical relation IDs accept exact scan identities and reject normalized spellings", () => {
    fc.assert(fc.property(noteIdentity, (identity) => {
      expect(isCanonicalNoteId(identity)).toBe(true);
      expect(isCanonicalNoteId(`${identity}.md`)).toBe(false);
      expect(isCanonicalNoteId(identity.replace("/", "\\"))).toBe(false);
      expect(isCanonicalNoteId(`${identity}/../other`)).toBe(false);
      expect(isCanonicalNoteId(`${identity}/e\u0301`)).toBe(false);
    }));
  });

  test("catalog rendering is order-independent and replacement is idempotent", () => {
    fc.assert(fc.property(
      fc.uniqueArray(noteIdentity, { maxLength: 40 }),
      (identities) => {
        const notes = identities.map((identity) =>
          parseNote(`${identity}.md`, `# ${identity.replaceAll("/", " ")}\n\nA maintained note.\n`));
        const catalog = renderCatalog(notes);
        expect(renderCatalog([...notes].reverse())).toBe(catalog);

        const index = `# Vault\n\n${catalogStart}\nstale\n${catalogEnd}\n`;
        const replaced = replaceCatalog(index, catalog);
        expect(replaceCatalog(replaced, catalog)).toBe(replaced);
      },
    ));
  });

  test("every resolved contextual edge has exactly one matching derived backlink", () => {
    fc.assert(fc.property(
      fc.uniqueArray(noteIdentity, { minLength: 1, maxLength: 30 }),
      fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 100 }),
      (identities, rawEdges) => {
        const linksBySource = new Map<number, Set<number>>();
        for (const [rawSource, rawTarget] of rawEdges) {
          const source = rawSource % identities.length;
          const target = rawTarget % identities.length;
          if (source === target) continue;
          const targets = linksBySource.get(source) ?? new Set<number>();
          targets.add(target);
          linksBySource.set(source, targets);
        }
        const notes = identities.map((identity, source) => {
          const links = [...(linksBySource.get(source) ?? [])]
            .map((target) => `[[${identities[target] ?? ""}]]`)
            .join(" ");
          return parseNote(`${identity}.md`, `# ${identity}\n\n${links}\n`);
        });
        const analysis = analyzeVault(notes);

        expect(analysis.backlinks).toHaveLength(analysis.contextualLinks.length);
        expect(analysis.backlinks).toEqual(analysis.contextualLinks.toSorted((left, right) =>
          left.target.localeCompare(right.target)
          || left.source.localeCompare(right.source)
          || left.line - right.line));
        expect(analysis.issues).toEqual([]);
      },
    ));
  });

  test("authored relation projection is permutation-stable, directed, and cardinality-safe", () => {
    fc.assert(fc.property(
      fc.uniqueArray(noteIdentity, { minLength: 1, maxLength: 30 }),
      fc.array(fc.tuple(fc.nat(), fc.nat(), relationPredicate), { maxLength: 100 }),
      (identities, rawRelations) => {
        const targetsBySource = new Map<number, Map<string, Set<number>>>();
        const expectedKeys = new Set<string>();
        for (const [rawSource, rawTarget, predicate] of rawRelations) {
          const source = rawSource % identities.length;
          const target = rawTarget % identities.length;
          const byPredicate = targetsBySource.get(source) ?? new Map<string, Set<number>>();
          const targets = byPredicate.get(predicate) ?? new Set<number>();
          targets.add(target);
          byPredicate.set(predicate, targets);
          targetsBySource.set(source, byPredicate);
          expectedKeys.add(
            `${identities[source] ?? ""}\0${predicate}\0${identities[target] ?? ""}`,
          );
        }

        const notes = identities.map((identity, source) => {
          const byPredicate = targetsBySource.get(source);
          if (byPredicate === undefined) {
            return parseNote(`${identity}.md`, `# ${identity}\n`);
          }
          const relations = [...byPredicate]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .flatMap(([predicate, targets]) => [
              `  ${predicate}:`,
              ...[...targets]
                .map((target) => identities[target] ?? "")
                .sort()
                .map((target) => `    - ${target}`),
            ]);
          return parseNote(`${identity}.md`, [
            "---",
            "relations:",
            ...relations,
            "---",
            `# ${identity}`,
          ].join("\n"));
        });
        const analysis = analyzeVault(notes);
        const reversed = analyzeVault([...notes].reverse());
        const projectedKeys = analysis.authoredRelations.map(
          ({ source, predicate, target }) => `${source}\0${predicate}\0${target}`,
        );

        expect(new Set(projectedKeys)).toEqual(expectedKeys);
        expect(projectedKeys).toHaveLength(expectedKeys.size);
        expect(analysis.authoredRelations).toEqual(reversed.authoredRelations);
        expect(analysis.noteConnections).toEqual(reversed.noteConnections);
        expect(analysis.relationIssues).toEqual([]);
        expect(analysis.noteConnections.reduce(
          (count, connection) => count + connection.relationBacklinks.length,
          0,
        )).toBe(analysis.authoredRelations.length);
      },
    ));
  });

  test("only strict lower-kebab predicate keys become declarations", () => {
    fc.assert(fc.property(predicateCandidate, (authoredPredicate) => {
      const normalized = authoredPredicate.normalize("NFC");
      const valid = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(normalized);
      const source = parseNote("notes/source.md", [
        "---",
        "relations:",
        `  ${JSON.stringify(authoredPredicate)}: notes/target`,
        "---",
        "# Source",
      ].join("\n"));
      const analysis = analyzeVault([
        source,
        parseNote("notes/target.md", "# Target\n"),
      ]);

      if (valid) {
        expect(source.relationDeclarations).toEqual([
          { predicate: normalized, target: "notes/target", line: 3 },
        ]);
        expect(analysis.relationIssues).toEqual([]);
        expect(analysis.authoredRelations).toHaveLength(1);
      } else {
        expect(source.relationDeclarations).toEqual([]);
        expect(analysis.authoredRelations).toEqual([]);
        expect(analysis.relationIssues).toEqual([
          expect.objectContaining({
            kind: "malformed",
            source: "notes/source.md",
            line: 3,
            predicate: normalized,
          }),
        ]);
      }
    }));
  });
});
