// @bun
import {
  countWords,
  sniffImage
} from "./index-sm1xsdta.js";
import {
  slugify,
  yamlString
} from "./index-hgve9rh2.js";
import {
  safeFetch
} from "./index-b0b0vy11.js";
import {
  BoundedByteBuffer
} from "./index-gh719d91.js";
import {
  redactSensitiveText,
  sanitizeArtifactUrl
} from "./index-ey9rycsn.js";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText
} from "./index-1xxnjn0d.js";

// src/pdf/args.ts
var pdfUsage = `kb pdf \u2014 save a local or public remote PDF as an auditable Markdown bundle

Usage:
  kb pdf <file-or-url> [--output <directory>] [--slug <slug>] [--annotations <json>] [--force] [--json]
  kb pdf save <file-or-url> [capture options]

Capture options:
  --output <directory>          Bundle parent (default: KB_PDF_OUTPUT or kb/articles)
  --slug <slug>                 Override the title-derived bundle name
  --annotations <json>         Optional hash-bound image interpretations from an agent
  --timeout-ms <milliseconds>  Per-tool timeout
  --max-pdf-bytes <size>       Input limit, for example 512mb
  --max-pages <count>          Maximum pages to process
  --max-images <count>         Maximum embedded images
  --max-asset-bytes <size>     Per-image limit
  --max-total-asset-bytes <size>
  --force                       Replace only a compatible PDF capture bundle
  --json                        Emit a machine-readable result
  --quiet                       Suppress progress and warning lines
`;
var valueOptions = new Set([
  "--output",
  "--slug",
  "--annotations",
  "--timeout-ms",
  "--max-pdf-bytes",
  "--max-pages",
  "--max-images",
  "--max-asset-bytes",
  "--max-total-asset-bytes"
]);
function optionValue(arguments_, index, name) {
  const value = arguments_[index + 1];
  return value === undefined || value.startsWith("--") ? { ok: false, message: `${name} requires a value` } : value;
}
function positiveInteger(value, name, maximum) {
  if (!/^\d+$/u.test(value))
    return `${name} must be a positive integer`;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : `${name} must be between 1 and ${maximum}`;
}
function byteSize(value, name, maximum) {
  const match = /^(\d+)(b|kb|mb|gb)?$/iu.exec(value);
  if (match === null || match[1] === undefined) {
    return `${name} must be an integer byte size such as 500000, 25mb, or 1gb`;
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  const multiplier = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  const parsed = amount * multiplier;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : `${name} must be between 1 byte and ${maximum} bytes`;
}
function parsePdfArguments(rawArguments, environment = {}) {
  if (rawArguments.length === 0 || rawArguments[0] === "help" || rawArguments[0] === "--help" || rawArguments[0] === "-h")
    return { ok: true, value: { command: "help" } };
  let cursor = rawArguments[0] === "save" || rawArguments[0] === "capture" ? 1 : 0;
  const positional = [];
  let outputBase = environment.KB_PDF_OUTPUT ?? "kb/articles";
  let slug;
  let interpretationsPath;
  let force = false;
  let json = false;
  let quiet = false;
  let timeoutMs;
  let maxPdfBytes;
  let maxPages;
  let maxImages;
  let maxAssetBytes;
  let maxTotalAssetBytes;
  for (;cursor < rawArguments.length; cursor += 1) {
    const argument = rawArguments[cursor];
    if (argument === undefined)
      continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--quiet") {
      quiet = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      return { ok: false, message: `unknown PDF option: ${argument}` };
    }
    const rawValue = optionValue(rawArguments, cursor, argument);
    if (typeof rawValue !== "string")
      return rawValue;
    cursor += 1;
    if (argument === "--output")
      outputBase = rawValue;
    else if (argument === "--slug")
      slug = rawValue;
    else if (argument === "--annotations")
      interpretationsPath = rawValue;
    else if (argument === "--timeout-ms") {
      const parsed = positiveInteger(rawValue, argument, 10 * 60000);
      if (typeof parsed === "string")
        return { ok: false, message: parsed };
      timeoutMs = parsed;
    } else if (argument === "--max-pages") {
      const parsed = positiveInteger(rawValue, argument, 1e4);
      if (typeof parsed === "string")
        return { ok: false, message: parsed };
      maxPages = parsed;
    } else if (argument === "--max-images") {
      const parsed = positiveInteger(rawValue, argument, 1e4);
      if (typeof parsed === "string")
        return { ok: false, message: parsed };
      maxImages = parsed;
    } else {
      const maximum = argument === "--max-asset-bytes" ? 2 * 1024 ** 3 : 8 * 1024 ** 3;
      const parsed = byteSize(rawValue, argument, maximum);
      if (typeof parsed === "string")
        return { ok: false, message: parsed };
      if (argument === "--max-pdf-bytes")
        maxPdfBytes = parsed;
      else if (argument === "--max-asset-bytes")
        maxAssetBytes = parsed;
      else
        maxTotalAssetBytes = parsed;
    }
  }
  const input = positional[0];
  if (input === undefined || positional.length !== 1) {
    return { ok: false, message: "kb pdf requires exactly one PDF path or public URL" };
  }
  if (input.length > 64 * 1024) {
    return { ok: false, message: "PDF input exceeds the 65536 code-unit limit" };
  }
  if (outputBase.trim() === "")
    return { ok: false, message: "--output must not be empty" };
  if (slug !== undefined && slug.trim() === "")
    return { ok: false, message: "--slug must not be empty" };
  return {
    ok: true,
    value: {
      command: "capture",
      input,
      outputBase,
      ...slug === undefined ? {} : { slug },
      ...interpretationsPath === undefined ? {} : { interpretationsPath },
      force,
      json,
      quiet,
      ...timeoutMs === undefined ? {} : { timeoutMs },
      ...maxPdfBytes === undefined ? {} : { maxPdfBytes },
      ...maxPages === undefined ? {} : { maxPages },
      ...maxImages === undefined ? {} : { maxImages },
      ...maxAssetBytes === undefined ? {} : { maxAssetBytes },
      ...maxTotalAssetBytes === undefined ? {} : { maxTotalAssetBytes }
    }
  };
}

