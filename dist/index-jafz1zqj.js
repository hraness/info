// @bun
import {
  findOhPackageRoot,
  isolatedAgentBrowserEnvironment
} from "./index-gdjwymq0.js";
import {
  BoundedByteBuffer
} from "./index-gh719d91.js";

// src/clip/doctor.ts
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
var expectedBunVersion = "1.3.14";
var dependencyVersions = {
  defuddle: "0.19.1",
  "agent-browser": "0.32.3",
  "@steipete/sweet-cookie": "0.4.0"
};
var dependencyNames = [
  "defuddle",
  "agent-browser",
  "@steipete/sweet-cookie"
];
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
async function readBoundedStream(stream, maxBytes) {
  const reader = stream.getReader();
  const bytes = new BoundedByteBuffer(maxBytes);
  try {
    for (;; ) {
      const result = await reader.read();
      if (result.done)
        break;
      if (!bytes.append(result.value))
        throw new Error(`diagnostic output exceeded ${maxBytes} bytes`);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}
var runDiagnosticCommand = async (specification) => {
  const child = Bun.spawn([...specification.command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...specification.cwd === undefined ? {} : { cwd: specification.cwd },
    ...specification.environment === undefined ? {} : { env: specification.environment }
  });
  let timedOut = false;
  let forceKillTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
  }, specification.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, specification.maxOutputBytes),
      readBoundedStream(child.stderr, specification.maxOutputBytes),
      child.exited
    ]);
    if (timedOut)
      throw new Error(`diagnostic command timed out after ${specification.timeoutMs}ms`);
    return { stdout, stderr, exitCode };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
    if (forceKillTimer !== null)
      clearTimeout(forceKillTimer);
  }
};
function parseJson(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1;index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line[0] !== "{" && line[0] !== "[")
      continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}
