import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  analyzeVault,
  isCanonicalNoteId,
  lookupNote,
  MAX_ANALYZED_NOTES,
  normalizeVaultPath,
  parseNote,
  renderCatalog,
  replaceCatalog,
  type AnalyzeVaultOptions,
  type Note,
  type VaultAnalysis,
} from "./graph.js";

export const MAX_SCANNED_NOTES = MAX_ANALYZED_NOTES;
export const MAX_NOTE_UTF8_BYTES = 16 * 1_024 * 1_024;
export const MAX_VAULT_UTF8_BYTES = 256 * 1_024 * 1_024;

export type VaultScanBudgetKind =
  | "notes"
  | "note-bytes"
  | "total-bytes";

/** A stable failure for callers that need to distinguish bounded disk input. */
export class VaultScanBudgetError extends RangeError {
  readonly kind: VaultScanBudgetKind;
  readonly limit: number;

  constructor(
    kind: VaultScanBudgetKind,
    limit: number,
    message: string,
  ) {
    super(message);
    this.name = "VaultScanBudgetError";
    this.kind = kind;
    this.limit = limit;
  }
}

export const defaultIgnoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
]);

export type CatalogMode = "managed" | "authored";

export type VaultIndexState = "current" | "stale" | "updated" | "authored";

export type VaultSnapshot = {
  readonly root: string;
  readonly indexPath: string;
  readonly catalogMode: CatalogMode;
  readonly index: VaultIndexState;
  readonly notes: readonly Note[];
  readonly analysis: VaultAnalysis;
};

export type ScanVaultOptions = Omit<AnalyzeVaultOptions, "mentionScope"> & {
  readonly index?: string;
  /** Override the configured index's `kb_catalog` mode for this operation. */
  readonly catalogMode?: CatalogMode;
  readonly ignoredDirectories?: ReadonlySet<string>;
  /** Maximum UTF-8 bytes accepted from one Markdown note. */
  readonly maxNoteBytes?: number;
  /** Maximum UTF-8 bytes accepted across all Markdown notes. */
  readonly maxTotalBytes?: number;
  /**
   * `false` omits mention pairing; a note query restricts pairing to edges
   * touching every note that query can resolve to.
   */
  readonly mentionScope?: string | false;
};

export async function markdownFiles(
  directory: string,
  ignoredDirectories: ReadonlySet<string> = defaultIgnoredDirectories,
): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      files.push(...await markdownFiles(entryPath, ignoredDirectories));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
      files.push(entryPath);
    }
  }
  return files;
}

type DiscoveredNoteFile = {
  readonly absolutePath: string;
  readonly vaultPath: string;
  readonly rawId: string;
};

type ScannedNoteFile = DiscoveredNoteFile & {
  readonly device: bigint;
  readonly inode: bigint;
};

type ScannableFileMetadata = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

function checkedScanLimit(
  value: number | undefined,
  hardMaximum: number,
  option: "maxNotes" | "maxNoteBytes" | "maxTotalBytes",
): number {
  const limit = value ?? hardMaximum;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > hardMaximum) {
    throw new RangeError(
      `${option} must be a safe integer from 0 through ${hardMaximum}.`,
    );
  }
  return limit;
}

function normalizedRawNoteId(rawId: string): string {
  return normalizeVaultPath(rawId).normalize("NFC");
}

function validateScannedNotePaths(
  root: string,
  paths: readonly string[],
): readonly DiscoveredNoteFile[] {
  const files = paths.map((absolutePath): DiscoveredNoteFile => {
    const vaultPath = relative(root, absolutePath).split(sep).join("/");
    return {
      absolutePath,
      vaultPath,
      rawId: vaultPath.slice(0, -3),
    };
  });

  const pathByNormalizedId = new Map<string, string>();
  for (const file of files) {
    const normalizedId = normalizedRawNoteId(file.rawId);
    const collision = pathByNormalizedId.get(normalizedId);
    if (collision !== undefined && collision !== file.vaultPath) {
      throw new Error(
        `Vault note paths ${JSON.stringify(collision)} and `
          + `${JSON.stringify(file.vaultPath)} normalize to the same note ID `
          + `${JSON.stringify(normalizedId)}.`,
      );
    }
    pathByNormalizedId.set(normalizedId, file.vaultPath);
  }

  for (const file of files) {
    if (isCanonicalNoteId(file.rawId)) continue;
    if (file.rawId !== file.rawId.normalize("NFC")) {
      throw new Error(
        `Vault note path ${JSON.stringify(file.vaultPath)} is not NFC; `
          + `its extensionless note ID must be exactly `
          + `${JSON.stringify(file.rawId.normalize("NFC"))}.`,
      );
    }
    if (file.rawId.includes("\\")) {
      throw new Error(
        `Vault note path ${JSON.stringify(file.vaultPath)} contains a backslash; `
          + "note IDs must use exact vault-root directory separators.",
      );
    }
    throw new Error(
      `Vault note path ${JSON.stringify(file.vaultPath)} must have an exact `
        + "canonical extensionless vault-root note ID.",
    );
  }
  return files;
}

