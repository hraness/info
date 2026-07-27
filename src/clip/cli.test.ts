import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localizeAssets } from "./assets.js";
import { captureExitCode, captureSummary, main } from "./cli.js";
import { runCapture, type CaptureOutcome } from "./capture.js";
import { hasUnsafeTerminalCharacters } from "./terminal.js";

const outcome = (status: CaptureOutcome["status"]): CaptureOutcome => ({
  status,
  sourceUrl: "https://example.com/?access_token=supersecret",
  canonicalUrl: "https://example.com/",
  platform: "generic",
  scope: "page",
  slug: "example",
  acquisitionMethod: "http",
  extractor: "fixture",
  wordCount: 10,
  capturedItems: 1,
  expectedItems: null,
  outputDirectory: null,
  markdownPath: null,
  assetCount: 0,
  warnings: ["authorization: Bearer warning-secret"],
  attempts: [{ method: "fixture", outcome: "failed", message: "token=attempt-secret" }],
  markdown: "body\n",
  manifest: null,
});

describe("clip CLI", () => {
  test("uses stable status exit codes", () => {
    expect(captureExitCode(outcome("complete"))).toBe(0);
    expect(captureExitCode(outcome("partial"))).toBe(0);
    expect(captureExitCode(outcome("auth-required"))).toBe(3);
    expect(captureExitCode(outcome("blocked"))).toBe(3);
    expect(captureExitCode(outcome("unsupported"))).toBe(3);
    expect(captureSummary(outcome("complete"))).toMatchObject({ ok: true, status: "complete" });
    expect(captureSummary(outcome("partial"))).toMatchObject({ ok: true, status: "partial" });
    expect(captureSummary(outcome("auth-required"))).toMatchObject({ ok: false, status: "auth-required" });
    expect(captureSummary(outcome("blocked"))).toMatchObject({ ok: false, status: "blocked" });
    expect(captureSummary(outcome("unsupported"))).toMatchObject({ ok: false, status: "unsupported" });
  });

  test("returns a successful JSON summary for a bounded generic rendered-page fallback", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      [
        "inspect",
        "https://app.example.test/feed",
        "--mode",
        "browser",
        "--scope",
        "page",
        "--json",
      ],
      {},
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      {
        runCapture: (options) => runCapture(options, {
          acquireBrowser: () => Promise.resolve({
            body: "<!doctype html><html><head><title>Signed-in workspace</title></head><body><main>Loading</main></body></html>",
            contentType: "text/html; charset=utf-8",
            finalUrl: new URL("https://app.example.test/feed"),
            method: "browser-fresh",
            warnings: [],
            browserTitle: "Signed-in workspace",
            renderedText: [
              "# Signed-in workspace",
              "Home Projects Activity Profile",
              "A useful authenticated feed card is visible in this bounded synthetic fixture.",
              "Another visible card provides enough generic page text for a useful read result.",
            ].join("\n\n"),
          }),
          now: () => new Date("2026-07-21T12:00:00Z"),
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr.join("")).toContain("cannot prove feed completeness");
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      status: "partial",
      platform: "generic",
      scope: "page",
      acquisitionMethod: "browser-fresh",
      capturedItems: 1,
      expectedItems: null,
    });
    expect((JSON.parse(stdout.join("")) as { extractor: string }).extractor).toEndWith("rendered-page");
  }, 30_000);

  test("returns machine-readable false results for unsupported outcomes and runtime failures", async () => {
    const unsupportedOutput: string[] = [];
    expect(await main(
      ["inspect", "https://example.com/unsupported", "--json"],
      {},
      { stdout: (value) => unsupportedOutput.push(value), stderr: () => undefined },
      { runCapture: () => Promise.resolve(outcome("unsupported")) },
    )).toBe(3);
    expect(JSON.parse(unsupportedOutput.join(""))).toMatchObject({ ok: false, status: "unsupported" });

    const failedOutput: string[] = [];
    const failedErrors: string[] = [];
    expect(await main(
      ["inspect", "https://example.com/failure", "--json"],
      {},
      { stdout: (value) => failedOutput.push(value), stderr: (value) => failedErrors.push(value) },
      { runCapture: () => Promise.reject(new Error("authorization: Bearer runtime-secret")) },
    )).toBe(1);
    const failed = JSON.parse(failedOutput.join("")) as { ok: boolean; error: string };
    expect(failed.ok).toBeFalse();
    expect(failed.error).toContain("REDACTED");
    expect(failed.error).not.toContain("runtime-secret");
    expect(failedErrors).toEqual([]);
  });

  test("marks only an embedding-provided profile clone as owned", async () => {
    let observed: unknown;
    const code = await main(
      [
        "inspect",
        "https://example.com/private",
        "--mode", "browser",
        "--browser-profile", "/private/owned-profile",
        "--json",
      ],
      {},
      { stdout: () => undefined, stderr: () => undefined },
      {
        runCapture: (options) => {
          observed = options;
          return Promise.resolve(outcome("partial"));
        },
      },
      {
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ownedBrowserProfile: { path: "/private/owned-profile", profileDirectory: "Default" },
      },
    );
    expect(code).toBe(0);
    expect(observed).toMatchObject({
      browserProfile: "/private/owned-profile",
      browserProfileOwnership: "owned",
      browserProfileDirectory: "Default",
      browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    });

    let publicObserved: unknown;
    expect(await main(
      ["inspect", "https://example.com/private", "--mode", "browser", "--browser-profile", "/private/source-profile"],
      {},
      { stdout: () => undefined, stderr: () => undefined },
      {
        runCapture: (options) => {
          publicObserved = options;
          return Promise.resolve(outcome("partial"));
        },
      },
    )).toBe(0);
    expect(publicObserved).not.toHaveProperty("browserProfileOwnership");

    let mismatchedCaptureCalled = false;
    const mismatchedOutput: string[] = [];
    expect(await main(
      ["inspect", "https://example.com/private", "--mode", "browser", "--browser-profile", "/private/selected", "--json"],
      {},
      { stdout: (value) => mismatchedOutput.push(value), stderr: () => undefined },
      {
        runCapture: () => {
          mismatchedCaptureCalled = true;
          return Promise.resolve(outcome("partial"));
        },
      },
      { ownedBrowserProfile: { path: "/private/different" } },
    )).toBe(1);
    expect(mismatchedCaptureCalled).toBeFalse();
    const mismatched = JSON.parse(mismatchedOutput.join("")) as { readonly ok: unknown; readonly error: unknown };
    expect(mismatched.ok).toBeFalse();
    expect(mismatched.error).toBeString();
    expect(typeof mismatched.error === "string" ? mismatched.error : "").toContain("does not match");
  });

  test("redacts credential-shaped source query values from JSON summaries", () => {
    const summary = JSON.stringify(captureSummary(outcome("complete")));
    expect(summary).not.toContain("supersecret");
    expect(summary).not.toContain("warning-secret");
    expect(summary).not.toContain("attempt-secret");
    expect(summary).toContain("REDACTED");
  });

  test("prints help and rejects malformed arguments without doing capture work", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await main(["help"], {}, { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) })).toBe(0);
    expect(stdout.join("")).toContain("kb clip");
    expect(await main(["ftp://example.com"], {}, { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) })).toBe(2);
    expect(stderr.join("")).toContain("must use http or https");
  });

  test("neutralizes hostile scraped controls across Markdown and warning terminal output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clip-terminal-output-"));
    const osc52 = "\u001b]52;c;c3RlYWwtY2xpcGJvYXJk\u0007";
    const bidi = "\u202etxt.exe\u202c";
    try {
      const localized = await localizeAssets("![bad](https://images.example/bad.jpg)", {
        assetsDirectory: directory,
        baseUrl: new URL("https://example.com/post"),
        userAgent: "test",
        timeoutMs: 1_000,
        maxAssetBytes: 1_024,
        maxTotalAssetBytes: 1_024,
        allowPrivateNetwork: false,
        fetchResource: (url) => Promise.resolve({
          bytes: new TextEncoder().encode("not an image"),
          finalUrl: url,
          status: 200,
          contentType: `text/html ${osc52}${bidi}`,
          etag: null,
          lastModified: null,
        }),
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const hostileOutcome: CaptureOutcome = {
        ...outcome("complete"),
        markdown: `Café 漢字 🙂\nBefore ${osc52}${bidi} after\n`,
        warnings: localized.warnings,
      };
      expect(await main(
        ["inspect", "https://example.com"],
        {},
        { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
        { runCapture: () => Promise.resolve(hostileOutcome) },
      )).toBe(0);
      const terminalOutput = `${stdout.join("")}\n${stderr.join("")}`;
      expect(terminalOutput).toContain("Café 漢字 🙂");
      expect(terminalOutput).toContain("Before txt.exe after");
      expect(terminalOutput).not.toContain("c3RlYWwtY2xpcGJvYXJk");
      expect(hasUnsafeTerminalCharacters(terminalOutput)).toBeFalse();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps JSON valid while removing bidi controls from every string leaf", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const hostileOutcome: CaptureOutcome = {
      ...outcome("complete"),
      slug: "safe\u202espoofed\u2066",
      warnings: ["warning \u202etxt.exe\u202c"],
    };
    expect(await main(
      ["inspect", "https://example.com", "--json"],
      {},
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      { runCapture: () => Promise.resolve(hostileOutcome) },
    )).toBe(0);

    const rendered = stdout.join("");
    const parsed = JSON.parse(rendered) as unknown;
    expect(parsed).toBeDefined();
    expect(rendered).toContain("safespoofed");
    expect(hasUnsafeTerminalCharacters(`${rendered}${stderr.join("")}`)).toBeFalse();
  });
});
