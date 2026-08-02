// @bun
// src/attachments.ts
import {
  lstat,
  readdir,
  realpath
} from "fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "path";
var MAX_ATTACHMENT_REFERENCES = 1e4;
var MAX_ATTACHMENT_SOURCE_BYTES = 16 * 1024 * 1024;
var MAX_ATTACHMENT_PATH_BYTES = 16 * 1024;
var MAX_ATTACHMENT_SCAN_ENTRIES = 1e5;
var supportedExtensions = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".svg",
  ".tldr",
  ".tldraw",
  ".webp"
]);
var externalPattern = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;
var windowsAbsolutePattern = /^[a-z]:[\\/]/iu;
var ignoredInventoryDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules"
]);
function hasControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
function attachmentExtension(target) {
  return extname(target).toLocaleLowerCase("en-US");
}
function isSupportedAttachment(target) {
  return supportedExtensions.has(attachmentExtension(target));
}
function issueFor(reference, kind, message, candidates) {
  return Object.freeze({
    kind,
    source: reference.source,
    line: reference.line,
    syntax: reference.syntax,
    target: reference.rawTarget,
    message,
    ...candidates === undefined ? {} : { candidates: Object.freeze([...candidates]) }
  });
}
function decodeLocalTarget(rawTarget, reference) {
  const withoutDecoration = rawTarget.trim().split(/[?#^]/u, 1)[0] ?? "";
  if (withoutDecoration === "" || withoutDecoration.startsWith("#")) {
    return { external: true };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(withoutDecoration).replace(/\\([\\()[\] ])/gu, "$1").normalize("NFC");
  } catch {
    if (!isSupportedAttachment(withoutDecoration))
      return { external: true };
    return {
      external: false,
      issue: issueFor(reference, "malformed-target", "Attachment target has invalid percent encoding.")
    };
  }
  if (windowsAbsolutePattern.test(decoded)) {
    if (!isSupportedAttachment(decoded))
      return { external: true };
    return {
      external: false,
      issue: issueFor(reference, "traversal", "Attachment targets must be vault-relative.")
    };
  }
  if (externalPattern.test(decoded))
    return { external: true };
  if (!isSupportedAttachment(decoded))
    return { external: true };
  if (decoded === "" || hasControl(decoded)) {
    return {
      external: false,
      issue: issueFor(reference, "malformed-target", "Attachment target is empty or contains control characters.")
    };
  }
  if (Buffer.byteLength(decoded, "utf8") > MAX_ATTACHMENT_PATH_BYTES) {
    return {
      external: false,
      issue: issueFor(reference, "budget", `Attachment targets may use at most ${MAX_ATTACHMENT_PATH_BYTES.toLocaleString("en-US")} UTF-8 bytes.`)
    };
  }
  return { target: decoded, external: false };
}
function markdownDestination(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const match = /^(?:\\.|[^\s])+/u.exec(trimmed);
  return match?.[0] ?? "";
}
function normalizedReferenceLabel(value) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}
function inlineMarkdownLinks(line) {
  const links = [];
  for (let cursor = 0;cursor < line.length; cursor += 1) {
    const image = line[cursor] === "!" && line[cursor + 1] === "[";
    if (line[cursor] !== "[" && !image)
      continue;
    const opening = image ? cursor + 1 : cursor;
    if (line[opening - 1] === "\\" || line[opening + 1] === "[")
      continue;
    let closing = opening + 1;
    for (;closing < line.length; closing += 1) {
      if (line[closing] === "]" && line[closing - 1] !== "\\")
        break;
    }
    if (closing >= line.length || line[closing + 1] !== "(")
      continue;
    let depth = 1;
    let destinationEnd = closing + 2;
    let angle = false;
    for (;destinationEnd < line.length; destinationEnd += 1) {
      const character = line[destinationEnd];
      if (character === "\\") {
        destinationEnd += 1;
        continue;
      }
      if (character === "<" && depth === 1)
        angle = true;
      else if (character === ">" && angle)
        angle = false;
      else if (!angle && character === "(")
        depth += 1;
      else if (!angle && character === ")") {
        depth -= 1;
        if (depth === 0)
          break;
      }
    }
    if (depth !== 0)
      continue;
    links.push({
      image,
      rawTarget: markdownDestination(line.slice(closing + 2, destinationEnd))
    });
    cursor = destinationEnd;
  }
  return links;
}
function maskInlineCode(value) {
  const characters = [...value];
  let cursor = 0;
  while (cursor < characters.length) {
    if (characters[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let ticks = 1;
    while (characters[cursor + ticks] === "`")
      ticks += 1;
    const delimiter = "`".repeat(ticks);
    const remainder = characters.slice(cursor + ticks).join("");
    const closingOffset = remainder.indexOf(delimiter);
    if (closingOffset === -1)
      break;
    const end = cursor + ticks + [...remainder.slice(0, closingOffset)].length + ticks;
    for (let index = cursor;index < end; index += 1)
      characters[index] = " ";
    cursor = end;
  }
  return characters.join("");
}
function maskHtmlComments(value, startsInsideComment) {
  let cursor = 0;
  let insideComment = startsInsideComment;
  let masked = "";
  while (cursor < value.length) {
    if (insideComment) {
      const closing = value.indexOf("-->", cursor);
      if (closing === -1) {
        masked += " ".repeat(value.length - cursor);
        return { line: masked, insideComment: true };
      }
      masked += " ".repeat(closing + 3 - cursor);
      cursor = closing + 3;
      insideComment = false;
      continue;
    }
    const opening = value.indexOf("<!--", cursor);
    if (opening === -1) {
      masked += value.slice(cursor);
      break;
    }
    masked += value.slice(cursor, opening);
    masked += " ".repeat(4);
    cursor = opening + 4;
    insideComment = true;
  }
  return { line: masked, insideComment };
}
function normalizedSource(source) {
  const normalized = source.replaceAll("\\", "/").normalize("NFC");
  if (normalized === "" || isAbsolute(normalized) || windowsAbsolutePattern.test(normalized) || hasControl(normalized) || normalized.split("/").some((part, index) => part === ".." || part === "" || part === "." && index !== 0)) {
    throw new TypeError("Attachment source paths must be normalized vault-relative paths.");
  }
  return normalized.replace(/^\.\//u, "");
}
function parseLocalAttachmentReferences(sourceInput, markdown, options = {}) {
  const source = normalizedSource(sourceInput);
  const maxReferences = options.maxReferences ?? MAX_ATTACHMENT_REFERENCES;
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > MAX_ATTACHMENT_REFERENCES) {
    throw new RangeError(`Attachment reference limit must be from 1 through ${MAX_ATTACHMENT_REFERENCES}.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_SOURCE_BYTES) {
    throw new RangeError(`Attachment source byte limit must be from 1 through ${MAX_ATTACHMENT_SOURCE_BYTES}.`);
  }
  if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
    throw new RangeError(`Attachment source exceeds the ${maxBytes.toLocaleString("en-US")}-byte limit.`);
  }
  const references = [];
  const issues = [];
  let truncated = false;
  let fence = null;
  let htmlComment = false;
  let frontmatter = false;
  const add = (line, syntax, rawTarget) => {
    if (references.length + issues.length >= maxReferences) {
      truncated = true;
      return;
    }
    const shell = { source, line, syntax, rawTarget };
    const decoded = decodeLocalTarget(rawTarget, shell);
    if (decoded.external)
      return;
    if (decoded.issue !== undefined) {
      issues.push(decoded.issue);
      return;
    }
    const target = decoded.target;
    if (target === undefined)
      return;
    references.push(Object.freeze({ ...shell, target }));
  };
  const lines = markdown.split(/\r?\n/u).map((rawLine, index) => {
    if (index === 0 && /^\uFEFF?---\s*$/u.test(rawLine)) {
      frontmatter = true;
      return { index, line: "", definition: true };
    }
    if (frontmatter) {
      if (/^(?:---|\.\.\.)\s*$/u.test(rawLine))
        frontmatter = false;
      return { index, line: "", definition: true };
    }
    if (fence !== null) {
      const fenceMatch2 = /^\s*(`{3,}|~{3,})/u.exec(rawLine);
      const marker = fenceMatch2?.[1]?.[0];
      if (marker === fence)
        fence = null;
      return { index, line: "", definition: true };
    }
    const inlineMasked = htmlComment ? rawLine : maskInlineCode(rawLine);
    const commentMasked = maskHtmlComments(inlineMasked, htmlComment);
    htmlComment = commentMasked.insideComment;
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(commentMasked.line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]?.[0];
      if (marker !== undefined)
        fence = marker;
      return { index, line: "", definition: true };
    }
    if (/^(?: {4}|\t)/u.test(rawLine)) {
      return { index, line: "", definition: true };
    }
    return {
      index,
      line: htmlComment ? commentMasked.line : maskInlineCode(commentMasked.line),
      definition: false
    };
  });
  const definitions = new Map;
  for (const entry of lines) {
    const match = /^ {0,3}\[([^\]\n]+)\]:\s*(.*)$/u.exec(entry.line);
    if (match === null)
      continue;
    entry.definition = true;
    const label = normalizedReferenceLabel(match[1] ?? "");
    if (label !== "" && !definitions.has(label)) {
      definitions.set(label, markdownDestination(match[2] ?? ""));
    }
  }
  for (const { index, line, definition } of lines) {
    if (definition || truncated)
      continue;
    for (const match of inlineMarkdownLinks(line)) {
      add(index + 1, match.image ? "markdown-image" : "markdown-link", match.rawTarget);
    }
    for (const match of line.matchAll(/(!?)\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/gu)) {
      const matchIndex = match.index;
      if (matchIndex === undefined)
        continue;
      const whole = match[0] ?? "";
      if (line[matchIndex - 1] === "[" || line[matchIndex + whole.length] === "(")
        continue;
      const explicitLabel = match[3];
      const label = normalizedReferenceLabel(explicitLabel === undefined || explicitLabel === "" ? match[2] ?? "" : explicitLabel);
      const rawTarget = definitions.get(label);
      if (rawTarget !== undefined) {
        add(index + 1, match[1] === "!" ? "markdown-image" : "markdown-link", rawTarget);
      }
    }
    for (const match of line.matchAll(/(!?)\[\[([^\]\n]+)\]\]/gu)) {
      const rawTarget = (match[2] ?? "").split("|", 1)[0]?.trim() ?? "";
      add(index + 1, match[1] === "!" ? "obsidian-embed" : "obsidian-link", rawTarget);
    }
  }
  if (truncated) {
    issues.push(Object.freeze({
      kind: "budget",
      source,
      line: 1,
      syntax: "markdown-link",
      target: "",
      message: `Attachment source exceeds the ${maxReferences.toLocaleString("en-US")}-reference limit.`
    }));
  }
  return Object.freeze({
    references: Object.freeze(references),
    issues: Object.freeze(issues),
    truncated
  });
}
function insideRoot(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}
function folded(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
async function inventoryAttachments(root, maximumEntries) {
  const files = [];
  const basename = new Map;
  const collisions = new Map;
  const pending = [""];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined)
      break;
    const absoluteDirectory = resolve(root, directory);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    const siblings = new Map;
    for (const child of children) {
      entries += 1;
      if (entries > maximumEntries) {
        throw new RangeError(`Attachment inventory exceeds the ${maximumEntries.toLocaleString("en-US")}-entry limit.`);
      }
      const relativePath = directory === "" ? child.name : `${directory}/${child.name}`;
      const key = folded(child.name);
      const matches = siblings.get(key) ?? [];
      matches.push(relativePath);
      siblings.set(key, matches);
      if (isSupportedAttachment(child.name)) {
        const names = basename.get(key) ?? [];
        names.push(relativePath);
        basename.set(key, names);
      }
      if (child.isSymbolicLink())
        continue;
      if (child.isDirectory()) {
        if (!child.name.startsWith(".") && !ignoredInventoryDirectories.has(child.name)) {
          pending.push(relativePath);
        }
      } else if (child.isFile() && isSupportedAttachment(child.name)) {
        files.push(relativePath);
      }
    }
    for (const [key, matches] of siblings) {
      if (matches.length > 1)
        collisions.set(`${directory}\x00${key}`, matches.toSorted());
    }
  }
  return Object.freeze({
    files: Object.freeze(files.toSorted()),
    basename: new Map([...basename].map(([key, values]) => [key, Object.freeze(values.toSorted())])),
    collisions: new Map([...collisions].map(([key, values]) => [key, Object.freeze(values)]))
  });
}
async function inspectExactPath(root, candidateRelative, inventory, reference) {
  const parts = candidateRelative.split("/").filter(Boolean);
  let directory = "";
  for (const [index, part] of parts.entries()) {
    const key = `${directory}\x00${folded(part)}`;
    const collision = inventory.collisions.get(key);
    if (collision !== undefined) {
      return {
        issue: issueFor(reference, "case-collision", "Attachment path is ambiguous under case-insensitive or Unicode-normalized lookup.", collision)
      };
    }
    const children = await readdir(resolve(root, directory), { withFileTypes: true });
    const equivalent = children.filter(({ name }) => folded(name) === folded(part));
    const exact = equivalent.find(({ name }) => name === part);
    if (exact === undefined) {
      if (equivalent.length > 0) {
        const actual = equivalent.map(({ name }) => directory === "" ? name : `${directory}/${name}`);
        return {
          issue: issueFor(reference, "case-mismatch", "Attachment target casing or Unicode normalization does not match the filesystem.", actual)
        };
      }
      return { issue: issueFor(reference, "missing", "Attachment target does not exist.") };
    }
    const next = directory === "" ? exact.name : `${directory}/${exact.name}`;
    const status2 = await lstat(resolve(root, next));
    if (status2.isSymbolicLink()) {
      return { issue: issueFor(reference, "symlink", "Attachment paths may not traverse symbolic links.") };
    }
    if (index < parts.length - 1 && !status2.isDirectory()) {
      return { issue: issueFor(reference, "non-regular", "An attachment path ancestor is not a directory.") };
    }
    directory = next;
  }
  const status = await lstat(resolve(root, candidateRelative));
  if (!status.isFile()) {
    return { issue: issueFor(reference, "non-regular", "Attachment target must be a regular file.") };
  }
  if (status.nlink !== 1) {
    return { issue: issueFor(reference, "hardlink", "Attachment target may not be a hard-linked file.") };
  }
  return {
    attachment: Object.freeze({
      ...reference,
      path: candidateRelative,
      bytes: status.size
    })
  };
}
function candidateFor(root, reference, inventory) {
  const slashTarget = reference.target.replaceAll("\\", "/");
  if (isAbsolute(slashTarget)) {
    return { issue: issueFor(reference, "traversal", "Attachment targets must be vault-relative.") };
  }
  let candidateRelative;
  if (reference.syntax === "markdown-image" || reference.syntax === "markdown-link") {
    const absolute = resolve(root, dirname(reference.source), slashTarget);
    if (!insideRoot(root, absolute)) {
      return { issue: issueFor(reference, "traversal", "Attachment target escapes the vault root.") };
    }
    candidateRelative = relative(root, absolute).split(sep).join("/");
  } else if (slashTarget.includes("/")) {
    const absolute = resolve(root, slashTarget);
    if (!insideRoot(root, absolute) || slashTarget.split("/").includes("..")) {
      return { issue: issueFor(reference, "traversal", "Obsidian attachment paths must be vault-relative without traversal.") };
    }
    candidateRelative = relative(root, absolute).split(sep).join("/");
  } else {
    const matches = inventory.basename.get(folded(slashTarget)) ?? [];
    if (matches.length === 0) {
      return { issue: issueFor(reference, "missing", "Obsidian attachment basename was not found in the vault.") };
    }
    const collidingMatches = matches.flatMap((path) => {
      const separator = path.lastIndexOf("/");
      const directory = separator === -1 ? "" : path.slice(0, separator);
      return inventory.collisions.get(`${directory}\x00${folded(slashTarget)}`) ?? [];
    });
    if (collidingMatches.length > 0) {
      return {
        issue: issueFor(reference, "case-collision", "Obsidian attachment basename collides under case-insensitive or Unicode-normalized lookup.", [...new Set(collidingMatches)].toSorted())
      };
    }
    if (matches.length > 1) {
      return {
        issue: issueFor(reference, "ambiguous", "Obsidian attachment basename resolves to more than one vault file.", matches)
      };
    }
    candidateRelative = matches[0] ?? "";
    const actualBasename = candidateRelative.slice(candidateRelative.lastIndexOf("/") + 1);
    if (actualBasename !== slashTarget) {
      return {
        issue: issueFor(reference, "case-mismatch", "Obsidian attachment basename casing or Unicode normalization does not match the filesystem.", [candidateRelative])
      };
    }
  }
  return { path: candidateRelative };
}
async function validateAttachmentReferences(options) {
  if (options.references.length > MAX_ATTACHMENT_REFERENCES) {
    throw new RangeError(`Attachment validation accepts at most ${MAX_ATTACHMENT_REFERENCES} references.`);
  }
  if ((options.parseIssues?.length ?? 0) > MAX_ATTACHMENT_REFERENCES + 1) {
    throw new RangeError(`Attachment validation accepts at most ${MAX_ATTACHMENT_REFERENCES + 1} parse issues.`);
  }
  const maxEntries = options.maxEntries ?? MAX_ATTACHMENT_SCAN_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ATTACHMENT_SCAN_ENTRIES) {
    throw new RangeError(`Attachment inventory limit must be from 1 through ${MAX_ATTACHMENT_SCAN_ENTRIES}.`);
  }
  const requestedRootStatus = await lstat(options.root);
  if (requestedRootStatus.isSymbolicLink()) {
    throw new TypeError("Attachment root may not be a symbolic link.");
  }
  const root = await realpath(options.root);
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new TypeError("Attachment root must be a real directory.");
  }
  const inventory = await inventoryAttachments(root, maxEntries);
  const attachments = [];
  const issues = [...options.parseIssues ?? []];
  for (const reference of options.references) {
    const candidate = candidateFor(root, reference, inventory);
    if (candidate.issue !== undefined) {
      issues.push(candidate.issue);
      continue;
    }
    const candidatePath = candidate.path;
    if (candidatePath === undefined)
      continue;
    const inspected = await inspectExactPath(root, candidatePath, inventory, reference);
    if (inspected.issue !== undefined)
      issues.push(inspected.issue);
    else if (inspected.attachment !== undefined)
      attachments.push(inspected.attachment);
  }
  return Object.freeze({
    root,
    references: Object.freeze([...options.references]),
    attachments: Object.freeze(attachments),
    issues: Object.freeze(issues),
    truncated: options.parseTruncated === true
  });
}
async function validateMarkdownAttachments(options) {
  const maximum = options.maxReferences ?? MAX_ATTACHMENT_REFERENCES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ATTACHMENT_REFERENCES) {
    throw new RangeError(`Attachment reference limit must be from 1 through ${MAX_ATTACHMENT_REFERENCES}.`);
  }
  const references = [];
  const issues = [];
  let truncated = false;
  for (const document of options.documents) {
    const remaining = maximum - references.length - issues.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const parsed = parseLocalAttachmentReferences(document.path, document.content, {
      maxReferences: remaining
    });
    references.push(...parsed.references);
    issues.push(...parsed.issues);
    truncated ||= parsed.truncated;
    if (parsed.truncated)
      break;
  }
  const report = await validateAttachmentReferences({
    root: options.root,
    references,
    parseIssues: issues,
    parseTruncated: truncated,
    ...options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }
  });
  return Object.freeze({ ...report, truncated: truncated || report.truncated });
}

export { MAX_ATTACHMENT_REFERENCES, MAX_ATTACHMENT_SOURCE_BYTES, MAX_ATTACHMENT_PATH_BYTES, MAX_ATTACHMENT_SCAN_ENTRIES, parseLocalAttachmentReferences, validateAttachmentReferences, validateMarkdownAttachments };
