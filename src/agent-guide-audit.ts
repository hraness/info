import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  parseAgentContextMarker,
  type AgentContextMarkerParseResult,
  type AgentGuideSource,
} from "./agent-context.js";

export const defaultAgentGuideIgnoredDirectories: ReadonlySet<string> = new Set([
  ".cache",
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

export type AgentGuideShapeIssue =
  | {
      readonly kind: "headings";
      readonly message: string;
    }
  | {
      readonly kind: "empty-contents";
      readonly message: string;
    }
  | {
      readonly kind: "empty-guidelines";
      readonly message: string;
    };

export type AgentGuideBullet = {
  readonly line: number;
  readonly text: string;
  readonly words: number;
};

export type AgentGuideSectionAudit = {
  readonly words: number;
  readonly bullets: readonly AgentGuideBullet[];
};

export type AgentGuideAudit = {
  readonly path: string;
  readonly scope: string;
  readonly source: string;
  readonly words: number;
  readonly nonblankLines: number;
  readonly contents: AgentGuideSectionAudit;
  readonly guidelines: AgentGuideSectionAudit;
  readonly marker: AgentContextMarkerParseResult;
  readonly shapeIssues: readonly AgentGuideShapeIssue[];
  readonly inheritedGuidePaths: readonly string[];
  readonly inheritedWords: number;
};

export type AgentGuideDuplicate = {
  readonly text: string;
  readonly words: number;
  readonly guides: readonly {
    readonly path: string;
    readonly line: number;
  }[];
};

export type AgentGuideAdvisory =
  | {
      readonly kind: "contents-budget";
      readonly path: string;
      readonly actualWords: number;
      readonly suggestedWords: number;
      readonly actualBullets: number;
      readonly suggestedBullets: number;
    }
  | {
      readonly kind: "guidelines-budget";
      readonly path: string;
      readonly actualWords: number;
      readonly suggestedWords: number;
      readonly actualBullets: number;
      readonly suggestedBullets: number;
    }
  | {
      readonly kind: "long-guideline";
      readonly path: string;
      readonly line: number;
      readonly words: number;
      readonly suggestedWords: number;
    }
  | {
      readonly kind: "inherited-budget";
      readonly path: string;
      readonly words: number;
      readonly suggestedWords: number;
      readonly guides: readonly string[];
    }
  | {
      readonly kind: "duplicate-guideline";
      readonly text: string;
      readonly words: number;
      readonly guides: readonly string[];
    };

export type AgentGuideAuditOptions = {
  readonly contentsWords?: number;
  readonly contentsBullets?: number;
  readonly guidelineWords?: number;
  readonly guidelineBullets?: number;
  readonly guidelineBulletWords?: number;
  readonly inheritedWords?: number;
};

export type AgentGuideAuditReport = {
  readonly guideCount: number;
  readonly mappedGuideCount: number;
  readonly words: number;
  readonly contentsWords: number;
  readonly guidelineWords: number;
  readonly nonblankLines: number;
  readonly guides: readonly AgentGuideAudit[];
  readonly duplicates: readonly AgentGuideDuplicate[];
  readonly advisories: readonly AgentGuideAdvisory[];
};

export type AgentGuideDiscoveryIssue = {
  readonly kind:
    | "symlink-directory"
    | "symlink-guide"
    | "non-regular-guide";
  readonly path: string;
  readonly message: string;
};

export type AgentGuideDiscovery = {
  readonly repositoryRoot: string;
  readonly guides: readonly AgentGuideSource[];
  readonly issues: readonly AgentGuideDiscoveryIssue[];
};

const defaultAuditOptions = {
  contentsWords: 120,
  contentsBullets: 8,
  guidelineWords: 250,
  guidelineBullets: 10,
  guidelineBulletWords: 40,
  inheritedWords: 1_200,
} as const;

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

function fenceDelimiter(line: string): { readonly character: "`" | "~"; readonly length: number } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  const delimiter = match?.[1];
  const character = delimiter?.[0];
  return delimiter !== undefined && (character === "`" || character === "~")
    ? { character, length: delimiter.length }
    : null;
}

function markdownHeadings(lines: readonly string[]): readonly {
  readonly line: number;
  readonly heading: string;
}[] {
  const headings: { line: number; heading: string }[] = [];
  let fence: { readonly character: "`" | "~"; readonly length: number } | null = null;
  for (const [index, line = ""] of lines.entries()) {
    const delimiter = fenceDelimiter(line);
    if (fence !== null) {
      if (delimiter?.character === fence.character && delimiter.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (delimiter !== null) {
      fence = delimiter;
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({ line: index + 1, heading: `${match[1]} ${match[2]}` });
    }
  }
  return headings;
}

function sectionBullets(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
): readonly AgentGuideBullet[] {
  const bullets: { line: number; parts: string[] }[] = [];
  let current: { line: number; parts: string[] } | undefined;
  let fence: { readonly character: "`" | "~"; readonly length: number } | null = null;
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index] ?? "";
    const delimiter = fenceDelimiter(line);
    if (fence !== null) {
      if (delimiter?.character === fence.character && delimiter.length >= fence.length) {
        fence = null;
      } else if (current !== undefined && line.trim() !== "") {
        current.parts.push(line.trim());
      }
      continue;
    }
    if (delimiter !== null) {
      fence = delimiter;
      if (current !== undefined) current.parts.push(line.trim());
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/u.exec(line);
    if (bullet?.[1] !== undefined) {
      current = { line: index + 1, parts: [bullet[1]] };
      bullets.push(current);
      continue;
    }
    if (current !== undefined && line.trim() !== "") current.parts.push(line.trim());
  }
  return bullets.map(({ line, parts }) => {
    const text = parts.join(" ").replace(/\s+/gu, " ").trim();
    return { line, text, words: wordCount(text) };
  });
}

function scopeForGuide(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "." : directory;
}

/** Parse one guide into shape, section, marker, and size measurements. */
export function auditAgentGuideSource(guide: AgentGuideSource): Omit<
  AgentGuideAudit,
  "inheritedGuidePaths" | "inheritedWords"
> {
  const lines = guide.source.split(/\r?\n/u);
  const headings = markdownHeadings(lines);
  const expected = ["# Contents", "# Guidelines"];
  const shapeIssues: AgentGuideShapeIssue[] = [];
  if (
    headings.length !== expected.length
    || headings.some(({ heading }, index) => heading !== expected[index])
  ) {
    shapeIssues.push({
      kind: "headings",
      message: "The guide must contain exactly '# Contents' then '# Guidelines' and no other headings.",
    });
  }

  const contentsHeading = headings.find(({ heading }) => heading === "# Contents");
  const guidelinesHeading = headings.find(({ heading }) => heading === "# Guidelines");
  const contentsStart = contentsHeading?.line ?? 0;
  const guidelinesStart = guidelinesHeading?.line ?? lines.length + 1;
  const contentsBody = contentsStart > 0 && guidelinesStart > contentsStart
    ? lines.slice(contentsStart, guidelinesStart - 1).join("\n").trim()
    : "";
  const guidelinesBody = guidelinesStart > 0
    ? lines.slice(guidelinesStart).join("\n").trim()
    : "";
  if (contentsBody === "") {
    shapeIssues.push({
      kind: "empty-contents",
      message: "Contents must describe useful direct children.",
    });
  }
  if (guidelinesBody === "") {
    shapeIssues.push({
      kind: "empty-guidelines",
      message: "Guidelines must contain scoped rules or '_None._'.",
    });
  }

  return {
    path: guide.path,
    scope: scopeForGuide(guide.path),
    source: guide.source,
    words: wordCount(guide.source),
    nonblankLines: lines.filter((line) => line.trim() !== "").length,
    contents: {
      words: wordCount(contentsBody),
      bullets: sectionBullets(
        lines,
        contentsStart,
        Math.max(contentsStart, guidelinesStart - 1),
      ),
    },
    guidelines: {
      words: wordCount(guidelinesBody),
      bullets: sectionBullets(lines, guidelinesStart, lines.length),
    },
    marker: parseAgentContextMarker(guide.source),
    shapeIssues,
  };
}

function scopeIsAncestor(ancestor: string, descendant: string): boolean {
  return ancestor === "."
    || ancestor === descendant
    || descendant.startsWith(`${ancestor}/`);
}

function guideSort(
  left: Pick<AgentGuideAudit, "path">,
  right: Pick<AgentGuideAudit, "path">,
): number {
  return left.path.localeCompare(right.path);
}

function duplicateGuidelines(
  guides: readonly AgentGuideAudit[],
): AgentGuideDuplicate[] {
  const groups = new Map<string, { path: string; line: number; words: number }[]>();
  for (const guide of guides) {
    for (const bullet of guide.guidelines.bullets) {
      const occurrences = groups.get(bullet.text) ?? [];
      occurrences.push({ path: guide.path, line: bullet.line, words: bullet.words });
      groups.set(bullet.text, occurrences);
    }
  }
  return [...groups.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([text, occurrences]): AgentGuideDuplicate => ({
      text,
      words: occurrences[0]?.words ?? 0,
      guides: occurrences
        .map(({ path, line }) => ({ path, line }))
        .toSorted((left, right) =>
          left.path.localeCompare(right.path) || left.line - right.line),
    }))
    .toSorted((left, right) =>
      right.guides.length - left.guides.length
      || right.words - left.words
      || left.text.localeCompare(right.text));
}

function advisoryTieBreakKey(advisory: AgentGuideAdvisory): string {
  const path = "path" in advisory ? advisory.path : "";
  const line = "line" in advisory ? advisory.line : 0;
  const text = "text" in advisory ? advisory.text : "";
  return `${advisory.kind}\0${path}\0${String(line).padStart(8, "0")}\0${text}`;
}

function budgetRatio(actual: number, suggested: number): number {
  return suggested > 0 ? actual / suggested : actual + 1;
}

function advisorySeverity(advisory: AgentGuideAdvisory): number {
  if (advisory.kind === "contents-budget") {
    return Math.max(
      budgetRatio(advisory.actualWords, advisory.suggestedWords),
      budgetRatio(advisory.actualBullets, advisory.suggestedBullets),
    );
  }
  if (advisory.kind === "guidelines-budget") {
    return Math.max(
      budgetRatio(advisory.actualWords, advisory.suggestedWords),
      budgetRatio(advisory.actualBullets, advisory.suggestedBullets),
    );
  }
  if (advisory.kind === "long-guideline") {
    return budgetRatio(advisory.words, advisory.suggestedWords);
  }
  if (advisory.kind === "inherited-budget") {
    return budgetRatio(advisory.words, advisory.suggestedWords);
  }
  return advisory.guides.length;
}

/** Produce deterministic per-guide, duplicate, and inherited-chain advisories. */
export function auditAgentGuides(
  guideSources: readonly AgentGuideSource[],
  options: AgentGuideAuditOptions = {},
): AgentGuideAuditReport {
  const thresholds = { ...defaultAuditOptions, ...options };
  const baseGuides = guideSources
    .map(auditAgentGuideSource)
    .toSorted(guideSort);
  const guides = baseGuides.map((guide): AgentGuideAudit => {
    const inherited = baseGuides
      .filter((candidate) => scopeIsAncestor(candidate.scope, guide.scope))
      .toSorted((left, right) => {
        const leftDepth = left.scope === "." ? 0 : left.scope.split("/").length;
        const rightDepth = right.scope === "." ? 0 : right.scope.split("/").length;
        return leftDepth - rightDepth || left.path.localeCompare(right.path);
      });
    return {
      ...guide,
      inheritedGuidePaths: inherited.map(({ path }) => path),
      inheritedWords: inherited.reduce((total, candidate) => total + candidate.words, 0),
    };
  });
  const duplicates = duplicateGuidelines(guides);
  const advisories: AgentGuideAdvisory[] = [];

  for (const guide of guides) {
    if (
      guide.contents.words > thresholds.contentsWords
      || guide.contents.bullets.length > thresholds.contentsBullets
    ) {
      advisories.push({
        kind: "contents-budget",
        path: guide.path,
        actualWords: guide.contents.words,
        suggestedWords: thresholds.contentsWords,
        actualBullets: guide.contents.bullets.length,
        suggestedBullets: thresholds.contentsBullets,
      });
    }
    if (
      guide.guidelines.words > thresholds.guidelineWords
      || guide.guidelines.bullets.length > thresholds.guidelineBullets
    ) {
      advisories.push({
        kind: "guidelines-budget",
        path: guide.path,
        actualWords: guide.guidelines.words,
        suggestedWords: thresholds.guidelineWords,
        actualBullets: guide.guidelines.bullets.length,
        suggestedBullets: thresholds.guidelineBullets,
      });
    }
    for (const bullet of guide.guidelines.bullets) {
      if (bullet.words > thresholds.guidelineBulletWords) {
        advisories.push({
          kind: "long-guideline",
          path: guide.path,
          line: bullet.line,
          words: bullet.words,
          suggestedWords: thresholds.guidelineBulletWords,
        });
      }
    }
    if (guide.inheritedWords > thresholds.inheritedWords) {
      advisories.push({
        kind: "inherited-budget",
        path: guide.path,
        words: guide.inheritedWords,
        suggestedWords: thresholds.inheritedWords,
        guides: guide.inheritedGuidePaths,
      });
    }
  }
  for (const duplicate of duplicates) {
    advisories.push({
      kind: "duplicate-guideline",
      text: duplicate.text,
      words: duplicate.words,
      guides: duplicate.guides.map(({ path }) => path),
    });
  }

  return {
    guideCount: guides.length,
    mappedGuideCount: guides.filter(({ marker }) => marker.kind === "found").length,
    words: guides.reduce((total, guide) => total + guide.words, 0),
    contentsWords: guides.reduce((total, guide) => total + guide.contents.words, 0),
    guidelineWords: guides.reduce((total, guide) => total + guide.guidelines.words, 0),
    nonblankLines: guides.reduce((total, guide) => total + guide.nonblankLines, 0),
    guides,
    duplicates,
    advisories: advisories.toSorted((left, right) =>
      advisorySeverity(right) - advisorySeverity(left)
      || advisoryTieBreakKey(left).localeCompare(advisoryTieBreakKey(right))),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

/** Discover regular AGENTS.md files without following repository symlinks. */
export async function discoverAgentGuides(
  repositoryRoot: string,
  ignoredDirectories: ReadonlySet<string> = defaultAgentGuideIgnoredDirectories,
): Promise<AgentGuideDiscovery> {
  const root = await realpath(resolve(repositoryRoot));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) throw new Error("The repository root must be a directory.");
  const guides: AgentGuideSource[] = [];
  const issues: AgentGuideDiscoveryIssue[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
      left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        if (entry.name === "AGENTS.md") {
          issues.push({
            kind: "symlink-guide",
            path,
            message: `The agent guide ${path} must be a regular file, not a symbolic link.`,
          });
        } else {
          try {
            const target = await realpath(absolutePath);
            if ((await lstat(target)).isDirectory()) {
              issues.push({
                kind: "symlink-directory",
                path,
                message: `Agent-guide discovery does not traverse the symbolic-link directory ${path}.`,
              });
            }
          } catch {
            // A broken non-guide symlink is outside this audit's ownership.
          }
        }
        continue;
      }
      if (entry.name === "AGENTS.md" && !entry.isFile()) {
        issues.push({
          kind: "non-regular-guide",
          path,
          message: `The agent guide ${path} must be a regular file.`,
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "AGENTS.md") continue;
      const canonicalPath = await realpath(absolutePath);
      if (!isWithin(root, canonicalPath)) {
        issues.push({
          kind: "symlink-guide",
          path,
          message: `The agent guide ${path} resolves outside the repository.`,
        });
        continue;
      }
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          issues.push({
            kind: "symlink-guide",
            path,
            message: `The agent guide ${path} must be a regular file.`,
          });
          continue;
        }
        guides.push({ path, source: await handle.readFile({ encoding: "utf8" }) });
      } finally {
        await handle.close();
      }
    }
  }

  await visit(root);
  return {
    repositoryRoot: root,
    guides: guides.toSorted((left, right) => left.path.localeCompare(right.path)),
    issues: issues.toSorted((left, right) =>
      left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
  };
}

/** Discover and audit every guide in a repository. */
export async function auditAgentGuideRepository(
  repositoryRoot: string,
  options: AgentGuideAuditOptions = {},
): Promise<AgentGuideDiscovery & { readonly audit: AgentGuideAuditReport }> {
  const discovery = await discoverAgentGuides(repositoryRoot);
  return {
    ...discovery,
    audit: auditAgentGuides(discovery.guides, options),
  };
}
