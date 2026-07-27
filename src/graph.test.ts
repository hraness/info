import { describe, expect, test } from "bun:test";

import {
  analyzeVault,
  catalogEnd,
  catalogStart,
  lookupNote,
  metadataValueFromUnknown,
  parseNote,
  renderCatalog,
  replaceCatalog,
  searchableMarkdown,
  VaultAnalysisBudgetError,
} from "./graph.js";

describe("note parsing", () => {
  test("reads Obsidian properties and ignores links in code and comments", () => {
    const note = parseNote("notes/context.md", [
      "---",
      'title: "Context engineering"',
      "aliases:",
      "  - Context design",
      'description: "A bounded description."',
      "---",
      "# A heading that does not override title",
      "",
      "See [[notes/agents|agents]].",
      "",
      "```md",
      "[[missing-in-example]]",
      "```",
      "<!-- [[missing-in-comment]] -->",
    ].join("\n"));

    expect(note.title).toBe("Context engineering");
    expect(note.aliases).toEqual(["Context design"]);
    expect(note.properties.description).toBe("A bounded description.");
    expect(note.summary).toBe("A bounded description.");
    expect(note.links).toEqual([{ target: "notes/agents", line: 9, embedded: false }]);
  });

  test("keeps commas inside quoted inline aliases", () => {
    const note = parseNote("notes/person.md", [
      "---",
      'aliases: ["Smith, John", \'Johnny, Jr.\', John Smith]',
      "---",
      "# John",
    ].join("\n"));

    expect(note.aliases).toEqual(["Smith, John", "Johnny, Jr.", "John Smith"]);
  });

  test("retains typed nested metadata while preserving scalar properties", () => {
    const note = parseNote("notes/metadata.md", [
      "---",
      "title: 'Metadata note'",
      "status: in-progress",
      "priority: 3",
      "published: false",
      "tags: [AI, 'Knowledge Graph', '#AI']",
      "owner:",
      "  name: Alice",
      "  teams:",
      "    - Research",
      "    - Platform",
      "---",
      "# Ignored heading",
    ].join("\n"));

    expect(note.title).toBe("Metadata note");
    expect(note.properties).toMatchObject({
      title: "Metadata note",
      status: "in-progress",
      priority: "3",
      published: "false",
    });
    expect(note.tags).toEqual(["ai", "knowledge graph"]);
    expect(note.metadata).toEqual({
      title: "Metadata note",
      status: "in-progress",
      priority: 3,
      published: false,
      tags: ["AI", "Knowledge Graph", "#AI"],
      owner: { name: "Alice", teams: ["Research", "Platform"] },
    });
  });

  test("normalizes block-list tags without changing their typed source values", () => {
    const note = parseNote("notes/tags.md", [
      "---",
      "tags:",
      "  - ' Local First '",
      "  - '#Tools'",
      "  - local first",
      "---",
      "# Tags",
    ].join("\n"));

    expect(note.tags).toEqual(["local first", "tools"]);
    expect(note.metadata.tags).toEqual([" Local First ", "#Tools", "local first"]);
  });

  test("parses scalar and list relations with strict normalized predicates", () => {
    const note = parseNote("notes/source.md", [
      "---",
      "relations:",
      "  supports: concepts/durable-memory",
      "  depends-on:",
      "    - notes/runtime",
      "    - notes/shared",
      "---",
      "# Source",
    ].join("\n"));

    expect(note.relationDeclarations).toEqual([
      { predicate: "depends-on", target: "notes/runtime", line: 5 },
      { predicate: "depends-on", target: "notes/shared", line: 6 },
      { predicate: "supports", target: "concepts/durable-memory", line: 3 },
    ]);
    expect(note.relationIssues).toEqual([]);
    expect(note.metadata.relations).toEqual({
      supports: "concepts/durable-memory",
      "depends-on": ["notes/runtime", "notes/shared"],
    });
  });

  test("reports malformed relation containers, predicates, and targets without hiding valid entries", () => {
    const mixed = parseNote("notes/mixed.md", [
      "---",
      "relations:",
      "  Related-To: notes/target",
      "  related_to: notes/target",
      "  supports:",
      "    - notes/target",
      "    - 42",
      "    - ''",
      "    - ./target",
      "    - notes/target.md",
      "  contains:",
      "    nested: notes/target",
      "---",
      "# Mixed",
    ].join("\n"));
    const wrongContainer = parseNote("notes/container.md", [
      "---",
      "relations: [notes/target]",
      "---",
      "# Container",
    ].join("\n"));

    expect(mixed.relationDeclarations).toEqual([
      { predicate: "supports", target: "notes/target", line: 6 },
    ]);
    expect(mixed.relationIssues?.map(({ kind, line, predicate }) => ({
      kind,
      line,
      predicate,
    }))).toEqual([
      { kind: "malformed", line: 3, predicate: "Related-To" },
      { kind: "malformed", line: 4, predicate: "related_to" },
      { kind: "malformed", line: 7, predicate: "supports" },
      { kind: "malformed", line: 8, predicate: "supports" },
      { kind: "malformed", line: 9, predicate: "supports" },
      { kind: "malformed", line: 10, predicate: "supports" },
      { kind: "malformed", line: 12, predicate: "contains" },
    ]);

    const analysis = analyzeVault([wrongContainer]);
    expect(analysis.relationIssues).toHaveLength(1);
    expect(analysis.relationIssues[0]).toMatchObject({
      kind: "malformed",
      source: "notes/container.md",
      line: 2,
    });
    expect(analysis.relationIssues[0]?.kind === "malformed"
      ? analysis.relationIssues[0].message
      : "").toContain("strict lower-kebab predicates");
  });

  test("rejects malformed or ambiguous frontmatter instead of splitting typed and legacy views", () => {
    expect(() => parseNote("plans/duplicate.md", [
      "---",
      "type: plan",
      "status: in-progress",
      "status: completed",
      "area: info",
      "---",
      "# Duplicate status",
    ].join("\n"))).toThrow("Invalid YAML frontmatter in plans/duplicate.md");

    expect(() => parseNote("notes/case.md", [
      "---",
      "Status: current",
      "status: stale",
      "---",
      "# Ambiguous status",
    ].join("\n"))).toThrow("keys must not differ only by case");

    expect(() => parseNote(
      "notes/unclosed.md",
      "---\ntitle: Never closed\n# Hidden body\n",
    )).toThrow("missing closing delimiter");

    expect(() => parseNote("notes/unsafe-number.md", [
      "---",
      "external_id: 9007199254740993",
      "---",
      "# Unsafe number",
    ].join("\n"))).toThrow("Invalid YAML frontmatter in notes/unsafe-number.md");
  });

  test("accepts empty and comment-only frontmatter as an empty metadata object", () => {
    const empty = parseNote("notes/empty.md", "---\n---\n# Empty\n");
    const comment = parseNote(
      "notes/comment.md",
      "---\n# metadata intentionally empty\n---\n# Comment\n",
    );
    expect(empty.metadata).toEqual({});
    expect(comment.metadata).toEqual({});
  });

  test("rejects non-JSON-like foreign metadata values and cycles", () => {
    expect(metadataValueFromUnknown({ valid: ["one", 2, true, null] })).toEqual({
      valid: ["one", 2, true, null],
    });
    expect(metadataValueFromUnknown({ invalid: Number.NaN })).toBeUndefined();
    expect(metadataValueFromUnknown({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(metadataValueFromUnknown(cyclic)).toBeUndefined();

    let getterRead = false;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        getterRead = true;
        return "not data";
      },
    });
    expect(metadataValueFromUnknown(accessor)).toBeUndefined();
    expect(getterRead).toBe(false);
  });

  test("keeps source line count while masking non-prose", () => {
    const source = "---\ntitle: Hidden\n---\nVisible `code`\n";
    expect(searchableMarkdown(source).split("\n")).toEqual(["", "", "", "Visible ", ""]);
  });

  test("requires a closing code fence to match the opening character and length", () => {
    const source = [
      "````md",
      "[[missing-one]]",
      "```",
      "[[missing-two]]",
      "~~~~",
      "[[missing-three]]",
      "```` not-a-closing-fence",
      "[[missing-four]]",
      "````",
      "[[notes/real]]",
    ].join("\n");

    expect(parseNote("notes/source.md", source).links).toEqual([
      { target: "notes/real", line: 10, embedded: false },
    ]);
  });

  test("masks inline code spans that cross line endings", () => {
    const note = parseNote("notes/source.md", [
      "Before `code",
      "[[missing]]",
      "end` after [[notes/real]].",
    ].join("\n"));

    expect(note.links).toEqual([
      { target: "notes/real", line: 3, embedded: false },
    ]);
  });

  test("does not pair inline code delimiters across Markdown blocks", () => {
    const note = parseNote("notes/source.md", [
      "Before `unclosed",
      "",
      "[[notes/real]]",
      "",
      "End ` trailing",
    ].join("\n"));

    expect(note.links).toEqual([
      { target: "notes/real", line: 3, embedded: false },
    ]);
  });

  test("ignores escaped links, indented code, and raw HTML code blocks", () => {
    const note = parseNote("notes/source.md", [
      String.raw`Escaped \[[missing-one]].`,
      "    [[missing-two]]",
      "<pre>",
      "[[missing-three]]",
      "</pre>",
      "<code>[[missing-four]]</code>",
      "[[notes/real]]",
    ].join("\n"));

    expect(note.links).toEqual([
      { target: "notes/real", line: 7, embedded: false },
    ]);
  });

  test("does not accept a backtick fence info string containing a backtick", () => {
    const note = parseNote("notes/source.md", [
      "```language`invalid",
      "[[notes/real]]",
      "```",
    ].join("\n"));

    expect(note.links).toEqual([
      { target: "notes/real", line: 2, embedded: false },
    ]);
  });
});

