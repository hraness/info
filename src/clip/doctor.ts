import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isolatedAgentBrowserEnvironment } from "./acquire.js";
import { BoundedByteBuffer } from "./bounded-byte-buffer.js";
import { findKbPackageRoot } from "./package-root.js";
import type { Platform } from "./platforms.js";

export const expectedBunVersion = "1.3.14" as const;
export const expectedQmdVersion = "2.5.3" as const;
export const expectedSqliteVecVersion = "0.1.9" as const;
export const expectedNodeLlamaCppVersion = "3.18.1" as const;

const expectedBetterSqliteVersion = "12.10.0" as const;
const homebrewSqliteLibraryPaths = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
] as const;

export type CapabilityStatus = "ready" | "partial" | "unavailable";

export type DependencyReport = {
  readonly name: "defuddle" | "agent-browser" | "@steipete/sweet-cookie" | "@tobilu/qmd";
  readonly expectedVersion: string;
  readonly declaredVersion: string | null;
  readonly installedVersion: string | null;
  readonly status: CapabilityStatus;
};

export type SearchReadinessReport = {
  readonly runtime: "bun" | "node";
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  /** Keyword-only QMD search does not initialize or require an embedding model. */
  readonly keywordOnly: {
    readonly status: CapabilityStatus;
    readonly modelRequired: false;
  };
  /** Static prerequisites only. Doctor never loads sqlite-vec or an embedding model. */
  readonly semanticPrerequisites: {
    readonly status: CapabilityStatus;
    readonly sqlite: {
      readonly provider: "bun-built-in" | "homebrew" | "better-sqlite3";
      readonly expectedVersion: string | null;
      readonly installedVersion: string | null;
      readonly searchedLibraryPaths: readonly string[];
      readonly selectedLibraryPath: string | null;
      readonly nativeBindingPresent: boolean | null;
      readonly status: CapabilityStatus;
    };
    readonly sqliteVec: {
      readonly expectedVersion: typeof expectedSqliteVecVersion;
      readonly installedVersion: string | null;
      readonly nativePackageName: string | null;
      readonly nativeInstalledVersion: string | null;
      readonly nativeBinaryPresent: boolean | null;
      readonly status: CapabilityStatus;
    };
    readonly embeddingRuntime: {
      readonly expectedVersion: typeof expectedNodeLlamaCppVersion;
      readonly installedVersion: string | null;
      readonly nativePackageName: string | null;
      readonly nativeInstalledVersion: string | null;
      readonly nativeBinaryPresent: boolean | null;
      readonly status: CapabilityStatus;
    };
    readonly embeddingModel: {
      readonly cacheStatus: "not-inspected";
    };
  };
};

export type BrowserReport = {
  readonly name: "Google Chrome" | "Chromium" | "Microsoft Edge" | "Arc";
  readonly paths: readonly string[];
  readonly status: CapabilityStatus;
};

export type ToolReport = {
  readonly name: "yt-dlp" | "ffmpeg" | "pdfinfo" | "pdftohtml" | "tesseract";
  readonly path: string | null;
  readonly version: string | null;
  readonly status: CapabilityStatus;
};

export type DoctorReport = {
  /** Schema 2 adds `search`; all schema-1 fields retain their names and meanings. */
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly bun: {
    readonly expectedVersion: typeof expectedBunVersion;
    readonly currentVersion: string;
    readonly status: CapabilityStatus;
  };
  readonly dependencies: readonly DependencyReport[];
  readonly deriveClient: {
    readonly available: boolean;
    readonly status: CapabilityStatus;
  };
  readonly browsers: readonly BrowserReport[];
  /** Display names only. Cookie stores and keychains are never inspected by doctor. */
  readonly chromeProfileNames: readonly string[];
  readonly tools: readonly ToolReport[];
  readonly search: SearchReadinessReport;
  readonly warnings: readonly string[];
};

export type DiagnosticCommand = {
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

export type DiagnosticCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type DiagnosticCommandRunner = (specification: DiagnosticCommand) => Promise<DiagnosticCommandResult>;

export type DoctorOptions = {
  readonly packageRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly runtime?: "bun" | "node";
  readonly currentBunVersion?: string;
  readonly now?: () => Date;
  readonly exists?: (path: string) => boolean;
  readonly readText?: (path: string) => string;
  readonly realpath?: (path: string) => string;
  readonly which?: (executable: string) => string | null;
  readonly run?: DiagnosticCommandRunner;
};

type JsonRecord = Readonly<Record<string, unknown>>;

const dependencyVersions = {
  "defuddle": "0.19.1",
  "agent-browser": "0.32.3",
  "@steipete/sweet-cookie": "0.4.0",
  "@tobilu/qmd": expectedQmdVersion,
} as const satisfies Readonly<Record<DependencyReport["name"], string>>;
const dependencyNames: readonly DependencyReport["name"][] = [
  "defuddle",
  "agent-browser",
  "@steipete/sweet-cookie",
  "@tobilu/qmd",
];

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const bytes = new BoundedByteBuffer(maxBytes);
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!bytes.append(result.value)) throw new Error(`diagnostic output exceeded ${maxBytes} bytes`);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}

