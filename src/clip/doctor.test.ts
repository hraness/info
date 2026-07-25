import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterCapabilities,
  inspectClipEnvironment,
  renderAdapterCapabilities,
  renderDoctorReport,
  runDiagnosticCommand,
  type DiagnosticCommand,
} from "./doctor.js";
import { classifiedPlatforms } from "./platforms.js";

function packageManifest(name: string, version: string): string {
  return JSON.stringify({ name, version });
}

describe("clip doctor", () => {
  test("reports pinned dependencies, derive-client, tools, browsers, and profile display names without probing secrets", async () => {
    const consumerRoot = "/repo";
    const packageRoot = join(consumerRoot, "node_modules", "@cclrte", "oh");
    const homeDirectory = "/Users/tester";
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({
        dependencies: {
          defuddle: "^0.19.1",
          "agent-browser": "0.32.3",
          "@steipete/sweet-cookie": "github:hraness/sweet-cookie#0123456789012345678901234567890123456789",
        },
      })],
      [join(consumerRoot, "node_modules", "defuddle", "package.json"), packageManifest("defuddle", "0.19.1")],
      [join(consumerRoot, "node_modules", "agent-browser", "package.json"), packageManifest("agent-browser", "0.32.3")],
      [
        join(consumerRoot, "node_modules", "@steipete", "sweet-cookie", "package.json"),
        packageManifest("@steipete/sweet-cookie", "0.4.0"),
      ],
    ]);
    const agentExecutable = join(consumerRoot, "node_modules", "agent-browser", "bin", "agent-browser.js");
    const existing = new Set([
      ...files.keys(),
      agentExecutable,
      "/Applications/Google Chrome.app",
      join(homeDirectory, ".local", "bin", "yt-dlp"),
      "/opt/homebrew/bin/pdfinfo",
      "/opt/homebrew/bin/pdftohtml",
      "/opt/homebrew/bin/tesseract",
    ]);
    const commands: string[][] = [];
    const run = ({ command }: DiagnosticCommand) => {
      commands.push([...command]);
      if (command.includes("skills")) {
        return Promise.resolve({
          stdout: `${JSON.stringify({ success: true, data: [{ name: "core" }, { name: "derive-client" }] })}\n`,
          stderr: "",
          exitCode: 0,
        });
      }
      if (command.includes("profiles")) {
        return Promise.resolve({
          stdout: JSON.stringify({
            success: true,
            data: [
              { name: "Work", directory: "/secret/chrome/Profile 9", cookie: "never-report-me" },
              { name: "Personal", directory: "Default" },
            ],
          }),
          stderr: "",
          exitCode: 0,
        });
      }
      if (command[0]?.endsWith("yt-dlp")) {
        return Promise.resolve({ stdout: "2026.03.17\n", stderr: "", exitCode: 0 });
      }
      if (command[0]?.endsWith("pdfinfo")) {
        return Promise.resolve({ stdout: "", stderr: "pdfinfo version 25.07.0\n", exitCode: 0 });
      }
      if (command[0]?.endsWith("pdftohtml")) {
        return Promise.resolve({ stdout: "", stderr: "pdftohtml version 25.07.0\n", exitCode: 0 });
      }
      if (command[0]?.endsWith("tesseract")) {
        return Promise.resolve({ stdout: "tesseract 5.5.1\n", stderr: "", exitCode: 0 });
      }
      return Promise.reject(new Error(`unexpected command: ${command.join(" ")}`));
    };

    const report = await inspectClipEnvironment({
      packageRoot,
      homeDirectory,
      platform: "darwin",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-07-21T12:00:00.000Z"),
      exists: (path) => existing.has(path),
      readText: (path) => {
        const fixture = files.get(path);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture;
      },
      which: () => null,
      run,
    });

    expect(report.bun.status).toBe("ready");
    expect(report.dependencies.every(({ status }) => status === "ready")).toBeTrue();
    expect(report.deriveClient).toEqual({ available: true, status: "ready" });
    expect(report.browsers.map(({ name }) => name)).toEqual([
      "Google Chrome",
      "Chromium",
      "Microsoft Edge",
      "Arc",
    ]);
    expect(report.browsers.find(({ name }) => name === "Google Chrome")).toMatchObject({
      paths: ["/Applications/Google Chrome.app"],
      status: "ready",
    });
    expect(report.chromeProfileNames).toEqual(["Personal", "Work"]);
    expect(report.tools.find(({ name }) => name === "yt-dlp")).toMatchObject({ status: "ready", version: "2026.03.17" });
    expect(report.tools.find(({ name }) => name === "ffmpeg")?.status).toBe("unavailable");
    expect(report.tools.find(({ name }) => name === "pdfinfo")).toMatchObject({
      status: "ready",
      version: "pdfinfo version 25.07.0",
    });
    expect(report.tools.find(({ name }) => name === "pdftohtml")).toMatchObject({
      status: "ready",
      version: "pdftohtml version 25.07.0",
    });
    expect(report.tools.find(({ name }) => name === "tesseract")).toMatchObject({
      status: "ready",
      version: "tesseract 5.5.1",
    });
    expect(JSON.stringify(report)).not.toContain("never-report-me");
    expect(JSON.stringify(report)).not.toContain("/secret/chrome");
    expect(commands.every((command) => command.every((argument) => !/cookie|keychain/i.test(argument)))).toBeTrue();
  });

  test("renders actionable mismatches and states that secret stores were not probed", async () => {
    const report = await inspectClipEnvironment({
      packageRoot: "/empty",
      homeDirectory: "/empty-home",
      platform: "darwin",
      currentBunVersion: "1.2.0",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: () => false,
      readText: () => { throw new Error("missing"); },
      which: () => null,
      run: () => Promise.reject(new Error("must not run")),
    });
    const rendered = renderDoctorReport(report);
    expect(report.dependencies.every(({ status }) => status === "unavailable")).toBeTrue();
    expect(rendered).toContain("Use Bun 1.3.14");
    expect(rendered).toContain("Cookie/keychain probe: not performed");
    expect(rendered).toContain("Install Google Chrome or Chromium for rendered capture");
    expect(rendered).toContain("Install yt-dlp");
    expect(rendered).toContain("oh pdf requires both pdfinfo and pdftohtml");
    expect(rendered).toContain("oh pdf still preserves native text and images without OCR");
  });

  test("discovers Chromium on Linux through an injected executable lookup", async () => {
    const chromiumPath = "/usr/bin/chromium";
    const report = await inspectClipEnvironment({
      packageRoot: "/empty",
      homeDirectory: "/home/tester",
      platform: "linux",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: (path) => path === chromiumPath,
      readText: () => { throw new Error("missing"); },
      which: (executable) => executable === "chromium" ? chromiumPath : null,
      run: () => Promise.reject(new Error("must not run")),
    });

    expect(report.browsers.find(({ name }) => name === "Chromium")).toEqual({
      name: "Chromium",
      paths: [chromiumPath],
      status: "ready",
    });
    expect(report.browsers.filter(({ name }) => name !== "Chromium").every(({ status }) =>
      status === "unavailable"
    )).toBeTrue();
    expect(report.warnings.some((warning) =>
      warning.includes("Install Google Chrome or Chromium for rendered capture")
    )).toBeFalse();
  });
});

