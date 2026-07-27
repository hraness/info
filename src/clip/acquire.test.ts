import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import {
  acquireBrowser,
  agentBrowserCommand,
  assertSafePersistentProfile,
  browserExpansionLimits,
  browserExpansionScript,
  browserExpansionStayedOnPage,
  browserExpansionWarnings,
  browserNavigationReachedTarget,
  browserCookieCommands,
  browserProxyArguments,
  seedOwnedBrowserCookies,
  createCookieHeaderReader,
  createCookieRecordReader,
  isolatedAgentBrowserEnvironment,
  mergeRenderedTextSnapshots,
  readBrowserExpansionTelemetry,
  type BrowserExpansionLimits,
  type BrowserExpansionTelemetry,
} from "./acquire.js";
import type { CaptureArguments } from "./args.js";

const temporaryDirectories: string[] = [];

async function executeExpansionScript(
  limits: BrowserExpansionLimits,
  document: object,
): Promise<BrowserExpansionTelemetry> {
  const result: unknown = runInNewContext(browserExpansionScript(limits), {
    document,
    window: { scrollTo: () => undefined },
    setTimeout: (callback: () => void) => callback(),
  });
  const telemetry = readBrowserExpansionTelemetry(await Promise.resolve(result), limits);
  if (telemetry === null) throw new Error("expansion test script returned invalid telemetry");
  return telemetry;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cookieOptions(cookieFile: string): CaptureArguments {
  return {
    command: "inspect",
    url: new URL("https://example.com/account"),
    currentTab: false,
    slug: undefined,
    mode: "http",
    scope: "page",
    media: "none",
    evidence: "none",
    htmlFile: undefined,
    outputBase: "kb/articles",
    force: false,
    stdout: true,
    json: false,
    quiet: true,
    browserProfile: undefined,
    browserLive: false,
    cdp: undefined,
    cookieSources: [],
    cookieProfile: undefined,
    cookiesFile: cookieFile,
    timeoutMs: 1_000,
    maxItems: 10,
    maxDepth: 4,
    maxHtmlBytes: 1_024,
    maxAssetBytes: 1_024,
    maxTotalAssetBytes: 2_048,
    allowPrivateNetwork: false,
    userAgent: "test",
  };
}

test("uses the cross-platform agent-browser wrapper when lifecycle scripts are skipped", () => {
  expect(agentBrowserCommand()).toEqual([
    process.execPath,
    expect.stringMatching(/[/\\]agent-browser[/\\]bin[/\\]agent-browser\.js$/u),
  ]);
});

test("fresh-browser cookie commands preserve host, path, Secure, HttpOnly, SameSite, and expiry", () => {
  expect(browserCookieCommands([{
    name: "session",
    value: "private",
    domain: "sub.example.com",
    hostOnly: true,
    path: "/account",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    expires: 4_102_444_800,
  }, {
    name: "parent",
    value: "value",
    domain: "example.com",
    hostOnly: false,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: 0,
  }], new URL("https://sub.example.com/account/page"))).toEqual([
    ["cookies", "set", "session", "private", "--url", "https://sub.example.com", "--path", "/account", "--httpOnly", "--secure", "--sameSite", "Strict", "--expires", "4102444800"],
    ["cookies", "set", "parent", "value", "--domain", ".example.com", "--path", "/"],
  ]);
});

test("owned profile cookie seeding filters the exact target before submitting stdin-only browser commands", async () => {
  const options: CaptureArguments = {
    ...cookieOptions("unused"),
    url: new URL("https://social.example/account/thread?id=1"),
    mode: "browser",
    browserProfile: "/private/owned-clone",
    browserProfileOwnership: "owned",
    cookieSources: ["arc"],
    cookieProfile: "Profile 1",
    cookiesFile: undefined,
  };
  const events: string[] = [];
  const warnings = await seedOwnedBrowserCookies(
    options,
    ["--session", "test"],
    { cwd: "/private", environment: {}, timeoutMs: 1_000, maxOutputBytes: 4_096 },
    {
      readCookies: (selected, target) => {
        events.push("read-filtered-cookies");
        expect(selected.cookieSources).toEqual(["arc"]);
        expect(selected.cookieProfile).toBe("Profile 1");
        expect(target.href).toBe("https://social.example/account/thread?id=1");
        return Promise.resolve({
          cookies: [{
            name: "session",
            value: "private",
            domain: "social.example",
            hostOnly: true,
            path: "/account",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            expires: 0,
          }],
          warnings: ["filtered one unrelated cookie"],
        });
      },
      runBatch: (globalArgs, commands) => {
        events.push("submit-cookie-batch");
        expect(globalArgs).toEqual(["--session", "test"]);
        expect(commands).toEqual([[
          "cookies", "set", "session", "private",
          "--url", "https://social.example",
          "--path", "/account",
          "--httpOnly",
          "--secure",
          "--sameSite", "Lax",
        ]]);
        return Promise.resolve();
      },
    },
  );
  expect(events).toEqual(["read-filtered-cookies", "submit-cookie-batch"]);
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toBe("filtered one unrelated cookie");
  expect(warnings[1]).toContain("Seeded explicitly selected cookies into the owned browser");
});

describe("browser thread scrolling and observation", () => {
  test("derives useful work budgets with fixed hard ceilings", () => {
    expect(browserExpansionLimits(1, 4_096)).toEqual({
      maxScrolls: 3,
      maxObservedTextBytes: 4_096,
    });
    expect(browserExpansionLimits(500, 8 * 1024 * 1024)).toEqual({
      maxScrolls: 25,
      maxObservedTextBytes: 4 * 1024 * 1024,
    });
    expect(browserExpansionLimits(Number.POSITIVE_INFINITY)).toEqual(browserExpansionLimits(500));
    expect(browserExpansionLimits(1_000_000)).toEqual({
      maxScrolls: 40,
      maxObservedTextBytes: 4 * 1024 * 1024,
    });
  });

  test("never dispatches any control, including form and generic load-more buttons", async () => {
    const limits = browserExpansionLimits(1, 4_096);
    let controlTraversalCalls = 0;
    let clicks = 0;
    const controls = [
      { localName: "button", type: "submit", form: {}, textContent: "Load more", click: () => { clicks += 1; } },
      { localName: "button", type: "reset", form: {}, textContent: "Load more", click: () => { clicks += 1; } },
      { localName: "button", type: "button", form: null, textContent: "Load more", click: () => { clicks += 1; } },
      { localName: "div", role: "button", textContent: "Load more", click: () => { clicks += 1; } },
    ];
    const telemetry = await executeExpansionScript(limits, {
      body: { innerText: "Feed\nVisible row" },
      documentElement: { scrollHeight: 100, innerText: "" },
      createTreeWalker: () => ({
        nextNode: () => {
          controlTraversalCalls += 1;
          return controls[controlTraversalCalls - 1] ?? null;
        },
      }),
    });

    const script = browserExpansionScript(limits);
    expect(script).not.toMatch(/\.click\s*\(|requestSubmit\s*\(|\.submit\s*\(/);
    expect(script).not.toContain("createTreeWalker");
    expect(controlTraversalCalls).toBe(0);
    expect(clicks).toBe(0);
    expect(telemetry.scrolls).toBe(3);
    expect(browserExpansionWarnings(telemetry, limits).join(" ")).toContain("disclosure controls untouched");
  });

  test("collects a bounded rendered-text observation after every scroll pass", async () => {
    const limits = browserExpansionLimits(1, 4_096);
    const observations = [
      "Feed\nRow 1\nRow 2",
      "Feed\nRow 2\nRow 3",
      "Feed\nRow 3\nRow 4",
    ];
    let observation = 0;
    const telemetry = await executeExpansionScript(limits, {
      body: {
        get innerText() {
          return observations[observation++] ?? "";
        },
      },
      documentElement: { scrollHeight: 100, innerText: "" },
    });

    expect(telemetry.renderedTextSnapshots).toEqual(observations);
    expect(telemetry.renderedTextObservationTruncated).toBeFalse();
    expect(new TextEncoder().encode(telemetry.renderedTextSnapshots.join("")).byteLength)
      .toBeLessThanOrEqual(limits.maxObservedTextBytes);
  });

  test("bounds in-pass text by UTF-8 bytes and reports truncated observations", async () => {
    const limits = browserExpansionLimits(1, 12);
    const telemetry = await executeExpansionScript(limits, {
      body: { innerText: "🙂🙂🙂🙂🙂🙂🙂🙂" },
      documentElement: { scrollHeight: 100, innerText: "" },
    });

    const observedBytes = telemetry.renderedTextSnapshots.reduce(
      (total, snapshot) => total + new TextEncoder().encode(snapshot).byteLength,
      0,
    );
    expect(observedBytes).toBeLessThanOrEqual(limits.maxObservedTextBytes);
    expect(telemetry.renderedTextObservationTruncated).toBeTrue();
    expect(browserExpansionWarnings(telemetry, limits).join(" ")).toContain("Rendered-text observations");
  });

  test("rejects impossible target-controlled expansion telemetry", () => {
    const limits = browserExpansionLimits(1, 4);
    expect(readBrowserExpansionTelemetry({
      scrolls: 1,
      scrollBudgetReached: false,
      renderedTextSnapshots: ["five!"],
      renderedTextObservationTruncated: false,
    }, limits)).toBeNull();
  });
});

describe("rendered-text snapshot merging", () => {
  test("preserves virtualized rows observed before and after expansion", () => {
    const merged = mergeRenderedTextSnapshots([
      "Feed\nRow 1\nRow 2\nRow 3",
      "Feed\nRow 3\nRow 4\nRow 5",
      "Feed\nRow 5\nRow 6",
    ], 4_096);

    expect(merged).toEqual({
      content: "Feed\nRow 1\nRow 2\nRow 3\nRow 4\nRow 5\nRow 6",
      truncated: false,
      observedSnapshots: 3,
      addedLines: 3,
    });
  });

  test("is idempotent and normalizes only line endings and blank edges", () => {
    const snapshot = "\r\nHeader\r\n\r\nBody with trailing spaces  \r\n\r\n";
    const once = mergeRenderedTextSnapshots([snapshot], 4_096);
    const repeated = mergeRenderedTextSnapshots([snapshot, snapshot], 4_096);

    expect(once.content).toBe("Header\n\nBody with trailing spaces  ");
    expect(repeated).toEqual({ ...once, observedSnapshots: 2 });
    expect(repeated.addedLines).toBe(0);
  });

  test("separates disjoint observations and handles repeated-row overlaps", () => {
    expect(mergeRenderedTextSnapshots([
      "First observation\nOnly here",
      "Second observation\nOnly there",
    ], 4_096).content).toBe("First observation\nOnly here\n\nSecond observation\nOnly there");

    expect(mergeRenderedTextSnapshots([
      "A\nB\nA\nB",
      "B\nA\nB\nC",
    ], 4_096).content).toBe("A\nB\nA\nB\nC");
  });

  test("enforces the byte limit without emitting partial UTF-8", () => {
    const exact = mergeRenderedTextSnapshots(["🙂a"], 4);
    expect(exact.content).toBe("🙂");
    expect(exact.truncated).toBeTrue();
    expect(new TextEncoder().encode(exact.content)).toHaveLength(4);

    const partial = mergeRenderedTextSnapshots(["🙂a"], 3);
    expect(partial.content).toBe("");
    expect(partial.truncated).toBeTrue();
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(partial.content),
    )).not.toThrow();
  });

  test("rejects invalid byte limits", () => {
    expect(() => mergeRenderedTextSnapshots(["content"], -1)).toThrow("non-negative safe integer");
    expect(() => mergeRenderedTextSnapshots(["content"], Number.POSITIVE_INFINITY)).toThrow(
      "non-negative safe integer",
    );
  });

  test("idempotence and byte bounds hold for arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 500 }), (snapshot) => {
      const once = mergeRenderedTextSnapshots([snapshot], 1_000_000);
      const repeated = mergeRenderedTextSnapshots([snapshot, snapshot], 1_000_000);
      expect(repeated.content).toBe(once.content);
      expect(repeated.truncated).toBe(once.truncated);
      expect(repeated.addedLines).toBe(0);
    }));

    fc.assert(fc.property(
      fc.array(fc.string({ maxLength: 100 }), { maxLength: 8 }),
      fc.integer({ min: 0, max: 256 }),
      (snapshots, maxBytes) => {
        const merged = mergeRenderedTextSnapshots(snapshots, maxBytes);
        expect(new TextEncoder().encode(merged.content).byteLength).toBeLessThanOrEqual(maxBytes);
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(
          new TextEncoder().encode(merged.content),
        )).not.toThrow();
      },
    ));
  });
});

