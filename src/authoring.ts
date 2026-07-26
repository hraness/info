import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import {
  acquireNoteLock,
  type NoteLock,
  type NoteLockOptions,
} from "./note-lock.js";
import { isCanonicalNoteId } from "./graph.js";

const MAX_NOTE_BYTES = 16 * 1024 * 1024;
const NOTE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PREDICATE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_PARENT_DIRECTORY_ENTRIES = 100_000;
const MAX_RECOVERY_LOCATIONS_PER_NOTE = 8;

export type NoteRevision = `sha256:${string}`;

export interface NoteRelation {
  readonly predicate: string;
  readonly target: string;
}

export interface NoteAuthoringResult {
  readonly changed: boolean;
  /** Exact vault-relative Markdown path. */
  readonly path: string;
  readonly revision: NoteRevision;
  readonly relations: readonly NoteRelation[];
}

export interface CreateNoteInput {
  /** Exact extensionless vault-root note ID, for example `notes/local-first`. */
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly tags?: readonly string[];
  /** Markdown after frontmatter. Defaults to one H1; a final newline is added. */
  readonly body?: string;
}

export interface CreateConceptNoteInput {
  readonly id: string;
  readonly title: string;
  readonly tags?: readonly string[];
  readonly body?: string;
}

export interface AuthoringInstallContext {
  readonly operation: "create" | "replace";
  readonly path: string;
  readonly temporaryPath: string;
  /**
   * Private recovery path used by replacements. It is absent for creates and
   * remains on disk only when restoring it without clobbering a raced writer
   * is impossible.
   */
  readonly recoveryPath?: string;
}

export interface AuthoringDependencies {
  readonly token: () => string;
  /**
   * Test and embedding seam immediately before ownership and source revision
   * are rechecked. Callers should normally omit this.
   */
  readonly beforeInstall?: (context: AuthoringInstallContext) => Promise<void>;
  /**
   * Deterministic test seam after the final optimistic read but immediately
   * before the no-clobber create or replacement transaction starts.
   */
  readonly beforeCommit?: (context: AuthoringInstallContext) => Promise<void>;
  /**
   * Deterministic test seam after an expected replacement source has been
   * moved and verified at recoveryPath, before the new content is linked.
   */
  readonly afterSourceQuarantined?: (
    context: Required<AuthoringInstallContext>,
  ) => Promise<void>;
}

export interface AuthoringOptions {
  readonly expectedRevision?: NoteRevision;
  readonly lock?: NoteLockOptions;
  readonly dependencies?: Partial<AuthoringDependencies>;
}

export class InvalidCanonicalNoteIdError extends TypeError {
  readonly noteId: string;

  constructor(noteId: string) {
    super(`not an exact canonical note ID: ${JSON.stringify(noteId)}`);
    this.name = "InvalidCanonicalNoteIdError";
    this.noteId = noteId;
  }
}

export class NoteRevisionConflictError extends Error {
  readonly path: string;
  readonly expected: NoteRevision | null;
  readonly actual: NoteRevision | null;
  /** Vault-relative path retaining the displaced bytes, when restoration raced. */
  readonly recoveryPath: string | null;

  constructor(
    path: string,
    expected: NoteRevision | null,
    actual: NoteRevision | null,
    recoveryPath: string | null = null,
  ) {
    super(recoveryPath === null
      ? "the note changed during authoring; retry from its current revision"
      : `the note changed during authoring; displaced bytes remain at ${recoveryPath}`);
    this.name = "NoteRevisionConflictError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.recoveryPath = recoveryPath;
  }
}

export class NoteAlreadyExistsError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`the existing note is incompatible with this create request: ${reason}`);
    this.name = "NoteAlreadyExistsError";
    this.path = path;
  }
}

export class NoteRecoveryRequiredError extends Error {
  readonly path: string;
  readonly recoveryPath: string;

  constructor(path: string, recoveryPath: string, cause: unknown) {
    super(`authoring stopped; displaced bytes remain at ${recoveryPath}`, { cause });
    this.name = "NoteRecoveryRequiredError";
    this.path = path;
    this.recoveryPath = recoveryPath;
  }
}

interface Vault {
  readonly root: string;
}

interface NoteSnapshot {
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
  readonly revision: NoteRevision;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
  readonly mode: number;
}

interface FrontmatterParts {
  readonly document: Document;
  readonly hadFrontmatter: boolean;
  readonly openingDelimiter: string;
  readonly closingDelimiter: string;
  readonly newline: "\n" | "\r\n";
  /** Exact bytes after the existing closing delimiter, including its newline. */
  readonly bodySuffix: string;
}

