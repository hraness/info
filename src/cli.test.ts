import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentContextMarkerForScope,
  agentContextNotePath,
} from "./agent-context.js";
import { main, parseArguments } from "./cli.js";
import { scanVault, type ScanVaultOptions } from "./vault.js";

function captureOutput(): {
  readonly output: { stdout: (value: string) => void; stderr: (value: string) => void };
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("expected CLI JSON output to be an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function stringProperty(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new TypeError(`expected ${key} to be a string`);
  }
  return value;
}

function arrayProperty(
  object: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new TypeError(`expected ${key} to be an array`);
  }
  return value as readonly unknown[];
}

describe("kb argument parsing", () => {
  test("delegates capture commands and rejects secret-shaped unknown values without echoing them", () => {
    expect(parseArguments(["clip", "https://example.com"])).toEqual({
      ok: true,
      value: { kind: "clip", arguments: ["capture", "https://example.com"] },
    });
    expect(parseArguments(["inspect", "https://example.com"])).toEqual({
      ok: true,
      value: { kind: "clip", arguments: ["inspect", "https://example.com"] },
    });
    expect(parseArguments(["clip", "--help"])).toEqual({
      ok: true,
      value: { kind: "clip", arguments: ["help"] },
    });
    expect(parseArguments(["pdf", "document.pdf", "--slug", "document"])).toEqual({
      ok: true,
      value: {
        kind: "pdf",
        arguments: ["document.pdf", "--slug", "document"],
      },
    });
    expect(parseArguments(["check", "--secret=do-not-print"])).toEqual({
      ok: false,
      message: "unknown check option",
    });
  });

  test("parses vault roots, custom indexes, and backlink queries", () => {
    expect(parseArguments(["backlinks", "Context design", "--root", "vault", "--index", "home.md", "--json"]))
      .toEqual({
        ok: true,
        value: {
          kind: "backlinks",
          root: "vault",
          options: { index: "home.md" },
          json: true,
          note: "Context design",
        },
      });
  });

  test("parses explicit semantic index and search options", () => {
    expect(parseArguments(["index", "--root", "vault", "--database", "cache.sqlite", "--force", "--json"]))
      .toEqual({
        ok: true,
        value: {
          kind: "index",
          root: "vault",
          database: "cache.sqlite",
          force: true,
          json: true,
        },
      });
    expect(parseArguments([
      "search",
      "bounded",
      "ingestion",
      "--root",
      "vault",
      "--mode",
      "keyword",
      "--limit",
      "4",
      "--min-score",
      "0.2",
    ])).toEqual({
      ok: true,
      value: {
        kind: "search",
        root: "vault",
        mode: "keyword",
        limit: 4,
        minScore: 0.2,
        query: "bounded ingestion",
        json: false,
      },
    });
    expect(parseArguments(["search", "query", "--mode", "unknown"])).toEqual({
      ok: false,
      message: "--mode must be semantic or keyword",
    });
  });

  test("parses metadata queries and bounded graph navigation", () => {
    expect(parseArguments([
      "list",
      "--root",
      "vault",
      "--where",
      "type=plan",
      "--where",
      "priority=2",
      "--has",
      "owner.name",
      "--tag",
      "Browser",
      "--sort",
      "meta.area",
      "--order",
      "desc",
      "--limit",
      "5",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "list",
        root: "vault",
        options: {},
        filters: [
          { kind: "equals", path: "type", value: "plan" },
          { kind: "equals", path: "priority", value: 2 },
          { kind: "exists", path: "owner.name" },
        ],
        tags: ["Browser"],
        sort: { kind: "metadata", path: "area" },
        direction: "desc",
        limit: 5,
        json: true,
      },
    });
    expect(parseArguments([
      "links",
      "Agent memory",
      "--root",
      "vault",
      "--direction",
      "in",
      "--depth",
      "3",
      "--limit",
      "25",
    ])).toEqual({
      ok: true,
      value: {
        kind: "links",
        root: "vault",
        options: {},
        json: false,
        note: "Agent memory",
        direction: "in",
        depth: 3,
        limit: 25,
      },
    });
  });

  test("parses compact note and relationship authoring commands", () => {
    expect(parseArguments([
      "note",
      "create",
      "notes/durable-memory",
      "--title",
      "Durable memory",
      "--type",
      "concept",
      "--tag",
      "agents",
      "--tag",
      "memory",
      "--body-file",
      "draft.md",
      "--root",
      "vault",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "note-create",
        root: "vault",
        input: {
          id: "notes/durable-memory",
          title: "Durable memory",
          type: "concept",
          tags: ["agents", "memory"],
        },
        bodyFile: "draft.md",
        json: true,
      },
    });

    const revision: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
    expect(parseArguments([
      "relation",
      "add",
      "notes/a",
      "builds-on",
      "notes/b",
      "--expected-revision",
      revision,
      "--root",
      "vault",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "relation",
        action: "add",
        root: "vault",
        source: "notes/a",
        predicate: "builds-on",
        target: "notes/b",
        expectedRevision: revision,
        json: true,
      },
    });
    expect(parseArguments([
      "relation",
      "remove",
      "notes/a",
      "builds-on",
      "notes/b",
    ])).toEqual({
      ok: true,
      value: {
        kind: "relation",
        action: "remove",
        root: ".",
        source: "notes/a",
        predicate: "builds-on",
        target: "notes/b",
        json: false,
      },
    });
    expect(parseArguments(["relation", "list", "notes/a", "--json"])).toEqual({
      ok: true,
      value: {
        kind: "relation",
        action: "list",
        root: ".",
        source: "notes/a",
        json: true,
      },
    });

    expect(parseArguments([
      "note",
      "create",
      "notes/a",
      "--title",
      "A",
      "--body",
      "inline",
      "--body-file",
      "body.md",
    ])).toEqual({
      ok: false,
      message: "note create accepts either --body or --body-file, not both",
    });
    expect(parseArguments([
      "relation",
      "add",
      "notes/a",
      "builds-on",
      "notes/b",
      "--expected-revision",
      "sha256:not-a-revision",
    ])).toEqual({
      ok: false,
      message: "--expected-revision must be sha256 followed by 64 lowercase hexadecimal characters",
    });
  });

  test("parses Datalog, percolation, and lane-safe catalog checks with strict bounds", () => {
    const query = '[:find ?id :where [?note ":note/id" ?id]]';
    expect(parseArguments([
      "datalog",
      query,
      "--root",
      "vault",
      "--limit",
      "12",
      "--timeout-ms",
      "250",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "datalog",
        root: "vault",
        query,
        limit: 12,
        timeoutMs: 250,
        json: true,
      },
    });
    expect(parseArguments([
      "datalog",
      "--query-file",
      "query.edn",
      "--rules-file",
      "rules.edn",
    ])).toEqual({
      ok: true,
      value: {
        kind: "datalog",
        root: ".",
        queryFile: "query.edn",
        rulesFile: "rules.edn",
        limit: 100,
        json: false,
      },
    });
    expect(parseArguments([
      "percolate",
      "notes/alpha",
      "--root",
      "vault",
      "--min-support",
      "3",
      "--limit",
      "8",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "percolate",
        root: "vault",
        note: "notes/alpha",
        minSupport: 3,
        limit: 8,
        json: true,
      },
    });
    expect(parseArguments(["check", "--root", "vault", "--no-catalog", "--json"]))
      .toEqual({
        ok: true,
        value: {
          kind: "check",
          root: "vault",
          options: {},
          noCatalog: true,
          json: true,
        },
      });

    expect(parseArguments(["datalog", query, "--query-file", "query.edn"]))
      .toEqual({
        ok: false,
        message: "datalog requires exactly one query or --query-file",
      });
    expect(parseArguments(["datalog", query, "--limit", "1001"])).toEqual({
      ok: false,
      message: "--limit must be an integer from 1 through 1000",
    });
    expect(parseArguments(["datalog", query, "--timeout-ms", "5001"]))
      .toEqual({
        ok: false,
        message: "--timeout-ms must be an integer from 1 through 5000",
      });
    expect(parseArguments(["percolate", "--min-support", "1"])).toEqual({
      ok: false,
      message: "--min-support must be an integer from 2 through 1000",
    });
    expect(parseArguments(["graph", "--no-catalog"])).toEqual({
      ok: false,
      message: "unknown graph option",
    });
  });

  test("parses repository context lookup and agent mapping commands", () => {
    expect(parseArguments([
      "context",
      "packages/kb/src/cli.ts",
      "--root",
      "kb",
      "--repo",
      ".",
      "--kind",
      "file",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "context",
        root: "kb",
        repository: ".",
        target: "packages/kb/src/cli.ts",
        targetKind: "file",
        json: true,
      },
    });
    expect(parseArguments([
      "agents",
      "audit",
      "--root",
      "kb",
      "--repo",
      ".",
    ])).toEqual({
      ok: true,
      value: {
        kind: "agents",
        action: "audit",
        root: "kb",
        repository: ".",
        json: false,
      },
    });
    expect(parseArguments([
      "agents",
      "identity",
      "packages/kb",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "agent-identity",
        scope: "packages/kb",
        json: true,
      },
    });
    expect(parseArguments(["context", "src", "--kind", "guess"])).toEqual({
      ok: false,
      message: "--kind must be auto, file, or directory",
    });
    expect(parseArguments(["agents", "fix"])).toEqual({
      ok: false,
      message: "agents requires identity, check, or audit",
    });
    expect(parseArguments(["agents", "identity"])).toEqual({
      ok: false,
      message: "agents identity requires exactly one repository scope",
    });
  });

  test("distinguishes typed filters from quoted string values without rounding identifiers", () => {
    expect(parseArguments([
      "list",
      "--where",
      'enabled="true"',
      "--where",
      "unset='null'",
      "--where",
      'external_id="9007199254740993"',
    ])).toMatchObject({
      ok: true,
      value: {
        filters: [
          { kind: "equals", path: "enabled", value: "true" },
          { kind: "equals", path: "unset", value: "null" },
          { kind: "equals", path: "external_id", value: "9007199254740993" },
        ],
      },
    });
    expect(parseArguments([
      "list",
      "--where",
      "external_id=9007199254740993",
    ])).toEqual({
      ok: false,
      message: "numeric --where values must be safe integers; quote large identifiers",
    });
  });
});