test("browser acquisition merges virtualized rows observed during every production scroll pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-browser-observations-test-"));
  temporaryDirectories.push(directory);
  const target = "https://github.com/example/project/issues/42";
  const reads = [
    "Feed\nRow 1\nRow 2",
    "Feed\nRow 4\nRow 5",
  ];
  let readIndex = 0;
  let evalIndex = 0;
  const networkChecks: string[] = [];

  const page = await acquireBrowser({
    ...cookieOptions(join(directory, "unused-cookies.json")),
    url: new URL(target),
    mode: "browser",
    scope: "comments",
    browserLive: true,
    cookiesFile: undefined,
    maxHtmlBytes: 4_096,
  }, directory, false, {
    assertNetworkUrl: (url) => {
      networkChecks.push(url.href);
      return Promise.resolve();
    },
    run: (_global, command) => {
      if (command[0] === "open") return Promise.resolve({});
      if (command[0] === "get") return Promise.resolve({ url: "about:blank" });
      if (command[0] === "read") {
        return Promise.resolve({
          content: reads[readIndex++] ?? "",
          finalUrl: target,
          truncated: false,
        });
      }
      if (command[0] === "eval") {
        evalIndex += 1;
        if (evalIndex === 1) {
          return Promise.resolve({
            result: {
              scrolls: 2,
              scrollBudgetReached: false,
              renderedTextSnapshots: [
                "Feed\nRow 2\nRow 3",
                "Feed\nRow 3\nRow 4",
              ],
              renderedTextObservationTruncated: false,
            },
          });
        }
        return Promise.resolve({
          result: {
            url: target,
            title: "Virtualized feed",
            html: "<!doctype html><html><body><main>Virtualized feed</main></body></html>",
          },
        });
      }
      throw new Error(`unexpected browser command ${command[0] ?? "missing"}`);
    },
    runBatch: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  });

  expect(page.renderedText).toBe("Feed\nRow 1\nRow 2\nRow 3\nRow 4\nRow 5");
  expect(page.renderedTextTruncated).toBeUndefined();
  expect(page.warnings.join(" ")).toContain("Merged 3 newly observed rendered-text line(s)");
  expect(networkChecks).toEqual([target, target]);
});

