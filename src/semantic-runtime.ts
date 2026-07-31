import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Note } from "./graph.js";
import {
  MAX_NOTE_UTF8_BYTES,
  MAX_SCANNED_NOTES,
  MAX_VAULT_UTF8_BYTES,
  VaultScanBudgetError,
} from "./vault.js";

const LEASE_VERSION = 1;
const PROJECTION_VERSION = 2;
const DEFAULT_LEASE_WAIT_MS = 30_000;
const DEFAULT_LEASE_POLL_MS = 25;
const MAX_LEASE_WAIT_MS = 10 * 60_000;
const MAX_LEASE_POLL_MS = 1_000;
const GENERATION_PREFIX = "generation-";
const READER_PREFIX = ".reader-";
const MANIFEST_NAME = "manifest.json";
const OWNER_NAME = "owner.json";
const SNAPSHOT_OWNER_NAME = ".hraness-kb-semantic-cache.json";
const SNAPSHOT_OWNER_VERSION = 1;
const SNAPSHOT_OWNER_KIND = "@hraness/kb/semantic-projection-cache";
const MAX_OWNER_BYTES = 4 * 1_024;
const MAX_MANIFEST_BYTES = 64 * 1_024 * 1_024;
const MAX_CACHE_DIRECTORY_ENTRIES = 1_024;
const MAX_INDEX_IDENTITY_BYTES = 16 * 1_024;
const MAX_INDEX_IDENTITY_STRING_BYTES = 4 * 1_024;
const MAX_INDEX_IDENTITY_ENTRIES = 64;

type LeaseOwner = {
  readonly version: typeof LEASE_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
};

type SnapshotCacheOwner = {
  readonly version: typeof SNAPSHOT_OWNER_VERSION;
  readonly kind: typeof SNAPSHOT_OWNER_KIND;
  readonly databaseIdentity: string;
};

export type SemanticWriterLeaseOptions = {
  readonly waitMs?: number;
  readonly pollMs?: number;
};

export type SemanticGenerationWriterLeaseOptions = SemanticWriterLeaseOptions & {
  /** Wait for every reader, including readers of this generation, before mutating. */
  readonly excludeReaders?: boolean;
};

export type SemanticWriterLease = {
  /** Idempotently release this process-owned database lease. */
  readonly release: () => Promise<void>;
};

/** Everything that determines whether two processes may safely share one semantic index. */
export type SemanticIndexIdentity = {
  readonly producer: {
    readonly package: string;
    readonly schema: number;
  };
  readonly indexer: {
    readonly package: string;
    readonly version: string;
  };
  readonly collection: {
    readonly name: string;
    readonly pattern: string;
    readonly ignore: readonly string[];
    readonly globalContext: string;
    readonly pathContexts: readonly {
      readonly path: string;
      readonly context: string;
    }[];
  };
  readonly embedding: {
    readonly model: string;
    readonly chunkStrategy: string;
  };
};

export type SemanticProjectionManifest = {
  readonly version: typeof PROJECTION_VERSION;
  readonly indexIdentity: SemanticIndexIdentity;
  readonly root: string;
  readonly generation: string;
  readonly notes: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly totalBytes: number;
};

export type SemanticProjection = {
  readonly root: string;
  readonly manifest: SemanticProjectionManifest;
  /** Release the generation reference after the QMD store no longer needs it. */
  readonly release: () => Promise<void>;
};

