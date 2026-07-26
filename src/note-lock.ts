import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const LOCK_SCHEMA_VERSION = 1 as const;
const MAX_LOCK_BYTES = 4 * 1024;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_RECLAIM_ATTEMPTS = 8;

interface LockOwner {
  readonly version: typeof LOCK_SCHEMA_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

interface RegularObservedLock {
  readonly kind: "regular";
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedAtMs: number;
  readonly owner: LockOwner | null;
}

interface UnsafeObservedLock {
  readonly kind: "unsafe";
}

type ObservedLock = RegularObservedLock | UnsafeObservedLock;

export interface NoteLock {
  /** Absolute path in the external XDG cache hierarchy. */
  readonly path: string;
  readonly assertOwned: () => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface NoteLockDependencies {
  readonly pid: number;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly token: () => string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly staleAfterMs: number;
  readonly heartbeatMs: number;
  readonly pollIntervalMs: number;
  /** Deterministic race seam after a lock path is moved to a tombstone. */
  readonly afterTombstoneMove?: (tombstone: string, lockPath: string) => Promise<void>;
}

export interface NoteLockOptions {
  /**
   * Override the XDG cache home. This is primarily useful for isolated callers
   * and tests; the resulting lock directory must remain outside the vault.
   */
  readonly cacheHome?: string;
  readonly waitTimeoutMs?: number;
  readonly dependencies?: Partial<NoteLockDependencies>;
}

export class NoteLockBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super("this note is already being edited");
    this.name = "NoteLockBusyError";
    this.lockPath = lockPath;
  }
}

export class NoteLockLostError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super("the note lock is no longer owned by this process");
    this.name = "NoteLockLostError";
    this.lockPath = lockPath;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function defaultCacheHome(): string {
  const configured = process.env.XDG_CACHE_HOME;
  return configured !== undefined && isAbsolute(configured)
    ? configured
    : join(homedir(), ".cache");
}

function defaultDependencies(): NoteLockDependencies {
  return {
    pid: process.pid,
    now: () => new Date(),
    monotonicNow: () => performance.now(),
    token: () => randomUUID(),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !isErrno(error, "ESRCH");
      }
    },
    sleep: async (milliseconds) => {
      await new Promise<void>((resolveSleep) => {
        setTimeout(resolveSleep, milliseconds);
      });
    },
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