test("owned Chromium sessions cannot bypass the filtering proxy through loopback, QUIC, or WebRTC", () => {
  const arguments_ = browserProxyArguments("http://127.0.0.1:41234", "Default");
  expect(arguments_).toContain("--proxy");
  expect(arguments_).toContain("http://127.0.0.1:41234");
  const flags = arguments_.join("\n");
  expect(flags).toContain("--proxy-bypass-list=<-loopback>");
  expect(flags).toContain("--profile-directory=Default");
  expect(flags).toContain("--disable-quic");
  expect(flags).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
});

test("browser subprocess isolation removes ambient auth, providers, startup state, and proxy bypasses", () => {
  const environment = isolatedAgentBrowserEnvironment({
    PATH: "/bin",
    HOME: "/Users/tester",
    AGENT_BROWSER_PROFILE: "Personal",
    AGENT_BROWSER_STATE: "/private/state.json",
    AGENT_BROWSER_RESTORE: "signed-in",
    AGENT_BROWSER_AUTO_CONNECT: "1",
    AGENT_BROWSER_PROVIDER: "browserbase",
    AGENT_BROWSER_EXTENSIONS: "/private/extension",
    AGENT_BROWSER_INIT_SCRIPTS: "/private/init.js",
    HTTP_PROXY: "http://ambient-proxy.invalid",
    NO_PROXY: "127.0.0.1",
  }, "/private/clip-sockets");
  expect(environment).toEqual({
    PATH: "/bin",
    HOME: "/Users/tester",
    AGENT_BROWSER_SOCKET_DIR: "/private/clip-sockets",
  });
});