interface RelationNodes {
  readonly root: YAMLMap;
  readonly relations: YAMLMap | null;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function revisionFor(bytes: Uint8Array): NoteRevision {
  return `sha256:${sha256(bytes)}`;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`);
}

/** Validate and return an exact extensionless canonical vault note ID. */
export function canonicalNoteId(value: string): string {
  if (!isCanonicalNoteId(value)) {
    throw new InvalidCanonicalNoteIdError(value);
  }
  return value;
}

/** Normalize a caller predicate to the strict lower-kebab authored form. */
export function normalizeRelationPredicate(value: string): string {
  const normalized = value
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replaceAll("_", "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/gu, "-");
  if (!PREDICATE_PATTERN.test(normalized)) {
    throw new TypeError(`not a valid relation predicate: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function exactPredicate(value: string): string {
  const normalized = normalizeRelationPredicate(value);
  if (value !== normalized) {
    throw new Error(`authored relation predicate is not canonical kebab-case: ${value}`);
  }
  return value;
}

function requireRevision(value: string): NoteRevision {
  if (!NOTE_REVISION_PATTERN.test(value)) {
    throw new TypeError("expectedRevision is not an Oh note revision");
  }
  return value as NoteRevision;
}

async function resolveVault(rootInput: string): Promise<Vault> {
  const root = await realpath(resolve(rootInput));
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the vault root must be a real directory");
  }
  if (dirname(root) === root) {
    throw new Error("refusing to author notes in a filesystem root");
  }
  return { root };
}

function pathFor(vault: Vault, id: string): {
  readonly path: string;
  readonly relativePath: string;
} {
  const canonicalId = canonicalNoteId(id);
  const relativePath = `${canonicalId}.md`;
  const path = resolve(vault.root, ...relativePath.split("/"));
  if (!inside(vault.root, path)) {
    throw new InvalidCanonicalNoteIdError(id);
  }
  return { path, relativePath };
}

async function assertExactDirectoryEntry(
  directory: string,
  name: string,
): Promise<void> {
  const entries = await readdir(directory);
  if (!entries.includes(name)) {
    const error = new Error(`vault path component is not exact: ${name}`) as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    throw error;
  }
}

async function assertSafeParent(vault: Vault, path: string): Promise<void> {
  if (!inside(vault.root, path)) {
    throw new Error("the note path must remain inside the vault");
  }
  const parent = dirname(path);
  const segments = relative(vault.root, parent).split(sep).filter(Boolean);
  let current = vault.root;
  for (const segment of segments) {
    await assertExactDirectoryEntry(current, segment);
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("the note path must not traverse a symbolic link");
    }
    if (!metadata.isDirectory()) {
      throw new Error("every note parent must be a directory");
    }
  }
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent || !inside(vault.root, join(canonicalParent, basename(path)))) {
    throw new Error("the note parent resolves outside the vault");
  }
}

async function readSnapshotAtPath(
  vault: Vault,
  path: string,
  relativePath: string,
): Promise<NoteSnapshot> {
  await assertSafeParent(vault, path);
  await assertExactDirectoryEntry(dirname(path), basename(path));

  const beforeOpen = await lstat(path, { bigint: true });
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw new Error("the note target must be a regular file");
  }
  if (beforeOpen.nlink !== 1n) {
    throw new Error("the note target must not be hard-linked");
  }
  if (beforeOpen.size > BigInt(MAX_NOTE_BYTES)) {
    throw new Error("the note is too large for bounded authoring");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== beforeOpen.dev
      || opened.ino !== beforeOpen.ino
      || opened.size !== beforeOpen.size
      || opened.size > BigInt(MAX_NOTE_BYTES)
    ) {
      throw new Error("the note target changed while it was opened");
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error("the note target changed while it was read");
      }
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, Number(opened.size))).bytesRead !== 0) {
      throw new Error("the note target grew while it was read");
    }

    const finished = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (
      !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || finalPath.nlink !== 1n
      || finalPath.dev !== opened.dev
      || finalPath.ino !== opened.ino
      || finalPath.size !== opened.size
      || finished.size !== opened.size
      || finished.mtimeNs !== opened.mtimeNs
      || finished.ctimeNs !== opened.ctimeNs
    ) {
      throw new Error("the note target changed while it was read");
    }
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || !inside(vault.root, canonicalPath)) {
      throw new Error("the note target resolves outside the vault");
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error("the note target is not valid UTF-8", { cause: error });
    }
    return {
      path,
      relativePath,
      content,
      revision: revisionFor(bytes),
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      modifiedAtNs: opened.mtimeNs,
      changedAtNs: opened.ctimeNs,
      mode: Number(opened.mode & 0o777n),
    };
  } finally {
    await handle.close();
  }
}

async function readSnapshot(
  vault: Vault,
  id: string,
): Promise<NoteSnapshot> {
  const { path, relativePath } = pathFor(vault, id);
  return readSnapshotAtPath(vault, path, relativePath);
}

async function readOptionalSnapshot(
  vault: Vault,
  id: string,
): Promise<NoteSnapshot | null> {
  try {
    return await readSnapshot(vault, id);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function sameSnapshot(left: NoteSnapshot, right: NoteSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAtNs === right.modifiedAtNs
    && left.changedAtNs === right.changedAtNs
    && left.mode === right.mode
    && left.revision === right.revision;
}

function frontmatter(content: string, relativePath: string): FrontmatterParts {
  const firstLineEnd = content.indexOf("\n");
  const openingEnd = firstLineEnd === -1 ? content.length : firstLineEnd;
  const openingContentEnd = content[openingEnd - 1] === "\r"
    ? openingEnd - 1
    : openingEnd;
  const opening = content.slice(0, openingContentEnd);
  if (opening.trim() !== "---") {
    return {
      document: parseFrontmatterDocument("", relativePath),
      hadFrontmatter: false,
      openingDelimiter: "---",
      closingDelimiter: "---",
      newline: content.includes("\r\n") ? "\r\n" : "\n",
      bodySuffix: content,
    };
  }
  if (firstLineEnd === -1) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: missing closing delimiter`);
  }
  const newline = content[firstLineEnd - 1] === "\r" ? "\r\n" : "\n";
  let cursor = firstLineEnd + 1;
  for (;;) {
    const nextNewline = content.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const lineContentEnd = content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = content.slice(cursor, lineContentEnd);
    if (line.trim() === "---") {
      const yamlSource = content.slice(firstLineEnd + 1, cursor);
      return {
        document: parseFrontmatterDocument(yamlSource, relativePath),
        hadFrontmatter: true,
        openingDelimiter: content.slice(0, openingContentEnd),
        closingDelimiter: content.slice(cursor, lineContentEnd),
        newline,
        bodySuffix: content.slice(lineContentEnd),
      };
    }
    if (nextNewline === -1) break;
    cursor = nextNewline + 1;
  }
  throw new Error(`invalid YAML frontmatter in ${relativePath}: missing closing delimiter`);
}

function parseFrontmatterDocument(source: string, relativePath: string): Document {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: expected a mapping`);
  }
  if (isMap(document.contents)) {
    const seen = new Set<string>();
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error(`invalid YAML frontmatter in ${relativePath}: keys must be strings`);
      }
      const folded = pair.key.value.toLocaleLowerCase("en-US");
      if (seen.has(folded)) {
        throw new Error(
          `invalid YAML frontmatter in ${relativePath}: keys must not differ only by case`,
        );
      }
      seen.add(folded);
    }
  }
  return document;
}