// src/pdf/layout.ts
var MAX_XML_ATTRIBUTE_CODE_UNITS = 64 * 1024;
var MAX_XML_TEXT_CODE_UNITS = 2 * 1024 * 1024;
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function bounded(value, maximum) {
  if (value.length <= maximum)
    return value;
  let end = maximum - 1;
  const final = value.charCodeAt(end - 1);
  if (final >= 55296 && final <= 56319)
    end -= 1;
  return `${value.slice(0, Math.max(0, end))}\u2026`;
}
function decodeXmlEntity(entity) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  };
  const numeric = /^#(?:x([0-9a-f]+)|(\d+))$/iu.exec(entity);
  if (numeric !== null) {
    const value = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] === undefined ? 10 : 16);
    if (Number.isSafeInteger(value) && value > 0 && value <= 1114111 && !(value >= 55296 && value <= 57343))
      return String.fromCodePoint(value);
    return "\uFFFD";
  }
  return named[entity] ?? `&${entity};`;
}
function decodePopplerText(value) {
  const withoutMarkup = value.replace(/<[^>]{0,65536}>/gu, "");
  const decoded = withoutMarkup.replace(/&([a-z]+|#x[0-9a-f]+|#\d+);/giu, (_match, entity) => decodeXmlEntity(entity.toLowerCase()));
  return sanitizeTerminalText(decoded).replace(/[\uFB01\uFB02\uFB00\uFB03\uFB04]/gu, (ligature) => ({
    "\uFB01": "fi",
    "\uFB02": "fl",
    "\uFB00": "ff",
    "\uFB03": "ffi",
    "\uFB04": "ffl"
  })[ligature] ?? ligature).normalize("NFC");
}
function attributes(value) {
  const result = {};
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/gu;
  for (const match of value.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined || raw.length > MAX_XML_ATTRIBUTE_CODE_UNITS)
      continue;
    result[key] = decodePopplerText(raw);
  }
  return result;
}
function nonNegativeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e8) {
    throw new Error(`Poppler XML contains an invalid ${label}`);
  }
  return parsed;
}
function positiveInteger2(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1e6) {
    throw new Error(`Poppler XML contains an invalid ${label}`);
  }
  return parsed;
}
function parsePopplerXml(xml, limits) {
  const maxTextFragments = Math.max(1, Math.min(limits.maxTextFragments ?? 500000, 2000000));
  const root = /<pdf2xml\b([^>]*)>/u.exec(xml);
  const popplerVersion = root === null ? null : attributes(root[1] ?? "").version ?? null;
  const tokenPattern = /<page\b[^>]*>|<\/page>|<fontspec\b[^>]*\/>|<image\b[^>]*\/>|<text\b[^>]*>[\s\S]*?<\/text>/gu;
  const fonts = new Map;
  const pages = [];
  let current = null;
  let imageCount = 0;
  let textCount = 0;
  let truncated = false;
  for (const tokenMatch of xml.matchAll(tokenPattern)) {
    const token = tokenMatch[0];
    if (token.startsWith("<page")) {
      if (current !== null)
        throw new Error("Poppler XML opened a page before closing the previous page");
      if (pages.length >= limits.maxPages) {
        truncated = true;
        continue;
      }
      const parsed2 = attributes(token);
      current = {
        page: positiveInteger2(parsed2.number, "page number"),
        width: nonNegativeNumber(parsed2.width, "page width"),
        height: nonNegativeNumber(parsed2.height, "page height"),
        text: [],
        images: []
      };
      continue;
    }
    if (token === "</page>") {
      if (current === null)
        continue;
      pages.push(current);
      current = null;
      continue;
    }
    if (current === null)
      continue;
    if (token.startsWith("<fontspec")) {
      const parsed2 = attributes(token);
      const id = parsed2.id;
      if (id !== undefined && id.length <= 256) {
        fonts.set(id, { size: nonNegativeNumber(parsed2.size, "font size") });
      }
      continue;
    }
    if (token.startsWith("<image")) {
      if (imageCount >= limits.maxImages) {
        truncated = true;
        continue;
      }
      const parsed2 = attributes(token);
      const sourcePath = parsed2.src;
      if (sourcePath === undefined || sourcePath === "")
        continue;
      current.images.push({
        page: current.page,
        top: nonNegativeNumber(parsed2.top, "image top"),
        left: nonNegativeNumber(parsed2.left, "image left"),
        width: nonNegativeNumber(parsed2.width, "image width"),
        height: nonNegativeNumber(parsed2.height, "image height"),
        sourcePath
      });
      imageCount += 1;
      continue;
    }
    if (textCount >= maxTextFragments) {
      truncated = true;
      continue;
    }
    const openEnd = token.indexOf(">");
    const closeStart = token.lastIndexOf("</text>");
    if (openEnd < 0 || closeStart <= openEnd)
      continue;
    const parsed = attributes(token.slice(0, openEnd + 1));
    const fontId = parsed.font ?? "";
    const inner = token.slice(openEnd + 1, closeStart);
    if (inner.length > MAX_XML_TEXT_CODE_UNITS) {
      truncated = true;
      continue;
    }
    const text = bounded(decodePopplerText(inner), MAX_XML_TEXT_CODE_UNITS);
    current.text.push({
      top: nonNegativeNumber(parsed.top, "text top"),
      left: nonNegativeNumber(parsed.left, "text left"),
      width: nonNegativeNumber(parsed.width, "text width"),
      height: nonNegativeNumber(parsed.height, "text height"),
      text,
      fontId,
      fontSize: fonts.get(fontId)?.size ?? nonNegativeNumber(parsed.height, "text height"),
      bold: /<b(?:\s[^>]*)?>/iu.test(inner),
      italic: /<i(?:\s[^>]*)?>/iu.test(inner)
    });
    textCount += 1;
  }
  if (current !== null)
    throw new Error("Poppler XML ended before the current page was closed");
  if (pages.length === 0)
    throw new Error("Poppler XML contained no pages");
  return { pages, popplerVersion, truncated };
}
function normalizedInfoKey(value) {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}
function boundedMetadata(value, maximum) {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? null : bounded(sanitizeTerminalText(normalized), maximum);
}
function parsePdfInfo(value) {
  const fields = new Map;
  for (const line of value.split(/\r?\n/gu)) {
    const separator = line.indexOf(":");
    if (separator <= 0)
      continue;
    const key = normalizedInfoKey(line.slice(0, separator));
    if (!fields.has(key))
      fields.set(key, line.slice(separator + 1).trim());
  }
  const pageCount = Number(fields.get("pages"));
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1e6) {
    throw new Error("pdfinfo did not report a valid positive page count");
  }
  return {
    title: boundedMetadata(fields.get("title"), 2048),
    author: boundedMetadata(fields.get("author"), 1024),
    subject: boundedMetadata(fields.get("subject"), 8192),
    keywords: boundedMetadata(fields.get("keywords"), 8192),
    creator: boundedMetadata(fields.get("creator"), 1024),
    producer: boundedMetadata(fields.get("producer"), 1024),
    createdAt: boundedMetadata(fields.get("creationdate"), 256),
    modifiedAt: boundedMetadata(fields.get("moddate"), 256),
    pageCount,
    encrypted: /^yes\b/iu.test(fields.get("encrypted") ?? "")
  };
}
function joinFragments(fragments) {
  const sorted = [...fragments].sort((left, right) => left.left - right.left);
  let output = "";
  let previousRight = 0;
  for (const fragment of sorted) {
    const text = fragment.text;
    if (text === "")
      continue;
    const gap = fragment.left - previousRight;
    const needsSpace = output !== "" && !/\s$/u.test(output) && !/^\s|^[,.;:!?)}\]]/u.test(text) && gap > Math.max(1, fragment.fontSize * 0.08);
    output += `${needsSpace ? " " : ""}${text}`;
    previousRight = Math.max(previousRight, fragment.left + fragment.width);
  }
  return output.replace(/[ \t]+/gu, " ").trim();
}
function splitVisualLine(page, pageWidth, fragments) {
  const sorted = [...fragments].sort((left, right) => left.left - right.left);
  const groups = [];
  let current = [];
  let previousRight = 0;
  for (const fragment of sorted) {
    const gap = fragment.left - previousRight;
    if (current.length > 0 && gap > Math.max(pageWidth * 0.2, fragment.fontSize * 8)) {
      groups.push(current);
      current = [];
    }
    current.push(fragment);
    previousRight = Math.max(previousRight, fragment.left + fragment.width);
  }
  if (current.length > 0)
    groups.push(current);
  return groups.flatMap((group) => {
    const text = joinFragments(group);
    if (text === "")
      return [];
    const characters = group.reduce((sum, fragment) => sum + Math.max(1, fragment.text.trim().length), 0);
    const boldCharacters = group.reduce((sum, fragment) => sum + (fragment.bold ? Math.max(1, fragment.text.trim().length) : 0), 0);
    const fontSize = group.reduce((sum, fragment) => sum + fragment.fontSize * Math.max(1, fragment.text.trim().length), 0) / Math.max(1, characters);
    const top = Math.min(...group.map((fragment) => fragment.top));
    const left = Math.min(...group.map((fragment) => fragment.left));
    const right = Math.max(...group.map((fragment) => fragment.left + fragment.width));
    const bottom = Math.max(...group.map((fragment) => fragment.top + fragment.height));
    return [{
      page,
      top,
      left,
      width: right - left,
      height: bottom - top,
      text,
      fontSize,
      boldRatio: boldCharacters / Math.max(1, characters)
    }];
  });
}
function pageLines(page) {
  const fragments = [...page.text].sort((left, right) => left.top - right.top || left.left - right.left);
  const rows = [];
  for (const fragment of fragments) {
    const row = rows.at(-1);
    const rowTop = row === undefined ? null : Math.min(...row.map((entry) => entry.top));
    const tolerance = Math.max(2, fragment.height * 0.18);
    if (row === undefined || rowTop === null || Math.abs(fragment.top - rowTop) > tolerance) {
      rows.push([fragment]);
    } else
      row.push(fragment);
  }
  return rows.flatMap((row) => splitVisualLine(page.page, page.width, row)).sort((left, right) => left.top - right.top || left.left - right.left);
}
function weightedBodyFontSize(lines) {
  const weights = new Map;
  for (const line of lines) {
    const rounded = Math.round(line.fontSize * 2) / 2;
    weights.set(rounded, (weights.get(rounded) ?? 0) + line.text.length);
  }
  let selected = 12;
  let greatestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > greatestWeight || weight === greatestWeight && size < selected) {
      selected = size;
      greatestWeight = weight;
    }
  }
  return selected;
}
function median(values, fallback) {
  if (values.length === 0)
    return fallback;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? fallback;
}
function normalizedMarginText(value) {
  return value.toLowerCase().replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();
}
function repeatedMarginLines(pages, linesByPage) {
  const occurrences = new Map;
  for (const page of pages) {
    for (const line of linesByPage.get(page.page) ?? []) {
      const inMargin = line.top <= page.height * 0.06 || line.top + line.height >= page.height * 0.94;
      if (!inMargin || line.text.length > 160)
        continue;
      const normalized = normalizedMarginText(line.text);
      if (normalized === "")
        continue;
      const pageNumbers = occurrences.get(normalized) ?? new Set;
      pageNumbers.add(page.page);
      occurrences.set(normalized, pageNumbers);
    }
  }
  const minimum = Math.max(3, Math.ceil(pages.length * 0.4));
  return new Set([...occurrences.entries()].filter(([, pageNumbers]) => pageNumbers.size >= minimum).map(([text]) => text));
}
function headingLevel(fontSize, bodySize, headingSizes) {
  if (fontSize <= bodySize * 1.08)
    return 2;
  const index = headingSizes.findIndex((size) => Math.abs(size - fontSize) < 0.25);
  return Math.min(6, 2 + Math.max(0, index));
}
function bulletText(value) {
  const bullet = /^(?:[\u2022\u25CF\u25E6\u25AA\u25AB\u2023\u2043*-]|\d{1,4}[.)]|[a-zA-Z][.)])\s+(.+)$/u.exec(value);
  return bullet?.[1]?.trim() ?? null;
}
function layoutBlocks(pages) {
  const linesByPage = new Map(pages.map((page) => [page.page, pageLines(page)]));
  const allLines = [...linesByPage.values()].flat();
  const bodySize = weightedBodyFontSize(allLines);
  const headingSizes = [...new Set(allLines.filter((line) => line.fontSize > bodySize * 1.08).map((line) => Math.round(line.fontSize * 2) / 2))].sort((left, right) => right - left);
  const repeatedMargins = repeatedMarginLines(pages, linesByPage);
  const output = [];
  for (const page of pages) {
    const lines = (linesByPage.get(page.page) ?? []).filter((line) => !repeatedMargins.has(normalizedMarginText(line.text)));
    const steps = lines.slice(1).map((line, index) => Math.max(0, line.top - (lines[index]?.top ?? line.top)));
    const normalStep = median(steps.filter((step) => step > 0), Math.max(1, bodySize * 1.4));
    const events = [
      ...lines.map((line, index) => ({ kind: "line", top: line.top, left: line.left, line, index })),
      ...page.images.map((image) => ({ kind: "image", top: image.top, left: image.left, image }))
    ].sort((left, right) => left.top - right.top || left.left - right.left || (left.kind === "line" ? -1 : 1));
    let paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length === 0)
        return;
      output.push({
        kind: "paragraph",
        page: page.page,
        text: paragraph.join(" ").replace(/\s+/gu, " ").trim()
      });
      paragraph = [];
    };
    for (const event of events) {
      if (event.kind === "image") {
        flushParagraph();
        output.push({ kind: "image", page: page.page, image: event.image });
        continue;
      }
      const { line, index } = event;
      const previous = lines[index - 1];
      const gapBefore = previous === undefined ? Number.POSITIVE_INFINITY : line.top - previous.top;
      const fontHeading = line.fontSize > bodySize * 1.08;
      const boldHeading = line.boldRatio >= 0.78 && line.text.length <= 180 && gapBefore >= normalStep * 1.45;
      if (line.text.length <= 240 && (fontHeading || boldHeading)) {
        flushParagraph();
        output.push({
          kind: "heading",
          page: page.page,
          level: headingLevel(line.fontSize, bodySize, headingSizes),
          text: line.text
        });
        continue;
      }
      const item = bulletText(line.text);
      if (item !== null) {
        flushParagraph();
        output.push({ kind: "list-item", page: page.page, text: item });
        continue;
      }
      if (previous !== undefined && gapBefore >= normalStep * 1.55)
        flushParagraph();
      paragraph.push(line.text);
    }
    flushParagraph();
  }
  return output.filter((block) => block.kind === "image" || block.text.trim() !== "");
}
function parsePdfImageInterpretations(value) {
  if (!Array.isArray(value))
    throw new Error("PDF image annotations must be an array");
  if (value.length > 1e4)
    throw new Error("PDF image annotations exceed the 10000-item limit");
  const output = [];
  for (const entry of value) {
    if (!isRecord(entry))
      throw new Error("each PDF image annotation must be an object");
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(id))
      throw new Error("PDF image annotation has an invalid id");
    if (!/^[0-9a-f]{64}$/u.test(sha256))
      throw new Error("PDF image annotation has an invalid sha256");
    if (entry.kind !== "text" && entry.kind !== "mixed" && entry.kind !== "visual") {
      throw new Error("PDF image annotation kind must be text, mixed, or visual");
    }
    if (entry.method !== undefined && entry.method !== "agent" && entry.method !== "manual") {
      throw new Error("PDF image annotation method must be agent or manual");
    }
    const method = entry.method;
    let metadata;
    if (entry.metadata !== undefined) {
      if (!isRecord(entry.metadata))
        throw new Error("PDF image annotation metadata must be an object");
      const metadataRecord = entry.metadata;
      const optional = (name, maximum = 2048) => {
        const candidate = metadataRecord[name];
        if (candidate === undefined)
          return;
        if (typeof candidate !== "string" || candidate.trim() === "") {
          throw new Error(`PDF image annotation metadata ${name} must be a non-empty string`);
        }
        return bounded(sanitizeTerminalText(candidate.trim()), maximum);
      };
      const participantsValue = metadataRecord.participants;
      let participants;
      if (participantsValue !== undefined) {
        if (!Array.isArray(participantsValue) || participantsValue.length > 256) {
          throw new Error("PDF image annotation participants must be non-empty strings");
        }
        const parsedParticipants = [];
        for (const participant of participantsValue) {
          if (typeof participant !== "string" || participant.trim() === "") {
            throw new Error("PDF image annotation participants must be non-empty strings");
          }
          parsedParticipants.push(bounded(sanitizeTerminalText(participant.trim()), 2048));
        }
        participants = parsedParticipants;
      }
      const platform = optional("platform", 256);
      const contentType = optional("contentType", 256);
      const channel = optional("channel");
      const author = optional("author");
      const timestamp = optional("timestamp", 512);
      metadata = {
        ...platform === undefined ? {} : { platform },
        ...contentType === undefined ? {} : { contentType },
        ...channel === undefined ? {} : { channel },
        ...author === undefined ? {} : { author },
        ...timestamp === undefined ? {} : { timestamp },
        ...participants === undefined ? {} : { participants }
      };
    }
    if (entry.kind === "text" || entry.kind === "mixed") {
      if (typeof entry.markdown !== "string" || entry.markdown.trim() === "") {
        throw new Error("text PDF image annotations require non-empty markdown");
      }
      output.push({
        id,
        sha256,
        kind: entry.kind,
        markdown: bounded(sanitizeTerminalText(entry.markdown.trim()), 2 * 1024 * 1024),
        ...metadata === undefined ? {} : { metadata },
        ...method === undefined ? {} : { method }
      });
    } else {
      const alt = entry.alt === undefined ? undefined : typeof entry.alt === "string" && entry.alt.trim() !== "" ? bounded(sanitizeTerminalText(entry.alt.trim()), 2048) : (() => {
        throw new Error("visual PDF image annotation alt must be a non-empty string");
      })();
      output.push({
        id,
        sha256,
        kind: "visual",
        ...alt === undefined ? {} : { alt },
        ...metadata === undefined ? {} : { metadata },
        ...method === undefined ? {} : { method }
      });
    }
  }
  const keys = new Set;
  for (const entry of output) {
    if (keys.has(entry.id))
      throw new Error(`duplicate PDF image annotation id: ${entry.id}`);
    keys.add(entry.id);
  }
  return output;
}