function assertScannableNoteFile(
  vaultPath: string,
  metadata: ScannableFileMetadata,
): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must not be a symbolic link.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must be a regular file.`);
  }
  if (metadata.nlink !== 1n) {
    throw new Error(`Vault note ${JSON.stringify(vaultPath)} must not be hard-linked.`);
  }
}

function noteBytesError(
  vaultPath: string,
  limit: number,
): VaultScanBudgetError {
  return new VaultScanBudgetError(
    "note-bytes",
    limit,
    `Vault note ${JSON.stringify(vaultPath)} exceeds the ${limit}-byte UTF-8 limit.`,
  );
}

function totalBytesError(limit: number): VaultScanBudgetError {
  return new VaultScanBudgetError(
    "total-bytes",
    limit,
    `Vault scan exceeds the ${limit}-byte cumulative UTF-8 limit.`,
  );
}

async function readBoundedNote(
  handle: FileHandle,
  vaultPath: string,
  maxNoteBytes: number,
  remainingTotalBytes: number,
  maxTotalBytes: number,
): Promise<{ readonly content: string; readonly bytes: number }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const remaining = Math.min(
      maxNoteBytes - bytes,
      remainingTotalBytes - bytes,
    );
    const buffer = new Uint8Array(Math.min(64 * 1_024, Math.max(1, remaining + 1)));
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
    if (bytes > maxNoteBytes) throw noteBytesError(vaultPath, maxNoteBytes);
    if (bytes > remainingTotalBytes) {
      throw totalBytesError(maxTotalBytes);
    }
    chunks.push(buffer.slice(0, result.bytesRead));
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(joined),
      bytes,
    };
  } catch (error) {
    throw new Error(
      `Vault note ${JSON.stringify(vaultPath)} is not valid UTF-8.`,
      { cause: error },
    );
  }
}

export async function readVaultNotes(
  root: string,
  ignoredDirectories: ReadonlySet<string> = defaultIgnoredDirectories,
  limits: Pick<
    ScanVaultOptions,
    "maxNotes" | "maxNoteBytes" | "maxTotalBytes"
  > = {},
): Promise<Note[]> {
  const maxNotes = checkedScanLimit(
    limits.maxNotes,
    MAX_SCANNED_NOTES,
    "maxNotes",
  );
  const maxNoteBytes = checkedScanLimit(
    limits.maxNoteBytes,
    MAX_NOTE_UTF8_BYTES,
    "maxNoteBytes",
  );
  const maxTotalBytes = checkedScanLimit(
    limits.maxTotalBytes,
    MAX_VAULT_UTF8_BYTES,
    "maxTotalBytes",
  );
  const paths = await markdownFiles(root, ignoredDirectories);
  if (paths.length > maxNotes) {
    throw new VaultScanBudgetError(
      "notes",
      maxNotes,
      `Vault scan exceeds the ${maxNotes} Markdown note limit.`,
    );
  }

  const files = validateScannedNotePaths(root, paths);
  let declaredTotal = 0n;
  const preflight: ScannedNoteFile[] = [];
  for (const file of files) {
    const metadata = await lstat(file.absolutePath, { bigint: true });
    assertScannableNoteFile(file.vaultPath, metadata);
    if (metadata.size > BigInt(maxNoteBytes)) {
      throw noteBytesError(file.vaultPath, maxNoteBytes);
    }
    declaredTotal += metadata.size;
    if (declaredTotal > BigInt(maxTotalBytes)) {
      throw totalBytesError(maxTotalBytes);
    }
    preflight.push({
      ...file,
      device: metadata.dev,
      inode: metadata.ino,
    });
  }

  const notes: Note[] = [];
  let observedTotal = 0;
  for (const file of preflight) {
    const handle = await open(
      file.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const beforeRead = await handle.stat({ bigint: true });
      assertScannableNoteFile(file.vaultPath, beforeRead);
      if (beforeRead.dev !== file.device || beforeRead.ino !== file.inode) {
        throw new Error(
          `Vault note ${JSON.stringify(file.vaultPath)} changed during scan; retry.`,
        );
      }
      if (beforeRead.size > BigInt(maxNoteBytes)) {
        throw noteBytesError(file.vaultPath, maxNoteBytes);
      }
      if (BigInt(observedTotal) + beforeRead.size > BigInt(maxTotalBytes)) {
        throw totalBytesError(maxTotalBytes);
      }
      const read = await readBoundedNote(
        handle,
        file.vaultPath,
        maxNoteBytes,
        maxTotalBytes - observedTotal,
        maxTotalBytes,
      );
      const afterRead = await handle.stat({ bigint: true });
      if (
        afterRead.dev !== file.device
        || afterRead.ino !== file.inode
        || afterRead.size !== beforeRead.size
        || afterRead.size !== BigInt(read.bytes)
      ) {
        throw new Error(
          `Vault note ${JSON.stringify(file.vaultPath)} changed during scan; retry.`,
        );
      }
      observedTotal += read.bytes;
      notes.push(parseNote(file.vaultPath, read.content));
    } finally {
      await handle.close();
    }
  }
  return notes;
}

type IndexRevision = {
  readonly content: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
};

function confined(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`);
}