test.each([
  { label: "live browser", browserLive: true, cdp: undefined, expectedGlobal: "--auto-connect" },
  { label: "CDP browser", browserLive: false, cdp: "9222", expectedGlobal: "9222" },
])("current-tab capture reads the $label without any navigation or action command", async ({
  browserLive,
  cdp,
  expectedGlobal,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "clip-browser-current-test-"));
  temporaryDirectories.push(directory);
  const currentUrl = "https://github.com/example/private/issues/42?view=all";
  const observed: { readonly global: readonly string[]; readonly command: readonly string[] }[] = [];
  let batchCalls = 0;
  const page = await acquireBrowser({
    ...cookieOptions(join(directory, "unused-cookies.json")),
    url: null,
    currentTab: true,
    mode: "browser",
    browserLive,
    cdp,
    cookiesFile: undefined,
  }, directory, false, {
    run: (global, command) => {
      observed.push({ global: [...global], command: [...command] });
      if (command[0] === "get") return Promise.resolve({ url: currentUrl });
      if (command[0] === "read") {
        return Promise.resolve({
          content: "Private issue title\n\nRendered issue body and comments.",
          finalUrl: currentUrl,
          truncated: false,
        });
      }
      if (command[0] === "eval") {
        return Promise.resolve({
          result: {
            url: currentUrl,
            title: "Private issue title",
            html: "<!doctype html><html><body><main>Rendered issue body and comments.</main></body></html>",
          },
        });
      }
      throw new Error(`unexpected browser command ${command[0] ?? "missing"}`);
    },
    runBatch: () => {
      batchCalls += 1;
      return Promise.reject(new Error("current-tab capture must not batch browser actions"));
    },
    sleep: () => Promise.reject(new Error("current-tab capture must not wait for navigation")),
  });

  expect(page.finalUrl.href).toBe(currentUrl);
  expect(page.method).toBe(browserLive ? "browser-live" : "browser-cdp");
  expect(page.warnings.join(" ")).toContain("without navigation or interaction");
  expect(batchCalls).toBe(0);
  expect(observed.map(({ command }) => command[0])).toEqual(["get", "read", "eval"]);
  expect(observed.every(({ global }) => global.includes(expectedGlobal))).toBeTrue();
  const forbiddenCommands = new Set(["open", "click", "fill", "type", "upload", "press", "select", "check", "uncheck", "drag"]);
  expect(observed.some(({ command }) => forbiddenCommands.has(command[0] ?? ""))).toBeFalse();
  const evaluated = observed.filter(({ command }) => command[0] === "eval").map(({ command }) => command[1] ?? "").join("\n");
  expect(evaluated).not.toMatch(/\.click\s*\(|scrollTo\s*\(|\.submit\s*\(|requestSubmit\s*\(/);
});

test("current-tab acquisition sanitizes userinfo and credential query state before exposing its URL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-browser-current-url-test-"));
  temporaryDirectories.push(directory);
  const currentUrl = "https://alice:DO_NOT_PRINT@example.com/private?view=all&access_token=SECRET_TOKEN";
  const expectedUrl = "https://example.com/private?view=all";

  const page = await acquireBrowser({
    ...cookieOptions(join(directory, "unused-cookies.json")),
    url: null,
    currentTab: true,
    mode: "browser",
    browserLive: true,
    cookiesFile: undefined,
  }, directory, false, {
    run: (_global, command) => {
      if (command[0] === "get") return Promise.resolve({ url: currentUrl });
      if (command[0] === "read") {
        return Promise.resolve({ content: "Private page", finalUrl: currentUrl, truncated: false });
      }
      if (command[0] === "eval") {
        return Promise.resolve({
          result: {
            url: currentUrl,
            title: "Private page",
            html: "<!doctype html><html><body><main>Private page</main></body></html>",
          },
        });
      }
      throw new Error(`unexpected browser command ${command[0] ?? "missing"}`);
    },
    runBatch: () => Promise.reject(new Error("current-tab capture must not batch browser actions")),
    sleep: () => Promise.reject(new Error("current-tab capture must not wait for navigation")),
  });

  expect(page.finalUrl.href).toBe(expectedUrl);
  expect(JSON.stringify(page)).not.toContain("DO_NOT_PRINT");
  expect(JSON.stringify(page)).not.toContain("SECRET_TOKEN");
});