describe("kb vault commands", () => {
  test("initializes, refreshes, checks, graphs, and derives backlinks without editing notes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-"));
    const vault = join(temporary, "vault");
    try {
      const initOutput = captureOutput();
      expect(await main(["init", vault], initOutput.output)).toBe(0);
      expect(initOutput.stdout()).toContain("Initialized");

      await mkdir(join(vault, "notes"), { recursive: true });
      const alphaPath = join(vault, "notes", "alpha.md");
      await writeFile(alphaPath, "# Alpha\n\nSee [[notes/beta]].\n", "utf8");
      await writeFile(join(vault, "notes", "beta.md"), [
        "---",
        "type: plan",
        "area: agent-memory",
        "status: in-progress",
        "tags: [browser, ingestion]",
        "---",
        "# Beta",
        "",
      ].join("\n"), "utf8");

      const staleOutput = captureOutput();
      expect(await main(["check", "--root", vault], staleOutput.output)).toBe(3);
      expect(staleOutput.stdout()).toContain("catalog is stale");

      const refreshOutput = captureOutput();
      expect(await main(["refresh", "--root", vault], refreshOutput.output)).toBe(0);
      expect(refreshOutput.stdout()).toContain("Index: updated");

      const graphOutput = captureOutput();
      expect(await main(["graph", "--root", vault, "--json"], graphOutput.output)).toBe(0);
      expect(JSON.parse(graphOutput.stdout())).toMatchObject({
        noteCount: 2,
        contextualLinkCount: 1,
      });

      const backlinkOutput = captureOutput();
      expect(await main(["backlinks", "Beta", "--root", vault], backlinkOutput.output)).toBe(0);
      expect(backlinkOutput.stdout()).toContain("notes/alpha.md:3");

      const listOutput = captureOutput();
      expect(await main([
        "list",
        "--root",
        vault,
        "--where",
        "type=plan",
        "--tag",
        "BROWSER",
        "--sort",
        "area",
        "--json",
      ], listOutput.output)).toBe(0);
      expect(JSON.parse(listOutput.stdout())).toMatchObject({
        count: 1,
        notes: [{ path: "notes/beta.md", tags: ["browser", "ingestion"] }],
      });

      const linksOutput = captureOutput();
      expect(await main([
        "links",
        "Beta",
        "--root",
        vault,
        "--direction",
        "in",
        "--json",
      ], linksOutput.output)).toBe(0);
      expect(JSON.parse(linksOutput.stdout())).toMatchObject({
        note: "notes/beta.md",
        direction: "in",
        limit: 50,
        truncated: false,
        nodes: [{ path: "notes/beta.md", distance: 0 }, { path: "notes/alpha.md", distance: 1 }],
      });
      expect(await Bun.file(alphaPath).text()).toBe("# Alpha\n\nSee [[notes/beta]].\n");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("authors notes and typed relationships, queries Datalog, and percolates evidence end to end", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-graph-"));
    const vault = join(temporary, "vault");
    try {
      expect(await main(["init", vault], captureOutput().output)).toBe(0);

      const alphaOutput = captureOutput();
      expect(await main([
        "note",
        "create",
        "notes/alpha",
        "--title",
        "Alpha",
        "--tag",
        "agent-memory",
        "--body",
        "# Alpha\n\nA durable write path.\n",
        "--root",
        vault,
        "--json",
      ], alphaOutput.output)).toBe(0);
      const alpha = parseJsonObject(alphaOutput.stdout());
      expect(alpha).toMatchObject({
        changed: true,
        path: "notes/alpha.md",
        relations: [],
      });
      const alphaRevision = stringProperty(alpha, "revision");
      expect(alphaRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);

      const betaBody = join(temporary, "beta-body.md");
      await writeFile(betaBody, "# Beta\n\nA local graph projection.\n", "utf8");
      const betaOutput = captureOutput();
      expect(await main([
        "note",
        "create",
        "notes/beta",
        "--title",
        "Beta",
        "--tag",
        "agent-memory",
        "--body-file",
        betaBody,
        "--root",
        vault,
        "--json",
      ], betaOutput.output)).toBe(0);
      expect(JSON.parse(betaOutput.stdout())).toMatchObject({
        changed: true,
        path: "notes/beta.md",
      });

      const gammaOutput = captureOutput();
      expect(await main([
        "note",
        "create",
        "notes/gamma",
        "--title",
        "Gamma",
        "--tag",
        "agent-memory",
        "--root",
        vault,
        "--json",
      ], gammaOutput.output)).toBe(0);

      const laneCheck = captureOutput();
      expect(await main([
        "check",
        "--root",
        vault,
        "--no-catalog",
        "--json",
      ], laneCheck.output)).toBe(0);
      expect(JSON.parse(laneCheck.stdout())).toMatchObject({
        index: "stale",
        catalogRequired: false,
        relationIssues: [],
      });
      expect(await main([
        "check",
        "--root",
        vault,
      ], captureOutput().output)).toBe(3);

      const addOutput = captureOutput();
      expect(await main([
        "relation",
        "add",
        "notes/alpha",
        "supports",
        "notes/beta",
        "--expected-revision",
        alphaRevision,
        "--root",
        vault,
        "--json",
      ], addOutput.output)).toBe(0);
      const added = parseJsonObject(addOutput.stdout());
      expect(added).toMatchObject({
        changed: true,
        path: "notes/alpha.md",
        relations: [{ predicate: "supports", target: "notes/beta" }],
      });
      const addedRevision = stringProperty(added, "revision");

      const outboundOutput = captureOutput();
      expect(await main([
        "relation",
        "list",
        "notes/alpha",
        "--root",
        vault,
        "--json",
      ], outboundOutput.output)).toBe(0);
      expect(JSON.parse(outboundOutput.stdout())).toMatchObject({
        note: "notes/alpha",
        outboundCount: 1,
        inboundCount: 0,
        outbound: [{
          source: "notes/alpha",
          predicate: "supports",
          target: "notes/beta",
        }],
      });

      const inboundOutput = captureOutput();
      expect(await main([
        "relation",
        "list",
        "notes/beta",
        "--root",
        vault,
        "--json",
      ], inboundOutput.output)).toBe(0);
      expect(JSON.parse(inboundOutput.stdout())).toMatchObject({
        note: "notes/beta",
        outboundCount: 0,
        inboundCount: 1,
        inbound: [{
          source: "notes/alpha",
          predicate: "supports",
          target: "notes/beta",
        }],
      });

      const relationshipQuery = [
        "[:find ?source-id ?predicate ?target-id",
        " :where",
        ' [?edge :edge/kind "relation"]',
        " [?edge :edge/source ?source]",
        " [?edge :edge/target ?target]",
        " [?edge :edge/predicate ?predicate]",
        " [?source :note/id ?source-id]",
        " [?target :note/id ?target-id]]",
      ].join("");
      const datalogOutput = captureOutput();
      expect(await main([
        "datalog",
        relationshipQuery,
        "--root",
        vault,
        "--json",
      ], datalogOutput.output)).toBe(0);
      expect(JSON.parse(datalogOutput.stdout())).toMatchObject({
        query: relationshipQuery,
        columns: ["?source-id", "?predicate", "?target-id"],
        rows: [["notes/alpha", "supports", "notes/beta"]],
        truncated: false,
      });

      const rulesFile = join(temporary, "relationship-rules.edn");
      await writeFile(rulesFile, [
        "[",
        " [(direct-support ?source ?target)",
        '  [?edge :edge/predicate "supports"]',
        "  [?edge :edge/source ?source]",
        "  [?edge :edge/target ?target]]",
        " [(supports-path ?source ?target)",
        "  (direct-support ?source ?target)]",
        " [(supports-path ?source ?target)",
        "  (direct-support ?source ?middle)",
        "  (supports-path ?middle ?target)]",
        "]",
      ].join(""), "utf8");
      const recursiveOutput = captureOutput();
      expect(await main([
        "datalog",
        "[:find ?source-id ?target-id :in $ % :where (supports-path ?source ?target) [?source :note/id ?source-id] [?target :note/id ?target-id]]",
        "--rules-file",
        rulesFile,
        "--root",
        vault,
        "--json",
      ], recursiveOutput.output)).toBe(0);
      expect(JSON.parse(recursiveOutput.stdout())).toMatchObject({
        rows: [["notes/alpha", "notes/beta"]],
      });

      const queryFile = join(temporary, "tag-query.edn");
      await writeFile(
        queryFile,
        '[:find ?id :where [?note ":note/id" ?id] [?note ":note/tag" "agent-memory"]]',
        "utf8",
      );
      const fileQueryOutput = captureOutput();
      expect(await main([
        "datalog",
        "--query-file",
        queryFile,
        "--root",
        vault,
        "--limit",
        "2",
        "--json",
      ], fileQueryOutput.output)).toBe(0);
      expect(JSON.parse(fileQueryOutput.stdout())).toMatchObject({
        columns: ["?id"],
        rows: [["notes/alpha"], ["notes/beta"]],
        truncated: true,
      });

      const percolationOutput = captureOutput();
      expect(await main([
        "percolate",
        "notes/alpha",
        "--root",
        vault,
        "--min-support",
        "2",
        "--json",
      ], percolationOutput.output)).toBe(0);
      const percolation = parseJsonObject(percolationOutput.stdout());
      expect(percolation).toMatchObject({
        note: "notes/alpha",
        minSupport: 2,
      });
      expect(arrayProperty(percolation, "candidates")).toContainEqual(expect.objectContaining({
        kind: "missing-concept",
        tag: "agent-memory",
        suggestedId: "notes/agent-memory",
        support: 3,
      }));

      const removeOutput = captureOutput();
      expect(await main([
        "relation",
        "remove",
        "notes/alpha",
        "supports",
        "notes/beta",
        "--expected-revision",
        addedRevision,
        "--root",
        vault,
        "--json",
      ], removeOutput.output)).toBe(0);
      expect(JSON.parse(removeOutput.stdout())).toMatchObject({
        changed: true,
        path: "notes/alpha.md",
        relations: [],
      });

      const emptyRelations = captureOutput();
      expect(await main([
        "relation",
        "list",
        "notes/alpha",
        "--root",
        vault,
        "--json",
      ], emptyRelations.output)).toBe(0);
      expect(JSON.parse(emptyRelations.stdout())).toMatchObject({
        note: "notes/alpha",
        outboundCount: 0,
        inboundCount: 0,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("fails checks on authored relationship issues even when the catalog is optional", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-relations-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      await mkdir(join(temporary, "notes"), { recursive: true });
      await writeFile(join(temporary, "notes", "source.md"), [
        "---",
        "relations:",
        "  supports:",
        "    - notes/missing",
        "---",
        "# Source",
        "",
      ].join("\n"), "utf8");

      const output = captureOutput();
      expect(await main([
        "check",
        "--root",
        temporary,
        "--no-catalog",
        "--json",
      ], output.output)).toBe(3);
      expect(JSON.parse(output.stdout())).toMatchObject({
        catalogRequired: false,
        relationIssues: [{
          kind: "broken",
          source: "notes/source.md",
          predicate: "supports",
          target: "notes/missing",
        }],
      });

      const terminalOutput = captureOutput();
      expect(await main([
        "check",
        "--root",
        temporary,
        "--no-catalog",
      ], terminalOutput.output)).toBe(3);
      expect(terminalOutput.stdout()).toContain(
        "broken relationship supports → notes/missing",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("sanitizes foreign Datalog cells and secrets in JSON output", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-json-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      const output = captureOutput();
      expect(await main([
        "datalog",
        '[:find ?value :where [?entity ":kb/id" ?value]]',
        "--root",
        temporary,
        "--json",
      ], output.output, {
        queryDatalog: () => Promise.resolve({
          columns: ["?value"],
          rows: [[
            "bad\u001b]8;;https://evil.example\u0007path\u001b]8;;\u0007 Authorization: Bearer runtime-secret",
          ]],
          truncated: false,
          factCount: 1,
        }),
      })).toBe(0);
      expect(output.stdout()).not.toContain("\u001b");
      expect(output.stdout()).not.toContain("runtime-secret");
      expect(arrayProperty(parseJsonObject(output.stdout()), "rows")).toEqual([[
        "badpath Authorization: [REDACTED]",
      ]]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("explains collision-safe concept IDs in terminal percolation output", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-concept-collision-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      await mkdir(join(temporary, "notes"), { recursive: true });
      await writeFile(
        join(temporary, "notes", "foo.md"),
        "---\ntype: note\n---\n# Foo memo\n",
        "utf8",
      );
      await writeFile(
        join(temporary, "notes", "alpha.md"),
        "---\ntags: [foo]\n---\n# Alpha\n",
        "utf8",
      );
      await writeFile(
        join(temporary, "notes", "beta.md"),
        "---\ntags: [foo]\n---\n# Beta\n",
        "utf8",
      );

      const output = captureOutput();
      expect(await main([
        "percolate",
        "--root",
        temporary,
      ], output.output)).toBe(0);
      expect(output.stdout()).toContain(
        "notes/foo-concept  (2 supporting notes); natural ID is occupied by notes/foo",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("uses structure-only scans for graph queries and endpoint-scoped scans for percolation", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-scan-mode-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      await mkdir(join(temporary, "notes"), { recursive: true });
      await writeFile(
        join(temporary, "notes", "alpha.md"),
        "# Alpha concept\n\nBeta concept appears here.\n",
        "utf8",
      );
      await writeFile(
        join(temporary, "notes", "beta.md"),
        "# Beta concept\n\nAlpha concept appears here.\n",
        "utf8",
      );
      const scans: unknown[] = [];
      const dependencies = {
        scanVault: (
          root = ".",
          options: ScanVaultOptions = {},
        ) => {
          scans.push(options);
          return scanVault(root, options);
        },
      };

      expect(await main([
        "relation",
        "list",
        "notes/alpha",
        "--root",
        temporary,
        "--json",
      ], captureOutput().output, dependencies)).toBe(0);
      expect(await main([
        "datalog",
        "[:find ?id :where [?note :note/id ?id]]",
        "--root",
        temporary,
        "--json",
      ], captureOutput().output, dependencies)).toBe(0);
      expect(await main([
        "percolate",
        "Alpha concept",
        "--root",
        temporary,
        "--json",
      ], captureOutput().output, dependencies)).toBe(0);
      expect(await main([
        "percolate",
        "--root",
        temporary,
        "--json",
      ], captureOutput().output, dependencies)).toBe(0);

      expect(scans).toEqual([
        { mentionScope: false },
        { mentionScope: false },
        {
          maxNotes: 10_000,
          maxMentionPairs: 20_000,
          maxMentions: 20_000,
          mentionScope: "Alpha concept",
        },
        {
          maxNotes: 10_000,
          maxMentionPairs: 250_000,
          maxMentions: 50_000,
        },
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("delegates clip arguments and preserves its exit code", async () => {
    const captured: string[][] = [];
    const output = captureOutput();
    const exitCode = await main(["clip", "https://example.com", "--json"], output.output, {
      runClipCommand: (arguments_) => {
        captured.push([...(arguments_ ?? [])]);
        return Promise.resolve(3);
      },
    });
    expect(exitCode).toBe(3);
    expect(captured).toEqual([["capture", "https://example.com", "--json"]]);
  });

  test("delegates PDF arguments and preserves its exit code", async () => {
    const captured: string[][] = [];
    const output = captureOutput();
    const exitCode = await main(["pdf", "document.pdf", "--json"], output.output, {
      runPdfCommand: (arguments_) => {
        captured.push([...(arguments_ ?? [])]);
        return Promise.resolve(3);
      },
    });
    expect(exitCode).toBe(3);
    expect(captured).toEqual([["document.pdf", "--json"]]);
  });

  test("delegates local semantic indexing and search without loading QMD in other commands", async () => {
    const indexedArguments: unknown[] = [];
    const searchedArguments: unknown[] = [];
    const indexOutput = captureOutput();
    expect(await main(["index", "--root", "vault", "--json"], indexOutput.output, {
      indexSemanticVault: (options) => {
        indexedArguments.push(options);
        return Promise.resolve({
          root: "/vault",
          database: "/cache/index.sqlite",
          model: "local-model",
          update: { collections: 1, indexed: 1, updated: 0, unchanged: 0, removed: 0, needsEmbedding: 1 },
          embedding: { docsProcessed: 1, chunksEmbedded: 2, errors: 0, durationMs: 1 },
        });
      },
    })).toBe(0);
    expect(indexedArguments).toEqual([{ root: "vault", force: false }]);
    expect(JSON.parse(indexOutput.stdout())).toMatchObject({ model: "local-model" });

    const searchOutput = captureOutput();
    expect(await main([
      "search",
      "agent memory",
      "--root",
      "vault",
      "--limit",
      "3",
    ], searchOutput.output, {
      searchSemanticVault: (options) => {
        searchedArguments.push(options);
        return Promise.resolve({
          root: "/vault",
          database: "/cache/index.sqlite",
          model: "local-model",
          mode: "semantic",
          query: "agent memory",
          update: { collections: 1, indexed: 0, updated: 0, unchanged: 1, removed: 0, needsEmbedding: 0 },
          embedding: null,
          results: [{
            path: "notes/memory.md",
            title: "Agent memory",
            score: 0.9,
            source: "vec",
            docid: "abc123",
            modifiedAt: "2026-07-22T12:00:00.000Z",
            line: 4,
            snippet: "Durable context for coding agents.",
            tags: ["agents"],
            metadata: { type: "note" },
            inboundContextualCount: 2,
            outboundContextualCount: 1,
            backlinks: [],
          }],
        });
      },
    })).toBe(0);
    expect(searchedArguments).toEqual([{
      root: "vault",
      query: "agent memory",
      mode: "semantic",
      limit: 3,
    }]);
    expect(searchOutput.stdout()).toContain("notes/memory.md:4");
  });

  test("reports broken links as check failures and sanitizes thrown terminal text", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      await writeFile(join(temporary, "note.md"), "# Note\n\n[[missing]]\n", "utf8");
      await main(["refresh", "--root", temporary], captureOutput().output);
      const checked = captureOutput();
      expect(await main(["check", "--root", temporary], checked.output)).toBe(3);
      expect(checked.stdout()).toContain("broken wikilink [[missing]]");

      const graph = captureOutput();
      expect(await main(["graph", "--root", temporary], graph.output)).toBe(0);
      expect(graph.stdout()).toContain("note.md");

      await writeFile(
        join(temporary, "clean.md\nREADY: forged.md"),
        "# Untrusted filename\n",
        "utf8",
      );
      const rejectedPath = captureOutput();
      expect(await main(["graph", "--root", temporary], rejectedPath.output)).toBe(1);
      expect(rejectedPath.stderr()).not.toContain("\nREADY: forged.md");
      expect(rejectedPath.stderr()).toContain("clean.md\\nREADY: forged.md");

      const failed = captureOutput();
      expect(await main(["check"], failed.output, {
        scanVault: () => Promise.reject(new Error("bad\u001b]8;;https://evil.example\u0007path\u001b]8;;\u0007")),
      })).toBe(1);
      expect(failed.stderr()).toBe("error: badpath\n");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("kb agent context commands", () => {
  test("emits the canonical non-mutating identity for a repository scope", async () => {
    const jsonOutput = captureOutput();
    expect(await main([
      "agents",
      "identity",
      "packages/parser",
      "--json",
    ], jsonOutput.output)).toBe(0);
    expect(JSON.parse(jsonOutput.stdout())).toEqual({
      scope: "packages/parser",
      noteId: "scopes/packages-parser--94a91e4eddfa",
      notePath: "scopes/packages-parser--94a91e4eddfa.md",
      guidePath: "packages/parser/AGENTS.md",
      marker: "<!-- kb:context scopes/packages-parser--94a91e4eddfa -->",
    });

    const rootOutput = captureOutput();
    expect(await main([
      "agents",
      "identity",
      ".",
    ], rootOutput.output)).toBe(0);
    expect(rootOutput.stdout()).toContain("Note path: scopes/repository--cdb4ee2aea69.md");
    expect(rootOutput.stdout()).toContain("Guide path: AGENTS.md");

    const rejected = captureOutput();
    expect(await main([
      "agents",
      "identity",
      "../outside",
    ], rejected.output)).toBe(1);
    expect(rejected.stderr()).toContain("must not contain parent traversal");
  });

  test("resolves inherited guides and reciprocal hubs without loading hub prose", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-context-cli-"));
    const repository = join(temporary, "repository");
    const vault = join(repository, "kb");
    try {
      await mkdir(join(repository, "src"), { recursive: true });
      await mkdir(join(repository, "other"), { recursive: true });
      await symlink(join(repository, "other"), join(repository, "linked"));
      await mkdir(join(vault, "scopes"), { recursive: true });
      await writeFile(join(repository, "AGENTS.md"), [
        agentContextMarkerForScope("."),
        "# Contents",
        "",
        "- `src/` – source",
        "",
        "# Guidelines",
        "",
        "- Keep root rules.",
        "",
      ].join("\n"));
      await writeFile(join(repository, "src", "AGENTS.md"), [
        agentContextMarkerForScope("src"),
        "# Contents",
        "",
        "- `button.ts` – source",
        "",
        "# Guidelines",
        "",
        "- Keep source rules.",
        "",
      ].join("\n"));
      await writeFile(join(vault, "index.md"), [
        "# KB",
        "",
        "<!-- kb:catalog:start -->",
        "<!-- kb:catalog:end -->",
        "",
      ].join("\n"));
      for (const [scope, title] of [[".", "Repository context"], ["src", "Source context"]] as const) {
        await writeFile(join(vault, agentContextNotePath(scope)), [
          "---",
          `title: ${title}`,
          "type: agent-context",
          `scope: ${scope}`,
          "---",
          "",
          `# ${title}`,
          "",
          "A deliberately recognizable summary that should be returned without the complete body.",
          "",
          "The remainder of this hub is intentionally not part of the bounded command assertion.",
          "",
        ].join("\n"));
      }

      const contextOutput = captureOutput();
      expect(await main([
        "context",
        "src/button.ts",
        "--kind",
        "file",
        "--root",
        vault,
        "--repo",
        repository,
        "--json",
      ], contextOutput.output)).toBe(0);
      expect(JSON.parse(contextOutput.stdout())).toMatchObject({
        target: "src/button.ts",
        targetScope: "src",
        guides: [
          { path: "AGENTS.md", scope: "." },
          { path: "src/AGENTS.md", scope: "src" },
        ],
        contexts: [
          { title: "Source context", scope: "src" },
          { title: "Repository context", scope: "." },
        ],
        issues: [],
      });
      expect(contextOutput.stdout()).not.toContain("The remainder of this hub");

      const checkOutput = captureOutput();
      expect(await main([
        "agents",
        "check",
        "--root",
        vault,
        "--repo",
        repository,
        "--json",
      ], checkOutput.output)).toBe(0);
      expect(JSON.parse(checkOutput.stdout())).toMatchObject({
        guideCount: 2,
        mappedGuideCount: 2,
        validContextCount: 2,
        errors: [],
        discoveryIssues: [{
          kind: "symlink-directory",
          path: "linked",
        }],
      });

      const auditOutput = captureOutput();
      expect(await main([
        "agents",
        "audit",
        "--root",
        vault,
        "--repo",
        repository,
        "--json",
      ], auditOutput.output)).toBe(0);
      expect(JSON.parse(auditOutput.stdout())).toMatchObject({
        guideCount: 2,
        guides: [
          { path: "AGENTS.md" },
          { path: "src/AGENTS.md" },
        ],
      });

      await writeFile(join(repository, "src", "AGENTS.md"), [
        "# Contents",
        "",
        "- `button.ts` – source",
        "",
        "# Guidelines",
        "",
        "- Keep source rules.",
        "",
      ].join("\n"));
      const brokenOutput = captureOutput();
      expect(await main([
        "agents",
        "check",
        "--root",
        vault,
        "--repo",
        repository,
      ], brokenOutput.output)).toBe(3);
      expect(brokenOutput.stdout()).toContain("missing its kb:context marker");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