function relationNodes(
  parts: FrontmatterParts,
  relativePath: string,
  create: boolean,
): RelationNodes {
  const { document } = parts;
  if (document.contents === null) {
    if (!create) {
      const detached = document.createNode({});
      if (!isMap(detached)) throw new Error("YAML did not create a mapping");
      return { root: detached, relations: null };
    }
    document.contents = document.createNode({});
  }
  if (!isMap(document.contents)) {
    throw new Error(`invalid YAML frontmatter in ${relativePath}: expected a mapping`);
  }
  const root = document.contents;
  const relationPair = root.items.find((pair) =>
    isScalar(pair.key)
    && typeof pair.key.value === "string"
    && pair.key.value.toLocaleLowerCase("en-US") === "relations");
  const existing = relationPair?.value;
  if (existing === undefined) {
    if (!create) return { root, relations: null };
    const created = document.createNode({});
    if (!isMap(created)) throw new Error("YAML did not create a relation mapping");
    root.set("relations", created);
    return { root, relations: created };
  }
  if (!isMap(existing)) {
    throw new Error(`invalid relations in ${relativePath}: expected a mapping`);
  }
  return { root, relations: existing };
}

function scalarString(value: unknown): string | null {
  return isScalar(value) && typeof value.value === "string" ? value.value : null;
}

function relationsFromParts(
  parts: FrontmatterParts,
  relativePath: string,
): readonly NoteRelation[] {
  const { relations } = relationNodes(parts, relativePath, false);
  if (relations === null) return [];
  const output: NoteRelation[] = [];
  const seen = new Set<string>();
  for (const pair of relations.items) {
    const predicateValue = scalarString(pair.key);
    if (predicateValue === null) {
      throw new Error(`invalid relations in ${relativePath}: predicates must be strings`);
    }
    const predicate = exactPredicate(predicateValue);
    const scalarTarget = scalarString(pair.value);
    if (scalarTarget !== null) {
      const target = canonicalNoteId(scalarTarget);
      const key = `${predicate}\0${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({ predicate, target });
      }
      continue;
    }
    if (!isSeq(pair.value)) {
      throw new Error(
        `invalid relations in ${relativePath}: ${predicate} targets must be a string or array`,
      );
    }
    for (const item of pair.value.items) {
      const targetValue = scalarString(item);
      if (targetValue === null) {
        throw new Error(
          `invalid relations in ${relativePath}: ${predicate} targets must be strings`,
        );
      }
      const target = canonicalNoteId(targetValue);
      const key = `${predicate}\0${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ predicate, target });
    }
  }
  return output.toSorted((left, right) =>
    left.predicate.localeCompare(right.predicate)
    || left.target.localeCompare(right.target));
}

type RelationValue =
  | { readonly kind: "scalar"; readonly target: string }
  | { readonly kind: "sequence"; readonly sequence: YAMLSeq }
  | null;

function relationValue(
  relations: YAMLMap,
  predicate: string,
  relativePath: string,
): RelationValue {
  const value = relations.get(predicate, true);
  if (value === undefined) return null;
  const scalarTarget = scalarString(value);
  if (scalarTarget !== null) {
    return { kind: "scalar", target: canonicalNoteId(scalarTarget) };
  }
  if (!isSeq(value)) {
    throw new Error(
      `invalid relations in ${relativePath}: ${predicate} targets must be a string or array`,
    );
  }
  for (const item of value.items) {
    if (scalarString(item) === null) {
      throw new Error(
        `invalid relations in ${relativePath}: ${predicate} targets must be strings`,
      );
    }
  }
  return { kind: "sequence", sequence: value };
}

function renderFrontmatter(parts: FrontmatterParts): string {
  let yaml = parts.document.toString({ lineWidth: 0 });
  if (parts.newline === "\r\n") yaml = yaml.replaceAll("\n", "\r\n");
  if (!yaml.endsWith(parts.newline)) yaml += parts.newline;
  if (parts.hadFrontmatter) {
    return parts.openingDelimiter
      + parts.newline
      + yaml
      + parts.closingDelimiter
      + parts.bodySuffix;
  }
  return parts.openingDelimiter
    + parts.newline
    + yaml
    + parts.closingDelimiter
    + parts.newline
    + parts.bodySuffix;
}

function compareScalarNodes(left: unknown, right: unknown): number {
  return (scalarString(left) ?? "").localeCompare(scalarString(right) ?? "");
}