test("browser navigation provenance fails closed after a navigation command failure", () => {
  const target = new URL("https://target.example/post?id=1");
  const unrelated = new URL("https://private.example/inbox");
  expect(browserNavigationReachedTarget(target, unrelated, unrelated, true)).toBeFalse();
  expect(browserNavigationReachedTarget(target, unrelated, new URL(target), false)).toBeTrue();
  expect(browserNavigationReachedTarget(
    target,
    unrelated,
    new URL("https://private.example/message/2"),
    false,
  )).toBeFalse();
  expect(browserNavigationReachedTarget(
    target,
    new URL("about:blank"),
    new URL("https://identity.example/login?return=target"),
    true,
  )).toBeTrue();
  expect(browserNavigationReachedTarget(target, null, new URL(target), false)).toBeTrue();
  expect(browserNavigationReachedTarget(target, null, new URL("https://identity.example/login"), true)).toBeFalse();
  expect(browserNavigationReachedTarget(target, unrelated, new URL("about:blank"), true)).toBeFalse();
});

test("browser expansion cannot replace the proven capture page", () => {
  const baseline = new URL("https://social.example/post/1?view=thread#top");
  expect(browserExpansionStayedOnPage(baseline, new URL("https://social.example/post/1?view=thread#comments"))).toBeTrue();
  expect(browserExpansionStayedOnPage(baseline, new URL("https://social.example/post/2?view=thread"))).toBeFalse();
  expect(browserExpansionStayedOnPage(baseline, new URL("https://social.example/post/1?view=latest"))).toBeFalse();
  expect(browserExpansionStayedOnPage(baseline, new URL("https://private.example/inbox"))).toBeFalse();
});

