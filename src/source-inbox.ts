import type { Note, VaultAnalysis } from "./graph.js";

export const MAX_SOURCE_INBOX_NOTES = 10_000;
export const MAX_SOURCE_INBOX_RESULTS = 1_000;
export const MAX_SOURCE_INBOX_PREFIXES = 16;
export const MAX_SOURCE_INBOX_CONNECTIONS = 250_000;
export const MAX_SOURCE_DISPOSITION_EVIDENCE = 20;
const windowsAbsolutePattern = /^[a-z]:[\\/]/iu;

export type SourceInboxReason =
  | "invalid-clipped-date"
  | "missing-clipped-date"
  | "no-maintained-disposition";

export type SourceInboxEvidence = {
  readonly kind: "link" | "relation";
  readonly source: string;
  readonly line: number;
  readonly predicate?: string;
};

export type SourceInboxItem = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly clipped: string | null;
  readonly reason: SourceInboxReason;
};

export type SourceDisposition = {
  readonly id: string;
  readonly path: string;
  readonly evidence: readonly SourceInboxEvidence[];
  readonly evidenceTruncated?: true;
};

export type SourceInboxReport = {
  readonly advisory: true;
  readonly sourcePrefixes: readonly string[];
  readonly totalSources: number;
  readonly disposedSources: number;
  readonly pendingSources: number;
  readonly returnedSources: number;
  readonly truncated: boolean;
  readonly items: readonly SourceInboxItem[];
  /** Bounded proof for sources omitted because maintained knowledge cites them. */
  readonly dispositions: readonly SourceDisposition[];
};