function addRelationToParts(
  parts: FrontmatterParts,
  relativePath: string,
  predicate: string,
  target: string,
): boolean {
  const { relations } = relationNodes(parts, relativePath, true);
  if (relations === null) throw new Error("YAML did not create relations");
  const existing = relationValue(relations, predicate, relativePath);
  if (existing === null) {
    const created = parts.document.createNode([target], { flow: true });
    if (!isSeq(created)) throw new Error("YAML did not create a relation sequence");
    relations.set(predicate, created);
    return true;
  }
  if (existing.kind === "scalar") {
    if (existing.target === target) return false;
    const created = parts.document.createNode(
      [existing.target, target].toSorted((left, right) => left.localeCompare(right)),
      { flow: true },
    );
    if (!isSeq(created)) throw new Error("YAML did not create a relation sequence");
    relations.set(predicate, created);
    return true;
  }
  const sequence = existing.sequence;
  if (sequence.items.some((item) => scalarString(item) === target)) return false;
  sequence.add(parts.document.createNode(target));
  sequence.items.sort(compareScalarNodes);
  return true;
}

function removeRelationFromParts(
  parts: FrontmatterParts,
  relativePath: string,
  predicate: string,
  target: string,
  sourceId: string,
): boolean {
  const { root, relations } = relationNodes(parts, relativePath, false);
  if (relations === null) return false;
  const value = relations.get(predicate, true);
  if (value === undefined) return false;

  const repairableTarget = (raw: string): string | null => {
    let candidate = raw;
    if (candidate.toLocaleLowerCase("en-US").endsWith(".md")) {
      candidate = candidate.slice(0, -3);
    }
    if (candidate.startsWith(".")) {
      candidate = posix.normalize(posix.join(posix.dirname(sourceId), candidate));
    }
    return isCanonicalNoteId(candidate) ? candidate : null;
  };
  const matches = (node: unknown): boolean => {
    const raw = scalarString(node);
    return raw !== null && repairableTarget(raw) === target;
  };

  if (!isSeq(value)) {
    if (!matches(value)) return false;
    relations.delete(predicate);
    if (relations.items.length === 0) root.delete("relations");
    return true;
  }
  const sequence = value;
  const retained = sequence.items.filter((item) => !matches(item));
  if (retained.length === sequence.items.length) return false;
  if (retained.length === 0) {
    relations.delete(predicate);
    if (relations.items.length === 0) root.delete("relations");
  } else {
    sequence.items = retained;
  }
  return true;
}

function dependenciesFor(
  overrides: Partial<AuthoringDependencies> | undefined,
): AuthoringDependencies {
  return {
    token: overrides?.token ?? randomUUID,
    ...(overrides?.beforeInstall === undefined
      ? {}
      : { beforeInstall: overrides.beforeInstall }),
    ...(overrides?.beforeCommit === undefined
      ? {}
      : { beforeCommit: overrides.beforeCommit }),
    ...(overrides?.afterSourceQuarantined === undefined
      ? {}
      : { afterSourceQuarantined: overrides.afterSourceQuarantined }),
  };
}

