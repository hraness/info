// @bun
import {
  parseAgentContextMarker
} from "./index-5vwpzb5a.js";

// src/agent-guide-audit.ts
import { constants } from "fs";
import {
  lstat,
  open,
  readdir,
  realpath
} from "fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from "path";
var defaultAgentGuideIgnoredDirectories = new Set([
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
  "vendor"
]);
var defaultAuditOptions = {
  contentsWords: 120,
  contentsBullets: 8,
  guidelineWords: 250,
  guidelineBullets: 10,
  guidelineBulletWords: 40,
  inheritedWords: 1200
};
function wordCount(value) {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}
function fenceDelimiter(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
  const delimiter = match?.[1];
  const character = delimiter?.[0];
  return delimiter !== undefined && (character === "`" || character === "~") ? { character, length: delimiter.length } : null;
}
function markdownHeadings(lines) {
  const headings = [];
  let fence = null;
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
function sectionBullets(lines, startIndex, endIndex) {
  const bullets = [];
  let current;
  let fence = null;
  for (let index = startIndex;index < endIndex; index += 1) {
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
      if (current !== undefined)
        current.parts.push(line.trim());
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/u.exec(line);
    if (bullet?.[1] !== undefined) {
      current = { line: index + 1, parts: [bullet[1]] };
      bullets.push(current);
      continue;
    }
    if (current !== undefined && line.trim() !== "")
      current.parts.push(line.trim());
  }
  return bullets.map(({ line, parts }) => {
    const text = parts.join(" ").replace(/\s+/gu, " ").trim();
    return { line, text, words: wordCount(text) };
  });
}
function scopeForGuide(path) {
  const directory = posix.dirname(path);
  return directory === "." ? "." : directory;
}
function auditAgentGuideSource(guide) {
  const lines = guide.source.split(/\r?\n/u);
  const headings = markdownHeadings(lines);
  const expected = ["# Contents", "# Guidelines"];
  const shapeIssues = [];
  if (headings.length !== expected.length || headings.some(({ heading }, index) => heading !== expected[index])) {
    shapeIssues.push({
      kind: "headings",
      message: "The guide must contain exactly '# Contents' then '# Guidelines' and no other headings."
    });
  }
  const contentsHeading = headings.find(({ heading }) => heading === "# Contents");
  const guidelinesHeading = headings.find(({ heading }) => heading === "# Guidelines");
  const contentsStart = contentsHeading?.line ?? 0;
  const guidelinesStart = guidelinesHeading?.line ?? lines.length + 1;
  const contentsBody = contentsStart > 0 && guidelinesStart > contentsStart ? lines.slice(contentsStart, guidelinesStart - 1).join(`
`).trim() : "";
  const guidelinesBody = guidelinesStart > 0 ? lines.slice(guidelinesStart).join(`
`).trim() : "";
  if (contentsBody === "") {
    shapeIssues.push({
      kind: "empty-contents",
      message: "Contents must describe useful direct children."
    });
  }
  if (guidelinesBody === "") {
    shapeIssues.push({
      kind: "empty-guidelines",
      message: "Guidelines must contain scoped rules or '_None._'."
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
      bullets: sectionBullets(lines, contentsStart, Math.max(contentsStart, guidelinesStart - 1))
    },
    guidelines: {
      words: wordCount(guidelinesBody),
      bullets: sectionBullets(lines, guidelinesStart, lines.length)
    },
    marker: parseAgentContextMarker(guide.source),
    shapeIssues
  };
}
function scopeIsAncestor(ancestor, descendant) {
  return ancestor === "." || ancestor === descendant || descendant.startsWith(`${ancestor}/`);
}
function guideSort(left, right) {
  return left.path.localeCompare(right.path);
}
function duplicateGuidelines(guides) {
  const groups = new Map;
  for (const guide of guides) {
    for (const bullet of guide.guidelines.bullets) {
      const occurrences = groups.get(bullet.text) ?? [];
      occurrences.push({ path: guide.path, line: bullet.line, words: bullet.words });
      groups.set(bullet.text, occurrences);
    }
  }
  return [...groups.entries()].filter(([, occurrences]) => occurrences.length > 1).map(([text, occurrences]) => ({
    text,
    words: occurrences[0]?.words ?? 0,
    guides: occurrences.map(({ path, line }) => ({ path, line })).toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
  })).toSorted((left, right) => right.guides.length - left.guides.length || right.words - left.words || left.text.localeCompare(right.text));
}
function advisoryTieBreakKey(advisory) {
  const path = "path" in advisory ? advisory.path : "";
  const line = "line" in advisory ? advisory.line : 0;
  const text = "text" in advisory ? advisory.text : "";
  return `${advisory.kind}\x00${path}\x00${String(line).padStart(8, "0")}\x00${text}`;
}
function budgetRatio(actual, suggested) {
  return suggested > 0 ? actual / suggested : actual + 1;
}
function advisorySeverity(advisory) {
  if (advisory.kind === "contents-budget") {
    return Math.max(budgetRatio(advisory.actualWords, advisory.suggestedWords), budgetRatio(advisory.actualBullets, advisory.suggestedBullets));
  }
  if (advisory.kind === "guidelines-budget") {
    return Math.max(budgetRatio(advisory.actualWords, advisory.suggestedWords), budgetRatio(advisory.actualBullets, advisory.suggestedBullets));
  }
  if (advisory.kind === "long-guideline") {
    return budgetRatio(advisory.words, advisory.suggestedWords);
  }
  if (advisory.kind === "inherited-budget") {
    return budgetRatio(advisory.words, advisory.suggestedWords);
  }
  return advisory.guides.length;
}
function auditAgentGuides(guideSources, options = {}) {
  const thresholds = { ...defaultAuditOptions, ...options };
  const baseGuides = guideSources.map(auditAgentGuideSource).toSorted(guideSort);
  const guides = baseGuides.map((guide) => {
    const inherited = baseGuides.filter((candidate) => scopeIsAncestor(candidate.scope, guide.scope)).toSorted((left, right) => {
      const leftDepth = left.scope === "." ? 0 : left.scope.split("/").length;
      const rightDepth = right.scope === "." ? 0 : right.scope.split("/").length;
      return leftDepth - rightDepth || left.path.localeCompare(right.path);
    });
    return {
      ...guide,
      inheritedGuidePaths: inherited.map(({ path }) => path),
      inheritedWords: inherited.reduce((total, candidate) => total + candidate.words, 0)
    };
  });
  const duplicates = duplicateGuidelines(guides);
  const advisories = [];
  for (const guide of guides) {
    if (guide.contents.words > thresholds.contentsWords || guide.contents.bullets.length > thresholds.contentsBullets) {
      advisories.push({
        kind: "contents-budget",
        path: guide.path,
        actualWords: guide.contents.words,
        suggestedWords: thresholds.contentsWords,
        actualBullets: guide.contents.bullets.length,
        suggestedBullets: thresholds.contentsBullets
      });
    }
    if (guide.guidelines.words > thresholds.guidelineWords || guide.guidelines.bullets.length > thresholds.guidelineBullets) {
      advisories.push({
        kind: "guidelines-budget",
        path: guide.path,
        actualWords: guide.guidelines.words,
        suggestedWords: thresholds.guidelineWords,
        actualBullets: guide.guidelines.bullets.length,
        suggestedBullets: thresholds.guidelineBullets
      });
    }
    for (const bullet of guide.guidelines.bullets) {
      if (bullet.words > thresholds.guidelineBulletWords) {
        advisories.push({
          kind: "long-guideline",
          path: guide.path,
          line: bullet.line,
          words: bullet.words,
          suggestedWords: thresholds.guidelineBulletWords
        });
      }
    }
    if (guide.inheritedWords > thresholds.inheritedWords) {
      advisories.push({
        kind: "inherited-budget",
        path: guide.path,
        words: guide.inheritedWords,
        suggestedWords: thresholds.inheritedWords,
        guides: guide.inheritedGuidePaths
      });
    }
  }
  for (const duplicate of duplicates) {
    advisories.push({
      kind: "duplicate-guideline",
      text: duplicate.text,
      words: duplicate.words,
      guides: duplicate.guides.map(({ path }) => path)
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
    advisories: advisories.toSorted((left, right) => advisorySeverity(right) - advisorySeverity(left) || advisoryTieBreakKey(left).localeCompare(advisoryTieBreakKey(right)))
  };
}
function longGuidelinesByIdentity(report) {
  const guides = new Map(report.guides.map((guide) => [guide.path, guide]));
  const guidelines = new Map;
  for (const advisory of report.advisories) {
    if (advisory.kind !== "long-guideline")
      continue;
    const bullet = guides.get(advisory.path)?.guidelines.bullets.find((candidate) => candidate.line === advisory.line);
    if (bullet === undefined)
      continue;
    const identity = bullet.text;
    const existing = guidelines.get(identity);
    if (existing === undefined || advisory.path.localeCompare(existing.path) < 0 || advisory.path === existing.path && advisory.line < existing.line) {
      guidelines.set(identity, {
        path: advisory.path,
        line: advisory.line,
        text: bullet.text,
        words: advisory.words,
        suggestedWords: advisory.suggestedWords
      });
    }
  }
  return guidelines;
}
function guidelineGuideSets(report) {
  const guideSets = new Map;
  for (const guide of report.guides) {
    for (const bullet of guide.guidelines.bullets) {
      const paths = guideSets.get(bullet.text) ?? new Set;
      paths.add(guide.path);
      guideSets.set(bullet.text, paths);
    }
  }
  return new Map([...guideSets].map(([text, paths]) => [
    text,
    [...paths].toSorted((left, right) => left.localeCompare(right))
  ]));
}
function compareAgentGuideAudits(base, current) {
  const baseGuides = new Map(base.guides.map((guide) => [guide.path, guide]));
  const guideWordRegressions = [];
  const inheritedWordRegressions = [];
  for (const guide of current.guides) {
    const baseGuide = baseGuides.get(guide.path);
    const baseWords = baseGuide?.words ?? 0;
    if (guide.words > baseWords) {
      guideWordRegressions.push({
        path: guide.path,
        baseWords,
        currentWords: guide.words,
        addedWords: guide.words - baseWords
      });
    }
    const baseInheritedWords = baseGuide?.inheritedWords ?? 0;
    if (guide.inheritedWords > baseInheritedWords) {
      inheritedWordRegressions.push({
        path: guide.path,
        baseWords: baseInheritedWords,
        currentWords: guide.inheritedWords,
        addedWords: guide.inheritedWords - baseInheritedWords,
        guides: guide.inheritedGuidePaths
      });
    }
  }
  const baseLongGuidelines = longGuidelinesByIdentity(base);
  const newlyLongGuidelines = [...longGuidelinesByIdentity(current)].filter(([identity]) => !baseLongGuidelines.has(identity)).map(([, guideline]) => guideline).toSorted((left, right) => left.path.localeCompare(right.path) || left.text.localeCompare(right.text) || left.line - right.line);
  const baseGuideSets = guidelineGuideSets(base);
  const expandedDuplicateGuidelines = [...guidelineGuideSets(current)].flatMap(([text, currentGuides]) => {
    if (currentGuides.length < 2)
      return [];
    const baseGuidesForText = baseGuideSets.get(text) ?? [];
    if (currentGuides.length <= baseGuidesForText.length)
      return [];
    const baseSet = new Set(baseGuidesForText);
    const addedGuides = currentGuides.filter((path) => !baseSet.has(path));
    if (addedGuides.length === 0)
      return [];
    const words = current.guides.flatMap((guide) => guide.guidelines.bullets).find((bullet) => bullet.text === text)?.words ?? 0;
    return [{
      text,
      words,
      baseGuides: baseGuidesForText,
      currentGuides,
      addedGuides
    }];
  }).toSorted((left, right) => left.text.localeCompare(right.text));
  return {
    guideWordRegressions: guideWordRegressions.toSorted(guideSort),
    inheritedWordRegressions: inheritedWordRegressions.toSorted(guideSort),
    newlyLongGuidelines,
    expandedDuplicateGuidelines
  };
}
function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
async function discoverAgentGuides(repositoryRoot, ignoredDirectories = defaultAgentGuideIgnoredDirectories) {
  const root = await realpath(resolve(repositoryRoot));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory())
    throw new Error("The repository root must be a directory.");
  const guides = [];
  const issues = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name))
        continue;
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        if (entry.name === "AGENTS.md") {
          issues.push({
            kind: "symlink-guide",
            path,
            message: `The agent guide ${path} must be a regular file, not a symbolic link.`
          });
        } else {
          try {
            const target = await realpath(absolutePath);
            if ((await lstat(target)).isDirectory()) {
              issues.push({
                kind: "symlink-directory",
                path,
                message: `Agent-guide discovery does not traverse the symbolic-link directory ${path}.`
              });
            }
          } catch {}
        }
        continue;
      }
      if (entry.name === "AGENTS.md" && !entry.isFile()) {
        issues.push({
          kind: "non-regular-guide",
          path,
          message: `The agent guide ${path} must be a regular file.`
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "AGENTS.md")
        continue;
      const canonicalPath = await realpath(absolutePath);
      if (!isWithin(root, canonicalPath)) {
        issues.push({
          kind: "symlink-guide",
          path,
          message: `The agent guide ${path} resolves outside the repository.`
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
            message: `The agent guide ${path} must be a regular file.`
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
    issues: issues.toSorted((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
  };
}
async function auditAgentGuideRepository(repositoryRoot, options = {}) {
  const discovery = await discoverAgentGuides(repositoryRoot);
  return {
    ...discovery,
    audit: auditAgentGuides(discovery.guides, options)
  };
}

export { defaultAgentGuideIgnoredDirectories, auditAgentGuideSource, auditAgentGuides, compareAgentGuideAudits, discoverAgentGuides, auditAgentGuideRepository };
