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
      },
      {
        id: "notes/beta",
        path: "notes/beta.md",
        inboundContextualCount: 1,
        outboundContextualCount: 1,
        backlinks: [{ source: "notes/alpha.md", target: "notes/beta.md", line: 3 }],
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
      },
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
      'title: "Safe\\n<!-- oh:catalog:end -->\\n# Injected"',
      'description: "Summary <!-- oh:catalog:start --> text"',
      "---",
    ].join("\n"));
    const catalog = renderCatalog([note]);

    expect(catalog.match(new RegExp(catalogStart, "g"))).toHaveLength(1);
    expect(catalog.match(new RegExp(catalogEnd, "g"))).toHaveLength(1);
    expect(catalog).toContain("[[notes/a%7Cb%5D|Safe ‹!-- oh:catalog:end --› # Injected]]");
    expect(catalog).toContain("Summary ‹!-- oh:catalog:start --› text");
    expect(() => replaceCatalog(`# Index\n\n${catalog}\n`, catalog)).not.toThrow();
  });
});