async function cleanupTemporary(
  temporaryPath: string,
  identity: { readonly device: bigint; readonly inode: bigint } | null,
): Promise<void> {
  if (identity === null) return;
  try {
    const current = await lstat(temporaryPath, { bigint: true });
    if (current.dev === identity.device && current.ino === identity.inode) {
      await unlink(temporaryPath);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface RecoveryLocation {
  readonly directory: string;
  readonly path: string;
  readonly relativePath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function recoveryRelativePath(vault: Vault, path: string): string {
  return relative(vault.root, path).split(sep).join("/");
}

async function discoveredRecoveryLocations(
  vault: Vault,
  notePath: string,
): Promise<{
  readonly recoverable: readonly RecoveryLocation[];
  readonly empty: readonly RecoveryLocation[];
}> {
  const directory = dirname(notePath);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_PARENT_DIRECTORY_ENTRIES) {
    throw new Error("the note parent has too many entries for bounded recovery");
  }
  const prefix = `.${basename(notePath)}.`;
  const suffix = ".recovery";
  const matching = entries
    .filter(({ name }) => name.startsWith(prefix) && name.endsWith(suffix))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (matching.length > MAX_RECOVERY_LOCATIONS_PER_NOTE) {
    const firstPath = join(directory, matching[0]?.name ?? "");
    throw new NoteRecoveryRequiredError(
      recoveryRelativePath(vault, notePath),
      recoveryRelativePath(vault, firstPath),
      new Error("too many interrupted authoring transactions require manual recovery"),
    );
  }
  const recoverable: RecoveryLocation[] = [];
  const empty: RecoveryLocation[] = [];
  for (const entry of matching) {
    const nonce = entry.name.slice(prefix.length, -suffix.length);
    const recoveryDirectory = join(directory, entry.name);
    const recoveryDirectoryRelative = recoveryRelativePath(vault, recoveryDirectory);
    if (
      !/^\d+\.[0-9a-f]{32}$/u.test(nonce)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      throw new NoteRecoveryRequiredError(
        recoveryRelativePath(vault, notePath),
        recoveryDirectoryRelative,
        new Error("an unrecognized authoring recovery artifact is present"),
      );
    }
    const metadata = await lstat(recoveryDirectory, { bigint: true });
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || await realpath(recoveryDirectory) !== recoveryDirectory
    ) {
      throw new NoteRecoveryRequiredError(
        recoveryRelativePath(vault, notePath),
        recoveryDirectoryRelative,
        new Error("an authoring recovery directory changed identity"),
      );
    }
    const children = await readdir(recoveryDirectory);
    if (children.length === 0) {
      empty.push({
        directory: recoveryDirectory,
        path: join(recoveryDirectory, basename(notePath)),
        relativePath: recoveryRelativePath(
          vault,
          join(recoveryDirectory, basename(notePath)),
        ),
        device: metadata.dev,
        inode: metadata.ino,
      });
      continue;
    }
    if (children.length !== 1 || children[0] !== basename(notePath)) {
      throw new NoteRecoveryRequiredError(
        recoveryRelativePath(vault, notePath),
        recoveryDirectoryRelative,
        new Error("an authoring recovery directory has unexpected contents"),
      );
    }
    const recoveryPath = join(recoveryDirectory, basename(notePath));
    try {
      await readSnapshotAtPath(
        vault,
        recoveryPath,
        recoveryRelativePath(vault, recoveryPath),
      );
    } catch (error) {
      throw new NoteRecoveryRequiredError(
        recoveryRelativePath(vault, notePath),
        recoveryRelativePath(vault, recoveryPath),
        error,
      );
    }
    recoverable.push({
      directory: recoveryDirectory,
      path: recoveryPath,
      relativePath: recoveryRelativePath(vault, recoveryPath),
      device: metadata.dev,
      inode: metadata.ino,
    });
  }
  return { recoverable, empty };
}

async function directoryIdentity(
  vault: Vault,
  notePath: string,
): Promise<DirectoryIdentity> {
  await assertSafeParent(vault, notePath);
  const metadata = await lstat(dirname(notePath), { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the note parent must remain a real directory");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertSameDirectory(
  vault: Vault,
  notePath: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await directoryIdentity(vault, notePath);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("the note parent changed during authoring");
  }
}

async function createRecoveryLocation(
  vault: Vault,
  path: string,
  dependencies: AuthoringDependencies,
): Promise<RecoveryLocation> {
  const directory = dirname(path);
  const recoveryDirectory = join(
    directory,
    `.${basename(path)}.${process.pid}.${sha256(dependencies.token()).slice(0, 32)}.recovery`,
  );
  await mkdir(recoveryDirectory, { mode: 0o700 });
  const metadata = await lstat(recoveryDirectory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the recovery location is not a private directory");
  }
  await fsyncDirectory(directory);
  const recoveryPath = join(recoveryDirectory, basename(path));
  return {
    directory: recoveryDirectory,
    path: recoveryPath,
    relativePath: relative(vault.root, recoveryPath).split(sep).join("/"),
    device: metadata.dev,
    inode: metadata.ino,
  };
}

async function assertRecoveryLocation(recovery: RecoveryLocation): Promise<void> {
  const metadata = await lstat(recovery.directory, { bigint: true });
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.dev !== recovery.device
    || metadata.ino !== recovery.inode
    || await realpath(recovery.directory) !== recovery.directory
  ) {
    throw new Error("the recovery location changed during authoring");
  }
}

async function removeRecoveryDirectory(
  recovery: RecoveryLocation,
  parentDirectory: string,
): Promise<void> {
  await rmdir(recovery.directory);
  await fsyncDirectory(parentDirectory);
}

function sameQuarantinedSnapshot(
  quarantined: NoteSnapshot,
  expected: NoteSnapshot,
): boolean {
  // A rename may update ctime on some supported filesystems. Identity, bytes,
  // mode, size, and mtime still prove that the entry moved was the snapshot
  // accepted by the optimistic read.
  return quarantined.device === expected.device
    && quarantined.inode === expected.inode
    && quarantined.size === expected.size
    && quarantined.modifiedAtNs === expected.modifiedAtNs
    && quarantined.mode === expected.mode
    && quarantined.revision === expected.revision;
}

async function restoreQuarantinedSource(
  vault: Vault,
  recovery: RecoveryLocation,
  path: string,
  expectedDirectory: DirectoryIdentity,
): Promise<boolean> {
  await assertSameDirectory(vault, path, expectedDirectory);
  await assertRecoveryLocation(recovery);
  try {
    // link(2) is the portable no-clobber primitive: unlike rename, it returns
    // EEXIST rather than replacing a writer that recreated the source path.
    await link(recovery.path, path);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await unlink(recovery.path);
  await fsyncDirectory(recovery.directory);
  await removeRecoveryDirectory(recovery, dirname(path));
  return true;
}

async function assertNoInterruptedRecovery(
  vault: Vault,
  id: string,
): Promise<void> {
  const { path, relativePath } = pathFor(vault, id);
  await assertSafeParent(vault, path);
  const artifacts = await discoveredRecoveryLocations(vault, path);
  const first = artifacts.recoverable[0] ?? artifacts.empty[0];
  if (first !== undefined) {
    throw new NoteRecoveryRequiredError(
      relativePath,
      first.relativePath,
      new Error("an interrupted authoring transaction requires a writer to recover it"),
    );
  }
}

async function recoverInterruptedAuthoring(
  vault: Vault,
  id: string,
  lock: NoteLock,
): Promise<void> {
  const { path, relativePath } = pathFor(vault, id);
  await lock.assertOwned();
  await assertSafeParent(vault, path);
  const artifacts = await discoveredRecoveryLocations(vault, path);
  for (const emptyRecovery of artifacts.empty) {
    await assertRecoveryLocation(emptyRecovery);
    await removeRecoveryDirectory(emptyRecovery, dirname(path));
  }
  const first = artifacts.recoverable[0];
  if (first === undefined) return;
  if (artifacts.recoverable.length !== 1) {
    throw new NoteRecoveryRequiredError(
      relativePath,
      first.relativePath,
      new Error("multiple interrupted authoring transactions require manual recovery"),
    );
  }

  const current = await readOptionalSnapshot(vault, id);
  if (current !== null) {
    throw new NoteRecoveryRequiredError(
      relativePath,
      first.relativePath,
      new Error("both the canonical note and displaced bytes exist"),
    );
  }
  const expectedDirectory = await directoryIdentity(vault, path);
  if (!await restoreQuarantinedSource(vault, first, path, expectedDirectory)) {
    throw new NoteRecoveryRequiredError(
      relativePath,
      first.relativePath,
      new Error("the canonical note was recreated during interrupted recovery"),
    );
  }
  await lock.assertOwned();
}

async function installTemporaryWithoutClobber(
  temporaryPath: string,
  path: string,
): Promise<boolean> {
  try {
    // The temporary file has already been fsync'd. Linking gives the final
    // name to that exact inode only if the name is still absent.
    await link(temporaryPath, path);
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await unlink(temporaryPath);
  return true;
}

async function currentRevisionOrNull(
  vault: Vault,
  id: string,
): Promise<NoteRevision | null> {
  try {
    return (await readOptionalSnapshot(vault, id))?.revision ?? null;
  } catch {
    // A raced directory, link, or non-UTF-8 file is still a conflict. Do not
    // inspect or mutate it further merely to improve an error field.
    return null;
  }
}

function withRecoveryPath(
  error: unknown,
  relativePath: string,
  recoveryPath: string,
): Error {
  if (error instanceof NoteRevisionConflictError) {
    return new NoteRevisionConflictError(
      error.path,
      error.expected,
      error.actual,
      recoveryPath,
    );
  }
  return new NoteRecoveryRequiredError(relativePath, recoveryPath, error);
}

async function atomicInstall(
  vault: Vault,
  id: string,
  content: string,
  expected: NoteSnapshot | null,
  lock: NoteLock,
  dependencies: AuthoringDependencies,
): Promise<NoteRevision> {
  const { path, relativePath } = pathFor(vault, id);
  await assertSafeParent(vault, path);
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_NOTE_BYTES) {
    throw new Error("the rendered note is too large for bounded authoring");
  }
  const directory = dirname(path);
  const expectedDirectory = await directoryIdentity(vault, path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${sha256(dependencies.token()).slice(0, 32)}.tmp`,
  );
  const mode = expected?.mode ?? 0o644;
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  let closed = false;
  let identity: { readonly device: bigint; readonly inode: bigint } | null = null;
  let recovery: RecoveryLocation | null = null;
  let sourceQuarantined = false;
  let destinationInstalled = false;
  try {
    const created = await handle.stat({ bigint: true });
    if (!created.isFile() || created.nlink !== 1n) {
      throw new Error("the temporary note target is not a private regular file");
    }
    identity = { device: created.dev, inode: created.ino };
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    const complete = await handle.stat({ bigint: true });
    if (
      !complete.isFile()
      || complete.nlink !== 1n
      || complete.dev !== identity.device
      || complete.ino !== identity.inode
    ) {
      throw new Error("the temporary note target changed before installation");
    }
    await handle.close();
    closed = true;

    await dependencies.beforeInstall?.({
      operation: expected === null ? "create" : "replace",
      path,
      temporaryPath,
    });
    await lock.assertOwned();
    const current = await readOptionalSnapshot(vault, id);
    if (
      (expected === null && current !== null)
      || (expected !== null && (current === null || !sameSnapshot(current, expected)))
    ) {
      throw new NoteRevisionConflictError(
        relativePath,
        expected?.revision ?? null,
        current?.revision ?? null,
      );
    }
    await assertSafeParent(vault, path);
    const temporary = await lstat(temporaryPath, { bigint: true });
    if (
      !temporary.isFile()
      || temporary.isSymbolicLink()
      || temporary.nlink !== 1n
      || temporary.dev !== identity.device
      || temporary.ino !== identity.inode
    ) {
      throw new Error("the temporary note target changed before installation");
    }

    if (expected === null) {
      const context: AuthoringInstallContext = {
        operation: "create",
        path,
        temporaryPath,
      };
      await dependencies.beforeCommit?.(context);
      await lock.assertOwned();
      await assertSameDirectory(vault, path, expectedDirectory);
      if (!await installTemporaryWithoutClobber(temporaryPath, path)) {
        throw new NoteRevisionConflictError(
          relativePath,
          null,
          await currentRevisionOrNull(vault, id),
        );
      }
      destinationInstalled = true;
      await fsyncDirectory(directory);
      return revisionFor(bytes);
    }

    recovery = await createRecoveryLocation(vault, path, dependencies);
    const context: Required<AuthoringInstallContext> = {
      operation: "replace",
      path,
      temporaryPath,
      recoveryPath: recovery.path,
    };
    await dependencies.beforeCommit?.(context);
    await lock.assertOwned();
    await assertSameDirectory(vault, path, expectedDirectory);
    await assertRecoveryLocation(recovery);
    try {
      // The recovery destination lives in a newly-created private directory,
      // so this rename cannot overwrite a pre-existing recovery artifact.
      await rename(path, recovery.path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new NoteRevisionConflictError(relativePath, expected.revision, null);
      }
      throw error;
    }
    sourceQuarantined = true;
    await Promise.all([
      fsyncDirectory(directory),
      fsyncDirectory(recovery.directory),
    ]);

    const quarantined = await readSnapshotAtPath(
      vault,
      recovery.path,
      recovery.relativePath,
    );
    if (!sameQuarantinedSnapshot(quarantined, expected)) {
      throw new NoteRevisionConflictError(
        relativePath,
        expected.revision,
        quarantined.revision,
      );
    }

    await dependencies.afterSourceQuarantined?.(context);
    await lock.assertOwned();
    await assertSameDirectory(vault, path, expectedDirectory);
    await assertRecoveryLocation(recovery);
    const stillQuarantined = await readSnapshotAtPath(
      vault,
      recovery.path,
      recovery.relativePath,
    );
    if (!sameQuarantinedSnapshot(stillQuarantined, expected)) {
      throw new NoteRevisionConflictError(
        relativePath,
        expected.revision,
        stillQuarantined.revision,
      );
    }
    if (!await installTemporaryWithoutClobber(temporaryPath, path)) {
      throw new NoteRevisionConflictError(
        relativePath,
        expected.revision,
        await currentRevisionOrNull(vault, id),
      );
    }
    destinationInstalled = true;
    await fsyncDirectory(directory);

    await unlink(recovery.path);
    sourceQuarantined = false;
    await fsyncDirectory(recovery.directory);
    await removeRecoveryDirectory(recovery, directory);
    recovery = null;
    await fsyncDirectory(directory);
    return revisionFor(bytes);
  } catch (error) {
    if (recovery !== null && sourceQuarantined && !destinationInstalled) {
      let restored = false;
      try {
        restored = await restoreQuarantinedSource(
          vault,
          recovery,
          path,
          expectedDirectory,
        );
      } catch (restoreError) {
        throw withRecoveryPath(
          new AggregateError(
            [error, restoreError],
            "authoring failed and the prior source could not be restored",
          ),
          relativePath,
          recovery.relativePath,
        );
      }
      if (restored) {
        sourceQuarantined = false;
        recovery = null;
      }
    }
    if (recovery !== null && sourceQuarantined) {
      throw withRecoveryPath(error, relativePath, recovery.relativePath);
    }
    if (recovery !== null) {
      try {
        await removeRecoveryDirectory(recovery, directory);
        recovery = null;
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) {
          throw new AggregateError(
            [error, cleanupError],
            "authoring failed and its empty recovery directory could not be removed",
          );
        }
      }
    }
    throw error;
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    // Once linked, the final destination is independent of this name. This
    // identity-checked cleanup is therefore safe on success and on failure.
    await cleanupTemporary(temporaryPath, identity);
  }
}

function checkedExpectedRevision(options: AuthoringOptions): NoteRevision | undefined {
  return options.expectedRevision === undefined
    ? undefined
    : requireRevision(options.expectedRevision);
}

function assertExpected(
  snapshot: NoteSnapshot,
  expected: NoteRevision | undefined,
): void {
  if (expected !== undefined && snapshot.revision !== expected) {
    throw new NoteRevisionConflictError(
      snapshot.relativePath,
      expected,
      snapshot.revision,
    );
  }
}

function noteResult(
  snapshot: Pick<NoteSnapshot, "relativePath" | "revision">,
  relations: readonly NoteRelation[],
  changed: boolean,
): NoteAuthoringResult {
  return {
    changed,
    path: snapshot.relativePath,
    revision: snapshot.revision,
    relations,
  };
}

function validateTitle(title: string): string {
  if (
    title === ""
    || title !== title.trim()
    || title.includes("\n")
    || title.includes("\r")
    || title.length > 512
  ) {
    throw new TypeError("a note title must be a non-empty single line");
  }
  return title;
}

function validateType(type: string): string {
  const canonical = normalizeRelationPredicate(type);
  if (canonical !== type) throw new TypeError("a note type must be canonical kebab-case");
  return type;
}

function validateTags(tags: readonly string[] | undefined): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of tags ?? []) {
    const tag = candidate.trim().replace(/^#+/u, "").normalize("NFC");
    if (
      tag === ""
      || tag.includes("\n")
      || tag.includes("\r")
      || tag.length > 128
    ) {
      throw new TypeError(`not a valid note tag: ${JSON.stringify(candidate)}`);
    }
    const folded = tag.toLocaleLowerCase("en-US");
    if (seen.has(folded)) continue;
    seen.add(folded);
    result.push(tag);
  }
  return result;
}

function normalizedRequestedBody(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

function renderCreatedNote(input: CreateNoteInput): string {
  const title = validateTitle(input.title);
  const type = validateType(input.type);
  const tags = validateTags(input.tags);
  const metadata: Record<string, unknown> = { type, title };
  if (tags.length > 0) metadata["tags"] = tags;
  const document = new Document(metadata, { schema: "core" });
  const body = normalizedRequestedBody(input.body ?? `# ${title}\n`);
  return `---\n${document.toString({ lineWidth: 0 })}---\n\n${body}`;
}

function topLevelScalar(
  parts: FrontmatterParts,
  key: string,
): string | null {
  if (!isMap(parts.document.contents)) return null;
  return scalarString(parts.document.contents.get(key, true));
}

function topLevelStrings(
  parts: FrontmatterParts,
  key: string,
): readonly string[] {
  if (!isMap(parts.document.contents)) return [];
  const value = parts.document.contents.get(key, true);
  if (value === undefined) return [];
  if (isScalar(value) && typeof value.value === "string") return [value.value];
  if (!isSeq(value)) return [];
  return value.items.flatMap((item) => {
    const candidate = scalarString(item);
    return candidate === null ? [] : [candidate];
  });
}

function assertCompatibleCreate(
  snapshot: NoteSnapshot,
  input: CreateNoteInput,
): readonly NoteRelation[] {
  const parts = frontmatter(snapshot.content, snapshot.relativePath);
  const requestedType = validateType(input.type);
  const requestedTitle = validateTitle(input.title);
  if (topLevelScalar(parts, "type") !== requestedType) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "type differs");
  }
  if (topLevelScalar(parts, "title") !== requestedTitle) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "title differs");
  }
  const presentTags = new Set(
    topLevelStrings(parts, "tags").map((tag) => tag.toLocaleLowerCase("en-US")),
  );
  const missingTag = validateTags(input.tags)
    .find((tag) => !presentTags.has(tag.toLocaleLowerCase("en-US")));
  if (missingTag !== undefined) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, `tag is missing: ${missingTag}`);
  }
  if (
    input.body !== undefined
    && parts.bodySuffix !== `${parts.newline}${parts.newline}${normalizedRequestedBody(input.body)}`
  ) {
    throw new NoteAlreadyExistsError(snapshot.relativePath, "body differs");
  }
  return relationsFromParts(parts, snapshot.relativePath);
}