describe("graph lint", () => {
  test("does not let catalog links hide contextual orphans", () => {
    const notes = [
      parseNote("index.md", "# Index\n\n[[notes/alpha]]\n[[notes/beta]]\n"),
      parseNote("notes/alpha.md", "# Alpha concept\n\nSee [[notes/beta|the beta concept]].\n"),
      parseNote("notes/beta.md", "# Beta concept\n\nConnected from alpha.\n"),
      parseNote("notes/gamma.md", "# Gamma concept\n\nStill isolated.\n"),
    ];
    const analysis = analyzeVault(notes);
    expect(analysis.contextualLinks).toHaveLength(1);
    expect(analysis.orphans).toEqual(["notes/gamma.md"]);
    expect(analysis.issues).toEqual([]);
  });

  test("treats a configured nested catalog as navigation", () => {
    const notes = [
      parseNote("navigation/catalog.md", "# Catalog\n\n[[notes/alpha]]\n[[notes/beta]]\n"),
      parseNote("notes/alpha.md", "# Alpha\n\n[[notes/beta]]\n"),
      parseNote("notes/beta.md", "# Beta\n"),
    ];
    const analysis = analyzeVault(notes, { catalogNoteId: "navigation/catalog.md" });

    expect(analysis.noteCount).toBe(2);
    expect(analysis.contextualLinks).toEqual([
      { source: "notes/alpha.md", target: "notes/beta.md", line: 3 },
    ]);
    expect(renderCatalog(notes, "navigation/catalog.md")).not.toContain(
      "[[navigation/catalog|Catalog]]",
    );
  });

  test("reports broken, ambiguous, and high-confidence unlinked mentions", () => {
    const notes = [
      parseNote("source.md", [
        "# Source",
        "",
        "Alpha concept belongs here. Context design matters too.",
        "[[shared]] and [[missing]]",
      ].join("\n")),
      parseNote("notes/alpha.md", "# Alpha concept\n"),
      parseNote("notes/context.md", "---\naliases: [Context design]\n---\n# Context engineering\n"),
      parseNote("one/shared.md", "# Shared one\n"),
      parseNote("two/shared.md", "# Shared two\n"),
    ];
    const analysis = analyzeVault(notes);
    expect(analysis.issues.map((issue) => issue.kind)).toEqual(["broken", "ambiguous"]);
    expect(analysis.mentions.map((candidate) => candidate.target)).toEqual([
      "notes/alpha.md",
      "notes/context.md",
    ]);
  });

  test("does not suggest phrases shared by multiple target notes", () => {
    const analysis = analyzeVault([
      parseNote("source.md", "# Source\n\nShared concept belongs in this paragraph.\n"),
      parseNote("one/shared.md", "# Shared concept\n"),
      parseNote("two/shared.md", "# Shared concept\n"),
    ]);

    expect(analysis.mentions).toEqual([]);
  });

  test("bounds mention discovery to pairs touching a scoped note", () => {
    const notes = [
      parseNote(
        "notes/alpha.md",
        "# Alpha concept\n\nBeta concept and Gamma concept matter.\n",
      ),
      parseNote(
        "notes/beta.md",
        "# Beta concept\n\nGamma concept matters independently.\n",
      ),
      parseNote(
        "notes/gamma.md",
        "# Gamma concept\n\nAlpha concept matters independently.\n",
      ),
    ];
    const scoped = analyzeVault(notes, {
      mentionScope: (note) => note.id === "notes/alpha",
    });

    expect(scoped.mentions.map(({ source, target }) => [source, target]))
      .toEqual([
        ["notes/alpha.md", "notes/beta.md"],
        ["notes/alpha.md", "notes/gamma.md"],
        ["notes/gamma.md", "notes/alpha.md"],
      ]);
    const structureOnly = analyzeVault(notes, {
      mentionScope: () => false,
      maxMentionPairs: 0,
      maxMentions: 0,
    });
    expect(structureOnly.mentions).toEqual([]);
    expect(structureOnly.noteConnections).toEqual(
      scoped.noteConnections,
    );
  });

  test("skips quadratic mention pairing for a CLI-scale structure scan", () => {
    const notes = Array.from({ length: 8_000 }, (_, index) =>
      parseNote(
        `notes/n-${index}.md`,
        `# Structurally unique note ${index}\n`,
      ));
    const analysis = analyzeVault(notes, {
      mentionScope: () => false,
      maxMentionPairs: 0,
      maxMentions: 0,
    });

    expect(analysis.noteCount).toBe(notes.length);
    expect(analysis.mentions).toEqual([]);
    expect(analysis.noteConnections).toHaveLength(notes.length);
  }, 5_000);

  test("accepts the exact connection-observation bound across links and relations", () => {
    const source = parseNote("notes/source.md", [
      "---",
      "relations:",
      "  Invalid: notes/target",
      "  supports: notes/target",
      "---",
      "# Source",
      "",
      "[[notes/target]]",
    ].join("\n"));
    const analysis = analyzeVault([
      source,
      parseNote("notes/target.md", "# Target\n"),
    ], {
      maxConnectionObservations: 3,
      mentionScope: () => false,
      maxMentionPairs: 0,
      maxMentions: 0,
    });

    expect(analysis.relationIssues).toHaveLength(1);
    expect(analysis.contextualLinks).toHaveLength(1);
    expect(analysis.authoredRelations).toHaveLength(1);
  });

  test("stops before reading or indexing a connection beyond the shared bound", () => {
    const parsed = parseNote("notes/source.md", [
      "---",
      "relations:",
      "  Invalid: notes/target",
      "  supports: notes/target",
      "---",
      "# Source",
      "",
      "[[notes/target]]",
    ].join("\n"));
    let excessRecordReads = 0;
    const source = {
      ...parsed,
      relationDeclarations: [
        ...(parsed.relationDeclarations ?? []),
        {
          get predicate(): string {
            excessRecordReads += 1;
            throw new Error("excess relation record was inspected");
          },
          get target(): string {
            excessRecordReads += 1;
            throw new Error("excess relation record was inspected");
          },
          get line(): number {
            excessRecordReads += 1;
            throw new Error("excess relation record was inspected");
          },
        },
      ],
    };

    let rejection: unknown;
    try {
      analyzeVault([
        source,
        parseNote("notes/target.md", "# Target\n"),
      ], {
        maxConnectionObservations: 3,
        mentionScope: () => false,
        maxMentionPairs: 0,
        maxMentions: 0,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultAnalysisBudgetError);
    expect(rejection).toMatchObject({
      kind: "connection-observations",
      limit: 3,
    });
    expect(excessRecordReads).toBe(0);
  });

  test("checks the shared bound before resolving an excess wikilink", () => {
    const parsed = parseNote(
      "notes/source.md",
      "# Source\n\n[[notes/target]]\n",
    );
    let excessLinkReads = 0;
    const source = {
      ...parsed,
      links: [
        ...parsed.links,
        {
          get target(): string {
            excessLinkReads += 1;
            throw new Error("excess wikilink was inspected");
          },
          line: 3,
          embedded: false,
        },
      ],
    };

    let rejection: unknown;
    try {
      analyzeVault([
        source,
        parseNote("notes/target.md", "# Target\n"),
      ], {
        maxConnectionObservations: 1,
        mentionScope: () => false,
        maxMentionPairs: 0,
        maxMentions: 0,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultAnalysisBudgetError);
    expect(rejection).toMatchObject({
      kind: "connection-observations",
      limit: 1,
    });
    expect(excessLinkReads).toBe(0);
  });

  test("stops before doing inner-pair mention work beyond the pair budget", () => {
    let phraseComparisons = 0;
    const lowerSearchableText = {
      indexOf: (): number => {
        phraseComparisons += 1;
        return -1;
      },
      length: 0,
    };
    const source = {
      ...parseNote("notes/alpha.md", "# Alpha concept\n"),
      searchableText: {
        toLocaleLowerCase: () => lowerSearchableText,
      } as unknown as string,
    };

    let rejection: unknown;
    try {
      analyzeVault([
        source,
        parseNote("notes/beta.md", "# Beta concept\n"),
        parseNote("notes/gamma.md", "# Gamma concept\n"),
      ], {
        maxMentionPairs: 1,
        maxMentions: 1,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultAnalysisBudgetError);
    expect(rejection).toMatchObject({
      kind: "mention-pairs",
      limit: 1,
    });
    expect(phraseComparisons).toBe(1);
  });

  test("checks the materialized mention budget before appending", () => {
    let rejection: unknown;
    try {
      analyzeVault([
        parseNote(
          "notes/alpha.md",
          "# Alpha concept\n\nBeta concept belongs here.\n",
        ),
        parseNote("notes/beta.md", "# Beta concept\n"),
      ], {
        maxMentionPairs: 2,
        maxMentions: 0,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VaultAnalysisBudgetError);
    expect(rejection).toMatchObject({ kind: "mentions", limit: 0 });
  });

  test("ignores attachment embeds", () => {
    const analysis = analyzeVault([
      parseNote("note.md", "# Note\n\n![[assets/diagram.png]]\n"),
    ]);
    expect(analysis.issues).toEqual([]);
  });

  test("derives backlinks and per-note contextual counts", () => {
    const analysis = analyzeVault([
      parseNote("index.md", "# Index\n\n[[notes/alpha]]\n"),
      parseNote("notes/alpha.md", "# Alpha\n\n[[notes/beta]] and [[notes/gamma]].\n"),
      parseNote("notes/beta.md", "# Beta\n\n[[notes/gamma]].\n"),
      parseNote("notes/gamma.md", "# Gamma\n"),
    ]);

    expect(analysis.backlinks).toEqual([
      { source: "notes/alpha.md", target: "notes/beta.md", line: 3 },
      { source: "notes/alpha.md", target: "notes/gamma.md", line: 3 },
      { source: "notes/beta.md", target: "notes/gamma.md", line: 3 },
    ]);
    expect(analysis.noteConnections).toEqual([
      {
        id: "notes/alpha",
        path: "notes/alpha.md",
        inboundContextualCount: 0,
        outboundContextualCount: 2,
        backlinks: [],
        inboundRelationCount: 0,
        outboundRelationCount: 0,
        relationBacklinks: [],
      },
      {
        id: "notes/beta",
        path: "notes/beta.md",
        inboundContextualCount: 1,
        outboundContextualCount: 1,
        backlinks: [{ source: "notes/alpha.md", target: "notes/beta.md", line: 3 }],
        inboundRelationCount: 0,
        outboundRelationCount: 0,
        relationBacklinks: [],
      },
      {
        id: "notes/gamma",
        path: "notes/gamma.md",
        inboundContextualCount: 2,
        outboundContextualCount: 0,
        backlinks: [
          { source: "notes/alpha.md", target: "notes/gamma.md", line: 3 },
          { source: "notes/beta.md", target: "notes/gamma.md", line: 3 },
        ],
        inboundRelationCount: 0,
        outboundRelationCount: 0,
        relationBacklinks: [],
      },
    ]);
  });

  test("resolves only exact relation IDs and diagnoses shorthand instead of guessing", () => {
    const source = parseNote("notes/deep/source.md", [
      "---",
      "relations:",
      "  exact-match: concepts/exact",
      "  nearby: ./neighbor",
      "  named-after: unique",
      "  conflicts-with: shared",
      "  depends-on: missing",
      "---",
      "# Source",
    ].join("\n"));
    const notes = [
      source,
      parseNote("concepts/exact.md", "# Exact\n"),
      parseNote("notes/deep/neighbor.md", "# Neighbor\n"),
      parseNote("other/unique.md", "# Unique\n"),
      parseNote("one/shared.md", "# Shared one\n"),
      parseNote("two/shared.md", "# Shared two\n"),
    ];
    const analysis = analyzeVault(notes);
    const reversed = analyzeVault([...notes].reverse());

    expect(analysis.authoredRelations).toEqual([
      {
        source: "notes/deep/source",
        target: "concepts/exact",
        predicate: "exact-match",
        provenance: {
          kind: "frontmatter",
          source: "notes/deep/source.md",
          line: 3,
          authoredTarget: "concepts/exact",
        },
      },
    ]);
    expect(analysis.relationIssues.map((issue) => {
      const { kind, source: issueSource, line, predicate, target } = issue;
      return { kind, source: issueSource, line, predicate, target };
    })).toEqual([
      {
        kind: "malformed",
        source: "notes/deep/source.md",
        line: 4,
        predicate: "nearby",
        target: "./neighbor",
      },
      {
        kind: "malformed",
        source: "notes/deep/source.md",
        line: 5,
        predicate: "named-after",
        target: "unique",
      },
      {
        kind: "malformed",
        source: "notes/deep/source.md",
        line: 6,
        predicate: "conflicts-with",
        target: "shared",
      },
      {
        kind: "broken",
        source: "notes/deep/source.md",
        line: 7,
        predicate: "depends-on",
        target: "missing",
      },
    ]);
    const malformedMessages = analysis.relationIssues.flatMap((issue) =>
      issue.kind === "malformed" ? [issue.message] : []);
    expect(malformedMessages[0]).toContain("extensionless vault-root note ID");
    expect(malformedMessages[1]).toContain("only a basename");
    expect(malformedMessages[2]).toContain("only a basename");
    expect(reversed.authoredRelations).toEqual(analysis.authoredRelations);
    expect(reversed.relationIssues).toEqual(analysis.relationIssues);
    expect(analysis.issues).toEqual([]);
    expect(analysis.backlinks).toEqual([]);
    expect(analysis.noteConnections.find(({ id }) => id === "concepts/exact"))
      .toMatchObject({
        inboundRelationCount: 1,
        outboundRelationCount: 0,
        relationBacklinks: [analysis.authoredRelations[0]],
      });
  });

  test("deduplicates canonical assertions, keeps predicates distinct, and never adds reciprocals", () => {
    const source = parseNote("notes/source.md", [
      "---",
      "relations:",
      "  supports:",
      "    - notes/target",
      "    - notes/target",
      "  challenges: notes/target",
      "---",
      "# Source",
    ].join("\n"));
    const target = parseNote("notes/target.md", "# Target\n");
    const analysis = analyzeVault([target, source]);
    const reversed = analyzeVault([source, target]);

    expect(analysis.authoredRelations.map(({ source: owner, predicate, target: related }) => ({
      source: owner,
      predicate,
      target: related,
    }))).toEqual([
      { source: "notes/source", predicate: "challenges", target: "notes/target" },
      { source: "notes/source", predicate: "supports", target: "notes/target" },
    ]);
    expect(analysis.authoredRelations[1]?.provenance).toMatchObject({
      line: 4,
      authoredTarget: "notes/target",
    });
    expect(reversed.authoredRelations).toEqual(analysis.authoredRelations);
    expect(reversed.noteConnections).toEqual(analysis.noteConnections);
    expect(analysis.authoredRelations).not.toContainEqual(
      expect.objectContaining({ source: "notes/target", target: "notes/source" }),
    );
    expect(analysis.noteConnections).toEqual([
      expect.objectContaining({
        id: "notes/source",
        inboundRelationCount: 0,
        outboundRelationCount: 2,
        relationBacklinks: [],
      }),
      expect.objectContaining({
        id: "notes/target",
        inboundRelationCount: 2,
        outboundRelationCount: 0,
        relationBacklinks: analysis.authoredRelations,
      }),
    ]);
  });

  test("lets callers exclude note classes from semantic-link suggestions", () => {
    const analysis = analyzeVault([
      parseNote("notes/public.md", "# Public note\n"),
      parseNote("sources/reference.md", "---\nsuggest: no\n---\n# Reference source\n"),
    ], {
      includeInSuggestions: (note) => note.properties.suggest !== "no",
    });

    expect(analysis.orphans).toEqual(["notes/public.md"]);
  });
});

describe("note lookup", () => {
  const context = parseNote("notes/context.md", "---\naliases: [Context design]\n---\n# Context engineering\n");
  const notes = [
    context,
    parseNote("one/shared.md", "# Shared one\n"),
    parseNote("two/shared.md", "# Shared two\n"),
  ];

  test("finds notes by path, title, and alias", () => {
    expect(lookupNote(notes, "notes/context.md")).toEqual({ kind: "found", note: context });
    expect(lookupNote(notes, "Context engineering")).toEqual({ kind: "found", note: context });
    expect(lookupNote(notes, "context design")).toEqual({ kind: "found", note: context });
  });

  test("reports ambiguous basenames and missing notes", () => {
    expect(lookupNote(notes, "shared")).toMatchObject({
      kind: "ambiguous",
      query: "shared",
      candidates: [{ path: "one/shared.md" }, { path: "two/shared.md" }],
    });
    expect(lookupNote(notes, "unknown")).toEqual({ kind: "missing", query: "unknown" });
  });
});

describe("catalog generation", () => {
  test("groups notes, uses summaries, and replaces only the managed block", () => {
    const notes = [
      parseNote("index.md", "# Knowledge base\n"),
      parseNote("notes/context.md", "# Context engineering\n\nDesigning bounded model input.\n"),
      parseNote("plans/runtime.md", [
        "---",
        "type: plan",
        "status: accepted",
        "area: runtime",
        'description: "Build the runtime boundary."',
        "---",
        "# Runtime plan",
      ].join("\n")),
      parseNote("riffs/2026-01-01-agents.md", "# Working with agents\n"),
    ];
    const catalog = renderCatalog(notes);
    expect(catalog).toContain("### Notes");
    expect(catalog).toContain("[[notes/context|Context engineering]] — Designing bounded model input.");
    expect(catalog).toContain("[[plans/runtime|Runtime plan]] — Status: accepted. Build the runtime boundary.");
    expect(catalog).toContain("### Riffs");

    const original = `# Knowledge base\n\nKeep this prose.\n\n${catalogStart}\nold\n${catalogEnd}\n`;
    const updated = replaceCatalog(original, catalog);
    expect(updated).toStartWith("# Knowledge base\n\nKeep this prose.");
    expect(updated).toContain(catalog);
    expect(updated).not.toContain("\nold\n");
  });

  test("adds a catalog boundary when initializing an index", () => {
    const updated = replaceCatalog("# Knowledge base\n", renderCatalog([]));
    expect(updated).toContain("_No durable notes have been filed yet._");
    expect(updated).toEndWith(`${catalogEnd}\n`);
  });

  test("refuses malformed managed boundaries", () => {
    expect(() => replaceCatalog(`# Index\n${catalogStart}\n`, renderCatalog([]))).toThrow(
      "malformed managed catalog boundary",
    );
  });

  test("neutralizes foreign catalog text and encodes unsafe path characters", () => {
    const note = parseNote("notes/a|b].md", [
      "---",
      'title: "Safe\\n<!-- kb:catalog:end -->\\n# Injected"',
      'description: "Summary <!-- kb:catalog:start --> text"',
      "---",
    ].join("\n"));
    const catalog = renderCatalog([note]);

    expect(catalog.match(new RegExp(catalogStart, "g"))).toHaveLength(1);
    expect(catalog.match(new RegExp(catalogEnd, "g"))).toHaveLength(1);
    expect(catalog).toContain("[[notes/a%7Cb%5D|Safe ‹!-- kb:catalog:end --› # Injected]]");
    expect(catalog).toContain("Summary ‹!-- kb:catalog:start --› text");
    expect(() => replaceCatalog(`# Index\n\n${catalog}\n`, catalog)).not.toThrow();
  });
});