function resolvedDependencies(
  overrides: Partial<NoteLockDependencies> | undefined,
): NoteLockDependencies {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0) {
    throw new TypeError("a note lock requires a positive process ID");
  }
  for (const [label, value] of [
    ["staleAfterMs", dependencies.staleAfterMs],
    ["heartbeatMs", dependencies.heartbeatMs],
    ["pollIntervalMs", dependencies.pollIntervalMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive finite duration`);
    }
  }
  return dependencies;
}

async function lockPathFor(
  vaultRootInput: string,
  canonicalNoteId: string,
  cacheHomeInput: string | undefined,
): Promise<string> {
  if (
    canonicalNoteId === ""
    || canonicalNoteId.includes("\0")
    || canonicalNoteId.includes("\n")
    || canonicalNoteId.includes("\r")
  ) {
    throw new TypeError("a note lock requires a non-empty single-line note ID");
  }

  const vaultRoot = await realpath(resolve(vaultRootInput));
  const cacheHome = resolve(cacheHomeInput ?? defaultCacheHome());
  const requestedDirectory = join(
    cacheHome,
    "hraness-oh",
    "note-locks",
    sha256(vaultRoot),
  );
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const requestedMetadata = await lstat(requestedDirectory);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("the note lock root must be a real directory");
  }
  const lockDirectory = await realpath(requestedDirectory);
  if (within(vaultRoot, lockDirectory)) {
    throw new Error("the note lock root must remain outside the vault");
  }
  return join(lockDirectory, `${sha256(canonicalNoteId)}.lock`);
}

function parseOwner(value: unknown): LockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const version = record["version"];
  const pid = record["pid"];
  const token = record["token"];
  const acquiredAt = record["acquiredAt"];
  if (
    version !== LOCK_SCHEMA_VERSION
    || typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof token !== "string"
    || !/^[0-9a-z-]{16,128}$/iu.test(token)
    || typeof acquiredAt !== "string"
    || Number.isNaN(Date.parse(acquiredAt))
  ) {
    return null;
  }
  return { version, pid, token, acquiredAt };
}

async function observeLock(path: string): Promise<ObservedLock | null> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || metadata.size > BigInt(MAX_LOCK_BYTES)
  ) {
    return { kind: "unsafe" };
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return isErrno(error, "ENOENT") ? null : { kind: "unsafe" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
      || opened.size > BigInt(MAX_LOCK_BYTES)
    ) {
      return { kind: "unsafe" };
    }

    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) return { kind: "unsafe" };
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, Number(opened.size))).bytesRead !== 0) {
      return { kind: "unsafe" };
    }

    const finished = await handle.stat({ bigint: true });
    let finalPath;
    try {
      finalPath = await lstat(path, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
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
      return { kind: "unsafe" };
    }

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      value = null;
    }
    return {
      kind: "regular",
      device: opened.dev,
      inode: opened.ino,
      modifiedAtMs: Number(opened.mtimeMs),
      owner: parseOwner(value),
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: RegularObservedLock, right: RegularObservedLock): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function restoreUnexpectedLock(tombstone: string, lockPath: string): Promise<void> {
  try {
    // POSIX rename would overwrite a lock created after the tombstone move.
    // Hard-link restoration is atomic and fails without clobbering that owner.
    await link(tombstone, lockPath);
  } catch {
    return;
  }
  try {
    await unlink(tombstone);
  } catch {
    // Both paths still identify the same inode. A quarantine entry is safer
    // than deleting a name after another path race.
  }
}

async function reclaimObservedLock(
  lockPath: string,
  observed: RegularObservedLock,
  token: string,
  dependencies: NoteLockDependencies,
): Promise<boolean> {
  const tombstone = `${lockPath}.stale-${token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved === null || moved.kind !== "regular" || !sameIdentity(observed, moved)) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return false;
  }
  await unlink(tombstone);
  return true;
}

async function releaseOwnedLock(
  lockPath: string,
  owner: LockOwner,
  dependencies: NoteLockDependencies,
): Promise<void> {
  const tombstone = `${lockPath}.release-${owner.token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved?.kind !== "regular" || moved.owner?.token !== owner.token) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return;
  }
  await unlink(tombstone);
}

async function tryAcquire(
  lockPath: string,
  dependencies: NoteLockDependencies,
): Promise<NoteLock> {
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const owner: LockOwner = {
      version: LOCK_SCHEMA_VERSION,
      pid: dependencies.pid,
      token: dependencies.token(),
      acquiredAt: dependencies.now().toISOString(),
    };
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const observed = await observeLock(lockPath);
      if (observed === null) continue;
      if (observed.kind === "unsafe") throw new NoteLockBusyError(lockPath);
      const ageMs = Math.max(0, dependencies.now().getTime() - observed.modifiedAtMs);
      const ownerAlive = observed.owner !== null
        && dependencies.isProcessAlive(observed.owner.pid);
      if (
        ownerAlive
        || (observed.owner === null && ageMs <= dependencies.staleAfterMs)
      ) {
        throw new NoteLockBusyError(lockPath);
      }
      if (await reclaimObservedLock(lockPath, observed, owner.token, dependencies)) {
        continue;
      }
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: "utf8" });
      // Persist the owner before exposing the lease. The external lock is
      // disposable coordination state, so its directory entry need not
      // survive a machine crash; authored Markdown has its own durable install.
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      const created = await observeLock(lockPath);
      if (created?.kind === "regular") {
        await reclaimObservedLock(lockPath, created, owner.token, dependencies)
          .catch(() => undefined);
      }
      throw error;
    }

    const timer = setInterval(() => {
      const now = dependencies.now();
      void handle.utimes(now, now).catch(() => undefined);
    }, dependencies.heartbeatMs);
    timer.unref();
    let released = false;
    return {
      path: lockPath,
      assertOwned: async () => {
        const observed = await observeLock(lockPath);
        if (observed?.kind !== "regular" || observed.owner?.token !== owner.token) {
          throw new NoteLockLostError(lockPath);
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await handle.close();
        await releaseOwnedLock(lockPath, owner, dependencies);
      },
    };
  }
  throw new NoteLockBusyError(lockPath);
}

/**
 * Acquire a vault-and-note-scoped local lock in the external XDG cache.
 *
 * The note ID is hashed only for the cache filename; authoring remains keyed by
 * the exact canonical ID. Live owners are never reclaimed. Dead owners and
 * expired incomplete acquisitions are quarantined and identity-checked before
 * deletion.
 */
export async function acquireNoteLock(
  vaultRoot: string,
  canonicalNoteId: string,
  options: NoteLockOptions = {},
): Promise<NoteLock> {
  const lockPath = await lockPathFor(vaultRoot, canonicalNoteId, options.cacheHome);
  const dependencies = resolvedDependencies(options.dependencies);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new TypeError("waitTimeoutMs must be a non-negative finite duration");
  }
  const deadline = dependencies.monotonicNow() + waitTimeoutMs;

  for (;;) {
    try {
      return await tryAcquire(lockPath, dependencies);
    } catch (error) {
      if (!(error instanceof NoteLockBusyError)) throw error;
      const remaining = deadline - dependencies.monotonicNow();
      if (remaining <= 0) throw error;
      await dependencies.sleep(Math.min(dependencies.pollIntervalMs, remaining));
    }
  }
}
