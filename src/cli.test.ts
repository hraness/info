import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  agentContextMarkerForScope,
  agentContextNotePath,
} from "./agent-context.js";
import { main, parseArguments } from "./cli.js";
import {
  MAX_QUERY_FILTERS,
  MAX_QUERY_METADATA_PATH_UTF8_BYTES,
  MAX_QUERY_TAGS,
  MAX_QUERY_TEXT_UTF8_BYTES,
} from "./query.js";
import type { KnowledgeBaseSession } from "./sdk.js";
import {
  MAX_SEARCH_NOTE_REFERENCE_BYTES,
  MAX_SEARCH_RELATED_SEEDS,
} from "./sdk.js";
import { scanVault, type ScanVaultOptions } from "./vault.js";
import {
  qmdIndexerVersion,
  recommendedEmbeddingModelSha256,
} from "./semantic.js";

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
    expect(parseArguments(["url-metadata", "backfill", "--root", "kb", "--json"])).toEqual({
      ok: true,
      value: {
        kind: "url-metadata",
        arguments: ["backfill", "--root", "kb", "--json"],
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
      "--candidate-limit",
      "40",
      "--min-score",
      "0.2",
      "--tag",
      "agents",
      "--scope",
      "packages/kb",
      "--where",
      "status=active",
      "--related",
      "notes/context",
      "--graph-depth",
      "2",
    ])).toEqual({
      ok: true,
      value: {
        kind: "search",
        root: "vault",
        repository: ".",
        mode: "keyword",
        filters: [{ kind: "equals", path: "status", value: "active" }],
        tags: ["agents"],
        repositoryScopes: ["packages/kb"],
        graph: { related: ["notes/context"], depth: 2 },
        history: false,
        limit: 4,
        candidateLimit: 40,
        minScore: 0.2,
        query: "bounded ingestion",
        json: false,
      },
    });
    expect(parseArguments(["search", "query", "--mode", "unknown"])).toEqual({
      ok: false,
      message: "--mode must be hybrid, exact, keyword, or semantic",
    });
    expect(parseArguments(["search", "query", "--min-score", "1.1"])).toEqual({
      ok: false,
      message: "--min-score must be a number from 0 through 1",
    });
    expect(parseArguments(["search", "query", "--limit", "101"])).toEqual({
      ok: false,
      message: "--limit must be an integer from 1 through 100",
    });
    expect(parseArguments(["search", "query", "--candidate-limit", "501"])).toEqual({
      ok: false,
      message: "--candidate-limit must be an integer from 1 through 500",
    });
    expect(parseArguments(["search", "query", "--candidate-limit", "9"])).toEqual({
      ok: false,
      message: "Search candidate limit must be at least the result limit.",
    });
    expect(parseArguments([
      "search",
      "query",
      "--limit",
      "10",
      "--candidate-limit",
      "9",
    ])).toEqual({
      ok: false,
      message: "Search candidate limit must be at least the result limit.",
    });
    expect(parseArguments([
      "search",
      "query",
      "--mode",
      "exact",
      "--min-score",
      "0.2",
    ])).toEqual({
      ok: false,
      message: "Search minimum score applies only to hybrid, keyword, or semantic mode.",
    });
    expect(parseArguments(["search", "query", "--require-history"])).toMatchObject({
      ok: true,
      value: { kind: "search", history: "required" },
    });
    expect(parseArguments(["search", "query", "--history"])).toMatchObject({
      ok: true,
      value: { kind: "search", history: "auto" },
    });
    expect(parseArguments([
      "search",
      "query",
      "--no-history",
      "--require-history",
    ])).toEqual({
      ok: false,
      message: "--no-history and --require-history cannot be used together",
    });
    expect(parseArguments(["search", "query", "--history", "--no-history"]))
      .toEqual({
        ok: false,
        message: "--history and --no-history cannot be used together",
      });
    expect(parseArguments(["search", "query", "--history", "--require-history"]))
      .toEqual({
        ok: false,
        message: "--history and --require-history cannot be used together",
      });
    expect(parseArguments([
      "search",
      "🧠".repeat((16 * 1_024 / 4) + 1),
    ])).toEqual({
      ok: false,
      message: "Search query must be at most 16,384 UTF-8 bytes.",
    });
    expect(parseArguments([
      "search",
      Array.from({ length: 65 }, (_, index) => `term${index}`).join(" "),
    ])).toEqual({
      ok: false,
      message: "Search query may contain at most 64 unique normalized terms.",
    });
  });

  test("parses bounded direct Git history commands", () => {
    expect(parseArguments([
      "history",
      "notes/retrieval",
      "--root",
      "vault",
      "--repo",
      "repository",
      "--limit",
      "12",
      "--cochanged-limit",
      "7",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "history",
        action: "note",
        root: "vault",
        repository: "repository",
        query: "notes/retrieval",
        limit: 12,
        cochangedLimit: 7,
        json: true,
      },
    });
    expect(parseArguments([
      "history",
      "search",
      "projects/example/app/articles.ts",
      "--limit",
      "9",
      "--commit-limit",
      "4",
      "--cochanged-limit",
      "0",
    ])).toMatchObject({
      ok: true,
      value: {
        kind: "history",
        action: "search",
        query: "projects/example/app/articles.ts",
        limit: 9,
        commitLimit: 4,
        cochangedLimit: 0,
      },
    });
    expect(parseArguments(["history", "note", "--limit", "51"])).toEqual({
      ok: false,
      message: "--limit must be an integer from 1 through 50",
    });
    expect(parseArguments(["history", "search", "query", "--commit-limit", "51"]))
      .toEqual({
        ok: false,
        message: "--commit-limit must be an integer from 1 through 50",
      });
    expect(parseArguments(["history", "note", "--commit-limit", "2"]))
      .toEqual({
        ok: false,
        message: "history <note> uses --limit for its per-note commit limit",
      });
  });

  test("parses frozen-corpus evaluation with explicit retrievers and evidence bounds", () => {
    expect(parseArguments([
      "evaluate",
      "kb/evaluations/memory.json",
      "--root",
      "kb",
      "--repo",
      ".",
      "--retriever",
      "exact",
      "--retriever",
      "metadata",
      "--split",
      "all",
      "--limit",
      "8",
      "--cutoff",
      "5",
      "--timeout",
      "1200",
      "--baseline",
      "exact",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "evaluate",
        manifest: "kb/evaluations/memory.json",
        root: "kb",
        repository: ".",
        retrievers: ["exact", "metadata"],
        split: "all",
        limit: 8,
        cutoff: 5,
        timeoutMs: 1200,
        baseline: "exact",
        cacheState: "not-applicable",
        json: true,
      },
    });
    expect(parseArguments([
      "evaluate",
      "corpus.json",
      "--retriever",
      "semantic",
    ])).toEqual({
      ok: false,
      message: "semantic and hybrid evaluation require --model-file to bind the pinned model bytes",
    });
    expect(parseArguments([
      "evaluate",
      "corpus.json",
      "--retriever",
      "exact",
      "--model-file",
      "unused.gguf",
    ])).toEqual({
      ok: false,
      message: "--model-file is only valid when semantic or hybrid evaluation is selected",
    });
    expect(parseArguments([
      "evaluate",
      "corpus.json",
      "--retriever",
      "exact",
      "--limit",
      "4",
      "--cutoff",
      "5",
    ])).toEqual({
      ok: false,
      message: "--cutoff must not exceed --limit",
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
      "--repository-scope",
      "projects/browser",
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
        repositoryScopes: ["projects/browser"],
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

  test("rejects unbounded metadata query options during argument parsing", () => {
    const tags = Array.from(
      { length: MAX_QUERY_TAGS + 1 },
      () => ["--tag", "agents"],
    ).flat();
    expect(parseArguments(["list", ...tags])).toEqual({
      ok: false,
      message: `Query tags may contain at most ${MAX_QUERY_TAGS} entries.`,
    });

    const filters = Array.from(
      { length: MAX_QUERY_FILTERS + 1 },
      () => ["--has", "status"],
    ).flat();
    expect(parseArguments(["search", "memory", ...filters])).toEqual({
      ok: false,
      message: `Query filters may contain at most ${MAX_QUERY_FILTERS} entries.`,
    });

    expect(parseArguments([
      "list",
      "--sort",
      `meta.${"x".repeat(MAX_QUERY_METADATA_PATH_UTF8_BYTES + 1)}`,
    ])).toEqual({
      ok: false,
      message: "Query sort metadata path must be at most 1,024 UTF-8 bytes.",
    });
    expect(parseArguments([
      "search",
      "memory",
      "--where",
      `status=${"x".repeat(MAX_QUERY_TEXT_UTF8_BYTES + 1)}`,
    ])).toEqual({
      ok: false,
      message: "Query filter 1 value must be at most 16,384 UTF-8 bytes.",
    });

    const related = Array.from(
      { length: MAX_SEARCH_RELATED_SEEDS + 1 },
      () => ["--related", "notes/memory"],
    ).flat();
    expect(parseArguments(["search", "memory", ...related])).toEqual({
      ok: false,
      message: `Hybrid search accepts at most ${MAX_SEARCH_RELATED_SEEDS} explicit related-note seeds.`,
    });
    expect(parseArguments([
      "search",
      "memory",
      "--related",
      "x".repeat(MAX_SEARCH_NOTE_REFERENCE_BYTES + 1),
    ])).toEqual({
      ok: false,
      message: "Search related-note seed 1 must be at most 16,384 UTF-8 bytes.",
    });
    expect(parseArguments(["search", "memory", "--related", " "])).toEqual({
      ok: false,
      message: "Search related-note seed 1 must not be empty.",
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

  test("parses percolation and lane-safe catalog checks with strict bounds", () => {
    expect(parseArguments(["datalog"])).toEqual({
      ok: false,
      message: "unknown command",
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
    expect(parseArguments([
      "catalog",
      "--root",
      "vault",
      "--index",
      "home.md",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "catalog",
        root: "vault",
        options: { index: "home.md", mentionScope: false },
        json: true,
      },
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

  test("parses the advisory source inbox and compatibility alias", () => {
    const expected = {
      ok: true,
      value: {
        kind: "inbox",
        root: "vault",
        options: { index: "home.md", mentionScope: false },
        sourcePrefixes: ["articles", "sources"],
        limit: 25,
        json: true,
      },
    } as const;
    expect(parseArguments([
      "inbox",
      "--root",
      "vault",
      "--index",
      "home.md",
      "--source-prefix",
      "articles",
      "--source-prefix",
      "sources",
      "--limit",
      "25",
      "--json",
    ])).toEqual(expected);
    expect(parseArguments([
      "source-inbox",
      "--root",
      "vault",
      "--index",
      "home.md",
      "--source-prefix",
      "articles",
      "--source-prefix",
      "sources",
      "--limit",
      "25",
      "--json",
    ])).toEqual(expected);
    expect(parseArguments(["inbox", "--limit", "1001"])).toEqual({
      ok: false,
      message: "--limit must be an integer from 0 through 1000",
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
  test("rejects invalid search bounds before opening the knowledge base", async () => {
    let opens = 0;
    const openKnowledgeBase = (): Promise<KnowledgeBaseSession> => {
      opens += 1;
      return Promise.reject(new Error("must not open"));
    };
    const invalid = [
      ["search", "query", "--limit", "101"],
      ["search", "query", "--candidate-limit", "501"],
      ["search", "query", "--candidate-limit", "9"],
      ["search", "query", "--limit", "10", "--candidate-limit", "9"],
      ["search", "query", "--mode", "exact", "--min-score", "0.2"],
    ] as const;
    for (const arguments_ of invalid) {
      const output = captureOutput();
      expect(await main(arguments_, output.output, { openKnowledgeBase })).toBe(2);
      expect(output.stderr()).toStartWith("error:");
    }
    expect(opens).toBe(0);
  });

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

      const indexBeforeCatalog = await Bun.file(join(vault, "index.md")).text();
      const catalogOutput = captureOutput();
      expect(await main([
        "catalog",
        "--root",
        vault,
        "--json",
      ], catalogOutput.output)).toBe(0);
      expect(JSON.parse(catalogOutput.stdout())).toMatchObject({
        catalogMode: "managed",
        noteCount: 2,
      });
      expect(stringProperty(parseJsonObject(catalogOutput.stdout()), "catalog"))
        .toContain("[[notes/alpha|Alpha]]");
      expect(await Bun.file(join(vault, "index.md")).text()).toBe(indexBeforeCatalog);

      const graphOutput = captureOutput();
      expect(await main(["graph", "--root", vault, "--json"], graphOutput.output)).toBe(0);
      expect(JSON.parse(graphOutput.stdout())).toMatchObject({
        noteCount: 2,
        contextualLinkCount: 1,
      });

      const backlinkOutput = captureOutput();
      expect(await main(["backlinks", "Beta", "--root", vault], backlinkOutput.output)).toBe(0);
      expect(backlinkOutput.stdout()).toContain("notes/alpha.md:3");

      const missingBacklinks = captureOutput();
      expect(await main([
        "backlinks",
        "missing",
        "--root",
        vault,
        "--json",
      ], missingBacklinks.output)).toBe(3);
      expect(JSON.parse(missingBacklinks.stdout())).toEqual({
        ok: false,
        kind: "missing",
        note: "missing",
      });
      expect(missingBacklinks.stderr()).toBe("");

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

  test("authors notes and typed relationships, then percolates evidence end to end", async () => {
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

  test("fails check on missing durable attachments with structured evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-cli-attachments-"));
    try {
      await writeFile(join(root, "index.md"), "# Index\n", "utf8");
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(
        join(root, "notes", "report.md"),
        "# Report\n\n![missing](../assets/result(1).png)\n",
        "utf8",
      );

      const jsonOutput = captureOutput();
      expect(await main([
        "check",
        "--root",
        root,
        "--no-catalog",
        "--json",
      ], jsonOutput.output)).toBe(3);
      expect(JSON.parse(jsonOutput.stdout())).toMatchObject({
        attachments: {
          referenceCount: 1,
          validatedCount: 0,
          truncated: false,
          issues: [{
            kind: "missing",
            source: "notes/report.md",
            line: 3,
            target: "../assets/result(1).png",
          }],
        },
      });

      const humanOutput = captureOutput();
      expect(await main([
        "check",
        "--root",
        root,
        "--no-catalog",
      ], humanOutput.output)).toBe(3);
      expect(humanOutput.stdout()).toContain(
        "error: notes/report.md:3: missing attachment ../assets/result(1).png",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists recent undisposed captures through the advisory inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-cli-inbox-"));
    try {
      await writeFile(join(root, "index.md"), "# Index\n", "utf8");
      await mkdir(join(root, "articles", "pending"), { recursive: true });
      await mkdir(join(root, "articles", "used"), { recursive: true });
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(join(root, "articles", "pending", "pending.md"), [
        "---",
        "clipped: 2026-08-02",
        "---",
        "# Pending",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(root, "articles", "used", "used.md"), [
        "---",
        "clipped: 2026-08-01",
        "---",
        "# Used",
        "",
      ].join("\n"), "utf8");
      await writeFile(
        join(root, "notes", "synthesis.md"),
        "---\ntype: note\n---\n# Synthesis\n\n[[articles/used/used]]\n",
        "utf8",
      );

      const output = captureOutput();
      expect(await main(["inbox", "--root", root, "--json"], output.output)).toBe(0);
      expect(JSON.parse(output.stdout())).toMatchObject({
        advisory: true,
        totalSources: 2,
        disposedSources: 1,
        pendingSources: 1,
        returnedSources: 1,
        items: [{
          id: "articles/pending/pending",
          clipped: "2026-08-02",
          reason: "no-maintained-disposition",
        }],
        dispositions: [{
          id: "articles/used/used",
          evidence: [{ kind: "link", source: "notes/synthesis", line: 6 }],
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
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

  test("delegates URL metadata arguments and preserves its exit code", async () => {
    const captured: string[][] = [];
    const output = captureOutput();
    const exitCode = await main(["url-metadata", "backfill", "--root", "kb", "--json"], output.output, {
      runUrlMetadataCommand: (arguments_) => {
        captured.push([...(arguments_ ?? [])]);
        return Promise.resolve(3);
      },
    });
    expect(exitCode).toBe(3);
    expect(captured).toEqual([["backfill", "--root", "kb", "--json"]]);
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
    let closed = 0;
    expect(await main([
      "search",
      "agent memory",
      "--root",
      "vault",
      "--limit",
      "3",
      "--min-score",
      "0.2",
    ], searchOutput.output, {
      openKnowledgeBase: (options) => {
        searchedArguments.push({ open: options });
        const unused = (): never => {
          throw new Error("not used in this test");
        };
        const session = {
          root: "/vault",
          repository: ".",
          noteCount: 1,
          grep: unused,
          list: unused,
          read: unused,
          links: unused,
          backlinks: unused,
          search: (searchOptions) => {
            searchedArguments.push({ search: searchOptions });
            return Promise.resolve({
              query: "agent memory",
              mode: "hybrid" as const,
              results: [{
                id: "notes/memory",
                path: "notes/memory.md",
                title: "Agent memory",
                rank: 1,
                score: 0.9,
                identity: false,
                line: 4,
                snippet: "Durable context for coding agents.",
                tags: ["agents"],
                metadata: { type: "note" },
                evidence: [{
                  kind: "qmd" as const,
                  rank: 1,
                  source: "hybrid" as const,
                  score: 0.9,
                  signals: { keyword: true, semantic: true },
                }],
                contributions: [{
                  lane: "qmd",
                  rank: 1,
                  weight: 1,
                  value: 1 / 61,
                }],
              }],
              graph: null,
              history: null,
              partial: false,
              diagnostics: {
                notes: 1,
                model: "local-model",
                elapsedMs: 2,
                lanes: [{ lane: "qmd" as const, status: "ready" as const, results: 1 }],
              },
            });
          },
          history: unused,
          searchHistory: unused,
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        } satisfies KnowledgeBaseSession;
        return Promise.resolve(session);
      },
    })).toBe(0);
    expect(searchedArguments).toEqual([
      { open: { root: "vault", repository: "." } },
      {
        search: {
          query: "agent memory",
          mode: "hybrid",
          filters: [],
          tags: [],
          repositoryScopes: [],
          graph: {},
          history: false,
          limit: 3,
          minScore: 0.2,
        },
      },
    ]);
    expect(closed).toBe(1);
    expect(searchOutput.stdout()).toContain("notes/memory.md:4");
  });

  test("runs an injected frozen-corpus evaluator and emits the complete raw report", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-evaluate-cli-"));
    const manifest = join(temporary, "corpus.json");
    try {
      await writeFile(manifest, JSON.stringify({
        schemaVersion: 1,
        id: "cli-evaluation-fixture",
        description: "Two independently specified CLI evaluation queries.",
        frozen: {
          repositoryCommit: "a".repeat(40),
          vaultTree: "b".repeat(40),
          vaultRoot: "kb",
        },
        assessment: {
          rubricVersion: "fixture-v1",
          assessors: [{ id: "fixture-author" }],
        },
        queries: [{
          id: "development-exact",
          text: "Where is alpha?",
          class: "exact-identifier",
          split: "development",
          answer: "answerable",
          inputs: { text: "alpha" },
          qrels: [{ documentId: "notes/alpha", relevance: 3 }],
          assessorIds: ["fixture-author"],
          adjudication: { status: "not-required" },
        }, {
          id: "test-no-answer",
          text: "Which note documents an absent system?",
          class: "no-answer",
          split: "test",
          answer: "no-answer",
          inputs: { text: "absent-system-identifier" },
          qrels: [],
          assessorIds: ["fixture-author"],
          adjudication: { status: "not-required" },
        }],
      }), "utf8");

      let closed = 0;
      const output = captureOutput();
      expect(await main([
        "evaluate",
        manifest,
        "--retriever",
        "exact",
        "--split",
        "all",
        "--limit",
        "5",
        "--cutoff",
        "5",
        "--json",
      ], output.output, {
        evaluationNow: () => new Date("2026-08-01T12:00:00.000Z"),
        openKnowledgeBaseEvaluation: () => Promise.resolve({
          retrievers: [{
            id: "exact",
            retrieve: ({ query }) => Promise.resolve({
              status: "ready",
              hits: query.answer === "no-answer"
                ? []
                : [{ documentId: "notes/alpha", rank: 1, score: 1 }],
            }),
          }],
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }),
      })).toBe(0);
      expect(JSON.parse(output.stdout())).toMatchObject({
        schemaVersion: 1,
        split: "all",
        queryCount: 2,
        cutoff: 5,
        environment: {
          generatedAt: "2026-08-01T12:00:00.000Z",
          model: { kind: "none" },
          cache: { state: "not-applicable" },
        },
        summaries: [{
          retrieverId: "exact",
          runs: 2,
          ready: 2,
          metrics: { recall: 1, reciprocalRank: 1, ndcg: 1, noAnswerAccuracy: 1 },
        }],
        runs: [
          { retrieverId: "exact", queryId: "development-exact", status: "ready" },
          { retrieverId: "exact", queryId: "test-no-answer", status: "ready" },
        ],
      });
      expect(closed).toBe(1);
      expect(output.stderr()).toBe("");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("binds semantic evaluation to verified model bytes and detects mutation", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-evaluate-model-"));
    const manifest = join(temporary, "corpus.json");
    const modelFile = join(temporary, "private-model.gguf");
    const arguments_ = [
      "evaluate",
      manifest,
      "--retriever",
      "semantic",
      "--model-file",
      modelFile,
      "--json",
    ] as const;
    try {
      await writeFile(manifest, JSON.stringify({
        schemaVersion: 1,
        id: "cli-model-binding-fixture",
        description: "One semantic query for local model binding.",
        frozen: {
          repositoryCommit: "a".repeat(40),
          vaultTree: "b".repeat(40),
          vaultRoot: "kb",
        },
        assessment: {
          rubricVersion: "fixture-v1",
          assessors: [{ id: "fixture-author" }],
        },
        queries: [{
          id: "development-semantic",
          text: "Where is development memory?",
          class: "conceptual-recall",
          split: "development",
          answer: "answerable",
          inputs: { text: "development memory" },
          qrels: [{ documentId: "notes/development", relevance: 3 }],
          assessorIds: ["fixture-author"],
          adjudication: { status: "not-required" },
        }, {
          id: "test-semantic",
          text: "Where is semantic memory?",
          class: "conceptual-recall",
          split: "test",
          answer: "answerable",
          inputs: { text: "semantic memory" },
          qrels: [{ documentId: "notes/semantic", relevance: 3 }],
          assessorIds: ["fixture-author"],
          adjudication: { status: "not-required" },
        }],
      }), "utf8");

      let mismatchOpens = 0;
      const mismatchOutput = captureOutput();
      expect(await main(arguments_, mismatchOutput.output, {
        digestEvaluationModel: () => Promise.resolve("0".repeat(64)),
        openKnowledgeBaseEvaluation: () => {
          mismatchOpens += 1;
          throw new Error("must not open an evaluator for mismatched bytes");
        },
      })).toBe(1);
      expect(mismatchOpens).toBe(0);
      expect(parseJsonObject(mismatchOutput.stdout())).toMatchObject({
        ok: false,
        error: {
          kind: "runtime",
          message: "The evaluation model does not match the pinned recommended model SHA-256.",
        },
      });
      expect(mismatchOutput.stdout()).not.toContain(modelFile);

      let verifiedOpens = 0;
      let verifiedCloses = 0;
      let digestCalls = 0;
      const verifiedOutput = captureOutput();
      expect(await main(arguments_, verifiedOutput.output, {
        evaluationNow: () => new Date("2026-08-02T12:00:00.000Z"),
        digestEvaluationModel: (path) => {
          digestCalls += 1;
          expect(path).toBe(resolve(modelFile));
          return Promise.resolve(recommendedEmbeddingModelSha256);
        },
        openKnowledgeBaseEvaluation: (options) => {
          verifiedOpens += 1;
          expect(options.embeddingModelFile).toBe(resolve(modelFile));
          return Promise.resolve({
            retrievers: [{
              id: "semantic",
              retrieve: () => Promise.resolve({
                status: "ready" as const,
                hits: [{ documentId: "notes/semantic", rank: 1, score: 0.9 }],
              }),
            }],
            close: () => {
              verifiedCloses += 1;
              return Promise.resolve();
            },
          });
        },
      })).toBe(0);
      expect({ digestCalls, verifiedOpens, verifiedCloses }).toEqual({
        digestCalls: 2,
        verifiedOpens: 1,
        verifiedCloses: 1,
      });
      expect(parseJsonObject(verifiedOutput.stdout())).toMatchObject({
        environment: {
          generatedAt: "2026-08-02T12:00:00.000Z",
          model: { kind: "local", sha256: recommendedEmbeddingModelSha256 },
          retrievers: [{
            id: "semantic",
            version: `qmd-${qmdIndexerVersion}/semantic`,
          }],
        },
      });
      expect(verifiedOutput.stdout()).not.toContain(modelFile);

      let mutationCloses = 0;
      let mutationDigestCalls = 0;
      const mutationOutput = captureOutput();
      expect(await main(arguments_, mutationOutput.output, {
        digestEvaluationModel: () => {
          mutationDigestCalls += 1;
          return Promise.resolve(
            mutationDigestCalls === 1
              ? recommendedEmbeddingModelSha256
              : "f".repeat(64),
          );
        },
        openKnowledgeBaseEvaluation: () => Promise.resolve({
          retrievers: [{
            id: "semantic",
            retrieve: () => Promise.resolve({ status: "ready" as const, hits: [] }),
          }],
          close: () => {
            mutationCloses += 1;
            return Promise.resolve();
          },
        }),
      })).toBe(1);
      expect({ mutationDigestCalls, mutationCloses }).toEqual({
        mutationDigestCalls: 2,
        mutationCloses: 1,
      });
      expect(parseJsonObject(mutationOutput.stdout())).toMatchObject({
        ok: false,
        error: {
          kind: "runtime",
          message: "The evaluation model changed while retrieval was running; retry.",
        },
      });
      expect(mutationOutput.stdout()).not.toContain(modelFile);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("renders usable but incomplete Git provenance in text and JSON search output", async () => {
    const result = {
      query: "agent memory",
      mode: "exact" as const,
      results: [],
      graph: null,
      history: {
        status: "ready" as const,
        head: "a".repeat(40),
        notes: [{ id: "notes/memory", path: "notes/memory.md", commits: [] }],
        limitedCommits: [{
          hash: "b".repeat(40),
          committedAt: "2026-07-30T12:00:00.000Z",
          subject: "Large repository rename",
          reason: "changed-path-limit" as const,
          pathLimit: 2_000,
          observedPathRecords: 3_142,
          affectedNoteIds: ["notes/memory"],
        }],
      },
      partial: true,
      diagnostics: {
        notes: 1,
        model: null,
        elapsedMs: 2,
        lanes: [{
          lane: "git" as const,
          status: "degraded" as const,
          results: 1,
          message: "1 Git commit exceeded the 2,000 changed-path detail limit; co-change evidence is incomplete.",
        }],
      },
    };
    const openKnowledgeBase = (): Promise<KnowledgeBaseSession> => Promise.resolve({
      root: "/vault",
      repository: ".",
      noteCount: 1,
      grep: () => [],
      list: () => [],
      read: () => { throw new Error("not used"); },
      links: () => { throw new Error("not used"); },
      backlinks: () => { throw new Error("not used"); },
      search: () => Promise.resolve(result),
      history: () => Promise.resolve(result.history),
      searchHistory: () => { throw new Error("not used"); },
      close: () => Promise.resolve(),
    });

    const textOutput = captureOutput();
    expect(await main([
      "search",
      "agent memory",
      "--root",
      "vault",
      "--repo",
      ".",
      "--mode",
      "exact",
    ], textOutput.output, { openKnowledgeBase })).toBe(0);
    expect(textOutput.stdout()).toContain("[partial]");
    expect(textOutput.stdout()).toContain("1 commit with incomplete co-change paths");

    const jsonOutput = captureOutput();
    expect(await main([
      "search",
      "agent memory",
      "--root",
      "vault",
      "--repo",
      ".",
      "--mode",
      "exact",
      "--json",
    ], jsonOutput.output, { openKnowledgeBase })).toBe(0);
    expect(parseJsonObject(jsonOutput.stdout())).toMatchObject({
      partial: true,
      history: { limitedCommits: [{ observedPathRecords: 3_142 }] },
      diagnostics: { lanes: [{ lane: "git", status: "degraded" }] },
    });
  });

  test("exposes direct note and co-change history with bounded evidence and guaranteed close", async () => {
    const calls: unknown[] = [];
    let closed = 0;
    const limitedCommit = {
      hash: "b".repeat(40),
      committedAt: "2026-07-30T12:00:00.000Z",
      subject: "Large repository rename",
      reason: "changed-path-limit" as const,
      pathLimit: 2_000,
      observedPathRecords: 3_142,
      affectedNoteIds: ["notes/memory"],
    };
    const openKnowledgeBase = (): Promise<KnowledgeBaseSession> => Promise.resolve({
      root: "/vault",
      repository: "/repository",
      noteCount: 1,
      grep: () => [],
      list: () => [],
      read: (note, options) => {
        calls.push({ read: note, options });
        return {
          id: "notes/memory",
          path: "notes/memory.md",
          title: "Agent memory",
          content: "A",
          truncated: true,
        };
      },
      links: () => { throw new Error("not used"); },
      backlinks: () => { throw new Error("not used"); },
      search: () => { throw new Error("not used"); },
      history: (ids, options) => {
        calls.push({ history: ids, options });
        return Promise.resolve({
          status: "ready" as const,
          head: "a".repeat(40),
          notes: [{
            id: "notes/memory",
            path: "notes/memory.md",
            commits: [{
              hash: "b".repeat(40),
              committedAt: "2026-07-30T12:00:00.000Z",
              subject: "Large repository rename",
              cochangedPaths: ["projects/example/app/articles.ts"],
              cochangeDetailsLimited: true as const,
            }],
          }],
          limitedCommits: [limitedCommit],
        });
      },
      searchHistory: (options) => {
        calls.push({ searchHistory: options });
        return Promise.resolve({
          status: "ready" as const,
          head: "a".repeat(40),
          query: options.query,
          hits: [{
            id: "notes/memory",
            path: "notes/memory.md",
            score: 3.25,
            commits: [{
              hash: "b".repeat(40),
              committedAt: "2026-07-30T12:00:00.000Z",
              subject: "Large repository rename",
              cochangedPaths: ["projects/example/app/articles.ts"],
              matchedSubject: false,
              matchedPaths: ["projects/example/app/articles.ts"],
            }],
          }],
          limitedCommits: [limitedCommit],
        });
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });

    const noteOutput = captureOutput();
    expect(await main([
      "history",
      "Agent memory",
      "--limit",
      "3",
      "--cochanged-limit",
      "8",
      "--json",
    ], noteOutput.output, { openKnowledgeBase })).toBe(0);
    expect(parseJsonObject(noteOutput.stdout())).toMatchObject({
      kind: "note",
      note: { id: "notes/memory", path: "notes/memory.md" },
      partial: true,
      history: {
        status: "ready",
        limitedCommits: [{ observedPathRecords: 3_142 }],
      },
    });

    const searchOutput = captureOutput();
    expect(await main([
      "history",
      "search",
      "projects/example/app/articles.ts",
      "--limit",
      "6",
      "--commit-limit",
      "2",
      "--cochanged-limit",
      "5",
    ], searchOutput.output, { openKnowledgeBase })).toBe(0);
    expect(searchOutput.stdout()).toContain("notes/memory.md");
    expect(searchOutput.stdout()).toContain("incomplete co-change paths");
    expect(calls).toEqual([
      { read: "Agent memory", options: { maxBytes: 1 } },
      {
        history: ["notes/memory"],
        options: { commitsPerNote: 3, cochangedPathsPerCommit: 8 },
      },
      {
        searchHistory: {
          query: "projects/example/app/articles.ts",
          limit: 6,
          commitsPerHit: 2,
          cochangedPathsPerCommit: 5,
        },
      },
    ]);
    expect(closed).toBe(2);
  });

  test("returns unavailable Git evidence and still closes the session", async () => {
    let closed = 0;
    const unavailable = {
      status: "unavailable" as const,
      repository: "/repository",
      root: "/vault",
      vaultPrefix: "kb",
      reason: "Git is unavailable.",
    };
    const output = captureOutput();
    expect(await main([
      "history",
      "search",
      "project/path",
      "--json",
    ], output.output, {
      openKnowledgeBase: () => Promise.resolve({
        root: "/vault",
        repository: "/repository",
        noteCount: 0,
        grep: () => [],
        list: () => [],
        read: () => { throw new Error("not used"); },
        links: () => { throw new Error("not used"); },
        backlinks: () => { throw new Error("not used"); },
        search: () => { throw new Error("not used"); },
        history: () => Promise.resolve(unavailable),
        searchHistory: () => Promise.resolve(unavailable),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    })).toBe(0);
    expect(parseJsonObject(output.stdout())).toMatchObject({
      kind: "search",
      partial: true,
      history: { status: "unavailable", reason: "Git is unavailable." },
    });
    expect(closed).toBe(1);
  });

  test("emits one JSON error object for parse and runtime failures", async () => {
    const parseOutput = captureOutput();
    expect(await main(["history", "--limit", "oops", "--json"], parseOutput.output))
      .toBe(2);
    expect(parseJsonObject(parseOutput.stdout())).toEqual({
      ok: false,
      error: {
        kind: "parse",
        message: "--limit must be an integer from 1 through 50",
      },
    });
    expect(parseOutput.stderr()).toBe("");

    const runtimeOutput = captureOutput();
    expect(await main(["index", "--json"], runtimeOutput.output, {
      indexSemanticVault: () => Promise.reject(new Error("model failed")),
    })).toBe(1);
    expect(parseJsonObject(runtimeOutput.stdout())).toEqual({
      ok: false,
      error: { kind: "runtime", message: "model failed" },
    });
  });

  test("keeps process-level JSON parseable while a dependency writes model progress", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-kb-cli-process-"));
    try {
      const cliUrl = pathToFileURL(join(import.meta.dir, "cli.ts")).href;
      const script = join(temporary, "strict-json.ts");
      const vault = join(temporary, "vault");
      await mkdir(vault);
      await writeFile(join(vault, "index.md"), "# Index\n", "utf8");
      await writeFile(script, [
        `import { runExecutable } from ${JSON.stringify(cliUrl)};`,
        "const mode = process.env.KB_CLI_TEST_MODE;",
        "if (mode === 'parse') {",
        "  process.exitCode = await runExecutable(['history', '--limit', 'oops', '--json']);",
        "} else if (mode === 'runtime') {",
        "  process.exitCode = await runExecutable(['index', '--json'], {",
        "    indexSemanticVault: async () => { throw new Error('simulated runtime failure'); },",
        "  });",
        "} else if (mode === 'unavailable') {",
        "  const unused = () => { throw new Error('unused'); };",
        "  process.exitCode = await runExecutable(['history', 'search', 'project/path', '--json'], {",
        "    openKnowledgeBase: async () => ({",
        "      root: '/vault', repository: '/repository', noteCount: 0,",
        "      grep: unused, list: unused, read: unused, links: unused, backlinks: unused, search: unused, history: unused,",
        "      searchHistory: async () => ({ status: 'unavailable', repository: '/repository', root: '/vault', vaultPrefix: 'kb', reason: 'Git unavailable' }),",
        "      close: async () => undefined,",
        "    }),",
        "  });",
        "} else if (mode === 'missing') {",
        "  process.exitCode = await runExecutable(['backlinks', 'missing', '--root', process.env.KB_CLI_TEST_ROOT!, '--json']);",
        "} else {",
        "  process.exitCode = await runExecutable(['index', '--json'], {",
        "    indexSemanticVault: async () => {",
        "      process.stdout.write('\\u001b[2KDownloading local model 40%\\r');",
        "      console.log('raw dependency progress');",
        "      return {",
        "        root: '/vault',",
        "        database: '/cache/index.sqlite',",
        "        model: 'local-model',",
        "        update: { collections: 1, indexed: 1, updated: 0, unchanged: 0, removed: 0, needsEmbedding: 1 },",
        "        embedding: { docsProcessed: 1, chunksEmbedded: 2, errors: 0, durationMs: 1 },",
        "      };",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"), "utf8");
      const invoke = (mode: string) =>
        Bun.spawnSync([process.execPath, script], {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NO_COLOR: "1",
            KB_CLI_TEST_MODE: mode,
            KB_CLI_TEST_ROOT: vault,
          },
        });
      const processResult = invoke("progress");
      expect(processResult.exitCode).toBe(0);
      const stdout = processResult.stdout.toString();
      expect(JSON.parse(stdout)).toMatchObject({ model: "local-model" });
      expect(stdout).not.toContain("Downloading");
      const stderr = processResult.stderr.toString();
      expect(stderr).toContain("Downloading local model 40%");
      expect(stderr).toContain("raw dependency progress");

      const unavailable = invoke("unavailable");
      expect(unavailable.exitCode).toBe(0);
      expect(JSON.parse(unavailable.stdout.toString())).toMatchObject({
        kind: "search",
        partial: true,
        history: { status: "unavailable", reason: "Git unavailable" },
      });

      const parseFailure = invoke("parse");
      expect(parseFailure.exitCode).toBe(2);
      expect(JSON.parse(parseFailure.stdout.toString())).toMatchObject({
        ok: false,
        error: { kind: "parse" },
      });

      const missing = invoke("missing");
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stdout.toString())).toEqual({
        ok: false,
        kind: "missing",
        note: "missing",
      });

      const runtimeFailure = invoke("runtime");
      expect(runtimeFailure.exitCode).toBe(1);
      expect(JSON.parse(runtimeFailure.stdout.toString())).toEqual({
        ok: false,
        error: { kind: "runtime", message: "simulated runtime failure" },
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
      await mkdir(join(vault, "notes"), { recursive: true });
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
      await writeFile(join(vault, "notes", "source-memory.md"), [
        "---",
        "title: Source memory",
        "description: Current decisions for the source directory.",
        "type: note",
        "repository_scopes:",
        "  - src",
        "---",
        "",
        "# Source memory",
        "",
        "Keep repository memory next to its source-owned Markdown record.",
        "",
      ].join("\n"));

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
        records: {
          target: "src/button.ts",
          counts: { matched: 1, returned: 1, invalid: 0, advisories: 0 },
          groups: {
            maintainedKnowledge: {
              total: 1,
              returned: 1,
              truncated: false,
              records: [{
                path: "notes/source-memory.md",
                matchedScope: "src",
                match: "ancestor",
                scopeState: { status: "present", scope: "src", kind: "directory" },
              }],
            },
            activePlans: { total: 0, returned: 0, truncated: false },
            historicalPlans: { total: 0, returned: 0, truncated: false },
          },
        },
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