/**
 * Read the content revision used by optimistic authoring operations.
 *
 * Revisions intentionally describe UTF-8 bytes, while installation also
 * checks inode and timestamps to detect same-content replacement races.
 */
export async function noteRevision(
  root: string,
  id: string,
): Promise<NoteRevision> {
  const vault = await resolveVault(root);
  const canonicalId = canonicalNoteId(id);
  await assertNoInterruptedRecovery(vault, canonicalId);
  return (await readSnapshot(vault, canonicalId)).revision;
}

/** List exact outbound relation declarations without taking an authoring lock. */
export async function listNoteRelations(
  root: string,
  sourceId: string,
): Promise<readonly NoteRelation[]> {
  const vault = await resolveVault(root);
  const canonicalId = canonicalNoteId(sourceId);
  await assertNoInterruptedRecovery(vault, canonicalId);
  const source = await readSnapshot(vault, canonicalId);
  return relationsFromParts(
    frontmatter(source.content, source.relativePath),
    source.relativePath,
  );
}

/**
 * Create one ordinary Markdown note. Existing compatible notes are an
 * idempotent success and are never rewritten.
 *
 * Parent directories must already exist as real in-vault directories. This
 * keeps the operation's durable write set to exactly one note.
 */
export async function createNote(
  root: string,
  input: CreateNoteInput,
  options: AuthoringOptions = {},
): Promise<NoteAuthoringResult> {
  const vault = await resolveVault(root);
  const id = canonicalNoteId(input.id);
  const expected = checkedExpectedRevision(options);
  const dependencies = dependenciesFor(options.dependencies);
  const lock = await acquireNoteLock(vault.root, id, options.lock);
  try {
    await recoverInterruptedAuthoring(vault, id, lock);
    const existing = await readOptionalSnapshot(vault, id);
    if (existing !== null) {
      assertExpected(existing, expected);
      const relations = assertCompatibleCreate(existing, input);
      return noteResult(existing, relations, false);
    }
    if (expected !== undefined) {
      throw new NoteRevisionConflictError(`${id}.md`, expected, null);
    }
    const content = renderCreatedNote(input);
    const revision = await atomicInstall(
      vault,
      id,
      content,
      null,
      lock,
      dependencies,
    );
    return {
      changed: true,
      path: `${id}.md`,
      revision,
      relations: [],
    };
  } finally {
    await lock.release();
  }
}

