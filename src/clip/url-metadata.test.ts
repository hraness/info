import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createUrlMetadataDocument,
  discoverSavedUrlRecords,
  METADATA_SEARCH_ENGINE_ID,
  METADATA_SEARCH_ENGINE_REVISION,
  parseUrlMetadataDocument,
  readUrlMetadataDocument,
  renderUrlMetadataDocument,
  URL_METADATA_FILENAME,
  writeUrlMetadataDocument,
  type SavedUrlRecord,
} from "./url-metadata.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "kb-url-metadata-test-"));
  roots.push(root);
  mkdirSync(join(root, "articles"));
  return root;
}

function article(root: string, slug: string, frontmatter: string): string {
  const directory = join(root, "articles", slug);
  mkdirSync(directory);
  const path = join(directory, `${slug}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n# ${slug}\n`);
  return path;
}

function candidate(url = "https://example.com/article"): {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly engines: readonly string[];
  readonly score: number;
} {
  return {
    title: "Example article",
    url,
    snippet: "A bounded search-engine description.",
    engines: ["duckduckgo", "brave"],
    score: 2 / 61,
  };
}

function document(subjectUrl = "https://example.com/article") {
  return createUrlMetadataDocument({
    subjectUrl,
    generatedAt: "2026-08-05T01:00:00.000Z",
    enginesQueried: ["duckduckgo", "brave", "startpage", "yahoo"],
    enginesFailed: ["yahoo"],
    attempts: [{
      provider: METADATA_SEARCH_ENGINE_ID,
      outcome: "partial",
      message: "3 of 4 engines returned bounded results",
    }],
    candidates: [candidate(subjectUrl)],
    archives: [{
      url: `https://archive.ph/20260801000000/${subjectUrl}`,
      capturedAt: "2026-08-01T00:00:00.000Z",
      discovery: "timemap",
    }],
  });
}

