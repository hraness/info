import { describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseLocalAttachmentReferences,
  validateMarkdownAttachments,
} from "./attachments.js";

describe("local attachment parsing", () => {
  test("preserves Markdown and Obsidian provenance while excluding remote and code examples", () => {
    const parsed = parseLocalAttachmentReferences("notes/deep/memory.md", [
      "# Memory",
      "",
      "![diagram](../../assets/my%20diagram.png)",
      "[manual](<../../assets/User Guide.pdf> \"PDF\")",
      "![[assets/board.tldraw|Board]] and [[capture.tldr#frame=one]]",
      "![[assets/second.tldraw^frame-one]]",
      "![remote](https://example.com/image.png)",
      "![data](data:image/png;base64,abc)",
      "`![example](missing.png)`",
      "```md",
      "![fixture](also-missing.png)",
      "```",
      "    ![indented fixture](indented.png)",
      "[ordinary](other.md)",
    ].join("\n"));

    expect(parsed.issues).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.references).toEqual([
      {
        source: "notes/deep/memory.md",
        line: 3,
        syntax: "markdown-image",
        rawTarget: "../../assets/my%20diagram.png",
        target: "../../assets/my diagram.png",
      },
      {
        source: "notes/deep/memory.md",
        line: 4,
        syntax: "markdown-link",
        rawTarget: "../../assets/User Guide.pdf",
        target: "../../assets/User Guide.pdf",
      },
      {
        source: "notes/deep/memory.md",
        line: 5,
        syntax: "obsidian-embed",
        rawTarget: "assets/board.tldraw",
        target: "assets/board.tldraw",
      },
      {
        source: "notes/deep/memory.md",
        line: 5,
        syntax: "obsidian-link",
        rawTarget: "capture.tldr#frame=one",
        target: "capture.tldr",
      },
      {
        source: "notes/deep/memory.md",
        line: 6,
        syntax: "obsidian-embed",
        rawTarget: "assets/second.tldraw^frame-one",
        target: "assets/second.tldraw",
      },
    ]);
  });

  test("reports malformed local encodings and stable truncation", () => {
    const malformed = parseLocalAttachmentReferences(
      "note.md",
      "![bad](asset%ZZ.png)\n![control](asset%00.png)\n[ordinary](note%ZZ.md)\n",
    );
    expect(malformed.references).toEqual([]);
    expect(malformed.issues.map(({ kind }) => kind)).toEqual([
      "malformed-target",
      "malformed-target",
    ]);

    const bounded = parseLocalAttachmentReferences(
      "note.md",
      "![one](one.png)\n![two](two.png)\n",
      { maxReferences: 1 },
    );
    expect(bounded.references.map(({ target }) => target)).toEqual(["one.png"]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.issues).toMatchObject([{ kind: "budget" }]);

    const windowsAbsolute = parseLocalAttachmentReferences(
      "note.md",
      "![absolute](C:%5Csecrets%5Cimage.png)",
    );
    expect(windowsAbsolute.issues).toMatchObject([{ kind: "traversal" }]);
    expect(() => parseLocalAttachmentReferences("C:\\vault\\note.md", ""))
      .toThrow("vault-relative paths");
  });

  test("parses balanced inline destinations and CommonMark reference attachments", () => {
    const parsed = parseLocalAttachmentReferences("notes/report.md", [
      "![nested](../assets/result(1).png)",
      "![full][artifact]",
      "[manual][]",
      "![shortcut]",
      "",
      "[artifact]: <../assets/reference image.png>",
      "[manual]: ../assets/manual.pdf \"PDF\"",
      "[shortcut]: ../assets/shortcut.webp",
    ].join("\n"));

    expect(parsed.issues).toEqual([]);
    expect(parsed.references.map(({ line, rawTarget, syntax }) => ({ line, rawTarget, syntax })))
      .toEqual([
        { line: 1, rawTarget: "../assets/result(1).png", syntax: "markdown-image" },
        { line: 2, rawTarget: "../assets/reference image.png", syntax: "markdown-image" },
        { line: 3, rawTarget: "../assets/manual.pdf", syntax: "markdown-link" },
        { line: 4, rawTarget: "../assets/shortcut.webp", syntax: "markdown-image" },
      ]);
  });

  test("ignores attachment examples in YAML frontmatter and HTML comments", () => {
    const parsed = parseLocalAttachmentReferences("notes/report.md", [
      "---",
      "description: '![frontmatter](missing-frontmatter.png)'",
      "example: '[manual](missing-frontmatter.pdf)'",
      "---",
      "# Report",
      "",
      "<!-- ![single](missing-single.png) -->",
      "<!--",
      "![multiline](missing-multiline.png)",
      "-->",
      "Visible <!-- ![hidden](missing-hidden.png) --> ![kept](kept.png)",
      "`<!--` ![also-kept](also-kept.pdf)",
    ].join("\n"));

    expect(parsed.issues).toEqual([]);
    expect(parsed.references.map(({ line, target }) => ({ line, target }))).toEqual([
      { line: 11, target: "kept.png" },
      { line: 12, target: "also-kept.pdf" },
    ]);
  });
});