test("explicit browser cookie sources suppress ambient Sweet Cookie profile selectors", async () => {
  let observed: unknown;
  const read = createCookieHeaderReader((options) => {
    observed = options;
    return Promise.resolve({
      cookies: [{ name: "session", value: "private", domain: "example.com", hostOnly: true, path: "/account" }],
      warnings: [],
    });
  });
  await read({
    ...cookieOptions("unused"),
    cookiesFile: undefined,
    cookieSources: ["chrome"],
  }, new URL("https://example.com/account"));
  expect(observed).toMatchObject({
    profile: "",
    chromeProfile: "",
    edgeProfile: "",
    firefoxProfile: "",
    browsers: ["chrome"],
    mode: "first",
  });
});

test("persistent profiles cannot enter the repository through a symlinked missing parent", () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-profile-repository-test-"));
  temporaryDirectories.push(directory);
  const repositoryAlias = join(directory, "repository-alias");
  symlinkSync(resolve(import.meta.dir, "..", ".."), repositoryAlias, "dir");
  expect(() => assertSafePersistentProfile({
    ...cookieOptions(join(directory, "unused-cookies.json")),
    browserProfile: join(repositoryAlias, "new-profile"),
    outputBase: join(directory, "output"),
  })).toThrow("outside the repository");
});