export type SemanticProjectionDescription = {
  readonly database: string;
  readonly snapshotDirectory: string;
  readonly generationPath: string;
  readonly manifest: SemanticProjectionManifest;
  readonly manifestText: string;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function checkedLeaseBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedIdentityString(value: string, label: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value === "" || bytes > MAX_INDEX_IDENTITY_STRING_BYTES) {
    throw new RangeError(
      `${label} must contain from 1 through ${MAX_INDEX_IDENTITY_STRING_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
    );
  }
  return value;
}

function validatedIndexIdentity(identity: SemanticIndexIdentity): SemanticIndexIdentity {
  if (!Number.isSafeInteger(identity.producer.schema) || identity.producer.schema < 1) {
    throw new RangeError("Semantic index producer schema must be a positive safe integer.");
  }
  if (identity.collection.ignore.length > MAX_INDEX_IDENTITY_ENTRIES
    || identity.collection.pathContexts.length > MAX_INDEX_IDENTITY_ENTRIES) {
    throw new RangeError(
      `Semantic index identity collections are limited to ${MAX_INDEX_IDENTITY_ENTRIES} entries.`,
    );
  }
  const validated: SemanticIndexIdentity = {
    producer: {
      package: checkedIdentityString(
        identity.producer.package,
        "Semantic index producer package",
      ),
      schema: identity.producer.schema,
    },
    indexer: {
      package: checkedIdentityString(identity.indexer.package, "Semantic indexer package"),
      version: checkedIdentityString(identity.indexer.version, "Semantic indexer version"),
    },
    collection: {
      name: checkedIdentityString(identity.collection.name, "Semantic collection name"),
      pattern: checkedIdentityString(identity.collection.pattern, "Semantic collection pattern"),
      ignore: identity.collection.ignore.map((pattern) =>
        checkedIdentityString(pattern, "Semantic collection ignore pattern")),
      globalContext: checkedIdentityString(
        identity.collection.globalContext,
        "Semantic collection global context",
      ),
      pathContexts: identity.collection.pathContexts.map((entry) => ({
        path: checkedIdentityString(entry.path, "Semantic collection context path"),
        context: checkedIdentityString(entry.context, "Semantic collection path context"),
      })),
    },
    embedding: {
      model: checkedIdentityString(identity.embedding.model, "Semantic embedding model"),
      chunkStrategy: checkedIdentityString(
        identity.embedding.chunkStrategy,
        "Semantic embedding chunk strategy",
      ),
    },
  };
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_INDEX_IDENTITY_BYTES) {
    throw new RangeError(
      `Semantic index identity exceeds the ${MAX_INDEX_IDENTITY_BYTES.toLocaleString("en-US")}-byte limit.`,
    );
  }
  return validated;
}

async function boundedMetadataText(path: string, maximum: number, label: string): Promise<string> {
  const pathBefore = await lstat(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1n) {
    throw new Error(`${label} must be a regular, singly linked file.`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.nlink !== 1n
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino) {
      throw new Error(`${label} must be a regular, singly linked file.`);
    }
    if (before.size > BigInt(maximum)) {
      throw new RangeError(
        `${label} exceeds the ${maximum.toLocaleString("en-US")}-byte metadata limit.`,
      );
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const remaining = maximum - bytes;
      const buffer = new Uint8Array(Math.min(64 * 1_024, remaining + 1));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > maximum) {
        throw new RangeError(
          `${label} exceeds the ${maximum.toLocaleString("en-US")}-byte metadata limit.`,
        );
      }
      chunks.push(buffer.slice(0, result.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = await lstat(path, { bigint: true });
    } catch {
      throw new Error(`${label} changed while it was being read; retry.`);
    }
    if (!after.isFile()
      || after.nlink !== 1n
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== BigInt(bytes)
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino) {
      throw new Error(`${label} changed while it was being read; retry.`);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } finally {
    await handle.close();
  }
}

async function safeDirectory(path: string, label: string): Promise<"absent" | "directory"> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
    if (!metadata.isDirectory()) throw new Error(`${label} must be a directory.`);
    return "directory";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "absent";
    throw error;
  }
}

async function canonicalProspectiveDirectory(path: string): Promise<string> {
  const missing: string[] = [];
  let candidate = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(candidate), ...missing.toReversed());
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function validateSemanticDatabaseFile(path: string): Promise<void> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("Semantic database must not be a symbolic link.");
  }
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    throw new Error("Semantic database must be a regular, singly linked file.");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile()
      || current.nlink !== 1n
      || current.dev !== metadata.dev
      || current.ino !== metadata.ino) {
      throw new Error("Semantic database must be a regular, singly linked file.");
    }
  } finally {
    await handle.close();
  }
}

async function canonicalSemanticDatabasePath(database: string): Promise<string> {
  const requested = resolve(database);
  const canonicalParent = await canonicalProspectiveDirectory(dirname(requested));
  const canonical = join(canonicalParent, basename(requested));
  await validateSemanticDatabaseFile(canonical);
  try {
    return await realpath(canonical);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return canonical;
    throw error;
  }
}

async function settledSemanticDatabasePath(database: string): Promise<string> {
  const canonical = await canonicalSemanticDatabasePath(database);
  await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
  const settledParent = await realpath(dirname(canonical));
  if (settledParent !== dirname(canonical)) {
    throw new Error("Semantic database parent changed while settling its identity; retry.");
  }
  let created: FileHandle | undefined;
  try {
    created = await open(
      canonical,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    await created?.close();
  }
  await validateSemanticDatabaseFile(canonical);
  return await realpath(canonical);
}

function pathIsWithin(root: string, candidate: string): boolean {
  return candidate === root || confinedPath(root, candidate);
}

function assertSemanticCacheOutsideVault(root: string, database: string): void {
  const ownedPaths = [
    database,
    `${database}.writer-lease`,
    `${database}.snapshot`,
  ];
  if (ownedPaths.some((path) => pathIsWithin(root, path) || pathIsWithin(path, root))) {
    throw new Error(
      "Semantic database, lease, and snapshot paths must not overlap the vault root.",
    );
  }
}

/** Resolve a database identity without writing and reject cache paths inside the vault. */
export async function resolveSemanticDatabase(
  database: string,
  root: string,
): Promise<string> {
  const [canonicalDatabase, canonicalRoot] = await Promise.all([
    canonicalSemanticDatabasePath(database),
    realpath(root),
  ]);
  assertSemanticCacheOutsideVault(canonicalRoot, canonicalDatabase);
  return canonicalDatabase;
}

function parsedOwner(value: unknown): LeaseOwner | null {
  if (!isRecord(value)
    || value.version !== LEASE_VERSION
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.token !== "string"
    || value.token.length < 16
    || value.token.length > 128
    || typeof value.acquiredAt !== "string") {
    return null;
  }
  return {
    version: LEASE_VERSION,
    pid: value.pid as number,
    token: value.token,
    acquiredAt: value.acquiredAt,
  };
}

async function readOwner(path: string): Promise<LeaseOwner | null> {
  try {
    return parsedOwner(JSON.parse(
      await boundedMetadataText(join(path, OWNER_NAME), MAX_OWNER_BYTES, "Semantic lease owner"),
    ) as unknown);
  } catch (error: unknown) {
    if (error instanceof RangeError) throw error;
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

async function recoverDeadLease(path: string): Promise<boolean> {
  if (await safeDirectory(path, "Semantic writer lease") === "absent") return false;
  const owner = await readOwner(path);
  if (owner === null || processIsAlive(owner.pid)) return false;
  const confirmed = await readOwner(path);
  if (confirmed?.pid !== owner.pid || confirmed.token !== owner.token) return false;
  const tombstone = `${path}.dead-${owner.token}-${randomUUID()}`;
  try {
    await rename(path, tombstone);
  } catch (error: unknown) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) return false;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
  return true;
}

async function acquireWriterLeaseState(
  database: string,
  options: SemanticWriterLeaseOptions,
): Promise<{
  readonly path: string;
  readonly owner: LeaseOwner;
  readonly database: string;
}> {
  const waitMs = checkedLeaseBound(
    options.waitMs,
    DEFAULT_LEASE_WAIT_MS,
    MAX_LEASE_WAIT_MS,
    "Semantic writer lease wait",
  );
  const pollMs = checkedLeaseBound(
    options.pollMs,
    DEFAULT_LEASE_POLL_MS,
    MAX_LEASE_POLL_MS,
    "Semantic writer lease poll interval",
  );
  const canonicalDatabase = await settledSemanticDatabasePath(database);
  const path = `${canonicalDatabase}.writer-lease`;
  const owner: LeaseOwner = {
    version: LEASE_VERSION,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const startedAt = Date.now();
  for (;;) {
    await safeDirectory(path, "Semantic writer lease");
    const claim = `${path}.claim-${process.pid}-${owner.token}`;
    await mkdir(claim, { mode: 0o700 });
    try {
      await writeFile(join(claim, OWNER_NAME), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        await rename(claim, path);
        const lease = { path, owner, database: canonicalDatabase };
        try {
          await validateSemanticDatabaseFile(canonicalDatabase);
          return lease;
        } catch (error: unknown) {
          await releaseWriterLease(lease);
          throw error;
        }
      } catch (error: unknown) {
        if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
      }
    } finally {
      await rm(claim, { recursive: true, force: true });
    }
    if (await recoverDeadLease(path)) continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= waitMs) {
      throw new Error(
        `Timed out after ${waitMs}ms waiting for the semantic writer lease for ${JSON.stringify(resolve(database))}.`,
      );
    }
    await Bun.sleep(Math.min(pollMs, waitMs - elapsed));
  }
}

async function releaseWriterLease(
  lease: { readonly path: string; readonly owner: LeaseOwner },
): Promise<void> {
  if (await safeDirectory(lease.path, "Semantic writer lease") === "absent") return;
  const current = await readOwner(lease.path);
  if (current?.pid !== lease.owner.pid || current.token !== lease.owner.token) return;
  const tombstone = `${lease.path}.release-${lease.owner.token}`;
  try {
    await rename(lease.path, tombstone);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
}

/** Serialize QMD database mutations across processes with dead-owner recovery. */
export async function acquireSemanticWriterLease(
  database: string,
  options: SemanticWriterLeaseOptions = {},
): Promise<SemanticWriterLease> {
  const lease = await acquireWriterLeaseState(database, options);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await releaseWriterLease(lease);
    },
  };
}

/** Run one bounded operation while owning a database-scoped writer lease. */
export async function withSemanticWriterLease<Value>(
  database: string,
  operation: () => Promise<Value>,
  options: SemanticWriterLeaseOptions = {},
): Promise<Value> {
  const lease = await acquireSemanticWriterLease(database, options);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export function semanticWriterLeasePath(database: string): string {
  return `${resolve(database)}.writer-lease`;
}

function confinedPath(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate !== ""
    && candidate !== ".."
    && !candidate.startsWith(`..${sep}`)
    && !isAbsolute(candidate);
}

function validatedProjectionNotes(notes: readonly Note[]): {
  readonly notes: SemanticProjectionManifest["notes"];
  readonly totalBytes: number;
} {
  if (notes.length > MAX_SCANNED_NOTES) {
    throw new VaultScanBudgetError(
      "notes",
      MAX_SCANNED_NOTES,
      `Vault scan exceeds the ${MAX_SCANNED_NOTES} Markdown note limit.`,
    );
  }
  const paths = new Set<string>();
  const validated: SemanticProjectionManifest["notes"][number][] = [];
  let totalBytes = 0;
  for (const note of notes) {
    const path = note.path;
    const segments = path.split("/");
    if (path === ""
      || isAbsolute(path)
      || path.includes("\\")
      || !path.endsWith(".md")
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Semantic projection note path ${JSON.stringify(path)} is invalid.`);
    }
    if (paths.has(path)) {
      throw new Error(`Semantic projection note path ${JSON.stringify(path)} is duplicated.`);
    }
    paths.add(path);
    const bytes = Buffer.byteLength(note.content, "utf8");
    if (bytes > MAX_NOTE_UTF8_BYTES) {
      throw new VaultScanBudgetError(
        "note-bytes",
        MAX_NOTE_UTF8_BYTES,
        `Vault note ${JSON.stringify(path)} exceeds the ${MAX_NOTE_UTF8_BYTES}-byte UTF-8 limit.`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_VAULT_UTF8_BYTES) {
      throw new VaultScanBudgetError(
        "total-bytes",
        MAX_VAULT_UTF8_BYTES,
        `Vault scan exceeds the ${MAX_VAULT_UTF8_BYTES}-byte cumulative UTF-8 limit.`,
      );
    }
    validated.push({
      path,
      sha256: createHash("sha256").update(note.content).digest("hex"),
      bytes,
    });
  }
  return { notes: validated, totalBytes };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function snapshotCacheOwner(database: string): SnapshotCacheOwner {
  return {
    version: SNAPSHOT_OWNER_VERSION,
    kind: SNAPSHOT_OWNER_KIND,
    databaseIdentity: resolve(database),
  };
}

async function assertOwnedSnapshotCache(
  database: string,
  snapshotDirectory: string,
): Promise<"absent" | "owned"> {
  if (await safeDirectory(snapshotDirectory, "Semantic snapshot cache") === "absent") {
    return "absent";
  }
  const expected = snapshotCacheOwner(database);
  let actual: unknown;
  try {
    actual = JSON.parse(await boundedMetadataText(
      join(snapshotDirectory, SNAPSHOT_OWNER_NAME),
      MAX_OWNER_BYTES,
      "Semantic snapshot cache owner",
    )) as unknown;
  } catch {
    throw new Error(
      `Semantic snapshot cache ${JSON.stringify(snapshotDirectory)} is unowned or has an incompatible ownership marker; remove this disposable directory explicitly before retrying.`,
    );
  }
  if (!isRecord(actual)
    || actual.version !== expected.version
    || actual.kind !== expected.kind
    || actual.databaseIdentity !== expected.databaseIdentity) {
    throw new Error(
      `Semantic snapshot cache ${JSON.stringify(snapshotDirectory)} is unowned or has an incompatible ownership marker; remove this disposable directory explicitly before retrying.`,
    );
  }
  return "owned";
}

async function ensureOwnedSnapshotCache(
  database: string,
  snapshotDirectory: string,
): Promise<void> {
  if (await assertOwnedSnapshotCache(database, snapshotDirectory) === "owned") return;
  const temporary = `${snapshotDirectory}.initialize-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(
      join(temporary, SNAPSHOT_OWNER_NAME),
      `${JSON.stringify(snapshotCacheOwner(database))}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    try {
      await rename(temporary, snapshotDirectory);
      return;
    } catch (error: unknown) {
      if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await assertOwnedSnapshotCache(database, snapshotDirectory);
}

async function existingGenerationMatches(
  generationPath: string,
  manifest: SemanticProjectionManifest,
  manifestText: string,
): Promise<boolean> {
  try {
    if (await safeDirectory(generationPath, "Semantic projection generation") === "absent") {
      return false;
    }
    if (await boundedMetadataText(
      join(generationPath, MANIFEST_NAME),
      MAX_MANIFEST_BYTES,
      "Semantic projection manifest",
    ) !== manifestText) {
      return false;
    }
    for (const entry of manifest.notes) {
      const path = resolve(generationPath, ...entry.path.split("/"));
      if (!confinedPath(generationPath, path)) return false;
      const content = await boundedMetadataText(
        path,
        MAX_NOTE_UTF8_BYTES,
        `Semantic projection note ${JSON.stringify(entry.path)}`,
      );
      if (Buffer.byteLength(content, "utf8") !== entry.bytes
        || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
        return false;
      }
    }

    const expectedNotes = new Set(manifest.notes.map(({ path }) => join(...path.split("/"))));
    const expectedDirectories = new Set<string>();
    for (const path of expectedNotes) {
      let parent = dirname(path);
      while (parent !== ".") {
        expectedDirectories.add(parent);
        parent = dirname(parent);
      }
    }
    const pending = [generationPath];
    let entries = 0;
    const maximumEntries = manifest.notes.length
      + expectedDirectories.size
      + MAX_CACHE_DIRECTORY_ENTRIES
      + 1;
    while (pending.length > 0) {
      const directoryPath = pending.pop();
      if (directoryPath === undefined) break;
      const directory = await opendir(directoryPath);
      try {
        for await (const entry of directory) {
          entries += 1;
          if (entries > maximumEntries || entry.isSymbolicLink()) return false;
          const absolute = join(directoryPath, entry.name);
          const path = relative(generationPath, absolute);
          if (entry.isDirectory()) {
            if (!expectedDirectories.has(path)) return false;
            pending.push(absolute);
            continue;
          }
          if (!entry.isFile()) return false;
          if (path === MANIFEST_NAME || expectedNotes.has(path)) continue;
          if (dirname(path) === "."
            && entry.name.startsWith(READER_PREFIX)
            && entry.name.endsWith(".json")) {
            continue;
          }
          return false;
        }
      } finally {
        try {
          await directory.close();
        } catch {
          // Async iteration closes the directory after exhaustion.
        }
      }
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError || (error instanceof Error && error.message.includes("symbolic link"))) {
      throw error;
    }
    return false;
  }
}

async function materializeGeneration(
  snapshotDirectory: string,
  generationPath: string,
  manifest: SemanticProjectionManifest,
  manifestText: string,
  notesByPath: ReadonlyMap<string, Note>,
): Promise<void> {
  if (await existingGenerationMatches(generationPath, manifest, manifestText)) return;
  if (await safeDirectory(generationPath, "Semantic projection generation") === "directory") {
    if (await activeGenerationReaders(generationPath) > 0) {
      throw new Error(
        "Semantic projection cache verification failed while this generation still has active readers; close those sessions and retry the repair.",
      );
    }
    await rm(generationPath, { recursive: true, force: true });
  }
  const temporary = join(
    snapshotDirectory,
    `.temporary-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const entry of manifest.notes) {
      const note = notesByPath.get(entry.path);
      if (note === undefined) {
        throw new Error(`Semantic projection lost note ${JSON.stringify(entry.path)}.`);
      }
      const bytes = Buffer.byteLength(note.content, "utf8");
      const sha256 = createHash("sha256").update(note.content).digest("hex");
      if (bytes !== entry.bytes || sha256 !== entry.sha256) {
        throw new Error(
          `Semantic projection note ${JSON.stringify(entry.path)} changed after validation.`,
        );
      }
      const destination = resolve(temporary, ...entry.path.split("/"));
      if (!confinedPath(temporary, destination)) {
        throw new Error(`Semantic projection path ${JSON.stringify(entry.path)} escapes its generation.`);
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, note.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    await atomicWrite(join(temporary, MANIFEST_NAME), manifestText);
    await rename(temporary, generationPath);
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readerOwnerName(owner: LeaseOwner): string {
  return `${READER_PREFIX}${owner.pid}-${owner.token}.json`;
}

async function activeGenerationReaders(generation: string): Promise<number> {
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(generation);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  let active = 0;
  let readerEntries = 0;
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.startsWith(READER_PREFIX) || !entry.name.endsWith(".json")) {
        continue;
      }
      readerEntries += 1;
      if (readerEntries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic projection generation has too many reader entries.");
      }
      const path = join(generation, entry.name);
      let owner: LeaseOwner | null;
      try {
        owner = parsedOwner(JSON.parse(
          await boundedMetadataText(path, MAX_OWNER_BYTES, "Semantic projection reader"),
        ) as unknown);
      } catch (error: unknown) {
        if (error instanceof RangeError) throw error;
        owner = null;
      }
      if (owner !== null && processIsAlive(owner.pid)) {
        active += 1;
      } else {
        await rm(path, { force: true });
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // Async iteration closes the directory after exhaustion.
    }
  }
  return active;
}

async function activeReaderGenerations(database: string): Promise<ReadonlySet<string>> {
  const canonicalDatabase = await canonicalSemanticDatabasePath(database);
  const snapshotDirectory = `${canonicalDatabase}.snapshot`;
  if (await assertOwnedSnapshotCache(canonicalDatabase, snapshotDirectory) === "absent") {
    return new Set();
  }
  const active = new Set<string>();
  const directory = await opendir(snapshotDirectory);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic snapshot cache has too many metadata entries.");
      }
      if (!entry.isDirectory() || !entry.name.startsWith(GENERATION_PREFIX)) continue;
      if (await activeGenerationReaders(join(snapshotDirectory, entry.name)) > 0) {
        active.add(entry.name);
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // Async iteration closes the directory after exhaustion.
    }
  }
  return active;
}

/**
 * Serialize one QMD mutation while allowing readers of the same immutable
 * projection generation. A generation switch waits until older readers close.
 */
export async function withSemanticGenerationWriterLease<Value>(
  database: string,
  generation: string,
  operation: () => Promise<Value>,
  options: SemanticGenerationWriterLeaseOptions = {},
): Promise<Value> {
  if (!generation.startsWith(GENERATION_PREFIX)) {
    throw new Error("Semantic projection generation is invalid.");
  }
  if (options.excludeReaders !== undefined && typeof options.excludeReaders !== "boolean") {
    throw new TypeError("Semantic writer excludeReaders must be a boolean.");
  }
  const waitMs = checkedLeaseBound(
    options.waitMs,
    DEFAULT_LEASE_WAIT_MS,
    MAX_LEASE_WAIT_MS,
    "Semantic writer lease wait",
  );
  const pollMs = checkedLeaseBound(
    options.pollMs,
    DEFAULT_LEASE_POLL_MS,
    MAX_LEASE_POLL_MS,
    "Semantic writer lease poll interval",
  );
  const readerDescription = options.excludeReaders === true
    ? "semantic projection readers"
    : "readers of an older semantic projection";
  const startedAt = Date.now();
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= waitMs) {
      throw new Error(
        `Timed out after ${waitMs}ms waiting for ${readerDescription} to close.`,
      );
    }
    const lease = await acquireSemanticWriterLease(database, {
      waitMs: Math.max(1, waitMs - elapsed),
      pollMs,
    });
    let compatible = false;
    try {
      const active = await activeReaderGenerations(database);
      compatible = options.excludeReaders === true
        ? active.size === 0
        : [...active].every((candidate) => candidate === generation);
      if (compatible) return await operation();
    } finally {
      await lease.release();
    }
    const waited = Date.now() - startedAt;
    if (waited >= waitMs) {
      throw new Error(
        `Timed out after ${waitMs}ms waiting for ${readerDescription} to close.`,
      );
    }
    await Bun.sleep(Math.min(pollMs, waitMs - waited));
  }
}

async function cleanUnusedGenerations(
  snapshotDirectory: string,
  currentGeneration: string,
): Promise<void> {
  const directory = await opendir(snapshotDirectory);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_CACHE_DIRECTORY_ENTRIES) {
        throw new RangeError("Semantic snapshot cache has too many metadata entries.");
      }
      if (!entry.isDirectory()) continue;
      const path = join(snapshotDirectory, entry.name);
      if (entry.name.startsWith(".temporary-")) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (!entry.name.startsWith(GENERATION_PREFIX) || entry.name === currentGeneration) continue;
      if (await activeGenerationReaders(path) === 0) {
        await rm(path, { recursive: true, force: true });
      }
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // Async iteration closes the directory after exhaustion.
    }
  }
}

/** Validate one bounded projection and atomically settle its empty database identity. */
export async function describeSemanticProjection(
  database: string,
  root: string,
  notes: readonly Note[],
  indexIdentity: SemanticIndexIdentity,
): Promise<SemanticProjectionDescription> {
  const [canonicalRoot, prospectiveDatabase] = await Promise.all([
    realpath(root),
    canonicalSemanticDatabasePath(database),
  ]);
  assertSemanticCacheOutsideVault(canonicalRoot, prospectiveDatabase);
  const validated = validatedProjectionNotes(notes);
  const validatedIdentity = validatedIndexIdentity(indexIdentity);
  const canonicalDatabase = await settledSemanticDatabasePath(prospectiveDatabase);
  assertSemanticCacheOutsideVault(canonicalRoot, canonicalDatabase);
  const identity = createHash("sha256").update(JSON.stringify({
    version: PROJECTION_VERSION,
    indexIdentity: validatedIdentity,
    root: canonicalRoot,
    notes: validated.notes,
    totalBytes: validated.totalBytes,
  })).digest("hex");
  const generation = `${GENERATION_PREFIX}${identity.slice(0, 32)}`;
  const snapshotDirectory = `${canonicalDatabase}.snapshot`;
  const generationPath = join(snapshotDirectory, generation);
  const manifest: SemanticProjectionManifest = {
    version: PROJECTION_VERSION,
    indexIdentity: validatedIdentity,
    root: canonicalRoot,
    generation,
    notes: validated.notes,
    totalBytes: validated.totalBytes,
  };
  const manifestText = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
    throw new RangeError(
      `Semantic projection manifest exceeds the ${MAX_MANIFEST_BYTES}-byte metadata limit.`,
    );
  }
  return {
    database: canonicalDatabase,
    snapshotDirectory,
    generationPath,
    manifest,
    manifestText,
  };
}

/**
 * Materialize one described snapshot and retain its reader generation.
 * Callers must hold that generation's semantic writer lease.
 */
export async function prepareSemanticProjection(
  description: SemanticProjectionDescription,
  notes: readonly Note[],
): Promise<SemanticProjection> {
  const { database, snapshotDirectory, generationPath, manifest, manifestText } = description;
  const validated = validatedProjectionNotes(notes);
  if (validated.totalBytes !== manifest.totalBytes
    || JSON.stringify(validated.notes) !== JSON.stringify(manifest.notes)) {
    throw new Error("Semantic projection notes changed after validation.");
  }
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  await ensureOwnedSnapshotCache(database, snapshotDirectory);
  await materializeGeneration(
    snapshotDirectory,
    generationPath,
    manifest,
    manifestText,
    notesByPath,
  );
  const reader: LeaseOwner = {
    version: LEASE_VERSION,
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const readerPath = join(generationPath, readerOwnerName(reader));
  await writeFile(readerPath, `${JSON.stringify(reader)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await atomicWrite(join(snapshotDirectory, MANIFEST_NAME), manifestText);
    await cleanUnusedGenerations(snapshotDirectory, manifest.generation);
  } catch (error: unknown) {
    await rm(readerPath, { force: true });
    throw error;
  }
  let released = false;
  return {
    root: generationPath,
    manifest,
    release: async () => {
      if (released) return;
      released = true;
      await rm(readerPath, { force: true });
    },
  };
}