export const runDiagnosticCommand: DiagnosticCommandRunner = async (specification) => {
  const child = Bun.spawn([...specification.command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(specification.cwd === undefined ? {} : { cwd: specification.cwd }),
    ...(specification.environment === undefined ? {} : { env: specification.environment }),
  });
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, specification.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, specification.maxOutputBytes),
      readBoundedStream(child.stderr, specification.maxOutputBytes),
      child.exited,
    ]);
    if (timedOut) throw new Error(`diagnostic command timed out after ${specification.timeoutMs}ms`);
    return { stdout, stderr, exitCode };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  }
};

function parseJson(value: string): unknown {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || (line[0] !== "{" && line[0] !== "[")) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // Some CLIs emit a diagnostic line before their final JSON payload.
    }
  }
  return null;
}

function readJsonRecord(path: string, readText: (path: string) => string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(readText(path));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dependencyVersion(manifest: JsonRecord | null, name: string): string | null {
  if (manifest === null) return null;
  for (const key of ["dependencies", "devDependencies"] as const) {
    const section = manifest[key];
    if (!isRecord(section)) continue;
    const value = section[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function packageDirectory(name: string): readonly string[] {
  return name.startsWith("@") ? name.split("/") : [name];
}

function installedDependencyDirectory(
  name: string,
  packageRoot: string,
  readText: (path: string) => string,
): { readonly directory: string; readonly manifest: JsonRecord } | null {
  const segments = packageDirectory(name);
  let directory = resolve(packageRoot);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(directory, "node_modules", ...segments);
    const manifest = readJsonRecord(join(candidate, "package.json"), readText);
    if (manifest !== null) return { directory: candidate, manifest };
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function installedPackageVersion(
  name: string,
  fromDirectory: string,
  readText: (path: string) => string,
): { readonly directory: string; readonly version: string | null } | null {
  const installed = installedDependencyDirectory(name, fromDirectory, readText);
  if (installed === null) return null;
  return {
    directory: installed.directory,
    version: typeof installed.manifest.version === "string" ? installed.manifest.version : null,
  };
}

function capabilityStatus(statuses: readonly CapabilityStatus[]): CapabilityStatus {
  if (statuses.some((status) => status === "unavailable")) return "unavailable";
  return statuses.every((status) => status === "ready") ? "ready" : "partial";
}

function canonicalDirectory(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function nativeSqliteVecPackage(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): { readonly name: string; readonly binary: string } | null {
  if (platform === "darwin" && (architecture === "arm64" || architecture === "x64")) {
    return { name: `sqlite-vec-darwin-${architecture}`, binary: "vec0.dylib" };
  }
  if (platform === "linux" && (architecture === "arm64" || architecture === "x64")) {
    return { name: `sqlite-vec-linux-${architecture}`, binary: "vec0.so" };
  }
  if (platform === "win32" && architecture === "x64") {
    return { name: "sqlite-vec-windows-x64", binary: "vec0.dll" };
  }
  return null;
}

function nativeNodeLlamaCppPackage(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): { readonly name: string; readonly binary: string } | null {
  if (platform === "darwin" && architecture === "arm64") {
    return {
      name: "@node-llama-cpp/mac-arm64-metal",
      binary: join("bins", "mac-arm64-metal", "llama-addon.node"),
    };
  }
  if (platform === "darwin" && architecture === "x64") {
    return {
      name: "@node-llama-cpp/mac-x64",
      binary: join("bins", "mac-x64", "llama-addon.node"),
    };
  }
  if (platform === "linux" && architecture === "arm64") {
    return {
      name: "@node-llama-cpp/linux-arm64",
      binary: join("bins", "linux-arm64", "llama-addon.node"),
    };
  }
  if (platform === "linux" && architecture === "arm") {
    return {
      name: "@node-llama-cpp/linux-armv7l",
      binary: join("bins", "linux-armv7l", "llama-addon.node"),
    };
  }
  if (platform === "linux" && architecture === "x64") {
    return {
      name: "@node-llama-cpp/linux-x64",
      binary: join("bins", "linux-x64", "llama-addon.node"),
    };
  }
  if (platform === "win32" && architecture === "arm64") {
    return {
      name: "@node-llama-cpp/win-arm64",
      binary: join("bins", "win-arm64", "llama-addon.node"),
    };
  }
  if (platform === "win32" && architecture === "x64") {
    return {
      name: "@node-llama-cpp/win-x64",
      binary: join("bins", "win-x64", "llama-addon.node"),
    };
  }
  return null;
}

function inspectSearchReadiness(
  dependencies: readonly DependencyReport[],
  packageRoot: string,
  runtime: SearchReadinessReport["runtime"],
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  currentBunVersion: string,
  exists: (path: string) => boolean,
  readText: (path: string) => string,
  realpath: (path: string) => string,
): SearchReadinessReport {
  const qmd = dependencies.find(({ name }) => name === "@tobilu/qmd");
  const qmdStatus = qmd?.status ?? "unavailable";
  const runtimeStatus: CapabilityStatus = runtime === "bun" && currentBunVersion !== expectedBunVersion
    ? "partial"
    : "ready";
  const installedQmdDirectory = installedDependencyDirectory("@tobilu/qmd", packageRoot, readText)?.directory;
  const qmdDirectory = installedQmdDirectory === undefined
    ? packageRoot
    : canonicalDirectory(installedQmdDirectory, realpath);

  let sqlite: SearchReadinessReport["semanticPrerequisites"]["sqlite"];
  if (runtime === "bun" && platform === "darwin") {
    const selectedLibraryPath = homebrewSqliteLibraryPaths.find((path) => exists(path)) ?? null;
    sqlite = {
      provider: "homebrew",
      expectedVersion: null,
      installedVersion: null,
      searchedLibraryPaths: homebrewSqliteLibraryPaths,
      selectedLibraryPath,
      nativeBindingPresent: null,
      status: selectedLibraryPath === null ? "unavailable" : "ready",
    };
  } else if (runtime === "bun") {
    sqlite = {
      provider: "bun-built-in",
      expectedVersion: null,
      installedVersion: null,
      searchedLibraryPaths: [],
      selectedLibraryPath: null,
      nativeBindingPresent: null,
      status: "ready",
    };
  } else {
    const installed = installedPackageVersion("better-sqlite3", qmdDirectory, readText);
    const nativeBindingPresent = installed === null
      ? false
      : exists(join(installed.directory, "build", "Release", "better_sqlite3.node"));
    sqlite = {
      provider: "better-sqlite3",
      expectedVersion: expectedBetterSqliteVersion,
      installedVersion: installed?.version ?? null,
      searchedLibraryPaths: [],
      selectedLibraryPath: null,
      nativeBindingPresent,
      status: installed === null
        ? "unavailable"
        : installed.version === expectedBetterSqliteVersion && nativeBindingPresent
          ? "ready"
          : "partial",
    };
  }

  const sqliteVecPackage = installedPackageVersion("sqlite-vec", qmdDirectory, readText);
  const nativeDefinition = nativeSqliteVecPackage(platform, architecture);
  const nativePackage = nativeDefinition === null
    ? null
    : installedPackageVersion(nativeDefinition.name, qmdDirectory, readText);
  const nativeBinaryPresent = nativeDefinition === null || nativePackage === null
    ? null
    : exists(join(nativePackage.directory, nativeDefinition.binary));
  const sqliteVecStatus: CapabilityStatus = nativeDefinition === null || sqliteVecPackage === null || nativePackage === null
    ? "unavailable"
    : sqliteVecPackage.version === expectedSqliteVecVersion
      && nativePackage.version === expectedSqliteVecVersion
      && nativeBinaryPresent === true
      ? "ready"
      : "partial";
  const nodeLlamaCpp = installedPackageVersion("node-llama-cpp", qmdDirectory, readText);
  const canonicalNodeLlamaCppDirectory = nodeLlamaCpp === null
    ? qmdDirectory
    : canonicalDirectory(nodeLlamaCpp.directory, realpath);
  const nativeEmbeddingDefinition = nativeNodeLlamaCppPackage(platform, architecture);
  const nativeEmbeddingPackage = nativeEmbeddingDefinition === null
    ? null
    : installedPackageVersion(nativeEmbeddingDefinition.name, canonicalNodeLlamaCppDirectory, readText);
  const nativeEmbeddingBinaryPresent = nativeEmbeddingDefinition === null || nativeEmbeddingPackage === null
    ? null
    : exists(join(nativeEmbeddingPackage.directory, nativeEmbeddingDefinition.binary));
  const embeddingRuntimeStatus: CapabilityStatus = nodeLlamaCpp === null
    ? "unavailable"
    : nativeEmbeddingDefinition === null || nativeEmbeddingPackage === null
      ? "partial"
      : nodeLlamaCpp.version === expectedNodeLlamaCppVersion
        && nativeEmbeddingPackage.version === expectedNodeLlamaCppVersion
        && nativeEmbeddingBinaryPresent === true
        ? "ready"
        : "partial";
  const keywordStatus = capabilityStatus([
    qmdStatus,
    runtimeStatus,
    ...(runtime === "node" ? [sqlite.status] : []),
  ]);

  return {
    runtime,
    platform,
    architecture,
    keywordOnly: {
      status: keywordStatus,
      modelRequired: false,
    },
    semanticPrerequisites: {
      status: capabilityStatus([keywordStatus, sqlite.status, sqliteVecStatus, embeddingRuntimeStatus]),
      sqlite,
      sqliteVec: {
        expectedVersion: expectedSqliteVecVersion,
        installedVersion: sqliteVecPackage?.version ?? null,
        nativePackageName: nativeDefinition?.name ?? null,
        nativeInstalledVersion: nativePackage?.version ?? null,
        nativeBinaryPresent,
        status: sqliteVecStatus,
      },
      embeddingRuntime: {
        expectedVersion: expectedNodeLlamaCppVersion,
        installedVersion: nodeLlamaCpp?.version ?? null,
        nativePackageName: nativeEmbeddingDefinition?.name ?? null,
        nativeInstalledVersion: nativeEmbeddingPackage?.version ?? null,
        nativeBinaryPresent: nativeEmbeddingBinaryPresent,
        status: embeddingRuntimeStatus,
      },
      embeddingModel: {
        cacheStatus: "not-inspected",
      },
    },
  };
}

function reportDependency(
  name: DependencyReport["name"],
  packageRoot: string,
  rootManifest: JsonRecord | null,
  readText: (path: string) => string,
): DependencyReport {
  const expectedVersion = dependencyVersions[name];
  const declaredVersion = dependencyVersion(rootManifest, name);
  const installed = installedDependencyDirectory(name, packageRoot, readText);
  const installedVersion = typeof installed?.manifest.version === "string" ? installed.manifest.version : null;
  const status: CapabilityStatus = installedVersion === expectedVersion && declaredVersion !== null
    ? "ready"
    : installedVersion === null
      ? "unavailable"
      : "partial";
  return { name, expectedVersion, declaredVersion, installedVersion, status };
}

type BrowserDefinition = {
  readonly name: BrowserReport["name"];
  readonly macApplications: readonly string[];
  readonly executableNames: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>>;
  readonly linuxPaths: readonly string[];
};

const browserDefinitions: readonly BrowserDefinition[] = [
  {
    name: "Google Chrome",
    macApplications: ["Google Chrome"],
    executableNames: {
      darwin: ["google-chrome"],
      linux: ["google-chrome", "google-chrome-stable"],
      win32: ["chrome"],
    },
    linuxPaths: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome",
      "/opt/google/chrome/google-chrome",
    ],
  },
  {
    name: "Chromium",
    macApplications: ["Chromium"],
    executableNames: {
      darwin: ["chromium"],
      linux: ["chromium", "chromium-browser"],
      win32: ["chromium"],
    },
    linuxPaths: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/local/bin/chromium",
      "/snap/bin/chromium",
    ],
  },
  {
    name: "Microsoft Edge",
    macApplications: ["Microsoft Edge"],
    executableNames: {
      darwin: ["microsoft-edge"],
      linux: ["microsoft-edge", "microsoft-edge-stable"],
      win32: ["msedge"],
    },
    linuxPaths: [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge",
    ],
  },
  {
    name: "Arc",
    macApplications: ["Arc"],
    executableNames: {},
    linuxPaths: [],
  },
];

function browserPaths(
  definition: BrowserDefinition,
  platform: NodeJS.Platform,
  homeDirectory: string,
  which: (name: string) => string | null,
  exists: (path: string) => boolean,
): readonly string[] {
  const candidates: string[] = [];
  if (platform === "darwin") {
    for (const applicationName of definition.macApplications) {
      candidates.push(
        `/Applications/${applicationName}.app`,
        join(homeDirectory, "Applications", `${applicationName}.app`),
      );
    }
  }
  if (platform === "linux") candidates.push(...definition.linuxPaths);
  for (const executable of definition.executableNames[platform] ?? []) {
    const path = which(executable);
    if (path !== null) candidates.push(path);
  }
  return [...new Set(candidates.filter((path) => exists(path)))];
}

function findExecutable(
  name: string,
  commonPaths: readonly string[],
  which: (name: string) => string | null,
  exists: (path: string) => boolean,
): string | null {
  const fromPath = which(name);
  if (fromPath !== null && exists(fromPath)) return fromPath;
  return commonPaths.find((path) => exists(path)) ?? null;
}

async function commandVersion(
  path: string | null,
  arguments_: readonly string[],
  run: DiagnosticCommandRunner,
): Promise<string | null> {
  if (path === null) return null;
  try {
    const result = await run({ command: [path, ...arguments_], timeoutMs: 30_000, maxOutputBytes: 128 * 1024 });
    if (result.exitCode !== 0) return null;
    const firstLine = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/, 1)[0] ?? "";
    return firstLine === "" ? null : firstLine;
  } catch {
    return null;
  }
}

async function inspectAgentBrowser(
  agentBrowserDirectory: string | null,
  exists: (path: string) => boolean,
  run: DiagnosticCommandRunner,
): Promise<{ readonly deriveClient: boolean; readonly profiles: readonly string[] }> {
  if (agentBrowserDirectory === null) return { deriveClient: false, profiles: [] };
  const executable = join(agentBrowserDirectory, "bin", "agent-browser.js");
  if (!exists(executable)) return { deriveClient: false, profiles: [] };
  const directory = mkdtempSync(join(tmpdir(), "hraness-kb-doctor-"));
  const socketRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const socketDirectory = mkdtempSync(join(socketRoot, "jc-ab-doctor-"));
  chmodSync(directory, 0o700);
  chmodSync(socketDirectory, 0o700);
  const configPath = join(directory, "agent-browser.config.json");
  writeFileSync(configPath, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(configPath, 0o600);
  const base = [process.execPath, executable, "--config", configPath];
  const isolatedCommand = {
    cwd: directory,
    environment: isolatedAgentBrowserEnvironment(process.env, socketDirectory),
    timeoutMs: 20_000,
    maxOutputBytes: 2 * 1024 * 1024,
  } as const;
  let skillsResult: DiagnosticCommandResult | null;
  let profilesResult: DiagnosticCommandResult | null;
  try {
    [skillsResult, profilesResult] = await Promise.all([
      run({ ...isolatedCommand, command: [...base, "skills", "list", "--json"] }).catch(() => null),
      run({ ...isolatedCommand, command: [...base, "profiles", "--json"] }).catch(() => null),
    ]);
  } finally {
    rmSync(socketDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }

  let deriveClient = false;
  if (skillsResult?.exitCode === 0) {
    const parsed = parseJson(skillsResult.stdout);
    if (isRecord(parsed) && parsed.success === true && Array.isArray(parsed.data)) {
      deriveClient = parsed.data.some((entry) => isRecord(entry) && entry.name === "derive-client");
    }
  }

  const profiles = new Set<string>();
  if (profilesResult?.exitCode === 0) {
    const parsed = parseJson(profilesResult.stdout);
    if (isRecord(parsed) && parsed.success === true && Array.isArray(parsed.data)) {
      for (const entry of parsed.data) {
        if (!isRecord(entry) || typeof entry.name !== "string") continue;
        const name = entry.name.trim();
        if (name !== "") profiles.add(name);
      }
    }
  }
  return { deriveClient, profiles: [...profiles].sort((left, right) => left.localeCompare(right)) };
}

/** Inspect local clipping capabilities without reading cookies, browser databases, or the system keychain. */
export async function inspectClipEnvironment(options: DoctorOptions = {}): Promise<DoctorReport> {
  const packageRoot = resolve(options.packageRoot ?? findKbPackageRoot());
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const runtime = options.runtime ?? (process.versions.bun === undefined ? "node" : "bun");
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const realpath = options.realpath ?? realpathSync;
  const which = options.which ?? ((name: string) => typeof Bun === "undefined" ? null : Bun.which(name));
  const run = options.run ?? runDiagnosticCommand;
  const rootManifest = readJsonRecord(join(packageRoot, "package.json"), readText);
  const dependencies = dependencyNames.map((name) => reportDependency(name, packageRoot, rootManifest, readText));
  const agentBrowserDirectory = installedDependencyDirectory(
    "agent-browser",
    packageRoot,
    readText,
  )?.directory ?? null;

  const browsers: readonly BrowserReport[] = browserDefinitions.map((definition) => {
    const paths = browserPaths(definition, platform, homeDirectory, which, exists);
    return { name: definition.name, paths, status: paths.length === 0 ? "unavailable" : "ready" };
  });

  const ytDlpPath = findExecutable("yt-dlp", [
    join(homeDirectory, ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
  ], which, exists);
  const ffmpegPath = findExecutable("ffmpeg", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ], which, exists);
  const pdfinfoPath = findExecutable("pdfinfo", [
    "/opt/homebrew/bin/pdfinfo",
    "/usr/local/bin/pdfinfo",
    "/usr/bin/pdfinfo",
  ], which, exists);
  const pdftohtmlPath = findExecutable("pdftohtml", [
    "/opt/homebrew/bin/pdftohtml",
    "/usr/local/bin/pdftohtml",
    "/usr/bin/pdftohtml",
  ], which, exists);
  const tesseractPath = findExecutable("tesseract", [
    join(homeDirectory, ".local", "bin", "tesseract"),
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/usr/bin/tesseract",
  ], which, exists);

  const [
    agentBrowser,
    ytDlpVersion,
    ffmpegVersion,
    pdfinfoVersion,
    pdftohtmlVersion,
    tesseractVersion,
  ] = await Promise.all([
    inspectAgentBrowser(agentBrowserDirectory, exists, run),
    commandVersion(ytDlpPath, ["--version"], run),
    commandVersion(ffmpegPath, ["-version"], run),
    commandVersion(pdfinfoPath, ["-v"], run),
    commandVersion(pdftohtmlPath, ["-v"], run),
    commandVersion(tesseractPath, ["--version"], run),
  ]);
  const tools: readonly ToolReport[] = [
    {
      name: "yt-dlp",
      path: ytDlpPath,
      version: ytDlpVersion,
      status: ytDlpPath === null ? "unavailable" : ytDlpVersion === null ? "partial" : "ready",
    },
    {
      name: "ffmpeg",
      path: ffmpegPath,
      version: ffmpegVersion,
      status: ffmpegPath === null ? "unavailable" : ffmpegVersion === null ? "partial" : "ready",
    },
    {
      name: "pdfinfo",
      path: pdfinfoPath,
      version: pdfinfoVersion,
      status: pdfinfoPath === null ? "unavailable" : pdfinfoVersion === null ? "partial" : "ready",
    },
    {
      name: "pdftohtml",
      path: pdftohtmlPath,
      version: pdftohtmlVersion,
      status: pdftohtmlPath === null ? "unavailable" : pdftohtmlVersion === null ? "partial" : "ready",
    },
    {
      name: "tesseract",
      path: tesseractPath,
      version: tesseractVersion,
      status: tesseractPath === null ? "unavailable" : tesseractVersion === null ? "partial" : "ready",
    },
  ];

  const warnings: string[] = [];
  const currentBunVersion = options.currentBunVersion ?? (typeof Bun === "undefined" ? "not running under Bun" : Bun.version);
  const search = inspectSearchReadiness(
    dependencies,
    packageRoot,
    runtime,
    platform,
    architecture,
    currentBunVersion,
    exists,
    readText,
    realpath,
  );
  if (currentBunVersion !== expectedBunVersion) {
    warnings.push(`Use Bun ${expectedBunVersion}; current runtime is ${currentBunVersion}.`);
  }
  for (const dependency of dependencies) {
    if (dependency.status === "unavailable") {
      warnings.push(`${dependency.name} ${dependency.expectedVersion} is not installed; reinstall @hraness/kb with Bun.`);
    } else if (dependency.status === "partial") {
      warnings.push(`${dependency.name} must resolve to ${dependency.expectedVersion} for this kb release.`);
    }
  }
  if (!agentBrowser.deriveClient) {
    warnings.push("agent-browser does not expose the derive-client skill; reinstall the pinned dependency before HAR-based client work.");
  }
  const renderedBrowserAvailable = browsers.some(({ name, status }) =>
    (name === "Google Chrome" || name === "Chromium") && status === "ready"
  );
  if (!renderedBrowserAvailable) {
    warnings.push("Install Google Chrome or Chromium for rendered capture; Microsoft Edge can also be used through an explicitly selected CDP session, while Arc remains an explicit cookie or CDP source.");
  }
  if (agentBrowser.profiles.length === 0) {
    warnings.push("No discoverable Chrome profile names were reported; use --browser-live, --cdp, or an explicit profile path when needed.");
  }
  if (ytDlpPath === null) {
    warnings.push("Install yt-dlp to capture default YouTube metadata, thumbnails, and transcripts, and to enable optional --media all downloads.");
  }
  if (ffmpegPath === null) warnings.push("Install ffmpeg for yt-dlp formats that require audio/video merging or remuxing.");
  if (pdfinfoPath === null || pdftohtmlPath === null) {
    const missing = [
      ...(pdfinfoPath === null ? ["pdfinfo"] : []),
      ...(pdftohtmlPath === null ? ["pdftohtml"] : []),
    ];
    warnings.push(`Install Poppler's ${missing.join(" and ")} command${missing.length === 1 ? "" : "s"}; kb pdf requires both pdfinfo and pdftohtml.`);
  } else if (pdfinfoVersion === null || pdftohtmlVersion === null) {
    warnings.push("Poppler was found, but a PDF tool version could not be verified; kb pdf can attempt ingestion with a degraded tool report.");
  }
  if (tesseractPath === null) {
    warnings.push("Install Tesseract to transcribe text in scans and screenshots; kb pdf still preserves native text and images without OCR.");
  } else if (tesseractVersion === null) {
    warnings.push("Tesseract was found, but its version could not be verified; kb pdf can attempt OCR with a degraded tool report.");
  }
  if (search.keywordOnly.status !== "ready") {
    warnings.push("QMD keyword-only search is not ready; exact Markdown search remains available.");
  }
  const keywordFallback = search.keywordOnly.status === "ready"
    ? " Keyword-only QMD search remains available."
    : "";
  if (
    runtime === "bun"
    && platform === "darwin"
    && search.semanticPrerequisites.sqlite.status !== "ready"
  ) {
    warnings.push(`Install Homebrew SQLite with \`brew install sqlite\`; semantic and hybrid vector retrieval are unavailable.${keywordFallback}`);
  } else if (runtime === "node" && search.semanticPrerequisites.sqlite.status !== "ready") {
    warnings.push(`Reinstall @hraness/kb with Node so better-sqlite3 ${expectedBetterSqliteVersion} and its native binding are available.${keywordFallback}`);
  }
  if (search.semanticPrerequisites.sqliteVec.status !== "ready") {
    const nativePackage = search.semanticPrerequisites.sqliteVec.nativePackageName;
    warnings.push(nativePackage === null
      ? `sqlite-vec ${expectedSqliteVecVersion} has no native package for ${platform}-${architecture}; semantic and hybrid vector retrieval are unavailable.${keywordFallback}`
      : `Reinstall @hraness/kb so sqlite-vec ${expectedSqliteVecVersion} and ${nativePackage} ${expectedSqliteVecVersion} are installed; semantic and hybrid vector retrieval are unavailable.${keywordFallback}`);
  }
  if (search.semanticPrerequisites.embeddingRuntime.status !== "ready") {
    const nativePackage = search.semanticPrerequisites.embeddingRuntime.nativePackageName;
    warnings.push(nativePackage === null
      ? `node-llama-cpp ${expectedNodeLlamaCppVersion} has no prebuilt package for ${platform}-${architecture}; semantic and hybrid vector retrieval require a compatible local embedding runtime.${keywordFallback}`
      : `Reinstall @hraness/kb with Bun so node-llama-cpp ${expectedNodeLlamaCppVersion} and ${nativePackage} ${expectedNodeLlamaCppVersion} with its native binary are installed; semantic and hybrid vector retrieval are not ready.${keywordFallback}`);
  }

  return {
    schemaVersion: 2,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    bun: {
      expectedVersion: expectedBunVersion,
      currentVersion: currentBunVersion,
      status: currentBunVersion === expectedBunVersion ? "ready" : "partial",
    },
    dependencies,
    deriveClient: {
      available: agentBrowser.deriveClient,
      status: agentBrowser.deriveClient ? "ready" : "unavailable",
    },
    browsers,
    chromeProfileNames: agentBrowser.profiles,
    tools,
    search,
    warnings,
  };
}

function versionSummary(report: DependencyReport): string {
  const declared = report.declaredVersion ?? "not declared";
  const installed = report.installedVersion ?? "not installed";
  return `${report.name}: ${report.status} (declared ${declared}; installed ${installed}; expected ${report.expectedVersion})`;
}

/** Render a stable, secret-free report suitable for a terminal. */
export function renderDoctorReport(report: DoctorReport): string {
  const sqlite = report.search.semanticPrerequisites.sqlite;
  const sqliteDetail = sqlite.provider === "homebrew"
    ? sqlite.selectedLibraryPath === null
      ? `not found (checked ${sqlite.searchedLibraryPaths.join(", ")})`
      : sqlite.selectedLibraryPath
    : sqlite.provider === "better-sqlite3"
      ? `${sqlite.installedVersion ?? "not installed"}; native binding ${sqlite.nativeBindingPresent === true ? "present" : "not found"}`
      : "provided by Bun";
  const sqliteVec = report.search.semanticPrerequisites.sqliteVec;
  const nativePackage = sqliteVec.nativePackageName === null
    ? `unsupported for ${report.search.platform}-${report.search.architecture}`
    : `${sqliteVec.nativePackageName} ${sqliteVec.nativeInstalledVersion ?? "not installed"}; native binary ${sqliteVec.nativeBinaryPresent === true ? "present" : "not found"}`;
  const embeddingRuntime = report.search.semanticPrerequisites.embeddingRuntime;
  const nativeEmbeddingRuntime = embeddingRuntime.nativePackageName === null
    ? `unsupported for ${report.search.platform}-${report.search.architecture}`
    : `${embeddingRuntime.nativePackageName} ${embeddingRuntime.nativeInstalledVersion ?? "not installed"}; native binary ${embeddingRuntime.nativeBinaryPresent === true ? "present" : "not found"}`;
  const lines = [
    "KB environment",
    `Bun: ${report.bun.status} (${report.bun.currentVersion}; expected ${report.bun.expectedVersion})`,
    ...report.dependencies.map(versionSummary),
    `agent-browser derive-client: ${report.deriveClient.status}`,
    ...report.browsers.map((browser) => `${browser.name}: ${browser.status}${browser.paths.length === 0 ? "" : ` (${browser.paths.join(", ")})`}`),
    `Chrome profiles: ${report.chromeProfileNames.length === 0 ? "none discovered" : report.chromeProfileNames.join(", ")}`,
    ...report.tools.map((tool) => `${tool.name}: ${tool.status}${tool.version === null ? "" : ` (${tool.version})`}${tool.path === null ? "" : ` at ${tool.path}`}`),
    `QMD keyword-only search: ${report.search.keywordOnly.status} (embedding model not required)`,
    `Semantic prerequisites: ${report.search.semanticPrerequisites.status}`,
    `SQLite extension support: ${sqlite.status} (${sqlite.provider}: ${sqliteDetail})`,
    `sqlite-vec: ${sqliteVec.status} (installed ${sqliteVec.installedVersion ?? "not installed"}; expected ${sqliteVec.expectedVersion}; ${nativePackage})`,
    `Embedding runtime: ${embeddingRuntime.status} (node-llama-cpp ${embeddingRuntime.installedVersion ?? "not installed"}; expected ${embeddingRuntime.expectedVersion}; ${nativeEmbeddingRuntime})`,
    "Embedding model cache: not inspected; first semantic use may download the configured local model",
    "Cookie/keychain probe: not performed",
  ];
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

export type AdapterCompleteness = "complete" | "bounded" | "best-effort" | "access-dependent" | "unsupported";

export type AdapterCapability = {
  readonly id: Platform | null;
  readonly platform: string;
  readonly preferredModes: readonly string[];
  readonly page: AdapterCompleteness;
  readonly conversations: AdapterCompleteness;
  readonly media: AdapterCompleteness;
  readonly limitations: readonly string[];
};

/** Honest capability matrix: statuses describe capture guarantees, not marketing claims. */
export const adapterCapabilities: readonly AdapterCapability[] = [
  {
    id: "generic",
    platform: "Generic web",
    preferredModes: ["HTTP + Defuddle", "rendered browser fallback", "saved HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: [
      "JavaScript-only regions require a browser",
      "visible conversation prose can be retained, but site-specific item trees are not inferred generically",
    ],
  },
  {
    id: "x",
    platform: "X",
    preferredModes: ["rendered Chrome profile/live session", "Defuddle X extractor"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only posts and replies loaded into the rendered page are captured", "virtualized or unloaded replies remain partial", "private GraphQL clients are not invoked automatically"],
  },
  {
    id: "substack",
    platform: "Substack",
    preferredModes: ["HTTP + Defuddle", "authorized rendered session for subscriber pages"],
    page: "access-dependent",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Subscriber-only text is captured only when the selected session can already view it", "visible comments are retained as unstructured rendered context with conservative counts", "email/app-only or virtualized comments can be absent"],
  },
  {
    id: "instagram",
    platform: "Instagram",
    preferredModes: ["authorized rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated item adapter", "Login walls, virtualization, and lazy-loaded comments limit completeness", "private accounts require the user's authorized session"],
  },
  {
    id: "linkedin",
    platform: "LinkedIn",
    preferredModes: ["authorized rendered session", "saved rendered HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered fallback; no dedicated adapter", "UI changes and collapsed comment branches can reduce completeness", "no automated private API derivation"],
  },
  {
    id: null,
    platform: "Signed-in pages",
    preferredModes: ["current browser tab", "temporary browser-profile copy", "origin-filtered cookie HTTP fallback"],
    page: "access-dependent",
    conversations: "access-dependent",
    media: "access-dependent",
    limitations: ["Captures what the selected session renders", "virtualized or unloaded regions can remain partial"],
  },
  {
    id: "hacker-news",
    platform: "Hacker News",
    preferredModes: ["official Firebase API", "rendered/Defuddle fallback"],
    page: "complete",
    conversations: "bounded",
    media: "unsupported",
    limitations: ["Comment count and depth obey CLI bounds", "deleted and dead items remain represented only as exposed by the service"],
  },
  {
    id: "reddit",
    platform: "Reddit",
    preferredModes: ["best-effort public listing JSON", "rendered session", "Defuddle Reddit extractor"],
    page: "best-effort",
    conversations: "bounded",
    media: "best-effort",
    limitations: ["The unofficial JSON surface can be denied or changed and falls back automatically", "collapsed/deleted branches and configured item/depth bounds remain explicit"],
  },
  {
    id: "facebook",
    platform: "Facebook",
    preferredModes: ["authorized rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated item adapter", "Only visible, loaded content is captured", "private audiences require the user's authorized session"],
  },
  {
    id: "tiktok",
    platform: "TikTok",
    preferredModes: ["rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated thread adapter", "Regional/login gates, virtualization, and lazy-loaded comments can reduce completeness", "DRM and access controls are never bypassed"],
  },
  {
    id: "bluesky",
    platform: "Bluesky",
    preferredModes: ["public AT Protocol thread API", "rendered/Defuddle fallback"],
    page: "complete",
    conversations: "bounded",
    media: "best-effort",
    limitations: ["Thread count and depth obey CLI bounds", "moderation labels and unavailable records are preserved only as exposed"],
  },
  {
    id: "threads",
    platform: "Threads",
    preferredModes: ["current browser tab", "rendered browser profile", "saved rendered HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only rendered posts and replies are retained", "virtualized or unloaded replies remain partial"],
  },
  {
    id: "whatsapp",
    platform: "WhatsApp Web",
    preferredModes: ["current signed-in browser tab", "rendered browser profile"],
    page: "access-dependent",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only the open, rendered conversation is retained", "older virtualized messages can remain partial"],
  },
  {
    id: "youtube",
    platform: "YouTube",
    preferredModes: ["yt-dlp metadata + thumbnail + transcript", "HTTP + Defuddle", "rendered browser"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: [
      "Transcript capture depends on an available exact-language caption track",
      "Only loaded comments are retained",
      "Full audio/video download remains opt-in with --media all",
    ],
  },
  {
    id: "github",
    platform: "GitHub issues, pull requests, and discussions",
    preferredModes: ["Defuddle GitHub extractor", "current signed-in browser tab for private repositories"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only loaded timeline and review items are retained", "collapsed or paginated history can remain partial"],
  },
  {
    id: "discourse",
    platform: "Discourse",
    preferredModes: ["Defuddle Discourse extractor", "rendered browser fallback"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only loaded topic posts are retained", "long or login-gated topics can remain partial"],
  },
];

export function renderAdapterCapabilities(capabilities: readonly AdapterCapability[] = adapterCapabilities): string {
  const lines = [
    "Clip adapters",
    "Statuses: complete, bounded, best-effort, access-dependent, unsupported.",
    "",
  ];
  for (const capability of capabilities) {
    lines.push(
      `${capability.platform}: page=${capability.page}, conversations=${capability.conversations}, media=${capability.media}`,
      `  modes: ${capability.preferredModes.join("; ")}`,
      ...capability.limitations.map((limitation) => `  - ${limitation}`),
    );
  }
  lines.push(
    "",
    "Use the current browser tab or a temporary copy of a signed-in browser profile for pages you already have open.",
    "Capture is ingestion-only: it reads rendered content and does not post, like, follow, send, or submit.",
  );
  return `${lines.join("\n")}\n`;
}