// src/pdf/tools.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var commonExecutableDirectories = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin"
];
async function readBoundedStream(stream, maxBytes) {
  const bytes = new BoundedByteBuffer(maxBytes);
  const iterable = stream;
  for await (const value of iterable) {
    let chunk;
    if (typeof value === "string")
      chunk = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array)
      chunk = value;
    else
      throw new Error("PDF tool returned an unsupported output chunk");
    if (!bytes.append(chunk))
      throw new Error(`PDF tool output exceeded ${maxBytes} bytes`);
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}
var runPdfToolCommand = async (specification) => {
  const executable = specification.command[0];
  if (executable === undefined)
    throw new Error("PDF tool command is empty");
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(executable, specification.command.slice(1), {
    cwd: specification.cwd,
    detached: useProcessGroup,
    env: {
      ...process.env,
      LC_ALL: "C",
      LANG: "C",
      ...specification.environment
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  const signalProcessTree = (signal) => {
    if (useProcessGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    try {
      child.kill(signal);
    } catch {}
  };
  const state = { failure: null };
  let forceKillTimer = null;
  const requestStop = (error) => {
    state.failure ??= error;
    if (forceKillTimer !== null)
      return;
    signalProcessTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree("SIGKILL"), 1000);
  };
  const timer = setTimeout(() => {
    requestStop(new Error(`PDF tool timed out after ${specification.timeoutMs}ms`));
  }, specification.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, specification.maxOutputBytes).catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        requestStop(normalized);
        throw normalized;
      }),
      readBoundedStream(child.stderr, specification.maxOutputBytes).catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        requestStop(normalized);
        throw normalized;
      }),
      exited
    ]);
    if (state.failure !== null)
      throw state.failure;
    return { stdout, stderr, exitCode };
  } catch (error) {
    requestStop(error instanceof Error ? error : new Error(String(error)));
    await exited.catch(() => 1);
    throw error;
  } finally {
    clearTimeout(timer);
    if (forceKillTimer !== null)
      clearTimeout(forceKillTimer);
  }
};
function discoverExecutable(name, dependencies) {
  const exists = dependencies.exists ?? existsSync;
  const fromPath = (dependencies.which ?? ((value) => Bun.which(value)))(name);
  if (fromPath !== null && exists(fromPath))
    return fromPath;
  const homeCandidates = name === "tesseract" ? [join(homedir(), ".local", "bin", name)] : [];
  for (const path of [
    ...homeCandidates,
    ...commonExecutableDirectories.map((directory) => join(directory, name))
  ]) {
    if (exists(path))
      return path;
  }
  return null;
}
function resolvePdfTools(dependencies = {}) {
  const pdfinfo = dependencies.tools?.pdfinfo ?? discoverExecutable("pdfinfo", dependencies);
  const pdftohtml = dependencies.tools?.pdftohtml ?? discoverExecutable("pdftohtml", dependencies);
  const tesseract = dependencies.tools?.tesseract === undefined ? discoverExecutable("tesseract", dependencies) : dependencies.tools.tesseract;
  if (pdfinfo === null) {
    throw new Error("pdfinfo is required for PDF ingestion; install the Poppler command-line tools");
  }
  if (pdftohtml === null) {
    throw new Error("pdftohtml is required for PDF ingestion; install the Poppler command-line tools");
  }
  return { pdfinfo, pdftohtml, tesseract };
}