/** Create an ordinary `type: concept` Markdown note. */
export async function createConceptNote(
  root: string,
  input: CreateConceptNoteInput,
  options: AuthoringOptions = {},
): Promise<NoteAuthoringResult> {
  return createNote(root, { ...input, type: "concept" }, options);
}

async function editNoteRelation(
  operation: "add" | "remove",
  root: string,
  sourceIdInput: string,
  predicateInput: string,
  targetIdInput: string,
  options: AuthoringOptions,
): Promise<NoteAuthoringResult> {
  const vault = await resolveVault(root);
  const sourceId = canonicalNoteId(sourceIdInput);
  const targetId = canonicalNoteId(targetIdInput);
  const predicate = normalizeRelationPredicate(predicateInput);
  const expected = checkedExpectedRevision(options);
  const dependencies = dependenciesFor(options.dependencies);
  const lock = await acquireNoteLock(vault.root, sourceId, options.lock);
  try {
    await recoverInterruptedAuthoring(vault, sourceId, lock);
    const source = await readSnapshot(vault, sourceId);
    assertExpected(source, expected);
    if (operation === "add" && targetId !== sourceId) {
      // Adds require a live exact target. Removes intentionally do not so a
      // dangling authored assertion can still be repaired after a rename.
      await readSnapshot(vault, targetId);
    }
    const parts = frontmatter(source.content, source.relativePath);
    // Adds must never preserve malformed assertions. Removes are also the
    // repair path for deterministic legacy spellings such as ./target.md.
    if (operation === "add") relationsFromParts(parts, source.relativePath);
    const changed = operation === "add"
      ? addRelationToParts(parts, source.relativePath, predicate, targetId)
      : removeRelationFromParts(
        parts,
        source.relativePath,
        predicate,
        targetId,
        sourceId,
      );
    if (!changed) {
      return noteResult(
        source,
        relationsFromParts(parts, source.relativePath),
        false,
      );
    }

    const content = renderFrontmatter(parts);
    const relations = relationsFromParts(
      frontmatter(content, source.relativePath),
      source.relativePath,
    );
    const revision = await atomicInstall(
      vault,
      sourceId,
      content,
      source,
      lock,
      dependencies,
    );
    return {
      changed: true,
      path: source.relativePath,
      revision,
      relations,
    };
  } finally {
    await lock.release();
  }
}

/** Add one exact outbound typed relation, idempotently. */
export async function addNoteRelation(
  root: string,
  sourceId: string,
  predicate: string,
  targetId: string,
  options: AuthoringOptions = {},
): Promise<NoteAuthoringResult> {
  return editNoteRelation("add", root, sourceId, predicate, targetId, options);
}

/** Remove one exact outbound typed relation, idempotently. */
export async function removeNoteRelation(
  root: string,
  sourceId: string,
  predicate: string,
  targetId: string,
  options: AuthoringOptions = {},
): Promise<NoteAuthoringResult> {
  return editNoteRelation("remove", root, sourceId, predicate, targetId, options);
}