function metadataLockPath(saved: SavedUrlRecord): string {
  return join(saved.directory, ".url-metadata.json.lock");
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

const lockHolderProgram = String.raw`
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

const [lockPath, readyPath] = process.argv.slice(2);
if (!lockPath || !readyPath) throw new Error("missing lock-holder paths");
const ffi = Bun.FFI;
const library = ffi.dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
});
const descriptor = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
if (library.symbols.flock(descriptor, 0x02 | 0x04) !== 0) throw new Error("could not hold test lock");
let processIdentity;
if (process.platform === "linux") {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
  processIdentity = "linux:" + readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + fields[19];
} else {
  const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" })
    .trim().replace(/\s+/gu, " ");
  processIdentity = "darwin:" + started;
}
const owner = {
  schemaVersion: 1,
  kind: "url-metadata-write-lock",
  host: hostname(),
  pid: process.pid,
  processIdentity,
  token: randomUUID(),
  acquiredAt: new Date().toISOString(),
};
ftruncateSync(descriptor, 0);
writeFileSync(descriptor, JSON.stringify(owner) + "\n", "utf8");
fchmodSync(descriptor, 0o600);
fsyncSync(descriptor);
writeFileSync(readyPath, "ready\n", "utf8");
process.on("SIGTERM", () => {
  closeSync(descriptor);
  process.exit(0);
});
setInterval(() => {}, 10_000);
`;

describe("saved URL inventory", () => {
  test("finds legacy, manifest-backed, and remote-PDF URLs while skipping a local PDF", () => {
    const root = vault();
    const legacy = [
      "open-culture",
      "cursor",
      "bonsai",
      "serpiente",
      "hardware",
      "woolgather-one",
      "woolgather-two",
    ];
    for (const [index, slug] of legacy.entries()) {
      article(root, slug, `title: ${slug}\nsource: "https://example.com/${index}"`);
    }
    const currentPath = article(root, "current", "title: Current\nsource: \"https://example.com/current\"");
    writeFileSync(join(root, "articles", "current", "capture.json"), "{\"schemaVersion\":3}\n");
    article(root, "remote-pdf", "title: PDF\nsource: \"source.pdf\"\nsource_url: \"https://arxiv.org/pdf/2507.09369\"");
    article(root, "local-pdf", "title: Local PDF\nsource: \"source.pdf\"");

    const records = discoverSavedUrlRecords(root);
    expect(records).toHaveLength(9);
    expect(() => JSON.stringify(records)).not.toThrow();
    expect(records.map(({ articleId }) => articleId)).toEqual([
      "bonsai",
      "current",
      "cursor",
      "hardware",
      "open-culture",
      "remote-pdf",
      "serpiente",
      "woolgather-one",
      "woolgather-two",
    ]);
    expect(records.find(({ articleId }) => articleId === "current")?.markdownPath).toBe(realpathSync(currentPath));
    expect(records.find(({ articleId }) => articleId === "remote-pdf")?.subjectUrl).toBe("https://arxiv.org/pdf/2507.09369");
  });

  test("rejects conflicting sources, multiple URL notes, symlinks, and hard-linked Markdown", () => {
    const conflicting = vault();
    article(conflicting, "conflict", "source: \"https://one.example/\"\nsource_url: \"https://two.example/\"");
    expect(() => discoverSavedUrlRecords(conflicting)).toThrow("conflicting source");

    const multiple = vault();
    const first = article(multiple, "multiple", "source: \"https://one.example/\"");
    writeFileSync(join(multiple, "articles", "multiple", "second.md"), "---\nsource: https://two.example/\n---\n");
    expect(() => discoverSavedUrlRecords(multiple)).toThrow("multiple URL-bearing");

    const hardLinked = vault();
    const hardSource = article(hardLinked, "hard", "source: \"https://example.com/\"");
    linkSync(hardSource, join(hardLinked, "articles", "hard", "copy.md"));
    expect(() => discoverSavedUrlRecords(hardLinked)).toThrow("single-link");

    const linked = vault();
    article(linked, "linked", "source: \"https://example.com/\"");
    symlinkSync(first, join(linked, "articles", "linked", "foreign.md"));
    expect(() => discoverSavedUrlRecords(linked)).toThrow("symbolic link");
  });

  test("rejects malformed YAML and private or credential-bearing source URLs", () => {
    const malformed = vault();
    article(malformed, "bad-yaml", "source: [unterminated");
    expect(() => discoverSavedUrlRecords(malformed)).toThrow("Invalid YAML");

    const malformedUrl = vault();
    article(malformedUrl, "bad-url", "source: \"https://[malformed\"");
    expect(() => discoverSavedUrlRecords(malformedUrl)).toThrow("absolute HTTP(S) URL");

    const nonStringUrl = vault();
    article(nonStringUrl, "non-string-url", "source_url:\n  nested: value");
    expect(() => discoverSavedUrlRecords(nonStringUrl)).toThrow("absolute HTTP(S) URL");

    const localPdf = vault();
    article(localPdf, "local-pdf", "source: \"source.pdf\"");
    expect(discoverSavedUrlRecords(localPdf)).toEqual([]);

    const privateVault = vault();
    article(privateVault, "private", "source: \"http://127.0.0.1/private\"");
    expect(() => discoverSavedUrlRecords(privateVault)).toThrow("private network");

    const credentials = vault();
    article(credentials, "credentials", "source: \"https://user:pass@example.com/private\"");
    expect(() => discoverSavedUrlRecords(credentials)).toThrow("credential-free");

    const signedQuery = vault();
    article(signedQuery, "signed-query", "source: \"https://example.com/private?access_token=secret-value\"");
    expect(() => discoverSavedUrlRecords(signedQuery)).toThrow("credential-shaped");

    const signedPath = vault();
    article(signedPath, "signed-path", "source: \"https://example.com/magic-link/secret-token-value-12345\"");
    expect(() => discoverSavedUrlRecords(signedPath)).toThrow("credential-shaped");
  });
});

describe("URL metadata schema and persistence", () => {
  test("round trips a closed, provider-bound sidecar and reports partial search coverage", () => {
    const parsed = parseUrlMetadataDocument(JSON.parse(renderUrlMetadataDocument(document())));
    expect(parsed.status).toBe("partial");
    expect(parsed.provider.revision).toBe(METADATA_SEARCH_ENGINE_REVISION);
    expect(parsed.selected.title?.value).toBe("Example article");
    expect(parsed.selected.description?.value).toBe("A bounded search-engine description.");
    expect(() => parseUrlMetadataDocument({ ...parsed, transport: "arbitrary" })).toThrow("unknown key");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      provider: { ...parsed.provider, revision: "moving-main" },
    })).toThrow("provider identity");
  });

  test("requires exact candidates and distinguishes unavailable from not-found", () => {
    expect(() => createUrlMetadataDocument({
      subjectUrl: "https://example.com/",
      generatedAt: "2026-08-05T01:00:00.000Z",
      enginesQueried: ["duckduckgo"],
      enginesFailed: [],
      attempts: [{ provider: METADATA_SEARCH_ENGINE_ID, outcome: "succeeded", message: "search completed" }],
      candidates: [candidate("https://example.com/b"), { ...candidate("https://example.com/a"), title: "A" }],
    })).toThrow("exactly match");
    expect(createUrlMetadataDocument({
      subjectUrl: "https://example.com/",
      generatedAt: "2026-08-05T01:00:00.000Z",
      enginesQueried: ["duckduckgo"],
      enginesFailed: [],
      attempts: [{ provider: METADATA_SEARCH_ENGINE_ID, outcome: "not-found", message: "no exact result" }],
      candidates: [],
    }).status).toBe("not-found");
    expect(createUrlMetadataDocument({
      subjectUrl: "https://example.com/",
      generatedAt: "2026-08-05T01:00:00.000Z",
      enginesQueried: ["duckduckgo", "brave"],
      enginesFailed: ["brave"],
      attempts: [{ provider: METADATA_SEARCH_ENGINE_ID, outcome: "partial", message: "one engine failed" }],
      candidates: [],
    }).status).toBe("partial");
    expect(createUrlMetadataDocument({
      subjectUrl: "https://example.com/",
      generatedAt: "2026-08-05T01:00:00.000Z",
      enginesQueried: ["duckduckgo"],
      enginesFailed: [],
      attempts: [
        { provider: METADATA_SEARCH_ENGINE_ID, outcome: "not-found", message: "no exact result" },
        { provider: "archive-today", outcome: "failed", message: "provider throttled" },
      ],
      candidates: [],
    }).status).toBe("partial");
    expect(createUrlMetadataDocument({
      subjectUrl: "https://example.com/",
      generatedAt: "2026-08-05T01:00:00.000Z",
      enginesQueried: ["duckduckgo"],
      enginesFailed: ["duckduckgo"],
      attempts: [{ provider: METADATA_SEARCH_ENGINE_ID, outcome: "failed", message: "engine unavailable" }],
      candidates: [],
    }).status).toBe("unavailable");
  });

  test("reports an archive-only discovery as partial metadata", () => {
    const archived = createUrlMetadataDocument({
      subjectUrl: "https://example.com/article",
      generatedAt: "2026-08-04T12:00:00.000Z",
      enginesQueried: [],
      enginesFailed: [],
      attempts: [{ provider: "archive-today", outcome: "succeeded", message: "found one exact snapshot" }],
      candidates: [],
      archives: [{
        url: "https://archive.ph/20260801000000/https://example.com/article",
        capturedAt: "2026-08-01T00:00:00.000Z",
        discovery: "newest",
      }],
    });
    expect(archived.status).toBe("partial");
  });

  test("atomically creates, idempotently reuses, and compatibly replaces only its sidecar", () => {
    const root = vault();
    article(root, "article", "source: \"https://example.com/article\"");
    const saved = discoverSavedUrlRecords(root)[0] as SavedUrlRecord;
    const first = document();
    expect(writeUrlMetadataDocument(saved, first)).toEqual({ changed: true, path: saved.sidecarPath });
    expect(writeUrlMetadataDocument(saved, first).changed).toBeFalse();
    expect(readUrlMetadataDocument(saved)).toEqual(first);
    const replacement = createUrlMetadataDocument({
      ...first,
      subjectUrl: first.subjectUrl,
      generatedAt: "2026-08-05T02:00:00.000Z",
      enginesQueried: first.provider.enginesQueried,
      enginesFailed: [],
      attempts: [{ provider: METADATA_SEARCH_ENGINE_ID, outcome: "succeeded", message: "all engines responded" }],
      candidates: first.candidates,
      archives: first.archives,
      warnings: [],
    });
    expect(writeUrlMetadataDocument(saved, replacement).changed).toBeTrue();
    expect(readUrlMetadataDocument(saved).generatedAt).toBe("2026-08-05T02:00:00.000Z");
    expect((lstatMode(saved.sidecarPath) & 0o777)).toBe(0o644);
  });

  test("never steals a live writer lock and recovers it after the verified owner dies", async () => {
    const root = vault();
    article(root, "article", "source: \"https://example.com/article\"");
    const saved = discoverSavedUrlRecords(root)[0] as SavedUrlRecord;
    const holderPath = join(root, "hold-url-metadata-lock.ts");
    const readyPath = join(root, "lock-ready");
    const lockPath = metadataLockPath(saved);
    writeFileSync(holderPath, lockHolderProgram);
    const holder = Bun.spawn([process.execPath, holderPath, lockPath, readyPath], {
      stderr: "pipe",
      stdout: "ignore",
    });
    try {
      await waitForPath(readyPath);
      const lockedIdentity = lstatSync(lockPath, { bigint: true });
      const lockedOwner = readFileSync(lockPath, "utf8");
      expect(() => writeUrlMetadataDocument(saved, document())).toThrow(`active writer pid ${holder.pid}`);
      const afterContention = lstatSync(lockPath, { bigint: true });
      expect(afterContention.dev).toBe(lockedIdentity.dev);
      expect(afterContention.ino).toBe(lockedIdentity.ino);
      expect(readFileSync(lockPath, "utf8")).toBe(lockedOwner);
      expect(existsSync(saved.sidecarPath)).toBeFalse();

      holder.kill("SIGKILL");
      await holder.exited;
      const legacyOrphan = join(saved.directory, `.${URL_METADATA_FILENAME}.${process.pid}.tmp`);
      writeFileSync(legacyOrphan, "orphan from a crashed PID\n");
      expect(writeUrlMetadataDocument(saved, document())).toEqual({
        changed: true,
        path: saved.sidecarPath,
      });
      expect(existsSync(lockPath)).toBeFalse();
      expect(readFileSync(legacyOrphan, "utf8")).toBe("orphan from a crashed PID\n");
      expect(readdirSync(saved.directory).filter((name) => name.endsWith(".tmp"))).toEqual([
        `.${URL_METADATA_FILENAME}.${process.pid}.tmp`,
      ]);
    } finally {
      if (holder.exitCode === null) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
    }
  });

  test("waits out fresh malformed locks, then recovers them without broad deletion", () => {
    for (const [slug, contents] of [["empty", ""], ["malformed", "not json"]] as const) {
      const root = vault();
      article(root, slug, "source: \"https://example.com/article\"");
      const saved = discoverSavedUrlRecords(root)[0] as SavedUrlRecord;
      const lockPath = metadataLockPath(saved);
      writeFileSync(lockPath, contents, { mode: 0o644 });
      expect(() => writeUrlMetadataDocument(saved, document())).toThrow("fresh malformed");
      expect(readFileSync(lockPath, "utf8")).toBe(contents);
      const staleTimestamp = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTimestamp, staleTimestamp);
      expect(writeUrlMetadataDocument(saved, document()).changed).toBeTrue();
      expect(existsSync(lockPath)).toBeFalse();
      expect((lstatMode(saved.sidecarPath) & 0o777)).toBe(0o644);
    }
  });

  test("fails closed on symbolic and hard-linked lock paths", () => {
    const linkedRoot = vault();
    article(linkedRoot, "linked", "source: \"https://example.com/article\"");
    const linkedSaved = discoverSavedUrlRecords(linkedRoot)[0] as SavedUrlRecord;
    const foreignLock = join(linkedRoot, "foreign-lock");
    writeFileSync(foreignLock, "do not remove\n");
    symlinkSync(foreignLock, metadataLockPath(linkedSaved));
    expect(() => writeUrlMetadataDocument(linkedSaved, document())).toThrow("owned regular single-link");
    expect(readFileSync(foreignLock, "utf8")).toBe("do not remove\n");
    expect(lstatSync(metadataLockPath(linkedSaved)).isSymbolicLink()).toBeTrue();
    expect(existsSync(linkedSaved.sidecarPath)).toBeFalse();

    const hardRoot = vault();
    article(hardRoot, "hard", "source: \"https://example.com/article\"");
    const hardSaved = discoverSavedUrlRecords(hardRoot)[0] as SavedUrlRecord;
    const hardLock = metadataLockPath(hardSaved);
    writeFileSync(hardLock, "stale lock\n", { mode: 0o600 });
    linkSync(hardLock, join(hardSaved.directory, "foreign-lock-link"));
    expect(() => writeUrlMetadataDocument(hardSaved, document())).toThrow("owned regular single-link");
    expect(lstatSync(hardLock).nlink).toBe(2);
    expect(existsSync(hardSaved.sidecarPath)).toBeFalse();
  });

  test("refuses stale metadata after the source Markdown or article directory changes", () => {
    const readRoot = vault();
    const readMarkdown = article(readRoot, "read", "source: \"https://example.com/article\"");
    const readSaved = discoverSavedUrlRecords(readRoot)[0] as SavedUrlRecord;
    writeUrlMetadataDocument(readSaved, document());
    writeFileSync(readMarkdown, "---\nsource: https://example.com/replacement\n---\n");
    expect(() => readUrlMetadataDocument(readSaved)).toThrow("Markdown identity changed");

    const changedRoot = vault();
    const changedMarkdown = article(changedRoot, "changed", "source: \"https://example.com/article\"");
    const changedSaved = discoverSavedUrlRecords(changedRoot)[0] as SavedUrlRecord;
    writeFileSync(changedMarkdown, "---\nsource: https://example.com/replacement\n---\n");
    expect(() => writeUrlMetadataDocument(changedSaved, document())).toThrow("Markdown identity changed");
    expect(() => lstatSync(changedSaved.sidecarPath)).toThrow();

    const swappedRoot = vault();
    article(swappedRoot, "swapped", "source: \"https://example.com/article\"");
    const swappedSaved = discoverSavedUrlRecords(swappedRoot)[0] as SavedUrlRecord;
    renameSync(swappedSaved.directory, `${swappedSaved.directory}.original`);
    mkdirSync(swappedSaved.directory);
    writeFileSync(swappedSaved.markdownPath, "---\nsource: https://example.com/article\n---\n");
    expect(() => writeUrlMetadataDocument(swappedSaved, document())).toThrow("directory identity changed");
    expect(() => lstatSync(swappedSaved.sidecarPath)).toThrow();
  });

  test("refuses malformed, foreign, symbolic, and hard-linked sidecars", () => {
    const root = vault();
    article(root, "article", "source: \"https://example.com/article\"");
    const saved = discoverSavedUrlRecords(root)[0] as SavedUrlRecord;

    writeFileSync(saved.sidecarPath, "not json");
    expect(() => writeUrlMetadataDocument(saved, document())).toThrow("malformed");
    rmSync(saved.sidecarPath);

    writeFileSync(saved.sidecarPath, renderUrlMetadataDocument(document("https://other.example/")));
    expect(() => writeUrlMetadataDocument(saved, document())).toThrow("different subject");
    rmSync(saved.sidecarPath);

    const foreign = join(root, "foreign.json");
    writeFileSync(foreign, renderUrlMetadataDocument(document()));
    symlinkSync(foreign, saved.sidecarPath);
    expect(() => writeUrlMetadataDocument(saved, document())).toThrow("single-link");
    rmSync(saved.sidecarPath);

    writeFileSync(saved.sidecarPath, renderUrlMetadataDocument(document()));
    linkSync(saved.sidecarPath, join(saved.directory, "copy.json"));
    expect(() => writeUrlMetadataDocument(saved, document())).toThrow("single-link");
  });

  test("rejects unknown fields, unsafe controls, oversized lists, and a mismatched write", () => {
    const parsed = document();
    expect(() => parseUrlMetadataDocument({ ...parsed, warnings: ["bad\u0000warning"] })).toThrow("control");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      candidates: Array.from({ length: 21 }, () => candidate()),
    })).toThrow("at most 20");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      provider: { ...parsed.provider, enginesFailed: ["unqueried"] },
    })).toThrow("unqueried engine");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      candidates: [{ ...parsed.candidates[0]!, url: "https://other.example/article" }],
    })).toThrow("exactly match");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      candidates: [{ ...parsed.candidates[0]!, engines: ["yahoo"] }],
    })).toThrow("unavailable or unqueried");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      archives: [{
        url: "https://example.com/not-an-archive",
        capturedAt: "2026-08-01T00:00:00.000Z",
        discovery: "newest",
      }],
    })).toThrow("timestamped Archive.today");
    expect(() => parseUrlMetadataDocument({
      ...parsed,
      selected: {
        ...parsed.selected,
        title: { ...parsed.selected.title!, sourceUrl: "https://other.example/article" },
      },
    })).toThrow("best exact candidate");
    expect(() => parseUrlMetadataDocument({ ...parsed, status: "matched" })).toThrow("status must be partial");

    const root = vault();
    article(root, "article", "source: \"https://example.com/article\"");
    const saved = discoverSavedUrlRecords(root)[0] as SavedUrlRecord;
    expect(() => writeUrlMetadataDocument(saved, document("https://other.example/"))).toThrow("does not match");
    expect(() => writeUrlMetadataDocument({
      ...saved,
      sidecarPath: join(saved.directory, "foreign.json"),
    }, document())).toThrow("not owned");
  });
});

function lstatMode(path: string): number {
  return lstatSync(path).mode;
}