// src/pdf/extract.ts
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync as existsSync2,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  statSync
} from "fs";
import { basename, isAbsolute, join as join2, relative, resolve, sep } from "path";
var pdfCaptureDefaults = {
  timeoutMs: 120000,
  maxPdfBytes: 512 * 1024 * 1024,
  maxPages: 500,
  maxImages: 1000,
  maxAssetBytes: 100 * 1024 * 1024,
  maxTotalAssetBytes: 512 * 1024 * 1024,
  maxLayoutBytes: 128 * 1024 * 1024
};
function positiveBound(value, fallback, maximum, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return selected;
}
function pathInside(root, target) {
  const child = relative(root, target);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
function prepareWorkspace(path) {
  const absolute = resolve(path);
  if (existsSync2(absolute)) {
    const stats = lstatSync(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("PDF inspection workspace must be a real directory");
    }
    if (readdirSync(absolute).length !== 0) {
      throw new Error("PDF inspection workspace must be empty");
    }
  } else {
    mkdirSync(absolute, { recursive: false, mode: 448 });
  }
  chmodSync(absolute, 448);
  return realpathSync(absolute);
}
function sourceIdentity(path, maxPdfBytes) {
  const originalFilename = basename(path);
  const canonical = realpathSync(resolve(path));
  const stats = statSync(canonical);
  if (!stats.isFile())
    throw new Error("PDF input must be a regular file");
  if (stats.size < 5)
    throw new Error("PDF input is too small to contain a PDF header");
  if (stats.size > maxPdfBytes)
    throw new Error(`PDF input exceeds the ${maxPdfBytes}-byte limit`);
  const descriptor = openSync(canonical, "r");
  try {
    const signature = Buffer.alloc(5);
    const count = readSync(descriptor, signature, 0, signature.length, 0);
    if (count !== signature.length || signature.toString("ascii") !== "%PDF-") {
      throw new Error("PDF input does not have a valid PDF signature");
    }
  } finally {
    closeSync(descriptor);
  }
  return { inputPath: canonical, originalFilename, bytes: stats.size };
}
async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path))
    digest.update(chunk);
  return digest.digest("hex");
}
function safeGeneratedImage(image, workspace, index, limits) {
  const candidate = resolve(workspace, image.sourcePath);
  if (!pathInside(workspace, candidate)) {
    return { warning: `Skipped an image on page ${image.page} whose generated path escaped the workspace.` };
  }
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch {
    return { warning: `Skipped a missing generated image on page ${image.page}.` };
  }
  if (!pathInside(workspace, canonical)) {
    return { warning: `Skipped an image on page ${image.page} whose canonical path escaped the workspace.` };
  }
  const stats = lstatSync(canonical);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { warning: `Skipped a non-file generated image on page ${image.page}.` };
  }
  if (stats.size > limits.maxAssetBytes || stats.size > limits.remainingBytes) {
    return { warning: `Skipped an image on page ${image.page} because the configured asset byte limit was reached.` };
  }
  const bytes = readFileSync(canonical);
  const sniffed = sniffImage(bytes);
  if (sniffed === null) {
    return { warning: `Skipped an unsupported generated image on page ${image.page}.` };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id: `page-${image.page}-image-${index + 1}-${sha256.slice(0, 12)}`,
    page: image.page,
    sourcePath: canonical,
    top: image.top,
    left: image.left,
    width: image.width,
    height: image.height,
    bytes: stats.size,
    sha256,
    mimeType: sniffed.mimeType
  };
}
function generatedTreeSize(workspace, maximumFiles, maximumBytes) {
  const entries = readdirSync(workspace, { withFileTypes: true });
  if (entries.length > maximumFiles) {
    throw new Error(`PDF extraction created more than ${maximumFiles} files`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const path = join2(workspace, entry.name);
    const stats = lstatSync(path);
    if (!entry.isFile() || stats.isSymbolicLink()) {
      throw new Error("PDF extraction created an unexpected non-file output");
    }
    totalBytes += stats.size;
    if (totalBytes > maximumBytes) {
      throw new Error(`PDF extraction exceeded the ${maximumBytes}-byte workspace limit`);
    }
  }
}
async function inspectPdf(options, dependencies = {}) {
  const timeoutMs = positiveBound(options.timeoutMs, pdfCaptureDefaults.timeoutMs, 10 * 60000, "timeoutMs");
  const maxPdfBytes = positiveBound(options.maxPdfBytes, pdfCaptureDefaults.maxPdfBytes, 8 * 1024 ** 3, "maxPdfBytes");
  const maxPages = positiveBound(options.maxPages, pdfCaptureDefaults.maxPages, 1e4, "maxPages");
  const maxImages = positiveBound(options.maxImages, pdfCaptureDefaults.maxImages, 1e4, "maxImages");
  const maxAssetBytes = positiveBound(options.maxAssetBytes, pdfCaptureDefaults.maxAssetBytes, 2 * 1024 ** 3, "maxAssetBytes");
  const maxTotalAssetBytes = positiveBound(options.maxTotalAssetBytes, pdfCaptureDefaults.maxTotalAssetBytes, 8 * 1024 ** 3, "maxTotalAssetBytes");
  const source = sourceIdentity(options.inputPath, maxPdfBytes);
  const sourceSha256 = await sha256File(source.inputPath);
  const workspaceDirectory = prepareWorkspace(options.workspaceDirectory);
  const tools = resolvePdfTools(dependencies);
  const runTool = dependencies.runTool ?? runPdfToolCommand;
  const info = await runTool({
    command: [tools.pdfinfo, source.inputPath],
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    cwd: workspaceDirectory
  });
  if (info.exitCode !== 0) {
    throw new Error("pdfinfo could not inspect the input PDF");
  }
  const metadata = parsePdfInfo(info.stdout);
  const processedPageLimit = Math.min(metadata.pageCount, maxPages);
  const layoutPath = join2(workspaceDirectory, "layout.xml");
  const extracted = await runTool({
    command: [
      tools.pdftohtml,
      "-q",
      "-f",
      "1",
      "-l",
      String(processedPageLimit),
      "-xml",
      "-hidden",
      "-fmt",
      "png",
      source.inputPath,
      layoutPath
    ],
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    cwd: workspaceDirectory
  });
  if (extracted.exitCode !== 0) {
    throw new Error("pdftohtml could not extract the input PDF");
  }
  generatedTreeSize(workspaceDirectory, 10002, Math.min(Number.MAX_SAFE_INTEGER, 8 * 1024 ** 3 + pdfCaptureDefaults.maxLayoutBytes));
  const layoutStats = statSync(layoutPath);
  if (!layoutStats.isFile() || layoutStats.size > pdfCaptureDefaults.maxLayoutBytes) {
    throw new Error(`Poppler layout XML exceeds the ${pdfCaptureDefaults.maxLayoutBytes}-byte limit`);
  }
  const parsed = parsePopplerXml(readFileSync(layoutPath, "utf8"), {
    maxPages: processedPageLimit,
    maxImages
  });
  const warnings = [];
  if (metadata.pageCount > processedPageLimit) {
    warnings.push(`PDF extraction stopped at ${processedPageLimit} of ${metadata.pageCount} pages.`);
  }
  if (parsed.truncated) {
    warnings.push("PDF layout extraction reached a configured page, image, or text-fragment limit.");
  }
  if (parsed.pages.length < processedPageLimit) {
    warnings.push(`Poppler returned ${parsed.pages.length} of ${processedPageLimit} requested pages.`);
  }
  let remainingBytes = maxTotalAssetBytes;
  const pages = parsed.pages.map((page) => {
    const images = [];
    const sorted = [...page.images].sort((left, right) => left.top - right.top || left.left - right.left || left.sourcePath.localeCompare(right.sourcePath));
    for (const [index, rawImage] of sorted.entries()) {
      const image = safeGeneratedImage(rawImage, workspaceDirectory, index, {
        maxAssetBytes,
        remainingBytes
      });
      if ("warning" in image) {
        warnings.push(image.warning);
        continue;
      }
      images.push(image);
      remainingBytes -= image.bytes;
    }
    return {
      page: page.page,
      width: page.width,
      height: page.height,
      text: page.text,
      images
    };
  });
  return {
    inputPath: source.inputPath,
    originalFilename: source.originalFilename,
    sourceBytes: source.bytes,
    sourceSha256,
    metadata,
    processedPages: pages.length,
    pages,
    popplerVersion: parsed.popplerVersion,
    warnings: [...new Set(warnings)],
    workspaceDirectory
  };
}

// src/pdf/model.ts
var PDF_CAPTURE_MANIFEST_SCHEMA_VERSION = 1;
var PDF_CAPTURE_MANIFEST_FILENAME = "capture.json";
var PDF_CAPTURE_SOURCE_FILENAME = "source.pdf";
var PDF_CAPTURE_ANNOTATIONS_FILENAME = "annotations.json";

// src/pdf/persist.ts
import { createHash as createHash2, randomUUID } from "crypto";
import {
  chmodSync as chmodSync2,
  copyFileSync,
  existsSync as existsSync3,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  realpathSync as realpathSync2,
  renameSync,
  rmSync,
  statSync as statSync2,
  writeFileSync
} from "fs";
import { homedir as homedir2 } from "os";
import { dirname, isAbsolute as isAbsolute2, join as join3, relative as relative2, resolve as resolve2, sep as sep2 } from "path";
function isConfinedChild(root, path) {
  const child = relative2(root, path);
  return child !== "" && !isAbsolute2(child) && child !== ".." && !child.startsWith(`..${sep2}`);
}
function assertConfinedChild(root, path, label) {
  if (!isConfinedChild(root, path))
    throw new Error(`${label} escapes the PDF capture root`);
}
function safeSlug(slug) {
  if (slug.length === 0 || slug.length > 240 || [...slug].length > 80 || slug !== slug.normalize("NFKC") || !/^[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}._-]*[\p{Letter}\p{Number}])?$/u.test(slug))
    throw new Error("unsafe PDF capture slug");
  return slug;
}
function outputRoot(path) {
  const absolute = resolve2(path);
  mkdirSync2(absolute, { recursive: true, mode: 493 });
  const stats = lstatSync2(absolute);
  if (!stats.isDirectory() && !stats.isSymbolicLink()) {
    throw new Error("PDF capture output root is not a directory");
  }
  const canonical = realpathSync2(absolute);
  if (!lstatSync2(canonical).isDirectory())
    throw new Error("PDF capture output root is not a directory");
  if (dirname(canonical) === canonical || canonical === realpathSync2(homedir2())) {
    throw new Error("refusing dangerous PDF capture output root");
  }
  return canonical;
}
function extensionForMimeType(mimeType) {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      throw new Error(`unsupported PDF image MIME type: ${mimeType}`);
  }
}
function pdfImageAssetPath(image) {
  if (!/^[0-9a-f]{64}$/u.test(image.sha256))
    throw new Error("invalid PDF image sha256");
  return `assets/${image.sha256}.${extensionForMimeType(image.mimeType)}`;
}
function hashFile(path) {
  return createHash2("sha256").update(readFileSync2(path)).digest("hex");
}
function assertSourceIdentity(path, expectedBytes, expectedSha256, label) {
  const stats = statSync2(path);
  if (!stats.isFile() || stats.size !== expectedBytes || hashFile(path) !== expectedSha256) {
    throw new Error(`${label} changed after PDF inspection`);
  }
}
function ownedPdfTarget(targetDirectory, slug) {
  const directory = lstatSync2(targetDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("PDF --force only replaces a regular PDF capture directory");
  }
  const manifestPath = join3(targetDirectory, PDF_CAPTURE_MANIFEST_FILENAME);
  const markdownPath = join3(targetDirectory, `${safeSlug(slug)}.md`);
  const sourcePath = join3(targetDirectory, PDF_CAPTURE_SOURCE_FILENAME);
  for (const path of [manifestPath, markdownPath, sourcePath]) {
    const stats = lstatSync2(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("PDF --force refused a target without its owned files");
    }
  }
  if (lstatSync2(manifestPath).size > 16 * 1024 * 1024) {
    throw new Error("PDF --force refused an oversized capture manifest");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(manifestPath, "utf8"));
  } catch {
    throw new Error("PDF --force refused an invalid capture manifest");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("schemaVersion" in parsed) || parsed.schemaVersion !== PDF_CAPTURE_MANIFEST_SCHEMA_VERSION || !("kind" in parsed) || parsed.kind !== "pdf")
    throw new Error("PDF --force refused an incompatible capture manifest");
  return { device: directory.dev, inode: directory.ino };
}
function assertStagingTreeSafe(root, directory = root) {
  for (const entry of readdirSync2(directory, { withFileTypes: true })) {
    const path = join3(directory, entry.name);
    assertConfinedChild(root, path, "staged PDF artifact");
    const stats = lstatSync2(path);
    if (stats.isSymbolicLink())
      throw new Error("staged PDF artifacts must not be symbolic links");
    if (stats.isDirectory())
      assertStagingTreeSafe(root, path);
    else if (!stats.isFile())
      throw new Error("staged PDF artifacts must be regular files");
  }
}
function unusedBackupPath(root) {
  for (;; ) {
    const candidate = join3(root, `.pdf-capture-backup-${randomUUID()}`);
    assertConfinedChild(root, candidate, "PDF capture backup");
    if (!existsSync3(candidate))
      return candidate;
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function persistPdfCapture(input) {
  const slug = safeSlug(input.slug);
  const root = outputRoot(input.outputBase);
  const targetDirectory = join3(root, slug);
  assertConfinedChild(root, targetDirectory, "PDF capture target");
  const targetExists = existsSync3(targetDirectory);
  if (targetExists && !input.force) {
    throw new Error(`PDF capture already exists: ${targetDirectory}; pass --force to replace it`);
  }
  const expectedIdentity = targetExists ? ownedPdfTarget(targetDirectory, slug) : null;
  const stagingDirectory = mkdtempSync(join3(root, ".pdf-capture-staging-"));
  chmodSync2(stagingDirectory, 448);
  assertConfinedChild(root, stagingDirectory, "PDF capture staging directory");
  try {
    assertSourceIdentity(input.sourcePath, input.manifest.source.bytes, input.manifest.source.sha256, "PDF source");
    const sourceDestination = join3(stagingDirectory, PDF_CAPTURE_SOURCE_FILENAME);
    copyFileSync(input.sourcePath, sourceDestination);
    chmodSync2(sourceDestination, 420);
    const assetsDirectory = join3(stagingDirectory, "assets");
    mkdirSync2(assetsDirectory, { recursive: true, mode: 493 });
    const imagesByPath = new Map;
    for (const image of input.images) {
      const assetPath = pdfImageAssetPath(image);
      const existing = imagesByPath.get(assetPath);
      if (existing !== undefined) {
        if (existing.bytes !== image.bytes || existing.sha256 !== image.sha256) {
          throw new Error("conflicting PDF image assets have the same destination");
        }
        continue;
      }
      imagesByPath.set(assetPath, image);
    }
    for (const [assetPath, image] of [...imagesByPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      assertSourceIdentity(image.sourcePath, image.bytes, image.sha256, "PDF image");
      const destination = join3(stagingDirectory, assetPath);
      assertConfinedChild(stagingDirectory, destination, "PDF image destination");
      copyFileSync(image.sourcePath, destination);
      chmodSync2(destination, 420);
    }
    writeFileSync(join3(stagingDirectory, `${slug}.md`), `${redactSensitiveText(input.markdown).trimEnd()}
`, { encoding: "utf8", flag: "wx", mode: 420 });
    if (input.manifest.annotations === null) {
      if (input.annotationsJson !== undefined) {
        throw new Error("PDF annotations were supplied without manifest provenance");
      }
    } else {
      const annotationsJson = input.annotationsJson;
      if (annotationsJson === undefined) {
        throw new Error("PDF annotation provenance is missing its retained input");
      }
      if (Buffer.byteLength(annotationsJson) !== input.manifest.annotations.bytes || createHash2("sha256").update(annotationsJson).digest("hex") !== input.manifest.annotations.sha256) {
        throw new Error("PDF annotation input does not match its manifest provenance");
      }
      let annotations;
      try {
        annotations = JSON.parse(annotationsJson);
      } catch {
        throw new Error("PDF annotation input is not valid JSON");
      }
      if (!Array.isArray(annotations) || annotations.length !== input.manifest.annotations.count) {
        throw new Error("PDF annotation input count does not match its manifest provenance");
      }
      writeFileSync(join3(stagingDirectory, PDF_CAPTURE_ANNOTATIONS_FILENAME), annotationsJson, { encoding: "utf8", flag: "wx", mode: 420 });
    }
    writeFileSync(join3(stagingDirectory, PDF_CAPTURE_MANIFEST_FILENAME), `${JSON.stringify(input.manifest, null, 2)}
`, { encoding: "utf8", flag: "wx", mode: 420 });
    assertStagingTreeSafe(stagingDirectory);
    if (existsSync3(targetDirectory) !== (expectedIdentity !== null)) {
      throw new Error("PDF capture target changed during the transaction");
    }
    if (expectedIdentity !== null) {
      const current = ownedPdfTarget(targetDirectory, slug);
      if (current.device !== expectedIdentity.device || current.inode !== expectedIdentity.inode) {
        throw new Error("PDF capture target changed during the transaction");
      }
    }
    const backupDirectory = expectedIdentity === null ? null : unusedBackupPath(root);
    let installed = false;
    let backedUp = false;
    try {
      if (backupDirectory !== null) {
        renameSync(targetDirectory, backupDirectory);
        backedUp = true;
        input.afterBackup?.();
      }
      renameSync(stagingDirectory, targetDirectory);
      installed = true;
      input.afterInstall?.();
      if (backupDirectory !== null)
        rmSync(backupDirectory, { recursive: true, force: true });
      return targetDirectory;
    } catch (error) {
      let rollbackError;
      try {
        if (installed && existsSync3(targetDirectory)) {
          rmSync(targetDirectory, { recursive: true, force: true });
        }
        if (backedUp && backupDirectory !== null && existsSync3(backupDirectory)) {
          if (existsSync3(targetDirectory))
            throw new Error("target was recreated before rollback");
          renameSync(backupDirectory, targetDirectory);
        }
      } catch (caught) {
        rollbackError = caught;
      }
      if (rollbackError !== undefined) {
        throw new Error(`PDF capture commit failed (${errorMessage(error)}) and rollback failed (${errorMessage(rollbackError)})`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    if (existsSync3(stagingDirectory))
      rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
function pdfMarkdownFilename(slug) {
  return `${safeSlug(slug)}.md`;
}

// src/pdf/markdown.ts
function escapeInline(value) {
  return sanitizeTerminalText(value).replace(/\\/gu, "\\\\").replace(/([`*_[\]{}<>#])/gu, "\\$1").replace(/\s+/gu, " ").trim();
}
function metadataLine(metadata) {
  if (metadata === null)
    return null;
  const values = [
    metadata.platform === undefined ? null : `platform: ${metadata.platform}`,
    metadata.contentType === undefined ? null : `type: ${metadata.contentType}`,
    metadata.channel === undefined ? null : `channel: ${metadata.channel}`,
    metadata.author === undefined ? null : `author: ${metadata.author}`,
    metadata.timestamp === undefined ? null : `timestamp: ${metadata.timestamp}`,
    metadata.participants === undefined ? null : `participants: ${metadata.participants.join(", ")}`
  ].filter((value) => value !== null);
  return values.length === 0 ? null : `*Image metadata \u2014 ${escapeInline(values.join("; "))}*`;
}
function imageMarkdown(image) {
  const assetPath = pdfImageAssetPath(image.image);
  const semantic = image.metadata?.contentType ?? image.metadata?.platform;
  const fallbackAlt = semantic === undefined ? `PDF image from page ${image.image.page}` : `${semantic} from page ${image.image.page}`;
  const alt = escapeInline(image.alt ?? fallbackAlt);
  const lines = [`![${alt}](${assetPath})`];
  const metadata = metadataLine(image.metadata);
  if (metadata !== null)
    lines.push("", metadata);
  if (image.kind === "text" || image.kind === "mixed") {
    const heading = image.metadata?.platform === undefined ? "Text visible in image" : `Text visible in ${escapeInline(image.metadata.platform)} image`;
    lines.push("", `#### ${heading}`, "", image.markdown.trim());
  }
  return lines.join(`
`);
}
function markdownContent(blocks, images) {
  const lines = [];
  let currentPage = null;
  let headingCount = 0;
  let textBlockCount = 0;
  for (const block of blocks) {
    if (currentPage !== block.page) {
      if (lines.length > 0)
        lines.push("");
      lines.push(`<!-- pdf-page: ${block.page} -->`, "");
      currentPage = block.page;
    }
    if (block.kind === "image") {
      const resolved = images.get(block.image.id);
      if (resolved === undefined)
        continue;
      lines.push(imageMarkdown(resolved), "");
      continue;
    }
    if (block.kind === "heading") {
      headingCount += 1;
      lines.push(`${"#".repeat(Math.max(2, Math.min(6, block.level)))} ${escapeInline(block.text)}`, "");
      continue;
    }
    textBlockCount += 1;
    if (block.kind === "list-item")
      lines.push(`- ${escapeInline(block.text)}`, "");
    else
      lines.push(escapeInline(block.text), "");
  }
  return {
    content: lines.join(`
`).trim(),
    headingCount,
    textBlockCount
  };
}
function buildPdfMarkdown(options) {
  const filenameTitle = options.originalFilename.replace(/\.pdf$/iu, "").trim();
  const title = options.metadata.title ?? (filenameTitle === "" ? options.slug : filenameTitle);
  const body = markdownContent(options.blocks, options.images);
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `source: ${yamlString("source.pdf")}`,
    `source_type: ${yamlString("pdf")}`,
    `source_original_filename: ${yamlString(options.originalFilename)}`,
    `source_sha256: ${yamlString(options.sourceSha256)}`,
    ...options.sourceUrl === undefined ? [] : [`source_url: ${yamlString(options.sourceUrl)}`],
    `pages: ${options.metadata.pageCount}`,
    `clipped: ${yamlString(options.capturedDate)}`,
    `capture_status: ${yamlString(options.status)}`,
    `capture_method: ${yamlString("poppler")}`,
    ...options.metadata.author === null ? [] : [`author: ${yamlString(options.metadata.author)}`],
    ...options.metadata.subject === null ? [] : [`description: ${yamlString(options.metadata.subject)}`],
    ...options.metadata.createdAt === null ? [] : [`created: ${yamlString(options.metadata.createdAt)}`],
    ...options.embeddedPlatforms.length === 0 ? [] : [`embedded_platforms: [${options.embeddedPlatforms.map(yamlString).join(", ")}]`],
    "---",
    "",
    `# ${escapeInline(title)}`,
    "",
    "[Open the source PDF](source.pdf)",
    "",
    body.content,
    ""
  ].join(`
`);
  return {
    markdown: `${redactSensitiveText(frontmatter).trimEnd()}
`,
    headingCount: body.headingCount,
    textBlockCount: body.textBlockCount
  };
}

// src/pdf/ocr.ts
function parseInteger(value) {
  if (value === undefined || !/^-?\d+$/u.test(value))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function parseConfidence(value) {
  if (value === undefined)
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}
function escapeMarkdownText(value) {
  return value.replace(/\\/gu, "\\\\").replace(/([`*_[\]{}<>#])/gu, "\\$1");
}
function parseTesseractTsv(value) {
  const lines = value.split(/\r?\n/gu);
  const header = lines[0]?.split("\t") ?? [];
  const positions = new Map(header.map((name, index) => [name, index]));
  const required = ["page_num", "block_num", "par_num", "line_num", "word_num", "conf", "text"];
  if (!required.every((name) => positions.has(name))) {
    throw new Error("Tesseract TSV is missing required columns");
  }
  const words = [];
  for (const row of lines.slice(1)) {
    if (row === "")
      continue;
    const fields = row.split("\t");
    const at = (name) => {
      const index = positions.get(name);
      return index === undefined ? undefined : fields[index];
    };
    const text2 = sanitizeTerminalText(at("text") ?? "").trim();
    const confidence2 = parseConfidence(at("conf"));
    const word = parseInteger(at("word_num"));
    const page = parseInteger(at("page_num"));
    const block = parseInteger(at("block_num"));
    const paragraph = parseInteger(at("par_num"));
    const line = parseInteger(at("line_num"));
    if (text2 === "" || confidence2 === null || word === null || page === null || block === null || paragraph === null || line === null)
      continue;
    words.push({
      page,
      block,
      paragraph,
      line,
      word,
      text: text2,
      confidence: confidence2
    });
    if (words.length >= 1e5)
      break;
  }
  words.sort((left, right) => left.page - right.page || left.block - right.block || left.paragraph - right.paragraph || left.line - right.line || left.word - right.word);
  const grouped = new Map;
  for (const word of words) {
    const lineIdentity = `${word.page}:${word.block}:${word.paragraph}:${word.line}`;
    const current = grouped.get(lineIdentity) ?? [];
    current.push(word.text);
    grouped.set(lineIdentity, current);
  }
  const textLines = [...grouped.values()].map((entries) => entries.join(" ").replace(/\s+/gu, " ").trim()).filter(Boolean);
  const text = redactSensitiveText(textLines.join(`
`));
  const weightedCharacters = words.reduce((sum, word) => sum + word.text.length, 0);
  const confidence = weightedCharacters === 0 ? null : words.reduce((sum, word) => sum + word.confidence * word.text.length, 0) / weightedCharacters;
  const alphanumericCount = [...text].filter((character) => /[\p{Letter}\p{Number}]/u.test(character)).length;
  const substantive = words.length >= 3 && alphanumericCount >= 12 && confidence !== null && confidence >= 35;
  const markdown = substantive ? text.split(`
`).map((line) => `> ${escapeMarkdownText(line)}`).join(`
`) : "";
  return {
    text,
    markdown,
    confidence,
    wordCount: words.length,
    substantive
  };
}
async function ocrPdfImage(image, options) {
  if (options.tesseractPath === null) {
    return {
      kind: "visual",
      text: "",
      markdown: "",
      confidence: null,
      wordCount: 0,
      warnings: ["Tesseract is unavailable; retained the image without OCR text."]
    };
  }
  try {
    const result = await options.runTool({
      command: [
        options.tesseractPath,
        image.sourcePath,
        "stdout",
        "--psm",
        "6",
        "tsv"
      ],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024
    });
    if (result.exitCode !== 0) {
      return {
        kind: "visual",
        text: "",
        markdown: "",
        confidence: null,
        wordCount: 0,
        warnings: ["Tesseract could not read this image; retained it as visual evidence."]
      };
    }
    const parsed = parseTesseractTsv(result.stdout);
    return {
      kind: parsed.substantive ? "mixed" : "visual",
      text: parsed.text,
      markdown: parsed.markdown,
      confidence: parsed.confidence,
      wordCount: parsed.wordCount,
      warnings: parsed.substantive ? [] : ["Tesseract did not find sufficiently confident text; retained the image as visual evidence."]
    };
  } catch {
    return {
      kind: "visual",
      text: "",
      markdown: "",
      confidence: null,
      wordCount: 0,
      warnings: ["Tesseract OCR failed; retained the image as visual evidence."]
    };
  }
}

// src/pdf/capture.ts
import { createHash as createHash3 } from "crypto";
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2 } from "fs";
import { tmpdir } from "os";
import { join as join4 } from "path";
function parsedInterpretations(raw, images) {
  const parsed = raw === undefined ? [] : parsePdfImageInterpretations(raw);
  const candidates = new Map(images.map((image) => [image.id, image]));
  const output = new Map;
  for (const interpretation of parsed) {
    const image = candidates.get(interpretation.id);
    if (image === undefined) {
      throw new Error(`PDF image annotation does not match an extracted image: ${interpretation.id}`);
    }
    if (image.sha256 !== interpretation.sha256) {
      throw new Error(`PDF image annotation hash does not match the extracted image: ${interpretation.id}`);
    }
    output.set(interpretation.id, interpretation);
  }
  return { byId: output, values: parsed };
}
function sortedImages(images) {
  return [...images].sort((left, right) => left.page - right.page || left.top - right.top || left.left - right.left || left.id.localeCompare(right.id));
}
function normalizedMetadata(value) {
  return value ?? null;
}
function resolvedAnnotation(image, annotation) {
  const markdown = annotation.kind === "visual" ? "" : annotation.markdown;
  return {
    image,
    kind: annotation.kind,
    method: annotation.method ?? "manual",
    markdown,
    alt: annotation.kind === "visual" ? annotation.alt ?? null : null,
    confidence: null,
    wordCount: annotation.kind === "visual" ? 0 : countWords(markdown),
    metadata: normalizedMetadata(annotation.metadata)
  };
}
function embeddedPlatforms(images) {
  const byIdentity = new Map;
  for (const image of images) {
    const platform = image.metadata?.platform?.trim();
    if (platform === undefined || platform === "")
      continue;
    const key = platform.toLocaleLowerCase("en-US");
    if (!byIdentity.has(key))
      byIdentity.set(key, platform);
  }
  return [...byIdentity.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}
function manifestImage(image) {
  return {
    id: image.image.id,
    page: image.image.page,
    top: image.image.top,
    left: image.image.left,
    width: image.image.width,
    height: image.image.height,
    asset: {
      path: pdfImageAssetPath(image.image),
      mimeType: image.image.mimeType,
      bytes: image.image.bytes,
      sha256: image.image.sha256
    },
    kind: image.kind,
    method: image.method,
    confidence: image.confidence,
    wordCount: image.wordCount,
    metadata: image.metadata
  };
}
async function runPdfCapture(options, dependencies = {}) {
  const callerOwnedWorkspace = options.workspaceDirectory !== undefined;
  const workspaceDirectory = options.workspaceDirectory ?? mkdtempSync2(join4(tmpdir(), "hraness-kb-pdf-"));
  try {
    const inspection = await inspectPdf({
      inputPath: options.inputPath,
      workspaceDirectory,
      ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      ...options.maxPdfBytes === undefined ? {} : { maxPdfBytes: options.maxPdfBytes },
      ...options.maxPages === undefined ? {} : { maxPages: options.maxPages },
      ...options.maxImages === undefined ? {} : { maxImages: options.maxImages },
      ...options.maxAssetBytes === undefined ? {} : { maxAssetBytes: options.maxAssetBytes },
      ...options.maxTotalAssetBytes === undefined ? {} : { maxTotalAssetBytes: options.maxTotalAssetBytes }
    }, dependencies);
    const tools = resolvePdfTools(dependencies);
    const runTool = dependencies.runTool ?? runPdfToolCommand;
    const images = sortedImages(inspection.pages.flatMap((page) => page.images));
    const annotations = parsedInterpretations(options.interpretations, images);
    const resolvedImages = [];
    const warnings = [...inspection.warnings];
    let unclassifiedImages = 0;
    let ocrWarningCount = 0;
    for (const image of images) {
      const annotation = annotations.byId.get(image.id);
      if (annotation !== undefined) {
        resolvedImages.push(resolvedAnnotation(image, annotation));
        continue;
      }
      const ocr2 = await ocrPdfImage(image, {
        tesseractPath: tools.tesseract,
        timeoutMs: options.timeoutMs ?? 120000,
        runTool
      });
      if (tools.tesseract === null)
        unclassifiedImages += 1;
      for (const warning of ocr2.warnings) {
        warnings.push(`Page ${image.page} image ${image.id}: ${warning}`);
        ocrWarningCount += 1;
      }
      resolvedImages.push({
        image,
        kind: ocr2.kind,
        method: tools.tesseract === null ? "unclassified" : "tesseract",
        markdown: ocr2.markdown,
        alt: null,
        confidence: ocr2.confidence,
        wordCount: ocr2.wordCount,
        metadata: null
      });
    }
    const platforms = embeddedPlatforms(resolvedImages);
    const status = warnings.length > 0 || unclassifiedImages > 0 || ocrWarningCount > 0 ? "partial" : "complete";
    const filenameTitle = inspection.originalFilename.replace(/\.pdf$/iu, "").trim();
    const requestedSlug = options.slug ?? inspection.metadata.title ?? filenameTitle;
    const slug = slugify(sanitizeTerminalText(requestedSlug));
    if (slug === "")
      throw new Error("could not derive a safe PDF capture slug; pass an explicit slug");
    const blocks = layoutBlocks(inspection.pages);
    const byId = new Map(resolvedImages.map((image) => [image.image.id, image]));
    const capturedAt = (dependencies.now ?? (() => new Date))().toISOString();
    const built = buildPdfMarkdown({
      slug,
      originalFilename: inspection.originalFilename,
      sourceSha256: inspection.sourceSha256,
      ...options.remoteSource === undefined ? {} : { sourceUrl: options.remoteSource.finalUrl },
      capturedDate: capturedAt.slice(0, 10),
      status,
      metadata: inspection.metadata,
      blocks,
      images: byId,
      embeddedPlatforms: platforms
    });
    const textImageCount = resolvedImages.filter((image) => image.kind === "text").length;
    const mixedImageCount = resolvedImages.filter((image) => image.kind === "mixed").length;
    const visualImageCount = resolvedImages.filter((image) => image.kind === "visual").length;
    const annotationCount = resolvedImages.filter((image) => image.method === "agent" || image.method === "manual").length;
    const tesseractCount = resolvedImages.filter((image) => image.method === "tesseract").length;
    const ocr = annotationCount > 0 && tesseractCount > 0 ? "mixed" : annotationCount > 0 ? "annotations" : tesseractCount > 0 ? "tesseract" : "unavailable";
    const finalWarnings = [...new Set(warnings)];
    const annotationsJson = annotations.values.length === 0 ? null : `${JSON.stringify(annotations.values, null, 2)}
`;
    const annotationsManifest = annotationsJson === null ? null : {
      path: PDF_CAPTURE_ANNOTATIONS_FILENAME,
      count: annotations.values.length,
      bytes: Buffer.byteLength(annotationsJson),
      sha256: createHash3("sha256").update(annotationsJson).digest("hex")
    };
    const manifest = {
      schemaVersion: PDF_CAPTURE_MANIFEST_SCHEMA_VERSION,
      kind: "pdf",
      capturedAt,
      status,
      source: {
        originalFilename: sanitizeTerminalText(inspection.originalFilename).slice(0, 4096),
        path: PDF_CAPTURE_SOURCE_FILENAME,
        mimeType: "application/pdf",
        bytes: inspection.sourceBytes,
        sha256: inspection.sourceSha256,
        ...options.remoteSource === undefined ? {} : {
          requestedUrl: options.remoteSource.requestedUrl,
          finalUrl: options.remoteSource.finalUrl
        }
      },
      document: {
        ...inspection.metadata,
        processedPages: inspection.processedPages
      },
      extraction: {
        layout: "pdftohtml-xml",
        popplerVersion: inspection.popplerVersion,
        ocr,
        headingCount: built.headingCount,
        textBlockCount: built.textBlockCount,
        imageCount: resolvedImages.length,
        textImageCount,
        mixedImageCount,
        visualImageCount
      },
      images: resolvedImages.map(manifestImage),
      annotations: annotationsManifest,
      embeddedPlatforms: platforms,
      warnings: finalWarnings
    };
    const outputDirectory = persistPdfCapture({
      outputBase: options.outputBase,
      slug,
      force: options.force ?? false,
      sourcePath: inspection.inputPath,
      markdown: built.markdown,
      manifest,
      images,
      ...annotationsJson === null ? {} : { annotationsJson }
    });
    return {
      status,
      slug,
      outputDirectory,
      markdownPath: join4(outputDirectory, pdfMarkdownFilename(slug)),
      sourcePath: join4(outputDirectory, PDF_CAPTURE_SOURCE_FILENAME),
      wordCount: countWords(built.markdown),
      pageCount: inspection.metadata.pageCount,
      processedPages: inspection.processedPages,
      imageCount: images.length,
      warnings: finalWarnings,
      markdown: built.markdown,
      manifest
    };
  } finally {
    if (!callerOwnedWorkspace)
      rmSync2(workspaceDirectory, { recursive: true, force: true });
  }
}

// src/pdf/cli.ts
import { lstatSync as lstatSync3, readFileSync as readFileSync3 } from "fs";
import { resolve as resolve3 } from "path";

// src/pdf/source.ts
import {
  chmodSync as chmodSync3,
  mkdtempSync as mkdtempSync3,
  rmSync as rmSync3,
  writeFileSync as writeFileSync2
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import { basename as basename2, join as join5 } from "path";
var remoteUserAgent = "hraness-kb/0.7 PDF capture";
function parseRemoteUrl(input) {
  if (!/^https?:\/\//iu.test(input))
    return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("PDF URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PDF URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PDF URL must not contain embedded credentials");
  }
  return url;
}
function remoteFilename(url) {
  let decoded;
  try {
    decoded = decodeURIComponent(basename2(url.pathname));
  } catch {
    decoded = "source.pdf";
  }
  const normalized = decoded.normalize("NFKC").replace(/[^\p{Letter}\p{Number}._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "").slice(0, 180);
  const stem = normalized === "" ? "source" : normalized.replace(/\.pdf$/iu, "");
  return `${stem}.pdf`;
}
function assertPdfSignature(bytes) {
  if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("remote PDF input does not have a valid PDF signature");
  }
}
async function preparePdfSource(input, options = {}, dependencies = {}) {
  const requestedUrl = parseRemoteUrl(input);
  if (requestedUrl === null) {
    return {
      inputPath: input,
      dispose: () => {}
    };
  }
  const result = await (dependencies.fetch ?? safeFetch)(requestedUrl, {
    timeoutMs: options.timeoutMs ?? pdfCaptureDefaults.timeoutMs,
    maxBytes: options.maxPdfBytes ?? pdfCaptureDefaults.maxPdfBytes,
    allowPrivateNetwork: false,
    userAgent: remoteUserAgent,
    accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
    retries: 2,
    maxRedirects: 5
  });
  assertPdfSignature(result.bytes);
  const makeTemporaryDirectory = dependencies.makeTemporaryDirectory ?? (() => mkdtempSync3(join5(tmpdir2(), "hraness-kb-pdf-source-")));
  const removeDirectory = dependencies.removeDirectory ?? ((path) => rmSync3(path, { recursive: true, force: true }));
  const directory = makeTemporaryDirectory();
  let disposed = false;
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    removeDirectory(directory);
  };
  try {
    chmodSync3(directory, 448);
    const inputPath = join5(directory, remoteFilename(result.finalUrl));
    (dependencies.writeFile ?? writeFileSync2)(inputPath, result.bytes, {
      encoding: null,
      flag: "wx",
      mode: 384
    });
    return {
      inputPath,
      remoteSource: {
        requestedUrl: sanitizeArtifactUrl(requestedUrl.href),
        finalUrl: sanitizeArtifactUrl(result.finalUrl.href)
      },
      dispose
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

// src/pdf/cli.ts
var defaultOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value)
};
function safe(value) {
  return sanitizeTerminalLine(redactSensitiveText(value));
}
function terminalSafeJson(value) {
  return `${JSON.stringify(value, (_key, candidate) => typeof candidate === "string" ? sanitizeTerminalText(redactSensitiveText(candidate)) : candidate, 2)}
`;
}
function readInterpretations(path) {
  const absolute = resolve3(path);
  const stats = lstatSync3(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("PDF image annotations must be a regular JSON file");
  }
  if (stats.size > 16 * 1024 * 1024) {
    throw new Error("PDF image annotations exceed the 16MB limit");
  }
  let value;
  try {
    value = JSON.parse(readFileSync3(absolute, "utf8"));
  } catch {
    throw new Error("PDF image annotations are not valid JSON");
  }
  return parsePdfImageInterpretations(value);
}
function pdfCaptureSummary(outcome) {
  return {
    ok: true,
    status: outcome.status,
    slug: outcome.slug,
    outputDirectory: outcome.outputDirectory,
    markdownPath: outcome.markdownPath,
    sourcePath: outcome.sourcePath,
    wordCount: outcome.wordCount,
    pageCount: outcome.pageCount,
    processedPages: outcome.processedPages,
    imageCount: outcome.imageCount,
    warnings: outcome.warnings,
    manifest: outcome.manifest
  };
}
async function main(rawArguments = process.argv.slice(2), environment = process.env, output = defaultOutput, dependencies = {}) {
  const parsed = parsePdfArguments(rawArguments, environment);
  if (!parsed.ok) {
    output.stderr(`error: ${safe(parsed.message)}

${sanitizeTerminalText(pdfUsage)}`);
    return 2;
  }
  const arguments_ = parsed.value;
  if (arguments_.command === "help") {
    output.stdout(sanitizeTerminalText(pdfUsage));
    return 0;
  }
  if (!arguments_.quiet && !arguments_.json) {
    output.stderr(`Saving PDF ${safe(arguments_.input)} ...
`);
  }
  let preparedSource = null;
  try {
    const interpretations = arguments_.interpretationsPath === undefined ? undefined : (dependencies.readInterpretations ?? readInterpretations)(arguments_.interpretationsPath);
    preparedSource = await (dependencies.preparePdfSource ?? preparePdfSource)(arguments_.input, {
      ...arguments_.timeoutMs === undefined ? {} : { timeoutMs: arguments_.timeoutMs },
      ...arguments_.maxPdfBytes === undefined ? {} : { maxPdfBytes: arguments_.maxPdfBytes }
    });
    const options = {
      inputPath: preparedSource.inputPath,
      outputBase: arguments_.outputBase,
      ...preparedSource.remoteSource === undefined ? {} : { remoteSource: preparedSource.remoteSource },
      ...arguments_.slug === undefined ? {} : { slug: arguments_.slug },
      ...interpretations === undefined ? {} : { interpretations },
      force: arguments_.force,
      ...arguments_.timeoutMs === undefined ? {} : { timeoutMs: arguments_.timeoutMs },
      ...arguments_.maxPdfBytes === undefined ? {} : { maxPdfBytes: arguments_.maxPdfBytes },
      ...arguments_.maxPages === undefined ? {} : { maxPages: arguments_.maxPages },
      ...arguments_.maxImages === undefined ? {} : { maxImages: arguments_.maxImages },
      ...arguments_.maxAssetBytes === undefined ? {} : { maxAssetBytes: arguments_.maxAssetBytes },
      ...arguments_.maxTotalAssetBytes === undefined ? {} : { maxTotalAssetBytes: arguments_.maxTotalAssetBytes }
    };
    const outcome = await (dependencies.runPdfCapture ?? runPdfCapture)(options, dependencies.captureDependencies);
    if (arguments_.json)
      output.stdout(terminalSafeJson(pdfCaptureSummary(outcome)));
    else {
      output.stdout(`Done: ${safe(outcome.markdownPath)}
`);
      const pages = outcome.processedPages === outcome.pageCount ? `${outcome.pageCount} pages` : `${outcome.processedPages} of ${outcome.pageCount} pages processed`;
      output.stdout(`Status: ${outcome.status}; ${pages}; ${outcome.wordCount} words; ${outcome.imageCount} images.
`);
    }
    if (!arguments_.quiet && !arguments_.json) {
      for (const warning of outcome.warnings)
        output.stderr(`warning: ${safe(warning)}
`);
    }
    return 0;
  } catch (error) {
    const message = safe(error instanceof Error ? error.message : String(error));
    if (arguments_.json)
      output.stdout(terminalSafeJson({ ok: false, error: message }));
    else
      output.stderr(`error: ${message}
`);
    return 1;
  } finally {
    preparedSource?.dispose();
  }
}
if (false)
  ;

export { pdfUsage, parsePdfArguments, decodePopplerText, parsePopplerXml, parsePdfInfo, layoutBlocks, parsePdfImageInterpretations, runPdfToolCommand, resolvePdfTools, pdfCaptureDefaults, inspectPdf, PDF_CAPTURE_MANIFEST_SCHEMA_VERSION, PDF_CAPTURE_MANIFEST_FILENAME, PDF_CAPTURE_SOURCE_FILENAME, PDF_CAPTURE_ANNOTATIONS_FILENAME, pdfImageAssetPath, persistPdfCapture, pdfMarkdownFilename, buildPdfMarkdown, parseTesseractTsv, ocrPdfImage, runPdfCapture, pdfCaptureSummary, main };
