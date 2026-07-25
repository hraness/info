import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentContextMarkerForScope,
  agentContextNotePath,
} from "./agent-context.js";
import { main, parseArguments } from "./cli.js";

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

describe("oh argument parsing", () => {
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

  test("parses repository context lookup and agent mapping commands", () => {
    expect(parseArguments([
      "context",
      "packages/oh/src/cli.ts",
      "--root",
      "oh",
      "--repo",
      ".",
      "--kind",
      "file",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "context",
        root: "oh",
        repository: ".",
        target: "packages/oh/src/cli.ts",
        targetKind: "file",
        json: true,
      },
    });
    expect(parseArguments([
      "agents",
      "audit",
      "--root",
      "oh",
      "--repo",
      ".",
    ])).toEqual({
      ok: true,
      value: {
        kind: "agents",
        action: "audit",
        root: "oh",
        repository: ".",
        json: false,
      },
    });
    expect(parseArguments([
      "agents",
      "identity",
      "packages/oh",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        kind: "agent-identity",
        scope: "packages/oh",
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

describe("oh vault commands", () => {
  test("initializes, refreshes, checks, graphs, and derives backlinks without editing notes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hraness-oh-cli-"));
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
    const temporary = await mkdtemp(join(tmpdir(), "hraness-oh-cli-"));
    try {
      await writeFile(join(temporary, "index.md"), "# Index\n", "utf8");
      await writeFile(join(temporary, "note.md"), "# Note\n\n[[missing]]\n", "utf8");
      await writeFile(
        join(temporary, "clean.md\nREADY: forged.md"),
        "# Untrusted filename\n",
        "utf8",
      );
      await main(["refresh", "--root", temporary], captureOutput().output);
      const checked = captureOutput();
      expect(await main(["check", "--root", temporary], checked.output)).toBe(3);
      expect(checked.stdout()).toContain("broken wikilink [[missing]]");

      const graph = captureOutput();
      expect(await main(["graph", "--root", temporary], graph.output)).toBe(0);
      expect(graph.stdout()).not.toContain("\nREADY: forged.md");
      expect(graph.stdout()).toContain("clean.md READY: forged.md");

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

describe("oh agent context commands", () => {
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
      marker: "<!-- oh:context scopes/packages-parser--94a91e4eddfa -->",
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
    const temporary = await mkdtemp(join(tmpdir(), "hraness-oh-context-cli-"));
    const repository = join(temporary, "repository");
    const vault = join(repository, "oh");
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
        "# Oh",
        "",
        "<!-- oh:catalog:start -->",
        "<!-- oh:catalog:end -->",
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
      expect(brokenOutput.stdout()).toContain("missing its oh:context marker");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