async function assertConfinedIndexParents(root: string, path: string): Promise<void> {
  if (!confined(root, path)) throw new Error("The configured index must be a file inside the vault root.");
  const parent = dirname(path);
  const segments = relative(root, parent).split(sep).filter((segment) => segment !== "");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("The configured index path must not traverse a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Every configured index parent must be a directory.");
    }
  }
  const canonicalParent = await realpath(parent);
  if (!confined(root, join(canonicalParent, basename(path)))) {
    throw new Error("The configured index parent resolves outside the vault root.");
  }
}

async function readIndexRevision(
  root: string,
  path: string,
  maxNoteBytes = MAX_NOTE_UTF8_BYTES,
): Promise<IndexRevision> {
  await assertConfinedIndexParents(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw new Error("The configured index must be a regular file.");
    if (metadata.nlink !== 1n) throw new Error("The configured index must not be hard-linked.");
    const canonicalPath = await realpath(path);
    if (!confined(root, canonicalPath)) {
      throw new Error("The configured index resolves outside the vault root.");
    }
    const vaultPath = relative(root, path).split(sep).join("/");
    if (metadata.size > BigInt(maxNoteBytes)) {
      throw noteBytesError(vaultPath, maxNoteBytes);
    }
    const read = await readBoundedNote(
      handle,
      vaultPath,
      maxNoteBytes,
      maxNoteBytes,
      maxNoteBytes,
    );
    const afterRead = await handle.stat({ bigint: true });
    if (
      afterRead.dev !== metadata.dev
      || afterRead.ino !== metadata.ino
      || afterRead.size !== metadata.size
      || afterRead.size !== BigInt(read.bytes)
    ) {
      throw new Error("The configured index changed during scan; retry.");
    }
    return {
      content: read.content,
      device: metadata.dev,
      inode: metadata.ino,
      mode: Number(metadata.mode & 0o777n),
    };
  } finally {
    await handle.close();
  }
}

function sameRevision(left: IndexRevision, right: IndexRevision): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.content === right.content;
}

function parsedCatalogMode(value: unknown, source: string): CatalogMode | undefined {
  if (value === undefined) return undefined;
  if (value === "managed" || value === "authored") return value;
  throw new Error(
    `${source} must be exactly "managed" or "authored".`,
  );
}

function declaredCatalogMode(indexNote: Note): CatalogMode | undefined {
  const declaration = Object.entries(indexNote.metadata).find(([name]) =>
    name.toLocaleLowerCase("en-US") === "kb_catalog");
  return parsedCatalogMode(
    declaration?.[1],
    `The configured index frontmatter property "kb_catalog"`,
  );
}