test("persistent profile and output confinement canonicalize missing paths below symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-profile-output-test-"));
  temporaryDirectories.push(directory);
  const realOutput = join(directory, "real-output");
  const outputAlias = join(directory, "output-alias");
  mkdirSync(realOutput);
  symlinkSync(realOutput, outputAlias, "dir");
  expect(() => assertSafePersistentProfile({
    ...cookieOptions(join(directory, "unused-cookies.json")),
    browserProfile: join(realOutput, "profiles", "new-profile"),
    outputBase: outputAlias,
  })).toThrow("capture output roots");
});

describe("explicit cookie-file isolation", () => {
  test("authenticated API selection rejects target-inferred cookie files", () => {
    const directory = mkdtempSync(join(tmpdir(), "clip-cookie-scope-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cookies.txt");
    writeFileSync(file, "Cookie: session=private", { mode: 0o600 });
    const read = createCookieRecordReader(() => Promise.reject(new Error("must not probe a browser")));

    expect(read({
      cookieSources: [],
      cookiesFile: file,
      cookieProfile: undefined,
      timeoutMs: 1_000,
      requireExplicitCookieScope: true,
    }, new URL("https://example.com/account"))).rejects.toThrow("explicit domain or URL");
  });

  test("authenticated API selection rejects group/world-readable cookie files", () => {
    const directory = mkdtempSync(join(tmpdir(), "clip-cookie-mode-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cookies.json");
    writeFileSync(file, JSON.stringify([{
      name: "session",
      value: "private",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: true,
    }]), { mode: 0o644 });
    const read = createCookieRecordReader(() => Promise.reject(new Error("must not probe a browser")));

    expect(read({
      cookieSources: [],
      cookiesFile: file,
      cookieProfile: undefined,
      timeoutMs: 1_000,
      requireExplicitCookieScope: true,
    }, new URL("https://example.com/account"))).rejects.toThrow("no usable cookies");
  });

  test("an invalid file fails closed without probing any browser provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clip-cookie-acquire-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cookies.txt");
    writeFileSync(file, "not a supported cookie payload\n", { mode: 0o600 });
    let browserProbes = 0;
    const read = createCookieHeaderReader(() => {
      browserProbes += 1;
      return Promise.resolve({ cookies: [], warnings: [] });
    });

    let message = "";
    try {
      await read(cookieOptions(file), new URL("https://example.com/account"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("no usable cookies");
    expect(browserProbes).toBe(0);
  });

  test("provider failures never expose raw error values", async () => {
    const read = createCookieHeaderReader(() => Promise.reject(new Error("provider leaked SECRET_VALUE")));
    const options = { ...cookieOptions("unused"), cookiesFile: undefined, cookieSources: ["chrome"] as const };
    let message = "";
    try {
      await read(options, new URL("https://example.com/account"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("SECRET_VALUE");
    expect(message).toContain("could not be read");
  });

  test("maps Safari's explicit profile to Sweet Cookie's cookie-file option", async () => {
    let safariCookiesFile: string | undefined;
    const read = createCookieHeaderReader((options) => {
      safariCookiesFile = typeof options.safariCookiesFile === "string" ? options.safariCookiesFile : undefined;
      return Promise.resolve({
        cookies: [{
          name: "session",
          value: "private",
          domain: "example.com",
          hostOnly: true,
          path: "/",
          secure: true,
          expires: Math.floor(Date.now() / 1_000) + 3_600,
        }],
        warnings: [],
      });
    });
    await read({
      ...cookieOptions("unused"),
      cookiesFile: undefined,
      cookieSources: ["safari"] as const,
      cookieProfile: "/private/Cookies.binarycookies",
    }, new URL("https://example.com/account"));
    expect(safariCookiesFile).toBe("/private/Cookies.binarycookies");
  });
});
