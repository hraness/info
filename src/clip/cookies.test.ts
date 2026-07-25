import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getCookies as getBrowserCookies } from "@steipete/sweet-cookie";

import {
  filterCookieProviderResult,
  parseCookiePayload,
  readCookieFile,
  renderCookieHeader,
} from "./cookies.js";
import { resolvePackageDirectory } from "./package-root.js";

const target = new URL("https://sub.example.com/account/page");
const future = 4_102_444_800;

describe("strict browser-like cookie filtering", () => {
  test("patched Chromium provider treats an empty top-level site as unpartitioned", async () => {
    const profile = mkdtempSync(join(tmpdir(), "hraness-oh-sweet-cookie-chromium-test-"));
    const cookieDatabase = join(profile, "Cookies");
    const database = new Database(cookieDatabase);
    try {
      database.exec(`
        CREATE TABLE cookies (
          name TEXT,
          value TEXT,
          host_key TEXT,
          path TEXT,
          expires_utc INTEGER,
          samesite INTEGER,
          encrypted_value BLOB,
          is_secure INTEGER,
          is_httponly INTEGER,
          top_frame_site_key TEXT,
          has_cross_site_ancestor INTEGER
        )
      `);
      const insert = database.prepare(`
        INSERT INTO cookies
          (name, value, host_key, path, expires_utc, samesite, encrypted_value,
           is_secure, is_httponly, top_frame_site_key, has_cross_site_ancestor)
        VALUES (?, ?, ?, '/', 0, 1, x'', 1, 1, ?, ?)
      `);
      insert.run("ordinary", "included", ".example.com", "", 1);
      insert.run("partitioned", "excluded", ".example.com", "https://top.example", 0);
      database.close();

      const sweetCookieRoot = resolvePackageDirectory("@steipete/sweet-cookie");
      const providerPath = [
        join(sweetCookieRoot, "dist", "providers", "chromeSqlite", "shared.js"),
        join(sweetCookieRoot, "packages", "core", "dist", "providers", "chromeSqlite", "shared.js"),
      ].find(existsSync);
      if (providerPath === undefined) {
        throw new Error("the pinned Sweet Cookie Chromium provider test seam is unavailable");
      }
      type ChromeProviderResult = {
        readonly cookies: readonly { readonly name: string; readonly value: string }[];
        readonly warnings: readonly string[];
      };
      type ChromeProvider = (
        options: { readonly dbPath: string },
        origins: readonly string[],
        allowlistNames: ReadonlySet<string> | undefined,
        decrypt: (bytes: Uint8Array, options: { readonly stripHashPrefix: boolean }) => string | null,
      ) => Promise<ChromeProviderResult>;
      const providerModule: unknown = await import(pathToFileURL(providerPath).href);
      if (
        typeof providerModule !== "object"
        || providerModule === null
        || !("getCookiesFromChromeSqliteDb" in providerModule)
        || typeof providerModule.getCookiesFromChromeSqliteDb !== "function"
      ) throw new Error("the pinned Sweet Cookie Chromium provider test seam is unavailable");
      const readChromeCookies = providerModule.getCookiesFromChromeSqliteDb as ChromeProvider;
      const result = await readChromeCookies(
        { dbPath: cookieDatabase },
        ["https://example.com/"],
        undefined,
        () => null,
      );
      expect(result.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
        { name: "ordinary", value: "included" },
      ]);
      expect(result.warnings).toEqual([
        "1 partitioned Chromium cookie(s) were excluded because replay cannot preserve their partition key.",
      ]);
    } finally {
      try {
        database.close();
      } catch {
        // The happy path closes before the provider opens its copied read-only database.
      }
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test("patched browser provider preserves host scope and excludes partitioned Firefox state", async () => {
    const profile = mkdtempSync(join(tmpdir(), "hraness-oh-sweet-cookie-test-"));
    const database = new Database(join(profile, "cookies.sqlite"));
    try {
      database.exec(`
        CREATE TABLE moz_cookies (
          name TEXT,
          value TEXT,
          host TEXT,
          path TEXT,
          expiry INTEGER,
          isSecure INTEGER,
          isHttpOnly INTEGER,
          sameSite INTEGER,
          originAttributes TEXT,
          isPartitionedAttributeSet INTEGER
        )
      `);
      const insert = database.prepare(`
        INSERT INTO moz_cookies
          (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes, isPartitionedAttributeSet)
        VALUES (?, ?, ?, '/', ?, 1, 1, 1, ?, ?)
      `);
      insert.run("scope", "host", "example.com", future, "", 0);
      insert.run("scope", "domain", ".example.com", future, "", 0);
      insert.run("partitioned", "excluded", "example.com", future, "^partitionKey=(https,example.com)", 1);
      database.close();

      const result = await getBrowserCookies({
        url: "https://example.com/",
        browsers: ["firefox"],
        firefoxProfile: profile,
      });
      expect(result.cookies
        .map(({ name, value, domain, hostOnly }) => ({ name, value, domain, hostOnly }))
        .sort((left, right) => left.value.localeCompare(right.value)))
        .toEqual([
          { name: "scope", value: "domain", domain: "example.com", hostOnly: false },
          { name: "scope", value: "host", domain: "example.com", hostOnly: true },
        ]);
      expect(result.warnings).toEqual([
        "1 partitioned or container-scoped Firefox cookie(s) were excluded because replay cannot preserve their origin attributes.",
      ]);
    } finally {
      try {
        database.close();
      } catch {
        // The happy path closes before the provider opens its copied read-only database.
      }
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test("enforces host/domain, request path, Secure, expiry, and syntax", () => {
    const result = filterCookieProviderResult({
      cookies: [
        { name: "parent", value: "ok", domain: "example.com", hostOnly: false, path: "/account", secure: true, httpOnly: true, sameSite: "Strict", expires: future },
        { name: "JSESSIONID", value: '"ajax:123456"', domain: "example.com", hostOnly: false, path: "/account", secure: true, httpOnly: false, sameSite: "Lax", expires: future },
        { name: "provider-parent", value: "ok", domain: "example.com", path: "/account", sameSite: "Lax" },
        { name: "session", value: "ok", domain: "example.com", hostOnly: true, path: "/account" },
        { name: "host-only", value: "no", domain: "example.com", hostOnly: true, path: "/account" },
        { name: "wrong-path", value: "no", domain: "example.com", hostOnly: false, path: "/admin" },
        { name: "expired", value: "no", domain: "example.com", hostOnly: false, path: "/", expires: 1 },
        { name: "bad-value", value: "line\nbreak", domain: "example.com", hostOnly: false, path: "/" },
        { name: "bad-samesite", value: "no", domain: "example.com", hostOnly: false, path: "/", sameSite: 1 },
      ],
      warnings: ["provider detail that must not be retained"],
    }, target);

    expect(result.validShape).toBeTrue();
    expect(result.rejected).toBe(7);
    expect(result.providerWarningCount).toBe(1);
    expect(renderCookieHeader(result.cookies)).toBe('JSESSIONID="ajax:123456"; parent=ok');
    expect(result.cookies.find((cookie) => cookie.name === "parent")).toMatchObject({
      name: "parent",
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      expires: future,
    });
  });

  test("never promotes ambiguous parent-host or partitioned provider cookies", () => {
    const result = filterCookieProviderResult({
      cookies: [
        { name: "ambiguous-parent", value: "no", domain: "example.com", path: "/account" },
        { name: "unproven-exact", value: "no", domain: "sub.example.com", path: "/account" },
        { name: "explicit-parent", value: "yes", domain: "example.com", hostOnly: false, path: "/account" },
        { name: "exact-host", value: "yes", domain: "sub.example.com", hostOnly: true, path: "/account" },
        { name: "partitioned", value: "no", domain: "sub.example.com", hostOnly: true, path: "/account", partitioned: true },
        { name: "container", value: "no", domain: "sub.example.com", hostOnly: true, path: "/account", originAttributes: "^userContextId=2" },
        { name: "object-partition", value: "no", domain: "sub.example.com", hostOnly: true, path: "/account", partitionKey: { topLevelSite: "https://attacker.example" } },
        { name: "malformed-top-frame", value: "no", domain: "sub.example.com", hostOnly: true, path: "/account", top_frame_site_key: 0 },
        { name: "malformed-origin", value: "no", domain: "sub.example.com", hostOnly: true, path: "/account", originAttributes: {} },
      ],
      warnings: [],
    }, target);

    expect(result.rejected).toBe(7);
    expect(result.cookies).toEqual([
      expect.objectContaining({ name: "exact-host", domain: "sub.example.com", hostOnly: true }),
      expect.objectContaining({ name: "explicit-parent", domain: "example.com", hostOnly: false }),
    ]);
  });

  test("never sends Secure cookies over HTTP and orders matching paths most-specific first", () => {
    const result = filterCookieProviderResult({
      cookies: [
        { name: "session", value: "root", domain: "example.com", hostOnly: true, path: "/" },
        { name: "session", value: "private", domain: "example.com", hostOnly: true, path: "/account" },
        { name: "secure", value: "no", domain: "example.com", hostOnly: true, path: "/", secure: true },
      ],
      warnings: [],
    }, new URL("http://example.com/account/page"));

    expect(result.rejected).toBe(1);
    expect(renderCookieHeader(result.cookies)).toBe("session=private; session=root");
  });
});

describe("explicit cookie payload formats", () => {
  const cookie = { name: "session", value: "value", domain: ".example.com", path: "/", expires: future };
  const fixtures = [
    ["json", JSON.stringify([cookie])],
    ["base64-json", Buffer.from(JSON.stringify({ cookies: [cookie] })).toString("base64")],
    ["netscape", `# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t${future}\tsession\tvalue\n`],
    ["cookie-header", "Cookie: session=value"],
    ["curl", "curl -H 'Cookie: session=value' https://sub.example.com/account/page"],
  ] as const;

  test.each(fixtures)("parses and filters %s", (format, input) => {
    const parsed = parseCookiePayload(input, target, 1_700_000_000);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.format).toBe(format);
    expect(renderCookieHeader(parsed.cookies)).toBe("session=value");
    if (format === "cookie-header" || format === "curl") {
      expect(parsed.cookies[0]).toMatchObject({
        domain: "sub.example.com",
        hostOnly: true,
        path: "/account/page",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      });
    }
  });

  test("distinguishes explicit scope from target-inferred cookie payloads", () => {
    const explicit = parseCookiePayload(JSON.stringify([cookie]), target, 1_700_000_000);
    const domainless = parseCookiePayload(JSON.stringify([{
      name: "session",
      value: "value",
      path: "/",
      secure: true,
    }]), target, 1_700_000_000);
    const header = parseCookiePayload("Cookie: session=value", target, 1_700_000_000);

    expect(explicit.ok && explicit.scopeProvenance).toBe("explicit");
    expect(domainless.ok && domainless.scopeProvenance).toBe("target-inferred");
    expect(header.ok && header.scopeProvenance).toBe("target-inferred");
  });

  test("rejects empty, malformed, and entirely out-of-scope input", () => {
    expect(parseCookiePayload("not cookies", target)).toEqual({ ok: false, reason: "invalid" });
    expect(parseCookiePayload("Cookie: session=value", new URL("https://other.example/path")).ok).toBeTrue();
    expect(parseCookiePayload(JSON.stringify([{ ...cookie, domain: "attacker.example" }]), target))
      .toEqual({ ok: false, reason: "empty" });
    expect(parseCookiePayload(JSON.stringify([{
      name: "ambiguous-parent",
      value: "no",
      domain: "example.com",
      path: "/",
    }]), target)).toEqual({ ok: false, reason: "empty" });
  });

  test("reads through one bounded no-follow descriptor even if the path is replaced", () => {
    const directory = mkdtempSync(join(tmpdir(), "hraness-oh-cookie-file-test-"));
    chmodSync(directory, 0o700);
    try {
      const selected = join(directory, "selected.cookies");
      const replacement = join(directory, "replacement.cookies");
      writeFileSync(selected, "Cookie: session=selected", { mode: 0o600 });
      writeFileSync(replacement, "Cookie: session=replacement", { mode: 0o600 });

      const parsed = readCookieFile(selected, target, {
        afterOpen: () => renameSync(replacement, selected),
      });
      expect(parsed.ok).toBeTrue();
      if (parsed.ok) expect(renderCookieHeader(parsed.cookies)).toBe("session=selected");

      const linked = join(directory, "linked.cookies");
      symlinkSync(selected, linked);
      expect(readCookieFile(linked, target)).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds dense header and Netscape record cardinality before object expansion", () => {
    const header = Array.from({ length: 10_000 }, (_, index) => `c${index}=v`).join(";");
    const headerStartedAt = performance.now();
    const parsedHeader = parseCookiePayload(`Cookie: ${header}`, target);
    expect(parsedHeader.ok).toBeTrue();
    if (parsedHeader.ok) {
      expect(parsedHeader.cookies).toHaveLength(4_096);
      expect(parsedHeader.rejected).toBeGreaterThan(0);
    }
    expect(performance.now() - headerStartedAt).toBeLessThan(2_000);

    const netscape = `# Netscape HTTP Cookie File\n${Array.from(
      { length: 10_000 },
      (_, index) => `.example.com\tTRUE\t/\tFALSE\t${future}\tc${index}\tv`,
    ).join("\n")}`;
    const parsedNetscape = parseCookiePayload(netscape, target, 1_700_000_000);
    expect(parsedNetscape.ok).toBeTrue();
    if (parsedNetscape.ok) {
      expect(parsedNetscape.cookies).toHaveLength(4_096);
      expect(parsedNetscape.rejected).toBeGreaterThan(0);
    }
  });
});