async function atomicReplace(
  root: string,
  path: string,
  content: string,
  expected: IndexRevision,
): Promise<void> {
  const beforeWrite = await readIndexRevision(root, path);
  if (!sameRevision(beforeWrite, expected)) {
    throw new Error("The configured index changed during refresh; retry without overwriting the editor's changes.");
  }
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await assertConfinedIndexParents(root, path);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    expected.mode,
  );
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    const beforeRename = await readIndexRevision(root, path);
    if (!sameRevision(beforeRename, expected)) {
      throw new Error("The configured index changed during refresh; retry without overwriting the editor's changes.");
    }
    await assertConfinedIndexParents(root, path);
    await rename(temporaryPath, path);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function snapshot(
  rootInput: string,
  options: ScanVaultOptions,
  writeIndex: boolean,
): Promise<VaultSnapshot> {
  const requestedRoot = resolve(rootInput);
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) throw new Error("The vault root must be a directory.");
  const indexPath = resolve(root, options.index ?? "index.md");
  const relativeIndex = relative(root, indexPath);
  if (!confined(root, indexPath)) {
    throw new Error("The configured index must be a file inside the vault root.");
  }
  if (!indexPath.toLowerCase().endsWith(".md")) {
    throw new Error("The configured index must be a Markdown file.");
  }
  const vaultIndexPath = relativeIndex.split(sep).join("/");
  const catalogNoteId = vaultIndexPath.toLowerCase().endsWith(".md")
    ? vaultIndexPath.slice(0, -3)
    : vaultIndexPath;
  const notes = await readVaultNotes(root, options.ignoredDirectories, {
    ...(options.maxNotes === undefined ? {} : { maxNotes: options.maxNotes }),
    ...(options.maxNoteBytes === undefined
      ? {}
      : { maxNoteBytes: options.maxNoteBytes }),
    ...(options.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxTotalBytes }),
  });
  const indexRevision = await readIndexRevision(
    root,
    indexPath,
    options.maxNoteBytes ?? MAX_NOTE_UTF8_BYTES,
  );
  const currentIndex = indexRevision.content;
  const indexNote = parseNote(vaultIndexPath, currentIndex);
  const catalogMode = parsedCatalogMode(
    options.catalogMode,
    "ScanVaultOptions.catalogMode",
  ) ?? declaredCatalogMode(indexNote) ?? "managed";
  let index: VaultIndexState = "authored";

  if (catalogMode === "managed") {
    const expectedIndex = replaceCatalog(
      currentIndex,
      renderCatalog(notes, catalogNoteId),
    );
    const stale = currentIndex !== expectedIndex;
    index = stale ? "stale" : "current";

    if (writeIndex && stale) {
      await atomicReplace(root, indexPath, expectedIndex, indexRevision);
      index = "updated";
      const parsed = parseNote(vaultIndexPath, expectedIndex);
      const noteIndex = notes.findIndex((note) => note.path === vaultIndexPath);
      if (noteIndex === -1) notes.push(parsed);
      else notes[noteIndex] = parsed;
    }
  }

  const mentionScope = options.mentionScope;
  const mentionIds = new Set<string>();
  if (typeof mentionScope === "string") {
    const lookup = lookupNote(notes, mentionScope);
    if (lookup.kind === "found") mentionIds.add(lookup.note.id);
    else if (lookup.kind === "ambiguous") {
      for (const note of lookup.candidates) mentionIds.add(note.id);
    }
  }
  const mentionScopePredicate = mentionScope === undefined
    ? undefined
    : (note: Note): boolean =>
        mentionScope !== false && mentionIds.has(note.id);

  return {
    root,
    indexPath,
    catalogMode,
    index,
    notes,
    analysis: analyzeVault(notes, {
      catalogNoteId,
      ...(options.includeInSuggestions === undefined
        ? {}
        : { includeInSuggestions: options.includeInSuggestions }),
      ...(mentionScopePredicate === undefined
        ? {}
        : { mentionScope: mentionScopePredicate }),
      ...(options.maxNotes === undefined ? {} : { maxNotes: options.maxNotes }),
      ...(options.maxConnectionObservations === undefined
        ? {}
        : { maxConnectionObservations: options.maxConnectionObservations }),
      ...(options.maxMentionPairs === undefined
        ? {}
        : { maxMentionPairs: options.maxMentionPairs }),
      ...(options.maxMentions === undefined
        ? {}
        : { maxMentions: options.maxMentions }),
    }),
  };
}

export async function scanVault(
  root = ".",
  options: ScanVaultOptions = {},
): Promise<VaultSnapshot> {
  return snapshot(root, options, false);
}

export async function refreshVault(
  root = ".",
  options: ScanVaultOptions = {},
): Promise<VaultSnapshot> {
  return snapshot(root, options, true);
}