function normalizedPrefix(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .normalize("NFC")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || windowsAbsolutePattern.test(normalized)
    || normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new TypeError("Source-inbox prefixes must be confined vault-relative directories.");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function clippedReason(note: Note): Pick<SourceInboxItem, "clipped" | "reason"> {
  const raw = note.metadata.clipped;
  const clipped = validDate(raw);
  if (clipped !== null) return { clipped, reason: "no-maintained-disposition" };
  return {
    clipped: null,
    reason: raw === undefined ? "missing-clipped-date" : "invalid-clipped-date",
  };
}

function defaultMaintained(note: Note): boolean {
  const type = note.metadata.type;
  return note.path.startsWith("notes/")
    || type === "note"
    || type === "concept";
}

function compareInbox(left: SourceInboxItem, right: SourceInboxItem): number {
  if (left.clipped !== null && right.clipped === null) return -1;
  if (left.clipped === null && right.clipped !== null) return 1;
  if (left.clipped !== null && right.clipped !== null && left.clipped !== right.clipped) {
    return right.clipped.localeCompare(left.clipped);
  }
  return left.path.localeCompare(right.path);
}

/**
 * Build an advisory-only inbox. A source leaves the inbox only when an inbound
 * link or authored relation comes from maintained, non-source knowledge.
 * Catalog and source-to-source edges never count as disposition.
 */
export function sourceInbox(
  notes: readonly Note[],
  analysis: VaultAnalysis,
  options: {
    readonly sourcePrefixes?: readonly string[];
    readonly catalogNoteIds?: readonly string[];
    readonly limit?: number;
    readonly maxNotes?: number;
    readonly maxConnections?: number;
    readonly isMaintained?: (note: Note) => boolean;
  } = {},
): SourceInboxReport {
  const maxNotes = options.maxNotes ?? MAX_SOURCE_INBOX_NOTES;
  const maxConnections = options.maxConnections ?? MAX_SOURCE_INBOX_CONNECTIONS;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(maxNotes) || maxNotes < 1 || maxNotes > MAX_SOURCE_INBOX_NOTES) {
    throw new RangeError(`Source inbox accepts from 1 through ${MAX_SOURCE_INBOX_NOTES} notes.`);
  }
  if (notes.length > maxNotes) {
    throw new RangeError(`Source inbox received ${notes.length} notes, above its ${maxNotes}-note limit.`);
  }
  if (
    !Number.isSafeInteger(maxConnections)
    || maxConnections < 0
    || maxConnections > MAX_SOURCE_INBOX_CONNECTIONS
  ) {
    throw new RangeError(
      `Source inbox connection limit must be from 0 through ${MAX_SOURCE_INBOX_CONNECTIONS}.`,
    );
  }
  const observedConnections = analysis.contextualLinks.length + analysis.authoredRelations.length;
  if (observedConnections > maxConnections) {
    throw new RangeError(
      `Source inbox received ${observedConnections} connections, above its ${maxConnections}-connection limit.`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_SOURCE_INBOX_RESULTS) {
    throw new RangeError(`Source inbox limit must be from 0 through ${MAX_SOURCE_INBOX_RESULTS}.`);
  }
  const prefixInputs = options.sourcePrefixes ?? ["articles/"];
  if (prefixInputs.length < 1 || prefixInputs.length > MAX_SOURCE_INBOX_PREFIXES) {
    throw new RangeError(`Source inbox accepts from 1 through ${MAX_SOURCE_INBOX_PREFIXES} source prefixes.`);
  }
  const sourcePrefixes = Object.freeze([...new Set(prefixInputs.map(normalizedPrefix))].toSorted());
  const catalogs = new Set(options.catalogNoteIds ?? ["index"]);
  const noteByReference = new Map(notes.flatMap((note) => [
    [note.id, note] as const,
    [note.path, note] as const,
  ]));
  const isSource = (note: Note): boolean => sourcePrefixes.some((prefix) => note.path.startsWith(prefix));
  const maintained = options.isMaintained ?? defaultMaintained;
  const sources = notes.filter(isSource).toSorted((left, right) => left.path.localeCompare(right.path));
  const evidence = new Map<string, SourceInboxEvidence[]>();
  const acceptSource = (
    sourceId: string,
    targetId: string,
  ): { readonly source: Note; readonly target: Note } | null => {
    const source = noteByReference.get(sourceId);
    const target = noteByReference.get(targetId);
    if (
      source === undefined
      || target === undefined
      || catalogs.has(source.id)
      || isSource(source)
      || !isSource(target)
      || !maintained(source)
    ) return null;
    return { source, target };
  };
  for (const link of analysis.contextualLinks) {
    const accepted = acceptSource(link.source, link.target);
    if (accepted === null) continue;
    const entries = evidence.get(accepted.target.id) ?? [];
    entries.push(Object.freeze({ kind: "link", source: accepted.source.id, line: link.line }));
    evidence.set(accepted.target.id, entries);
  }
  for (const relation of analysis.authoredRelations) {
    const accepted = acceptSource(relation.source, relation.target);
    if (accepted === null) continue;
    const entries = evidence.get(accepted.target.id) ?? [];
    entries.push(Object.freeze({
      kind: "relation",
      source: accepted.source.id,
      line: relation.provenance.line,
      predicate: relation.predicate,
    }));
    evidence.set(accepted.target.id, entries);
  }

  const dispositions = sources.flatMap((source): SourceDisposition[] => {
    const entries = evidence.get(source.id);
    if (entries === undefined || entries.length === 0) return [];
    const sorted = entries.toSorted((left, right) =>
      left.source.localeCompare(right.source)
        || left.line - right.line
        || left.kind.localeCompare(right.kind));
    return [Object.freeze({
      id: source.id,
      path: source.path,
      evidence: Object.freeze(sorted.slice(0, MAX_SOURCE_DISPOSITION_EVIDENCE)),
      ...(sorted.length > MAX_SOURCE_DISPOSITION_EVIDENCE
        ? { evidenceTruncated: true as const }
        : {}),
    })];
  });
  const pending = sources
    .filter(({ id }) => !evidence.has(id))
    .map((source): SourceInboxItem => Object.freeze({
      id: source.id,
      path: source.path,
      title: source.title,
      ...clippedReason(source),
    }))
    .toSorted(compareInbox);
  const items = pending.slice(0, limit);
  return Object.freeze({
    advisory: true,
    sourcePrefixes,
    totalSources: sources.length,
    disposedSources: dispositions.length,
    pendingSources: pending.length,
    returnedSources: items.length,
    truncated: items.length < pending.length,
    items: Object.freeze(items),
    dispositions: Object.freeze(dispositions),
  });
}