describe("local attachment validation", () => {
  test("resolves source-relative Markdown and documented Obsidian paths without reading binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-"));
    try {
      await mkdir(join(root, "notes", "deep"), { recursive: true });
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "assets", "my diagram.png"), "not parsed", "utf8");
      await writeFile(join(root, "assets", "User Guide.pdf"), "not parsed", "utf8");
      await writeFile(join(root, "assets", "board.tldraw"), "not parsed", "utf8");
      await writeFile(join(root, "capture.tldr"), "not parsed", "utf8");

      const report = await validateMarkdownAttachments({
        root,
        documents: [{
          path: "notes/deep/memory.md",
          content: [
            "![diagram](../../assets/my%20diagram.png)",
            "[manual](<../../assets/User Guide.pdf>)",
            "![[assets/board.tldraw]]",
            "[[capture.tldr]]",
            "![remote](https://example.com/image.png)",
          ].join("\n"),
        }],
      });

      expect(report.issues).toEqual([]);
      expect(report.attachments.map(({ path }) => path)).toEqual([
        "assets/my diagram.png",
        "assets/User Guide.pdf",
        "assets/board.tldraw",
        "capture.tldr",
      ]);
      expect(report.attachments.every(({ bytes }) => bytes === 10)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing, escaping, ambiguous, and case-mismatched targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-"));
    try {
      await mkdir(join(root, "notes"), { recursive: true });
      await mkdir(join(root, "a"), { recursive: true });
      await mkdir(join(root, "b"), { recursive: true });
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "a", "chart.png"), "a", "utf8");
      await writeFile(join(root, "b", "chart.png"), "b", "utf8");
      await writeFile(join(root, "assets", "Photo.PNG"), "photo", "utf8");

      const report = await validateMarkdownAttachments({
        root,
        documents: [{
          path: "notes/memory.md",
          content: [
            "![missing](missing.png)",
            "![escape](../../outside.png)",
            "![[chart.png]]",
            "![case](../assets/photo.png)",
          ].join("\n"),
        }],
      });

      expect(report.attachments).toEqual([]);
      expect(report.issues.map(({ kind }) => kind)).toEqual([
        "missing",
        "traversal",
        "ambiguous",
        "case-mismatch",
      ]);
      expect(report.issues[2]?.candidates).toEqual(["a/chart.png", "b/chart.png"]);
      expect(report.issues[3]?.candidates).toEqual(["assets/Photo.PNG"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports missing nested and reference-style attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-"));
    try {
      await mkdir(join(root, "notes"), { recursive: true });
      const report = await validateMarkdownAttachments({
        root,
        documents: [{
          path: "notes/report.md",
          content: [
            "![nested](result(1).png)",
            "![reference][artifact]",
            "[artifact]: missing.pdf",
          ].join("\n"),
        }],
      });
      expect(report.issues.map(({ kind, line, target }) => ({ kind, line, target }))).toEqual([
        { kind: "missing", line: 1, target: "result(1).png" },
        { kind: "missing", line: 2, target: "missing.pdf" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symbolic links, hard links, and non-regular attachment targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-"));
    const outside = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-outside-"));
    try {
      await mkdir(join(root, "notes"), { recursive: true });
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "assets", "original.png"), "original", "utf8");
      await link(join(root, "assets", "original.png"), join(root, "assets", "hard.png"));
      await writeFile(join(outside, "outside.png"), "outside", "utf8");
      await symlink(join(outside, "outside.png"), join(root, "assets", "linked.png"));
      await mkdir(join(root, "assets", "folder.pdf"));

      const report = await validateMarkdownAttachments({
        root,
        documents: [{
          path: "notes/memory.md",
          content: [
            "![hard](../assets/hard.png)",
            "![linked](../assets/linked.png)",
            "[folder](../assets/folder.pdf)",
          ].join("\n"),
        }],
      });

      expect(report.attachments).toEqual([]);
      expect(report.issues.map(({ kind }) => kind)).toEqual([
        "hardlink",
        "symlink",
        "non-regular",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a symbolic-link vault root before traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-"));
    const parent = await mkdtemp(join(tmpdir(), "hraness-kb-attachments-link-"));
    const linkedRoot = join(parent, "vault");
    try {
      await symlink(root, linkedRoot);
      let thrown: unknown;
      try {
        await validateMarkdownAttachments({
          root: linkedRoot,
          documents: [{ path: "note.md", content: "" }],
        });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toContain("may not be a symbolic link");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
