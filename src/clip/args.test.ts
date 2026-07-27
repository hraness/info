import { describe, expect, test } from "bun:test";

import { parseArguments } from "./args.js";

describe("CLI arguments", () => {
  test("keeps the legacy URL and optional slug surface", () => {
    const result = parseArguments(["https://example.com/post", "Named clip"], {
      KB_CLIP_OUTPUT: "/tmp/clips",
      FORCE: "1",
      KB_CLIP_USER_AGENT: "agent",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: "capture",
        slug: "Named clip",
        outputBase: "/tmp/clips",
        force: false,
        userAgent: "agent",
      },
    });
  });

  test("ignores collision-prone ambient variables and never enables force from the environment", () => {
    const result = parseArguments(["https://example.com/post"], {
      OUT_DIR: "/tmp/unrelated",
      FORCE: "1",
      USER_AGENT: "ambient-agent",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        outputBase: "kb/articles",
        force: false,
      },
    });
    if (result.ok && result.value.command === "capture") {
      expect(result.value.userAgent).not.toBe("ambient-agent");
    }
  });

  test("parses authenticated browser, cookie, scope, evidence, and bounded-size options", () => {
    const result = parseArguments([
      "capture",
      "https://x.com/person/status/123",
      "--mode",
      "browser",
      "--scope",
      "thread",
      "--browser-profile",
      "Work",
      "--cookie-source",
      "chrome",
      "--cookie-profile",
      "Profile 2",
      "--media",
      "all",
      "--evidence",
      "all",
      "--timeout-ms",
      "45000",
      "--max-items",
      "900",
      "--max-depth",
      "20",
      "--max-html-bytes",
      "30mb",
      "--max-asset-bytes",
      "2mb",
      "--max-total-asset-bytes",
      "1gb",
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: "capture",
        mode: "browser",
        scope: "thread",
        browserProfile: "Work",
        cookieSources: ["chrome"],
        cookieProfile: "Profile 2",
        media: "all",
        evidence: "all",
        timeoutMs: 45_000,
        maxItems: 900,
        maxDepth: 20,
        maxHtmlBytes: 30 * 1024 * 1024,
        maxAssetBytes: 2 * 1024 * 1024,
        maxTotalAssetBytes: 1024 ** 3,
      },
    });
  });

  test("accepts attached browser capture without an acknowledgement flag", () => {
    const result = parseArguments(["https://example.com", "--browser-live"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        browserLive: true,
        allowPrivateNetwork: false,
      },
    });
  });

  test("parses current as an attached-tab target whose URL is resolved during acquisition", () => {
    expect(parseArguments(["current", "--browser-live"])).toMatchObject({
      ok: true,
      value: {
        url: null,
        currentTab: true,
        mode: "browser",
        browserLive: true,
        cdp: undefined,
      },
    });
    expect(parseArguments(["current", "named clip", "--cdp", "9222"])).toMatchObject({
      ok: true,
      value: {
        url: null,
        currentTab: true,
        slug: "named clip",
        mode: "browser",
        browserLive: false,
        cdp: "9222",
      },
    });
  });

  test("accepts only a numeric local CDP port so secrets never enter process arguments", () => {
    const local = parseArguments([
      "https://example.com",
      "--cdp",
      "09222",
    ]);
    expect(local).toMatchObject({ ok: true, value: { cdp: "9222" } });
    for (const endpoint of [
      "ws://127.0.0.1:9222/devtools/browser/secret",
      "http://localhost:9222?token=secret",
      "0",
      "65536",
    ]) {
      const result = parseArguments([
        "https://example.com",
        "--cdp",
        endpoint,
      ]);
      expect(result).toEqual({
        ok: false,
        message: "--cdp accepts only a local remote-debugging port between 1 and 65535",
      });
    }
  });

  test("never silently ignores artifact requests in stdout mode", () => {
    const plain = parseArguments(["capture", "https://example.com", "--stdout"]);
    expect(plain).toMatchObject({ ok: true, value: { stdout: true, media: "none", evidence: "none" } });
    expect(parseArguments(["capture", "https://example.com", "--stdout", "--json"])).toEqual({
      ok: false,
      message: "--stdout and --json cannot be combined",
    });
    expect(parseArguments(["inspect", "https://example.com", "--json"])).toMatchObject({
      ok: true,
      value: { command: "inspect", json: true },
    });
    expect(parseArguments(["capture", "https://example.com", "--stdout", "--media", "all"]).ok).toBeFalse();
    expect(parseArguments(["capture", "https://example.com", "--stdout", "--evidence", "source"]).ok).toBeFalse();
  });

  test("accepts one selected browser and rejects ambiguous multi-source selection", () => {
    const arc = parseArguments(["https://example.com", "--cookie-source", "arc"]);
    expect(arc.ok && arc.value.command === "capture" ? arc.value.cookieSources : []).toEqual(["arc"]);
    const ambiguous = parseArguments([
      "https://example.com",
      "--cookie-source",
      "safari",
      "--cookie-source",
      "brave",
    ]);
    expect(ambiguous).toEqual({
      ok: false,
      message: "select at most one --cookie-source so profile and media behavior stay unambiguous",
    });
    expect(parseArguments([
      "https://example.com",
      "--cookie-source",
      "chrome",
      "--cookies-file",
      "/private/tmp/cookies.json",
    ])).toEqual({
      ok: false,
      message: "--cookie-source and --cookies-file are mutually exclusive authentication sources",
    });
  });

  test("switches to file mode when rendered HTML is supplied", () => {
    expect(parseArguments([
      "https://example.com/article",
      "--html",
      "-",
      "--stdout",
    ])).toMatchObject({ ok: true, value: { mode: "file", htmlFile: "-", stdout: true } });
  });

  test("parses diagnostic commands", () => {
    expect(parseArguments(["doctor", "--json"])).toEqual({
      ok: true,
      value: { command: "doctor", json: true },
    });
    expect(parseArguments(["adapters"])).toEqual({
      ok: true,
      value: { command: "adapters", json: false },
    });
  });

  test("rejects an oversized URL before parser expansion", () => {
    const result = parseArguments([`https://example.com/?q=${"x".repeat(65 * 1024)}`]);
    expect(result).toEqual({ ok: false, message: "URL exceeds the 65536 code-unit safety limit" });
  });

  test.each([
    { args: ["ftp://example.com"], error: "must use http or https" },
    { args: ["https://example.com", "--mode", "magic"], error: "--mode must be one of" },
    { args: ["https://example.com", "--mode", "file"], error: "requires --html" },
    { args: ["https://example.com", "--browser-live", "--browser-profile", "Work"], error: "mutually exclusive" },
    { args: ["https://example.com", "--cdp", "9222", "--browser-live"], error: "cannot be combined" },
    { args: ["current"], error: "requires --browser-live or --cdp" },
    { args: ["current", "--browser-profile", "Work"], error: "cannot use --browser-profile" },
    { args: ["current", "--browser-live", "--mode", "http"], error: "requires --mode auto or --mode browser" },
    { args: ["current", "--cdp", "9222", "--html", "page.html"], error: "cannot be combined with --html" },
    { args: ["https://example.com", "--mode", "http", "--browser-profile", "Work"], error: "requires --mode auto or --mode browser" },
    { args: ["https://example.com", "--mode", "file", "--html", "page.html", "--browser-live"], error: "requires --mode auto or --mode browser" },
    { args: ["https://example.com", "--mode", "http", "--evidence", "screenshot"], error: "screenshot evidence requires" },
    { args: ["https://example.com", "--html", "page.html", "--evidence", "all"], error: "screenshot evidence requires" },
    { args: ["https://example.com", "--cookie-profile", "Work"], error: "requires at least one" },
    { args: ["https://example.com", "--timeout-ms", "0"], error: "between 1" },
    { args: ["https://example.com", "--max-items", "10001"], error: "between 1 and 10000" },
    { args: ["https://example.com", "--max-depth", "65"], error: "between 1 and 64" },
    { args: ["https://example.com", "--max-asset-bytes", "5mb", "--max-total-asset-bytes", "4mb"], error: "cannot be smaller" },
    { args: ["https://example.com", "--force", "--stdout"], error: "cannot be combined" },
    { args: ["inspect", "https://example.com", "--media", "all"], error: "inspect does not persist media" },
    { args: ["inspect", "https://example.com", "--evidence", "source"], error: "inspect does not persist evidence" },
    { args: ["https://example.com", "--wat"], error: "unknown option" },
  ])("rejects invalid combinations: $args", ({ args, error }) => {
    const result = parseArguments(args);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.message).toContain(error);
  });
});
