import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  NoteLockBusyError,
  NoteLockLostError,
  acquireNoteLock,
  type NoteLockDependencies,
} from "./note-lock.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function fixture(): Promise<{
  readonly base: string;
  readonly vault: string;
  readonly cache: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "kb-note-lock-test-"));
  fixtures.push(base);
  const vault = join(base, "vault");
  const cache = join(base, "cache");
  await Promise.all([
    mkdir(vault),
    mkdir(cache),
  ]);
  return { base, vault, cache };
}

function dependencies(
  overrides: Partial<NoteLockDependencies> = {},
): Partial<NoteLockDependencies> {
  let sequence = 0;
  return {
    pid: 12_345,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    monotonicNow: () => 0,
    token: () =>
      `00000000-0000-4000-8000-${String(sequence += 1).padStart(12, "0")}`,
    isProcessAlive: () => true,
    staleAfterMs: 60_000,
    heartbeatMs: 60_000,
    pollIntervalMs: 1,
    ...overrides,
  };
}

describe("per-note XDG locks", () => {
  test("exclude a live owner and release idempotently outside the vault", async () => {
    const { vault, cache } = await fixture();
    const first = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies(),
    });
    expect(first.path.startsWith(`${await realpath(cache)}/`)).toBeTrue();
    expect(first.path.startsWith(`${await realpath(vault)}/`)).toBeFalse();
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({
      version: 1,
      pid: 12_345,
    });
    await first.assertOwned();
    expect(acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies(),
    })).rejects.toBeInstanceOf(NoteLockBusyError);

    await first.release();
    await first.release();
    const second = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies(),
    });
    await second.release();
  });

  test("waits for the same note while different notes remain independent", async () => {
    const { vault, cache } = await fixture();
    const first = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 1_000,
    });
    let secondAcquired = false;
    const secondPromise = acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 1_000,
    }).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    await Bun.sleep(40);
    expect(secondAcquired).toBeFalse();

    const independent = await acquireNoteLock(vault, "notes/other", {
      cacheHome: cache,
      waitTimeoutMs: 0,
    });
    expect(independent.path).not.toBe(first.path);
    await independent.release();

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBeTrue();
    await second.release();
  });

  test("reclaims a dead owner but never reclaims unsafe foreign entries", async () => {
    const { base, vault, cache } = await fixture();
    const seed = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies(),
    });
    const lockPath = seed.path;
    await seed.release();

    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      token: "11111111-1111-4111-8111-111111111111",
      acquiredAt: "2026-07-26T11:59:59.000Z",
    })}\n`, { mode: 0o600 });
    const reclaimed = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies({ isProcessAlive: () => false }),
    });
    await reclaimed.release();

    const foreign = join(base, "foreign");
    await writeFile(foreign, "caller-owned\n");
    await symlink(foreign, lockPath);
    expect(acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies({ isProcessAlive: () => false }),
    })).rejects.toBeInstanceOf(NoteLockBusyError);
    expect(await readFile(foreign, "utf8")).toBe("caller-owned\n");
    await rm(lockPath);

    await link(foreign, lockPath);
    const old = new Date("2026-07-25T00:00:00.000Z");
    await utimes(lockPath, old, old);
    expect(acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies({ isProcessAlive: () => false }),
    })).rejects.toBeInstanceOf(NoteLockBusyError);
    expect(await readFile(foreign, "utf8")).toBe("caller-owned\n");
  });

  test("release does not remove a replacement lock", async () => {
    const { vault, cache } = await fixture();
    const lock = await acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
      dependencies: dependencies(),
    });
    await rm(lock.path);
    const replacement = `${JSON.stringify({
      version: 1,
      pid: 54_321,
      token: "22222222-2222-4222-8222-222222222222",
      acquiredAt: "2026-07-26T12:00:00.000Z",
    })}\n`;
    await writeFile(lock.path, replacement, { mode: 0o600 });
    expect(lock.assertOwned()).rejects.toBeInstanceOf(NoteLockLostError);
    await lock.release();
    expect(await readFile(lock.path, "utf8")).toBe(replacement);
  });

  test("refuses to place an explicitly configured lock hierarchy in the vault", async () => {
    const { vault } = await fixture();
    const cache = join(vault, ".cache");
    await mkdir(cache);
    expect(acquireNoteLock(vault, "notes/source", {
      cacheHome: cache,
      waitTimeoutMs: 0,
    })).rejects.toThrow("outside the vault");
    expect(dirname(cache)).toBe(vault);
  });
});