function readJsonRecord(path, readText) {
  try {
    const parsed = JSON.parse(readText(path));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function dependencyVersion(manifest, name) {
  if (manifest === null)
    return null;
  for (const key of ["dependencies", "devDependencies"]) {
    const section = manifest[key];
    if (!isRecord(section))
      continue;
    const value = section[name];
    if (typeof value === "string")
      return value;
  }
  return null;
}
function packageDirectory(name) {
  return name.startsWith("@") ? name.split("/") : [name];
}
function installedDependencyDirectory(name, packageRoot, readText) {
  const segments = packageDirectory(name);
  let directory = resolve(packageRoot);
  for (let depth = 0;depth < 12; depth += 1) {
    const candidate = join(directory, "node_modules", ...segments);
    const manifest = readJsonRecord(join(candidate, "package.json"), readText);
    if (manifest !== null)
      return { directory: candidate, manifest };
    const parent = dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  return null;
}
function reportDependency(name, packageRoot, rootManifest, readText) {
  const expectedVersion = dependencyVersions[name];
  const declaredVersion = dependencyVersion(rootManifest, name);
  const installed = installedDependencyDirectory(name, packageRoot, readText);
  const installedVersion = typeof installed?.manifest.version === "string" ? installed.manifest.version : null;
  const status = installedVersion === expectedVersion && declaredVersion !== null ? "ready" : installedVersion === null ? "unavailable" : "partial";
  return { name, expectedVersion, declaredVersion, installedVersion, status };
}
var browserDefinitions = [
  {
    name: "Google Chrome",
    macApplications: ["Google Chrome"],
    executableNames: {
      darwin: ["google-chrome"],
      linux: ["google-chrome", "google-chrome-stable"],
      win32: ["chrome"]
    },
    linuxPaths: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome",
      "/opt/google/chrome/google-chrome"
    ]
  },
  {
    name: "Chromium",
    macApplications: ["Chromium"],
    executableNames: {
      darwin: ["chromium"],
      linux: ["chromium", "chromium-browser"],
      win32: ["chromium"]
    },
    linuxPaths: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/local/bin/chromium",
      "/snap/bin/chromium"
    ]
  },
  {
    name: "Microsoft Edge",
    macApplications: ["Microsoft Edge"],
    executableNames: {
      darwin: ["microsoft-edge"],
      linux: ["microsoft-edge", "microsoft-edge-stable"],
      win32: ["msedge"]
    },
    linuxPaths: [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge"
    ]
  },
  {
    name: "Arc",
    macApplications: ["Arc"],
    executableNames: {},
    linuxPaths: []
  }
];
function browserPaths(definition, platform, homeDirectory, which, exists) {
  const candidates = [];
  if (platform === "darwin") {
    for (const applicationName of definition.macApplications) {
      candidates.push(`/Applications/${applicationName}.app`, join(homeDirectory, "Applications", `${applicationName}.app`));
    }
  }
  if (platform === "linux")
    candidates.push(...definition.linuxPaths);
  for (const executable of definition.executableNames[platform] ?? []) {
    const path = which(executable);
    if (path !== null)
      candidates.push(path);
  }
  return [...new Set(candidates.filter((path) => exists(path)))];
}
function findExecutable(name, commonPaths, which, exists) {
  const fromPath = which(name);
  if (fromPath !== null && exists(fromPath))
    return fromPath;
  return commonPaths.find((path) => exists(path)) ?? null;
}
async function commandVersion(path, arguments_, run) {
  if (path === null)
    return null;
  try {
    const result = await run({ command: [path, ...arguments_], timeoutMs: 30000, maxOutputBytes: 128 * 1024 });
    if (result.exitCode !== 0)
      return null;
    const firstLine = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/, 1)[0] ?? "";
    return firstLine === "" ? null : firstLine;
  } catch {
    return null;
  }
}
async function inspectAgentBrowser(agentBrowserDirectory, exists, run) {
  if (agentBrowserDirectory === null)
    return { deriveClient: false, profiles: [] };
  const executable = join(agentBrowserDirectory, "bin", "agent-browser.js");
  if (!exists(executable))
    return { deriveClient: false, profiles: [] };
  const directory = mkdtempSync(join(tmpdir(), "hraness-oh-doctor-"));
  const socketRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const socketDirectory = mkdtempSync(join(socketRoot, "jc-ab-doctor-"));
  chmodSync(directory, 448);
  chmodSync(socketDirectory, 448);
  const configPath = join(directory, "agent-browser.config.json");
  writeFileSync(configPath, `{}
`, { encoding: "utf8", flag: "wx", mode: 384 });
  chmodSync(configPath, 384);
  const base = [process.execPath, executable, "--config", configPath];
  const isolatedCommand = {
    cwd: directory,
    environment: isolatedAgentBrowserEnvironment(process.env, socketDirectory),
    timeoutMs: 20000,
    maxOutputBytes: 2 * 1024 * 1024
  };
  let skillsResult;
  let profilesResult;
  try {
    [skillsResult, profilesResult] = await Promise.all([
      run({ ...isolatedCommand, command: [...base, "skills", "list", "--json"] }).catch(() => null),
      run({ ...isolatedCommand, command: [...base, "profiles", "--json"] }).catch(() => null)
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
  const profiles = new Set;
  if (profilesResult?.exitCode === 0) {
    const parsed = parseJson(profilesResult.stdout);
    if (isRecord(parsed) && parsed.success === true && Array.isArray(parsed.data)) {
      for (const entry of parsed.data) {
        if (!isRecord(entry) || typeof entry.name !== "string")
          continue;
        const name = entry.name.trim();
        if (name !== "")
          profiles.add(name);
      }
    }
  }
  return { deriveClient, profiles: [...profiles].sort((left, right) => left.localeCompare(right)) };
}
async function inspectClipEnvironment(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? findOhPackageRoot());
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((path) => readFileSync(path, "utf8"));
  const which = options.which ?? ((name) => Bun.which(name));
  const run = options.run ?? runDiagnosticCommand;
  const rootManifest = readJsonRecord(join(packageRoot, "package.json"), readText);
  const dependencies = dependencyNames.map((name) => reportDependency(name, packageRoot, rootManifest, readText));
  const agentBrowserDirectory = installedDependencyDirectory("agent-browser", packageRoot, readText)?.directory ?? null;
  const browsers = browserDefinitions.map((definition) => {
    const paths = browserPaths(definition, platform, homeDirectory, which, exists);
    return { name: definition.name, paths, status: paths.length === 0 ? "unavailable" : "ready" };
  });
  const ytDlpPath = findExecutable("yt-dlp", [
    join(homeDirectory, ".local", "bin", "yt-dlp"),
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp"
  ], which, exists);
  const ffmpegPath = findExecutable("ffmpeg", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg"
  ], which, exists);
  const pdfinfoPath = findExecutable("pdfinfo", [
    "/opt/homebrew/bin/pdfinfo",
    "/usr/local/bin/pdfinfo",
    "/usr/bin/pdfinfo"
  ], which, exists);
  const pdftohtmlPath = findExecutable("pdftohtml", [
    "/opt/homebrew/bin/pdftohtml",
    "/usr/local/bin/pdftohtml",
    "/usr/bin/pdftohtml"
  ], which, exists);
  const tesseractPath = findExecutable("tesseract", [
    join(homeDirectory, ".local", "bin", "tesseract"),
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/usr/bin/tesseract"
  ], which, exists);
  const [
    agentBrowser,
    ytDlpVersion,
    ffmpegVersion,
    pdfinfoVersion,
    pdftohtmlVersion,
    tesseractVersion
  ] = await Promise.all([
    inspectAgentBrowser(agentBrowserDirectory, exists, run),
    commandVersion(ytDlpPath, ["--version"], run),
    commandVersion(ffmpegPath, ["-version"], run),
    commandVersion(pdfinfoPath, ["-v"], run),
    commandVersion(pdftohtmlPath, ["-v"], run),
    commandVersion(tesseractPath, ["--version"], run)
  ]);
  const tools = [
    {
      name: "yt-dlp",
      path: ytDlpPath,
      version: ytDlpVersion,
      status: ytDlpPath === null ? "unavailable" : ytDlpVersion === null ? "partial" : "ready"
    },
    {
      name: "ffmpeg",
      path: ffmpegPath,
      version: ffmpegVersion,
      status: ffmpegPath === null ? "unavailable" : ffmpegVersion === null ? "partial" : "ready"
    },
    {
      name: "pdfinfo",
      path: pdfinfoPath,
      version: pdfinfoVersion,
      status: pdfinfoPath === null ? "unavailable" : pdfinfoVersion === null ? "partial" : "ready"
    },
    {
      name: "pdftohtml",
      path: pdftohtmlPath,
      version: pdftohtmlVersion,
      status: pdftohtmlPath === null ? "unavailable" : pdftohtmlVersion === null ? "partial" : "ready"
    },
    {
      name: "tesseract",
      path: tesseractPath,
      version: tesseractVersion,
      status: tesseractPath === null ? "unavailable" : tesseractVersion === null ? "partial" : "ready"
    }
  ];
  const warnings = [];
  const currentBunVersion = options.currentBunVersion ?? Bun.version;
  if (currentBunVersion !== expectedBunVersion) {
    warnings.push(`Use Bun ${expectedBunVersion}; current runtime is ${currentBunVersion}.`);
  }
  for (const dependency of dependencies) {
    if (dependency.status === "unavailable") {
      warnings.push(`${dependency.name} ${dependency.expectedVersion} is not installed; reinstall @hraness/oh with Bun.`);
    } else if (dependency.status === "partial") {
      warnings.push(`${dependency.name} must resolve to ${dependency.expectedVersion} for this oh release.`);
    }
  }
  if (!agentBrowser.deriveClient) {
    warnings.push("agent-browser does not expose the derive-client skill; reinstall the pinned dependency before HAR-based client work.");
  }
  const renderedBrowserAvailable = browsers.some(({ name, status }) => (name === "Google Chrome" || name === "Chromium") && status === "ready");
  if (!renderedBrowserAvailable) {
    warnings.push("Install Google Chrome or Chromium for rendered capture; Microsoft Edge can also be used through an explicitly selected CDP session, while Arc remains an explicit cookie or CDP source.");
  }
  if (agentBrowser.profiles.length === 0) {
    warnings.push("No discoverable Chrome profile names were reported; use --browser-live, --cdp, or an explicit profile path when needed.");
  }
  if (ytDlpPath === null) {
    warnings.push("Install yt-dlp to capture default YouTube metadata, thumbnails, and transcripts, and to enable optional --media all downloads.");
  }
  if (ffmpegPath === null)
    warnings.push("Install ffmpeg for yt-dlp formats that require audio/video merging or remuxing.");
  if (pdfinfoPath === null || pdftohtmlPath === null) {
    const missing = [
      ...pdfinfoPath === null ? ["pdfinfo"] : [],
      ...pdftohtmlPath === null ? ["pdftohtml"] : []
    ];
    warnings.push(`Install Poppler's ${missing.join(" and ")} command${missing.length === 1 ? "" : "s"}; oh pdf requires both pdfinfo and pdftohtml.`);
  } else if (pdfinfoVersion === null || pdftohtmlVersion === null) {
    warnings.push("Poppler was found, but a PDF tool version could not be verified; oh pdf can attempt ingestion with a degraded tool report.");
  }
  if (tesseractPath === null) {
    warnings.push("Install Tesseract to transcribe text in scans and screenshots; oh pdf still preserves native text and images without OCR.");
  } else if (tesseractVersion === null) {
    warnings.push("Tesseract was found, but its version could not be verified; oh pdf can attempt OCR with a degraded tool report.");
  }
  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date))().toISOString(),
    bun: {
      expectedVersion: expectedBunVersion,
      currentVersion: currentBunVersion,
      status: currentBunVersion === expectedBunVersion ? "ready" : "partial"
    },
    dependencies,
    deriveClient: {
      available: agentBrowser.deriveClient,
      status: agentBrowser.deriveClient ? "ready" : "unavailable"
    },
    browsers,
    chromeProfileNames: agentBrowser.profiles,
    tools,
    warnings
  };
}
function versionSummary(report) {
  const installed = report.installedVersion ?? "not installed";
  return `${report.name}: ${report.status} (installed ${installed}; expected ${report.expectedVersion})`;
}
function renderDoctorReport(report) {
  const lines = [
    "Oh ingestion environment",
    `Bun: ${report.bun.status} (${report.bun.currentVersion}; expected ${report.bun.expectedVersion})`,
    ...report.dependencies.map(versionSummary),
    `agent-browser derive-client: ${report.deriveClient.status}`,
    ...report.browsers.map((browser) => `${browser.name}: ${browser.status}${browser.paths.length === 0 ? "" : ` (${browser.paths.join(", ")})`}`),
    `Chrome profiles: ${report.chromeProfileNames.length === 0 ? "none discovered" : report.chromeProfileNames.join(", ")}`,
    ...report.tools.map((tool) => `${tool.name}: ${tool.status}${tool.version === null ? "" : ` (${tool.version})`}${tool.path === null ? "" : ` at ${tool.path}`}`),
    "Cookie/keychain probe: not performed"
  ];
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join(`
`)}
`;
}
var adapterCapabilities = [
  {
    id: "generic",
    platform: "Generic web",
    preferredModes: ["HTTP + Defuddle", "rendered browser fallback", "saved HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: [
      "JavaScript-only regions require a browser",
      "visible conversation prose can be retained, but site-specific item trees are not inferred generically"
    ]
  },
  {
    id: "x",
    platform: "X",
    preferredModes: ["rendered Chrome profile/live session", "Defuddle X extractor"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only posts and replies loaded into the rendered page are captured", "virtualized or unloaded replies remain partial", "private GraphQL clients are not invoked automatically"]
  },
  {
    id: "substack",
    platform: "Substack",
    preferredModes: ["HTTP + Defuddle", "authorized rendered session for subscriber pages"],
    page: "access-dependent",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Subscriber-only text is captured only when the selected session can already view it", "visible comments are retained as unstructured rendered context with conservative counts", "email/app-only or virtualized comments can be absent"]
  },
  {
    id: "instagram",
    platform: "Instagram",
    preferredModes: ["authorized rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated item adapter", "Login walls, virtualization, and lazy-loaded comments limit completeness", "private accounts require the user's authorized session"]
  },
  {
    id: "linkedin",
    platform: "LinkedIn",
    preferredModes: ["authorized rendered session", "saved rendered HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered fallback; no dedicated adapter", "UI changes and collapsed comment branches can reduce completeness", "no automated private API derivation"]
  },
  {
    id: null,
    platform: "Signed-in pages",
    preferredModes: ["current browser tab", "temporary browser-profile copy", "origin-filtered cookie HTTP fallback"],
    page: "access-dependent",
    conversations: "access-dependent",
    media: "access-dependent",
    limitations: ["Captures what the selected session renders", "virtualized or unloaded regions can remain partial"]
  },
  {
    id: "hacker-news",
    platform: "Hacker News",
    preferredModes: ["official Firebase API", "rendered/Defuddle fallback"],
    page: "complete",
    conversations: "bounded",
    media: "unsupported",
    limitations: ["Comment count and depth obey CLI bounds", "deleted and dead items remain represented only as exposed by the service"]
  },
  {
    id: "reddit",
    platform: "Reddit",
    preferredModes: ["best-effort public listing JSON", "rendered session", "Defuddle Reddit extractor"],
    page: "best-effort",
    conversations: "bounded",
    media: "best-effort",
    limitations: ["The unofficial JSON surface can be denied or changed and falls back automatically", "collapsed/deleted branches and configured item/depth bounds remain explicit"]
  },
  {
    id: "facebook",
    platform: "Facebook",
    preferredModes: ["authorized rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated item adapter", "Only visible, loaded content is captured", "private audiences require the user's authorized session"]
  },
  {
    id: "tiktok",
    platform: "TikTok",
    preferredModes: ["rendered session", "yt-dlp for accessible media"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Generic rendered context; no dedicated thread adapter", "Regional/login gates, virtualization, and lazy-loaded comments can reduce completeness", "DRM and access controls are never bypassed"]
  },
  {
    id: "bluesky",
    platform: "Bluesky",
    preferredModes: ["public AT Protocol thread API", "rendered/Defuddle fallback"],
    page: "complete",
    conversations: "bounded",
    media: "best-effort",
    limitations: ["Thread count and depth obey CLI bounds", "moderation labels and unavailable records are preserved only as exposed"]
  },
  {
    id: "threads",
    platform: "Threads",
    preferredModes: ["current browser tab", "rendered browser profile", "saved rendered HTML"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only rendered posts and replies are retained", "virtualized or unloaded replies remain partial"]
  },
  {
    id: "whatsapp",
    platform: "WhatsApp Web",
    preferredModes: ["current signed-in browser tab", "rendered browser profile"],
    page: "access-dependent",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only the open, rendered conversation is retained", "older virtualized messages can remain partial"]
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
      "Full audio/video download remains opt-in with --media all"
    ]
  },
  {
    id: "github",
    platform: "GitHub issues, pull requests, and discussions",
    preferredModes: ["Defuddle GitHub extractor", "current signed-in browser tab for private repositories"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only loaded timeline and review items are retained", "collapsed or paginated history can remain partial"]
  },
  {
    id: "discourse",
    platform: "Discourse",
    preferredModes: ["Defuddle Discourse extractor", "rendered browser fallback"],
    page: "best-effort",
    conversations: "best-effort",
    media: "best-effort",
    limitations: ["Only loaded topic posts are retained", "long or login-gated topics can remain partial"]
  }
];
function renderAdapterCapabilities(capabilities = adapterCapabilities) {
  const lines = [
    "Clip adapters",
    "Statuses: complete, bounded, best-effort, access-dependent, unsupported.",
    ""
  ];
  for (const capability of capabilities) {
    lines.push(`${capability.platform}: page=${capability.page}, conversations=${capability.conversations}, media=${capability.media}`, `  modes: ${capability.preferredModes.join("; ")}`, ...capability.limitations.map((limitation) => `  - ${limitation}`));
  }
  lines.push("", "Use the current browser tab or a temporary copy of a signed-in browser profile for pages you already have open.", "Capture is ingestion-only: it reads rendered content and does not post, like, follow, send, or submit.");
  return `${lines.join(`
`)}
`;
}

export { expectedBunVersion, runDiagnosticCommand, inspectClipEnvironment, renderDoctorReport, adapterCapabilities, renderAdapterCapabilities };