test("adapter matrix names every promised surface and communicates bounded access", () => {
  const rendered = renderAdapterCapabilities();
  for (const platform of [
    "Generic web",
    "X",
    "Substack",
    "Instagram",
    "LinkedIn",
    "Signed-in pages",
    "Hacker News",
    "Reddit",
    "Facebook",
    "TikTok",
    "Bluesky",
    "Threads",
    "WhatsApp Web",
    "YouTube",
    "GitHub issues, pull requests, and discussions",
    "Discourse",
  ]) {
    expect(adapterCapabilities.some((capability) => capability.platform === platform)).toBeTrue();
    expect(rendered).toContain(platform);
  }
  expect(adapterCapabilities.find(({ platform }) => platform === "Generic web")?.conversations).toBe("best-effort");
  for (const platform of classifiedPlatforms) {
    expect(adapterCapabilities.some(({ id }) => id === platform)).toBeTrue();
  }
  expect(rendered).toContain("site-specific item trees are not inferred generically");
  expect(rendered).toContain("current browser tab");
  expect(rendered).toContain("ingestion-only");
  expect(rendered).toContain("yt-dlp metadata + thumbnail + transcript");
  expect(rendered).toContain("Full audio/video download remains opt-in with --media all");
});

test("diagnostic timeouts escalate to SIGKILL when a child ignores SIGTERM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-doctor-runner-"));
  const fixture = join(directory, "ignore-term.sh");
  writeFileSync(fixture, "trap '' TERM\nwhile :; do :; done\n");
  const startedAt = Date.now();
  try {
    let failure: unknown;
    try {
      await runDiagnosticCommand({
        command: ["/bin/sh", fixture],
        timeoutMs: 1_000,
        maxOutputBytes: 4_096,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain("timed out");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
