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
    const packageRoot = join(consumerRoot, "node_modules", "@hraness", "kb");
    const qmdRoot = join(consumerRoot, "node_modules", "@tobilu", "qmd");
    const nodeLlamaCppRoot = join(qmdRoot, "node_modules", "node-llama-cpp");
    const nativeEmbeddingRoot = join(
      nodeLlamaCppRoot,
      "node_modules",
      "@node-llama-cpp",
      "mac-arm64-metal",
    );
    const homeDirectory = "/Users/tester";
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({
        dependencies: {
          defuddle: "^0.19.1",
          "agent-browser": "0.32.3",
          "@steipete/sweet-cookie": "github:hraness/sweet-cookie#0123456789012345678901234567890123456789",
          "@tobilu/qmd": "2.5.3",
        },
      })],
      [join(consumerRoot, "node_modules", "defuddle", "package.json"), packageManifest("defuddle", "0.19.1")],
      [join(consumerRoot, "node_modules", "agent-browser", "package.json"), packageManifest("agent-browser", "0.32.3")],
      [
        join(consumerRoot, "node_modules", "@steipete", "sweet-cookie", "package.json"),
        packageManifest("@steipete/sweet-cookie", "0.4.0"),
      ],
      [join(qmdRoot, "package.json"), packageManifest("@tobilu/qmd", "2.5.3")],
      [join(qmdRoot, "node_modules", "sqlite-vec", "package.json"), packageManifest("sqlite-vec", "0.1.9")],
      [
        join(qmdRoot, "node_modules", "sqlite-vec-darwin-arm64", "package.json"),
        packageManifest("sqlite-vec-darwin-arm64", "0.1.9"),
      ],
      [join(nodeLlamaCppRoot, "package.json"), packageManifest("node-llama-cpp", "3.18.1")],
      [
        join(nativeEmbeddingRoot, "package.json"),
        packageManifest("@node-llama-cpp/mac-arm64-metal", "3.18.1"),
      ],
    ]);
    const agentExecutable = join(consumerRoot, "node_modules", "agent-browser", "bin", "agent-browser.js");
    const existing = new Set([
      ...files.keys(),
      agentExecutable,
      join(qmdRoot, "node_modules", "sqlite-vec-darwin-arm64", "vec0.dylib"),
      join(nativeEmbeddingRoot, "bins", "mac-arm64-metal", "llama-addon.node"),
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
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
      architecture: "arm64",
      runtime: "bun",
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
    expect(report.schemaVersion).toBe(2);
    expect(report.dependencies.every(({ status }) => status === "ready")).toBeTrue();
    expect(report.dependencies.find(({ name }) => name === "@tobilu/qmd")).toEqual({
      name: "@tobilu/qmd",
      expectedVersion: "2.5.3",
      declaredVersion: "2.5.3",
      installedVersion: "2.5.3",
      status: "ready",
    });
    expect(report.search.keywordOnly).toEqual({ status: "ready", modelRequired: false });
    expect(report.search.semanticPrerequisites).toMatchObject({
      status: "ready",
      sqlite: {
        provider: "homebrew",
        selectedLibraryPath: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        status: "ready",
      },
      sqliteVec: {
        expectedVersion: "0.1.9",
        installedVersion: "0.1.9",
        nativePackageName: "sqlite-vec-darwin-arm64",
        nativeInstalledVersion: "0.1.9",
        nativeBinaryPresent: true,
        status: "ready",
      },
      embeddingRuntime: {
        expectedVersion: "3.18.1",
        installedVersion: "3.18.1",
        nativePackageName: "@node-llama-cpp/mac-arm64-metal",
        nativeInstalledVersion: "3.18.1",
        nativeBinaryPresent: true,
        status: "ready",
      },
      embeddingModel: { cacheStatus: "not-inspected" },
    });
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

  test("reports missing QMD without loading it or claiming an embedding model is cached", async () => {
    let commandWasRun = false;
    const report = await inspectClipEnvironment({
      packageRoot: "/empty",
      homeDirectory: "/empty-home",
      platform: "linux",
      architecture: "x64",
      runtime: "bun",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: () => false,
      readText: () => { throw new Error("missing"); },
      which: () => null,
      run: () => {
        commandWasRun = true;
        return Promise.reject(new Error("must not run"));
      },
    });

    expect(report.schemaVersion).toBe(2);
    expect(report.dependencies.find(({ name }) => name === "@tobilu/qmd")).toEqual({
      name: "@tobilu/qmd",
      expectedVersion: "2.5.3",
      declaredVersion: null,
      installedVersion: null,
      status: "unavailable",
    });
    expect(report.search.keywordOnly.status).toBe("unavailable");
    expect(report.search.semanticPrerequisites.status).toBe("unavailable");
    expect(report.search.semanticPrerequisites.embeddingModel.cacheStatus).toBe("not-inspected");
    expect(commandWasRun).toBeFalse();
  });

  test("does not claim semantic readiness when node-llama-cpp is missing", async () => {
    const consumerRoot = "/repo";
    const packageRoot = join(consumerRoot, "node_modules", "@hraness", "kb");
    const qmdRoot = join(consumerRoot, "node_modules", "@tobilu", "qmd");
    const sqliteVecRoot = join(qmdRoot, "node_modules", "sqlite-vec");
    const nativeSqliteVecRoot = join(qmdRoot, "node_modules", "sqlite-vec-darwin-arm64");
    const homebrewSqlite = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "@tobilu/qmd": "2.5.3" } })],
      [join(qmdRoot, "package.json"), packageManifest("@tobilu/qmd", "2.5.3")],
      [join(sqliteVecRoot, "package.json"), packageManifest("sqlite-vec", "0.1.9")],
      [join(nativeSqliteVecRoot, "package.json"), packageManifest("sqlite-vec-darwin-arm64", "0.1.9")],
    ]);
    const existing = new Set([
      ...files.keys(),
      join(nativeSqliteVecRoot, "vec0.dylib"),
      homebrewSqlite,
    ]);

    const report = await inspectClipEnvironment({
      packageRoot,
      homeDirectory: "/empty-home",
      platform: "darwin",
      architecture: "arm64",
      runtime: "bun",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: (path) => existing.has(path),
      readText: (path) => {
        const fixture = files.get(path);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture;
      },
      which: () => null,
      run: () => Promise.reject(new Error("must not run")),
    });

    expect(report.search.keywordOnly.status).toBe("ready");
    expect(report.search.semanticPrerequisites.sqlite.status).toBe("ready");
    expect(report.search.semanticPrerequisites.sqliteVec.status).toBe("ready");
    expect(report.search.semanticPrerequisites.embeddingRuntime).toEqual({
      expectedVersion: "3.18.1",
      installedVersion: null,
      nativePackageName: "@node-llama-cpp/mac-arm64-metal",
      nativeInstalledVersion: null,
      nativeBinaryPresent: null,
      status: "unavailable",
    });
    expect(report.search.semanticPrerequisites.status).toBe("unavailable");
    expect(report.warnings).toContain(
      "Reinstall @hraness/kb with Bun so node-llama-cpp 3.18.1 and @node-llama-cpp/mac-arm64-metal 3.18.1 with its native binary are installed; semantic and hybrid vector retrieval are not ready. Keyword-only QMD search remains available.",
    );
  });

  test("reports mismatched embedding runtime packages as partial without loading native code", async () => {
    const consumerRoot = "/repo";
    const packageRoot = join(consumerRoot, "node_modules", "@hraness", "kb");
    const qmdRoot = join(consumerRoot, "node_modules", "@tobilu", "qmd");
    const sqliteVecRoot = join(qmdRoot, "node_modules", "sqlite-vec");
    const nativeSqliteVecRoot = join(qmdRoot, "node_modules", "sqlite-vec-linux-x64");
    const nodeLlamaCppRoot = join(qmdRoot, "node_modules", "node-llama-cpp");
    const nativeEmbeddingRoot = join(
      nodeLlamaCppRoot,
      "node_modules",
      "@node-llama-cpp",
      "linux-x64",
    );
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "@tobilu/qmd": "2.5.3" } })],
      [join(qmdRoot, "package.json"), packageManifest("@tobilu/qmd", "2.5.3")],
      [join(sqliteVecRoot, "package.json"), packageManifest("sqlite-vec", "0.1.9")],
      [join(nativeSqliteVecRoot, "package.json"), packageManifest("sqlite-vec-linux-x64", "0.1.9")],
      [join(nodeLlamaCppRoot, "package.json"), packageManifest("node-llama-cpp", "3.17.0")],
      [
        join(nativeEmbeddingRoot, "package.json"),
        packageManifest("@node-llama-cpp/linux-x64", "3.18.0"),
      ],
    ]);
    const existing = new Set([
      ...files.keys(),
      join(nativeSqliteVecRoot, "vec0.so"),
      join(nativeEmbeddingRoot, "bins", "linux-x64", "llama-addon.node"),
    ]);
    const readPaths: string[] = [];

    const report = await inspectClipEnvironment({
      packageRoot,
      homeDirectory: "/empty-home",
      platform: "linux",
      architecture: "x64",
      runtime: "bun",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: (path) => existing.has(path),
      readText: (path) => {
        readPaths.push(path);
        const fixture = files.get(path);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture;
      },
      which: () => null,
      run: () => Promise.reject(new Error("must not run")),
    });

    expect(report.search.semanticPrerequisites.embeddingRuntime).toEqual({
      expectedVersion: "3.18.1",
      installedVersion: "3.17.0",
      nativePackageName: "@node-llama-cpp/linux-x64",
      nativeInstalledVersion: "3.18.0",
      nativeBinaryPresent: true,
      status: "partial",
    });
    expect(report.search.semanticPrerequisites.status).toBe("partial");
    expect(report.warnings.some((warning) => warning.includes("@node-llama-cpp/linux-x64 3.18.1"))).toBeTrue();
    expect(readPaths.every((path) => path.endsWith("package.json"))).toBeTrue();
  });

  test("keeps keyword-only search ready when macOS Bun lacks extension-capable Homebrew SQLite", async () => {
    const consumerRoot = "/repo";
    const packageRoot = join(consumerRoot, "node_modules", "@hraness", "kb");
    const qmdRoot = join(consumerRoot, "node_modules", "@tobilu", "qmd");
    const nativeRoot = join(qmdRoot, "node_modules", "sqlite-vec-darwin-arm64");
    const nodeLlamaCppRoot = join(qmdRoot, "node_modules", "node-llama-cpp");
    const nativeEmbeddingRoot = join(
      nodeLlamaCppRoot,
      "node_modules",
      "@node-llama-cpp",
      "mac-arm64-metal",
    );
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "@tobilu/qmd": "2.5.3" } })],
      [join(qmdRoot, "package.json"), packageManifest("@tobilu/qmd", "2.5.3")],
      [join(qmdRoot, "node_modules", "sqlite-vec", "package.json"), packageManifest("sqlite-vec", "0.1.9")],
      [join(nativeRoot, "package.json"), packageManifest("sqlite-vec-darwin-arm64", "0.1.9")],
      [join(nodeLlamaCppRoot, "package.json"), packageManifest("node-llama-cpp", "3.18.1")],
      [
        join(nativeEmbeddingRoot, "package.json"),
        packageManifest("@node-llama-cpp/mac-arm64-metal", "3.18.1"),
      ],
    ]);
    const existing = new Set([
      ...files.keys(),
      join(nativeRoot, "vec0.dylib"),
      join(nativeEmbeddingRoot, "bins", "mac-arm64-metal", "llama-addon.node"),
    ]);

    const report = await inspectClipEnvironment({
      packageRoot,
      homeDirectory: "/empty-home",
      platform: "darwin",
      architecture: "arm64",
      runtime: "bun",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: (path) => existing.has(path),
      readText: (path) => {
        const fixture = files.get(path);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture;
      },
      which: () => null,
      run: () => Promise.reject(new Error("must not run")),
    });

    expect(report.search.keywordOnly).toEqual({ status: "ready", modelRequired: false });
    expect(report.search.semanticPrerequisites.sqlite).toMatchObject({
      provider: "homebrew",
      searchedLibraryPaths: [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ],
      selectedLibraryPath: null,
      status: "unavailable",
    });
    expect(report.search.semanticPrerequisites.sqliteVec.status).toBe("ready");
    expect(report.search.semanticPrerequisites.status).toBe("unavailable");
    expect(report.warnings).toContain(
      "Install Homebrew SQLite with `brew install sqlite`; semantic and hybrid vector retrieval are unavailable. Keyword-only QMD search remains available.",
    );
  });

  test("finds semantic prerequisites beside QMD's canonical Bun package without inspecting or downloading a model", async () => {
    const consumerRoot = "/repo";
    const packageRoot = join(consumerRoot, "node_modules", "@hraness", "kb");
    const qmdRoot = join(consumerRoot, "node_modules", "@tobilu", "qmd");
    const bunPackageRoot = "/bun-store/@tobilu+qmd@2.5.3";
    const canonicalQmdRoot = join(bunPackageRoot, "node_modules", "@tobilu", "qmd");
    const nativeRoot = join(bunPackageRoot, "node_modules", "sqlite-vec-darwin-arm64");
    const nodeLlamaCppRoot = join(bunPackageRoot, "node_modules", "node-llama-cpp");
    const nodeLlamaCppPackageRoot = "/bun-store/node-llama-cpp@3.18.1";
    const canonicalNodeLlamaCppRoot = join(nodeLlamaCppPackageRoot, "node_modules", "node-llama-cpp");
    const nativeEmbeddingRoot = join(
      nodeLlamaCppPackageRoot,
      "node_modules",
      "@node-llama-cpp",
      "mac-arm64-metal",
    );
    const homebrewSqlite = "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
    const files = new Map<string, string>([
      [join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "@tobilu/qmd": "2.5.3" } })],
      [join(qmdRoot, "package.json"), packageManifest("@tobilu/qmd", "2.5.3")],
      [join(bunPackageRoot, "node_modules", "sqlite-vec", "package.json"), packageManifest("sqlite-vec", "0.1.9")],
      [join(nativeRoot, "package.json"), packageManifest("sqlite-vec-darwin-arm64", "0.1.9")],
      [join(nodeLlamaCppRoot, "package.json"), packageManifest("node-llama-cpp", "3.18.1")],
      [
        join(nativeEmbeddingRoot, "package.json"),
        packageManifest("@node-llama-cpp/mac-arm64-metal", "3.18.1"),
      ],
    ]);
    const existing = new Set([
      ...files.keys(),
      join(nativeRoot, "vec0.dylib"),
      join(nativeEmbeddingRoot, "bins", "mac-arm64-metal", "llama-addon.node"),
      homebrewSqlite,
    ]);
    let commandWasRun = false;

    const report = await inspectClipEnvironment({
      packageRoot,
      homeDirectory: "/empty-home",
      platform: "darwin",
      architecture: "arm64",
      runtime: "bun",
      currentBunVersion: "1.3.14",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      exists: (path) => existing.has(path),
      readText: (path) => {
        const fixture = files.get(path);
        if (fixture === undefined) throw new Error("missing fixture");
        return fixture;
      },
      realpath: (path) => {
        if (path === qmdRoot) return canonicalQmdRoot;
        if (path === nodeLlamaCppRoot) return canonicalNodeLlamaCppRoot;
        return path;
      },
      which: () => null,
      run: () => {
        commandWasRun = true;
        return Promise.reject(new Error("must not run"));
      },
    });

    expect(report.search.semanticPrerequisites.status).toBe("ready");
    expect(report.search.semanticPrerequisites.sqlite.selectedLibraryPath).toBe(homebrewSqlite);
    expect(report.search.semanticPrerequisites.embeddingRuntime).toMatchObject({
      status: "ready",
      installedVersion: "3.18.1",
      nativePackageName: "@node-llama-cpp/mac-arm64-metal",
      nativeInstalledVersion: "3.18.1",
      nativeBinaryPresent: true,
    });
    expect(report.search.semanticPrerequisites.embeddingModel).toEqual({ cacheStatus: "not-inspected" });
    expect(renderDoctorReport(report)).toContain("Embedding model cache: not inspected");
    expect(commandWasRun).toBeFalse();
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
    expect(rendered).toContain("kb pdf requires both pdfinfo and pdftohtml");
    expect(rendered).toContain("kb pdf still preserves native text and images without OCR");
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
