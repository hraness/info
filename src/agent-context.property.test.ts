import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  agentContextMarkerForScope,
  agentContextNoteId,
  agentContextSlugMaximumLength,
  normalizeRepositoryScope,
  parseAgentContextMarker,
} from "./agent-context.js";

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const scope = fc
  .array(segment, { minLength: 1, maxLength: 8 })
  .map((segments) => segments.join("/"));

describe("agent-context identity properties", () => {
  test("normalization is idempotent across POSIX and backslash separators", () => {
    fc.assert(fc.property(scope, (value) => {
      const normalized = normalizeRepositoryScope(value);
      expect(normalizeRepositoryScope(normalized)).toBe(normalized);
      expect(normalizeRepositoryScope(value.replaceAll("/", "\\"))).toBe(
        normalized,
      );
    }));
  });

  test("canonical keys are deterministic, bounded, and derived from full scope", () => {
    fc.assert(fc.property(scope, (value) => {
      const normalized = normalizeRepositoryScope(value);
      const noteId = agentContextNoteId(value);
      expect(agentContextNoteId(normalized)).toBe(noteId);
      expect(agentContextNoteId(value)).toBe(noteId);

      const basename = noteId.slice("scopes/".length);
      const separator = basename.lastIndexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(basename.slice(0, separator).length).toBeLessThanOrEqual(
        agentContextSlugMaximumLength,
      );
      expect(basename.slice(separator + 2)).toMatch(/^[0-9a-f]{12}$/);
    }));
  });

  test("same-leaf scopes retain distinct canonical identities", () => {
    fc.assert(fc.property(
      fc.tuple(scope, scope, segment)
        .filter(([left, right]) =>
          normalizeRepositoryScope(left) !== normalizeRepositoryScope(right)),
      ([left, right, leaf]) => {
        expect(agentContextNoteId(`${left}/${leaf}`)).not.toBe(
          agentContextNoteId(`${right}/${leaf}`),
        );
      },
    ));
  });

  test("formatted markers parse back to exactly one canonical note ID", () => {
    fc.assert(fc.property(scope, (value) => {
      const marker = agentContextMarkerForScope(value);
      const result = parseAgentContextMarker(`${marker}\n# Contents\n`);
      expect(result.kind).toBe("found");
      expect(result.markers.map((parsed) => parsed.noteId)).toEqual([
        agentContextNoteId(value),
      ]);
      expect(result.malformed).toEqual([]);
    }));
  });

  test("parent traversal and control characters are always rejected", () => {
    fc.assert(fc.property(
      scope,
      fc.integer({ min: 0, max: 31 }),
      (value, controlCodePoint) => {
        expect(() => normalizeRepositoryScope(`${value}/../escape`)).toThrow();
        expect(() =>
          normalizeRepositoryScope(
            `${value}/${String.fromCodePoint(controlCodePoint)}/child`,
          )).toThrow();
      },
    ));
  });
});
