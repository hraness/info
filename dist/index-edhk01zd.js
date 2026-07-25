// @bun
import {
  classifyPlatformUrl
} from "./index-hgve9rh2.js";
import {
  filterCookieProviderResult,
  readCookieFile,
  renderCookieHeader
} from "./index-1nmbpv8m.js";
import {
  startNetworkProxy
} from "./index-09ave90x.js";
import {
  assertSafeNetworkUrl,
  decodeBytes,
  safeFetch
} from "./index-b0b0vy11.js";
import {
  sanitizeArtifactUrl
} from "./index-ey9rycsn.js";
import {
  captureUrl
} from "./index-p1vzcd6b.js";
import {
  readBoundedByteStream
} from "./index-gh719d91.js";

// src/clip/acquire.ts
import {
  chmodSync,
  existsSync as existsSync2,
  lstatSync,
  mkdtempSync,
  readFileSync as readFileSync2,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname as dirname2, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "path";
import { getCookies } from "@steipete/sweet-cookie";

// src/clip/package-root.ts
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
function isPackageManifest(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function findOhPackageRoot(startDirectory = import.meta.dir, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync;
  const readText = dependencies.readText ?? ((path) => readFileSync(path, "utf8"));
  let directory = resolve(startDirectory);
  for (let depth = 0;depth < 8; depth += 1) {
    const manifestPath = join(directory, "package.json");
    if (exists(manifestPath)) {
      try {
        const parsed = JSON.parse(readText(manifestPath));
        if (isPackageManifest(parsed) && typeof parsed.name === "string" && parsed.name.endsWith("/oh") && typeof parsed.version === "string")
          return directory;
      } catch {}
    }
    const parent = dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  throw new Error("Could not locate the oh package root.");
}
function resolvePackageDirectory(packageName, parentUrl = import.meta.url) {
  const manifest = createRequire(parentUrl).resolve(`${packageName}/package.json`);
  return dirname(manifest);
}

// src/clip/acquire.ts
var agentBrowserBinDirectory = join2(resolvePackageDirectory("agent-browser"), "bin");
function agentBrowserCommand() {
  return [process.execPath, join2(agentBrowserBinDirectory, "agent-browser.js")];
}
var inheritedProxyKeys = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);
function isolatedAgentBrowserEnvironment(source, socketDirectory) {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith("AGENT_BROWSER_") || inheritedProxyKeys.has(key))
      continue;
    environment[key] = value;
  }
  environment.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
  return environment;
}
function createAgentBrowserIsolation(directory) {
  const configPath = join2(directory, "agent-browser.config.json");
  const socketRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const socketDirectory = mkdtempSync(join2(socketRoot, "jc-ab-"));
  try {
    chmodSync(socketDirectory, 448);
    writeFileSync(configPath, `{}
`, { encoding: "utf8", flag: "wx", mode: 384 });
    chmodSync(configPath, 384);
    return {
      configPath,
      cwd: directory,
      socketDirectory,
      environment: isolatedAgentBrowserEnvironment(process.env, socketDirectory)
    };
  } catch (error) {
    rmSync(socketDirectory, { recursive: true, force: true });
    throw error;
  }
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
async function readBoundedStream(stream, maxBytes) {
  const bytes = await readBoundedByteStream(stream, maxBytes, "process output");
  return new TextDecoder().decode(bytes);
}
async function runCommand(command, timeoutMs, maxOutputBytes, isolation, stdin) {
  const child = Bun.spawn([...command], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    ...isolation === undefined ? {} : { cwd: isolation.cwd, env: isolation.environment }
  });
  let timedOut = false;
  let forceKill = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, maxOutputBytes),
      readBoundedStream(child.stderr, Math.min(maxOutputBytes, 2 * 1024 * 1024)),
      child.exited
    ]);
    if (timedOut)
      throw new Error(`command timed out after ${timeoutMs}ms`);
    return { stdout, stderr, exitCode };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (forceKill !== null)
      clearTimeout(forceKill);
  }
}
function parseJsonValueOutput(output, label) {
  let lineEnd = output.length;
  while (lineEnd >= 0) {
    const newline = output.lastIndexOf(`
`, lineEnd - 1);
    const line = output.slice(newline + 1, lineEnd).trim();
    lineEnd = newline;
    if (line[0] !== "{" && line[0] !== "[")
      continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error(`${label} did not return JSON`);
}
function parseJsonOutput(output, label) {
  const parsed = parseJsonValueOutput(output, label);
  if (isRecord(parsed))
    return parsed;
  throw new Error(`${label} did not return a JSON object`);
}
function parseAgentBrowserData(output, label) {
  const parsed = parseJsonOutput(output, label);
  if (parsed.success !== true) {
    throw new Error(`${label} failed`);
  }
  if (!isRecord(parsed.data))
    throw new Error(`${label} returned no data`);
  return parsed.data;
}
async function runAgentBrowser(globalArgs, command, options) {
  let result;
  try {
    result = await runCommand([...agentBrowserCommand(), ...globalArgs, ...command, "--json"], options.timeoutMs, options.maxOutputBytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent-browser ${command[0] ?? "command"} failed: ${message}`, { cause: error });
  }
  if (result.exitCode !== 0) {
    throw new Error(`agent-browser ${command[0] ?? "command"} failed with exit code ${result.exitCode}`);
  }
  return parseAgentBrowserData(result.stdout, `agent-browser ${command[0] ?? "command"}`);
}
async function runAgentBrowserBatch(globalArgs, commands, options) {
  const result = await runCommand([...agentBrowserCommand(), ...globalArgs, "batch", "--bail", "--json"], options.timeoutMs, options.maxOutputBytes, options, JSON.stringify(commands));
  if (result.exitCode !== 0)
    throw new Error(`agent-browser batch failed with exit code ${result.exitCode}`);
  const parsed = parseJsonValueOutput(result.stdout, "agent-browser batch");
  if (!Array.isArray(parsed) || parsed.length !== commands.length || parsed.some((entry) => !isRecord(entry) || entry.success !== true))
    throw new Error("agent-browser batch failed");
}
async function discoverChromeProfiles(timeoutMs = 15000) {
  const directory = mkdtempSync(join2(tmpdir(), "hraness-oh-profiles-"));
  chmodSync(directory, 448);
  let socketDirectory = null;
  try {
    const isolation = createAgentBrowserIsolation(directory);
    socketDirectory = isolation.socketDirectory;
    const result = await runCommand([...agentBrowserCommand(), "--config", isolation.configPath, "profiles", "--json"], timeoutMs, 1024 * 1024, isolation);
    if (result.exitCode !== 0)
      return [];
    const parsed = parseJsonOutput(result.stdout, "agent-browser profiles");
    if (parsed.success !== true || !Array.isArray(parsed.data))
      return [];
    const profiles = [];
    for (const entry of parsed.data) {
      if (!isRecord(entry))
        continue;
      if (typeof entry.directory !== "string" || typeof entry.name !== "string")
        continue;
      profiles.push({ directory: entry.directory, name: entry.name });
    }
    return profiles;
  } finally {
    if (socketDirectory !== null)
      rmSync(socketDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
function selectedProfile(profiles) {
  const defaultProfile = profiles.find(({ directory }) => directory === "Default");
  if (defaultProfile !== undefined)
    return defaultProfile.directory;
  return profiles.length === 1 ? profiles[0]?.directory : undefined;
}
function shouldExpand(url, options, method) {
  if (options.scope === "page")
    return false;
  const platform = classifyPlatformUrl(url.href)?.platform ?? "generic";
  const hasExplicitCookies = options.cookieSources.length > 0 || options.cookiesFile !== undefined;
  if (platform === "x" && method === "browser-fresh" && !hasExplicitCookies)
    return false;
  return platform === "x" || platform === "hacker-news" || platform === "reddit" || platform === "bluesky" || platform === "linkedin" || platform === "facebook" || platform === "instagram" || platform === "tiktok" || platform === "threads" || platform === "whatsapp" || platform === "youtube" || platform === "github" || platform === "discourse" || platform === "substack";
}
function renderedTextLines(snapshot) {
  const lines = snapshot.replace(/\r\n?/g, `
`).split(`
`);
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "")
    start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1]?.trim() === "")
    end -= 1;
  return lines.slice(start, end);
}
function suffixPrefixOverlap(source, prefix) {
  if (source.length === 0 || prefix.length === 0)
    return 0;
  const fallback = new Array(prefix.length).fill(0);
  for (let index = 1;index < prefix.length; index += 1) {
    let matched2 = fallback[index - 1] ?? 0;
    while (matched2 > 0 && prefix[index] !== prefix[matched2]) {
      matched2 = fallback[matched2 - 1] ?? 0;
    }
    if (prefix[index] === prefix[matched2])
      matched2 += 1;
    fallback[index] = matched2;
  }
  let matched = 0;
  for (let index = 0;index < source.length; index += 1) {
    while (matched > 0 && source[index] !== prefix[matched]) {
      matched = fallback[matched - 1] ?? 0;
    }
    if (source[index] === prefix[matched])
      matched += 1;
    if (matched === prefix.length && index < source.length - 1) {
      matched = fallback[matched - 1] ?? 0;
    }
  }
  return matched;
}
function truncateUtf8(value, maxBytes) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes)
    return { content: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >>> 6 === 2)
    end -= 1;
  return {
    content: new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end)),
    truncated: true
  };
}
function mergeRenderedTextSnapshots(snapshots, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("rendered text byte limit must be a non-negative safe integer");
  }
  const merged = [];
  let hasBaseline = false;
  let addedLines = 0;
  for (const snapshot of snapshots) {
    const lines = renderedTextLines(snapshot);
    if (lines.length === 0)
      continue;
    if (!hasBaseline) {
      for (const line of lines)
        merged.push(line);
      hasBaseline = true;
      continue;
    }
    let commonPrefix = 0;
    const prefixLimit = Math.min(merged.length, lines.length);
    while (commonPrefix < prefixLimit && merged[commonPrefix] === lines[commonPrefix]) {
      commonPrefix += 1;
    }
    const remaining = lines.slice(commonPrefix);
    if (remaining.length === 0)
      continue;
    const overlap = suffixPrefixOverlap(merged, remaining);
    const additions = remaining.slice(overlap);
    if (additions.length === 0)
      continue;
    if (commonPrefix === 0 && overlap === 0 && merged.at(-1) !== "")
      merged.push("");
    for (const line of additions)
      merged.push(line);
    addedLines += additions.length;
  }
  const bounded = truncateUtf8(merged.join(`
`), maxBytes);
  return {
    ...bounded,
    observedSnapshots: snapshots.length,
    addedLines
  };
}
function browserExpansionLimits(maxItems, maxObservedTextBytes = 4 * 1024 * 1024) {
  const boundedItems = Number.isSafeInteger(maxItems) ? Math.max(1, Math.min(maxItems, 1e4)) : 500;
  const boundedObservationBytes = Number.isSafeInteger(maxObservedTextBytes) && maxObservedTextBytes > 0 ? Math.min(maxObservedTextBytes, 4 * 1024 * 1024) : 4 * 1024 * 1024;
  return {
    maxScrolls: Math.max(3, Math.min(40, Math.ceil(boundedItems / 20))),
    maxObservedTextBytes: boundedObservationBytes
  };
}
function browserExpansionScript(limits) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const renderedTextSnapshots = [];
    let observedTextBytes = 0;
    let renderedTextObservationTruncated = false;
    let stable = 0;
    let previousHeight = 0;
    let scrolls = 0;
    let settled = false;
    const boundedRenderedText = (value, maxBytes) => {
      let bytes = 0;
      let end = 0;
      while (end < value.length) {
        const first = value.charCodeAt(end);
        let width = 3;
        let codeUnits = 1;
        if (first <= 0x7f) width = 1;
        else if (first <= 0x7ff) width = 2;
        else if (first >= 0xd800 && first <= 0xdbff) {
          const second = value.charCodeAt(end + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            width = 4;
            codeUnits = 2;
          }
        }
        if (bytes + width > maxBytes) break;
        bytes += width;
        end += codeUnits;
      }
      return { text: value.slice(0, end), bytes, truncated: end < value.length };
    };
    for (let pass = 0; pass < ${limits.maxScrolls}; pass += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      scrolls += 1;
      await sleep(700);
      try {
        const root = document.body || document.documentElement;
        const renderedValue = root ? root.innerText : '';
        const rendered = typeof renderedValue === 'string' ? renderedValue : '';
        const remainingBytes = ${limits.maxObservedTextBytes} - observedTextBytes;
        const remainingPasses = ${limits.maxScrolls} - pass;
        const passBytes = Math.max(0, Math.ceil(remainingBytes / remainingPasses));
        const observation = boundedRenderedText(rendered, passBytes);
        if (observation.text.trim() !== '') renderedTextSnapshots.push(observation.text);
        observedTextBytes += observation.bytes;
        if (observation.truncated) renderedTextObservationTruncated = true;
      } catch {
        renderedTextObservationTruncated = true;
      }
      const height = document.documentElement.scrollHeight;
      stable = height === previousHeight ? stable + 1 : 0;
      previousHeight = height;
      if (stable >= 2) {
        settled = true;
        break;
      }
    }
    window.scrollTo(0, 0);
    return {
      scrolls,
      scrollBudgetReached: !settled && scrolls >= ${limits.maxScrolls},
      renderedTextSnapshots,
      renderedTextObservationTruncated
    };
  })()`;
}
var nonNegativeInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function readBrowserExpansionTelemetry(value, limits) {
  if (!isRecord(value))
    return null;
  const scrolls = nonNegativeInteger(value.scrolls);
  if (!Array.isArray(value.renderedTextSnapshots))
    return null;
  if (value.renderedTextSnapshots.length > limits.maxScrolls)
    return null;
  const renderedTextSnapshots = [];
  let observedTextBytes = 0;
  for (const snapshot of value.renderedTextSnapshots) {
    if (typeof snapshot !== "string")
      return null;
    if (snapshot.length > limits.maxObservedTextBytes)
      return null;
    observedTextBytes += new TextEncoder().encode(snapshot).byteLength;
    if (observedTextBytes > limits.maxObservedTextBytes)
      return null;
    renderedTextSnapshots.push(snapshot);
  }
  if (scrolls === null || scrolls > limits.maxScrolls || renderedTextSnapshots.length > scrolls || typeof value.scrollBudgetReached !== "boolean" || typeof value.renderedTextObservationTruncated !== "boolean")
    return null;
  return {
    scrolls,
    scrollBudgetReached: value.scrollBudgetReached,
    renderedTextSnapshots,
    renderedTextObservationTruncated: value.renderedTextObservationTruncated
  };
}
function browserExpansionWarnings(telemetry, limits) {
  const warnings = [
    "Browser capture left disclosure controls untouched; collapsed content may remain unavailable."
  ];
  if (telemetry.scrollBudgetReached) {
    warnings.push(`Browser capture reached its ${limits.maxScrolls}-scroll budget before the document stabilized; lazy content may remain unloaded.`);
  }
  if (telemetry.renderedTextObservationTruncated) {
    warnings.push(`Rendered-text observations reached their ${limits.maxObservedTextBytes}-byte capture budget; some virtualized content may be missing.`);
  }
  return warnings;
}
function browserCaptureScript() {
  return `({
    url: location.href,
    title: document.title,
    html: '<!doctype html>\\n' + document.documentElement.outerHTML
  })`;
}
function readBrowserContent(data) {
  if (typeof data.content !== "string" || data.content.trim() === "") {
    throw new Error("agent-browser read returned no rendered content");
  }
  const url = typeof data.finalUrl === "string" ? data.finalUrl : data.url;
  if (typeof url !== "string")
    throw new Error("agent-browser read returned no final URL");
  return { content: data.content, finalUrl: new URL(url), truncated: data.truncated === true };
}
function readBrowserUrl(data) {
  const value = typeof data.url === "string" ? data.url : data.finalUrl;
  if (typeof value !== "string")
    throw new Error("agent-browser returned no current URL");
  return new URL(value);
}
function navigationIdentity(url) {
  const comparable = new URL(url);
  comparable.hash = "";
  return comparable.href;
}
function browserExpansionStayedOnPage(before, after) {
  return (after.protocol === "http:" || after.protocol === "https:") && navigationIdentity(before) === navigationIdentity(after);
}
function browserNavigationReachedTarget(target, before, after, navigationCommandSucceeded) {
  if (after.protocol !== "http:" && after.protocol !== "https:")
    return false;
  const targetIdentity = navigationIdentity(target);
  const afterIdentity = navigationIdentity(after);
  if (afterIdentity === targetIdentity)
    return true;
  return navigationCommandSucceeded && before !== null && navigationIdentity(before) !== afterIdentity;
}
async function terminateAgentBrowserSession(session, socketDirectory) {
  const pidPath = join2(socketDirectory, `${session}.pid`);
  if (!existsSync2(pidPath))
    return;
  const rawPid = readFileSync2(pidPath, "utf8").trim();
  if (!/^\d+$/.test(rawPid))
    return;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    return;
  const signal = (name) => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {}
    }
  };
  signal("SIGTERM");
  await Bun.sleep(500);
  signal("SIGKILL");
}
function pathInside(root, target) {
  const child = relative(root, target);
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
function canonicalPotentialPath(value, label) {
  const suffix = [];
  let ancestor = resolve2(value);
  while (true) {
    try {
      lstatSync(ancestor);
      let canonicalAncestor;
      try {
        canonicalAncestor = realpathSync(ancestor);
      } catch {
        throw new Error(`${label} contains an unresolved symbolic link.`);
      }
      return resolve2(canonicalAncestor, ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
    const parent = dirname2(ancestor);
    if (parent === ancestor)
      throw new Error(`${label} has no resolvable filesystem ancestor.`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
}
function profilePath(value) {
  const pathLike = isAbsolute(value) || value.startsWith(`.${sep}`) || value.startsWith(`..${sep}`) || value.startsWith(`~${sep}`) || value.includes("/") || value.includes("\\");
  if (!pathLike)
    return null;
  const expanded = value.startsWith(`~${sep}`) ? join2(homedir(), value.slice(2)) : resolve2(value);
  return canonicalPotentialPath(expanded, "Persistent browser profile");
}
function assertSafePersistentProfile(options) {
  if (options.browserProfile === undefined)
    return null;
  const path = profilePath(options.browserProfile);
  if (path === null)
    return null;
  const repositoryRoot = realpathSync(findOhPackageRoot());
  const outputRoot = canonicalPotentialPath(options.outputBase, "Capture output root");
  if (pathInside(repositoryRoot, path) || pathInside(outputRoot, path) || pathInside(path, outputRoot)) {
    throw new Error("Persistent browser profiles must live outside the repository and capture output roots.");
  }
  return path;
}
function browserCookieCommands(cookies, target) {
  return cookies.map((cookie) => {
    const command = ["cookies", "set", cookie.name, cookie.value];
    if (cookie.hostOnly)
      command.push("--url", target.origin);
    else
      command.push("--domain", `.${cookie.domain}`);
    command.push("--path", cookie.path);
    if (cookie.httpOnly)
      command.push("--httpOnly");
    if (cookie.secure)
      command.push("--secure");
    if (cookie.sameSite !== null)
      command.push("--sameSite", cookie.sameSite);
    if (cookie.expires > 0)
      command.push("--expires", String(cookie.expires));
    return command;
  });
}
async function seedOwnedBrowserCookies(options, globalArgs, commandOptions, dependencies = {}) {
  const selected = options.cookieSources.length > 0 || options.cookiesFile !== undefined;
  if (!selected)
    return [];
  const target = captureUrl(options);
  const result = await (dependencies.readCookies ?? acquireCookieRecords)(options, target);
  await (dependencies.runBatch ?? runAgentBrowserBatch)(globalArgs, browserCookieCommands(result.cookies, target), commandOptions);
  return [
    ...result.warnings,
    "Seeded explicitly selected cookies into the owned browser without broadening their domain, path, Secure, HttpOnly, SameSite, or expiry attributes."
  ];
}
function browserProxyArguments(proxyUrl, profileDirectory) {
  const chromiumArguments = [
    ...profileDirectory === undefined ? [] : [`--profile-directory=${profileDirectory}`],
    "--disable-quic",
    "--disable-dns-prefetch",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=AsyncDns",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--proxy-bypass-list=<-loopback>"
  ].join(`
`);
  return ["--proxy", proxyUrl, "--args", chromiumArguments];
}
async function acquireBrowser(options, temporaryDirectory, useDiscoveredProfile = false, dependencies = {}) {
  if (options.currentTab && (!options.browserLive && options.cdp === undefined)) {
    throw new Error("current-tab capture requires --browser-live or --cdp");
  }
  if (options.currentTab && options.browserProfile !== undefined) {
    throw new Error("current-tab capture cannot use a browser profile; attach with --browser-live or --cdp");
  }
  const assertNetworkUrl = dependencies.assertNetworkUrl ?? assertSafeNetworkUrl;
  const requestedUrl = options.currentTab ? null : captureUrl(options);
  if (requestedUrl !== null) {
    await assertNetworkUrl(requestedUrl, options.allowPrivateNetwork, options.timeoutMs);
  }
  const runBrowser = dependencies.run ?? runAgentBrowser;
  const runBrowserBatch = dependencies.runBatch ?? runAgentBrowserBatch;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const warnings = [];
  const persistentProfilePath = assertSafePersistentProfile(options);
  const ownedProfile = options.browserProfileOwnership === "owned";
  if (ownedProfile && persistentProfilePath === null) {
    throw new Error("owned browser-profile execution requires an explicit path-backed profile");
  }
  const session = `clip-${process.pid}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const isolation = createAgentBrowserIsolation(temporaryDirectory);
  try {
    const globalArgs = ["--config", isolation.configPath, "--session", session];
    if (options.browserExecutable !== undefined) {
      globalArgs.push("--executable-path", options.browserExecutable);
    }
    let method = "browser-fresh";
    let ownsBrowser = true;
    if (options.cdp !== undefined) {
      globalArgs.push("--cdp", options.cdp);
      method = "browser-cdp";
      ownsBrowser = false;
    } else if (options.browserLive) {
      globalArgs.push("--auto-connect");
      method = "browser-live";
      ownsBrowser = false;
    } else {
      const profile = options.browserProfile ?? (useDiscoveredProfile ? selectedProfile(await discoverChromeProfiles(options.timeoutMs)) : undefined);
      if (profile !== undefined) {
        globalArgs.push("--profile", profile);
        method = "browser-profile";
        warnings.push(ownedProfile ? "Used an owned private browser-profile snapshot; page activity cannot modify the source profile." : persistentProfilePath === null ? "A named Chrome profile can expose broad all-origin browser state to public subresources loaded by the target page; prefer a dedicated per-site profile." : "The selected persistent browser profile can be updated by page activity; keep dedicated capture profiles outside the repository.");
      } else if (options.browserProfile !== undefined || useDiscoveredProfile) {
        warnings.push("No unambiguous Chrome profile was found; used a fresh browser session.");
      }
    }
    let networkProxy = null;
    const commandOptions = {
      cwd: isolation.cwd,
      environment: isolation.environment,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: Math.max(options.maxHtmlBytes * 2 + 1024 * 1024, 4 * 1024 * 1024)
    };
    try {
      if (ownsBrowser) {
        networkProxy = await startNetworkProxy({
          allowPrivateNetwork: options.allowPrivateNetwork,
          timeoutMs: options.timeoutMs,
          maxTransferredBytes: Math.max(64 * 1024 * 1024, Math.min(Number.MAX_SAFE_INTEGER, (options.maxHtmlBytes + options.maxTotalAssetBytes) * 2))
        });
        globalArgs.push(...browserProxyArguments(networkProxy.url, options.browserProfileDirectory));
      }
      if (!options.currentTab) {
        try {
          await runBrowser(globalArgs, ["open", "about:blank"], commandOptions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Browser startup did not settle cleanly; attempted to use the isolated session: ${message}`);
        }
      }
      if (ownsBrowser && (method === "browser-fresh" || ownedProfile)) {
        warnings.push(...await seedOwnedBrowserCookies(options, globalArgs, commandOptions));
      } else if (options.cookieSources.length > 0 || options.cookiesFile !== undefined) {
        warnings.push("Explicit cookie input remained a separate HTTP/media lane and was not imported into the selected profile or attached browser.");
      }
      if (!ownsBrowser) {
        warnings.push(options.currentTab ? "Captured the current attached tab without navigation or interaction; the external browser itself was left open." : "Attached browser capture navigated and scrolled the active tab; the external browser itself was left open.");
      }
      let beforeNavigation = null;
      try {
        beforeNavigation = readBrowserUrl(await runBrowser(globalArgs, ["get", "url"], commandOptions));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Could not establish a pre-navigation browser URL: ${message}`);
      }
      let navigationCommandSucceeded = false;
      if (!options.currentTab) {
        try {
          await runBrowserBatch(globalArgs, [["open", captureUrl(options).href]], commandOptions);
          navigationCommandSucceeded = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Browser navigation command ended during page transition: ${message}`);
        }
        await sleep(Math.min(5000, Math.max(1500, Math.floor(options.timeoutMs / 6))));
      }
      let readable;
      try {
        readable = readBrowserContent(await runBrowser(globalArgs, ["read"], commandOptions));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Rendered readable text was unavailable; continuing with the bounded DOM: ${message}`);
        readable = {
          content: "",
          finalUrl: readBrowserUrl(await runBrowser(globalArgs, ["get", "url"], commandOptions)),
          truncated: false
        };
      }
      if (options.currentTab) {
        if (readable.finalUrl.protocol !== "http:" && readable.finalUrl.protocol !== "https:") {
          throw new Error("the current tab must have an HTTP or HTTPS URL");
        }
        if (beforeNavigation !== null && !browserExpansionStayedOnPage(beforeNavigation, readable.finalUrl)) {
          throw new Error("the current tab changed pages while it was being read; retry on the intended page");
        }
      } else if (!browserNavigationReachedTarget(captureUrl(options), beforeNavigation, readable.finalUrl, navigationCommandSucceeded)) {
        throw new Error("browser did not establish the requested navigation; refusing to capture a pre-existing tab");
      }
      let browserPageProvenanceIntact = true;
      if (!options.currentTab && shouldExpand(readable.finalUrl, options, method)) {
        const expansionLimits = browserExpansionLimits(options.maxItems, options.maxHtmlBytes);
        try {
          const expansion = await runBrowser(globalArgs, ["eval", browserExpansionScript(expansionLimits)], {
            ...commandOptions,
            timeoutMs: Math.min(commandOptions.timeoutMs, 30000)
          });
          const telemetry = readBrowserExpansionTelemetry(expansion.result, expansionLimits);
          if (telemetry === null) {
            warnings.push("Browser expansion returned no trustworthy bounded-work telemetry; conversation completeness cannot be confirmed.");
          } else {
            warnings.push(...browserExpansionWarnings(telemetry, expansionLimits));
          }
          const expandedReadable = readBrowserContent(await runBrowser(globalArgs, ["read"], commandOptions));
          if (browserExpansionStayedOnPage(readable.finalUrl, expandedReadable.finalUrl)) {
            const merged = mergeRenderedTextSnapshots([
              readable.content,
              ...telemetry?.renderedTextSnapshots ?? [],
              expandedReadable.content
            ], options.maxHtmlBytes);
            readable = {
              content: merged.content,
              finalUrl: expandedReadable.finalUrl,
              truncated: readable.truncated || expandedReadable.truncated || telemetry?.renderedTextObservationTruncated === true || merged.truncated
            };
            if (merged.addedLines > 0) {
              warnings.push(`Merged ${merged.addedLines} newly observed rendered-text line(s) with the pre-expansion snapshot so virtualized content remains available.`);
            }
          } else {
            browserPageProvenanceIntact = false;
            warnings.push("Browser expansion navigated away from the captured page; preserved the proven baseline and skipped post-expansion DOM and screenshot capture.");
          }
        } catch (error) {
          browserPageProvenanceIntact = false;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Browser expansion stopped early; preserved the baseline rendered text and skipped post-expansion DOM and screenshot capture: ${message}`);
        }
      }
      if (!options.currentTab) {
        await assertNetworkUrl(readable.finalUrl, options.allowPrivateNetwork, options.timeoutMs);
      }
      const renderedText = readable.content;
      let body = renderedText;
      let contentType = "text/plain; charset=utf-8";
      let contentTruncated = readable.truncated;
      let sourceEvidence;
      let browserTitle;
      if (browserPageProvenanceIntact) {
        try {
          const capture = await runBrowser(globalArgs, ["eval", browserCaptureScript()], commandOptions);
          if (isRecord(capture.result)) {
            const html = capture.result.html;
            const title = capture.result.title;
            const captureUrl2 = typeof capture.result.url === "string" ? new URL(capture.result.url) : null;
            if (captureUrl2 === null || !browserExpansionStayedOnPage(readable.finalUrl, captureUrl2)) {
              browserPageProvenanceIntact = false;
              warnings.push("Rendered DOM capture changed pages; preserved the proven readable baseline.");
            } else if (typeof html === "string") {
              const byteLength = new TextEncoder().encode(html).byteLength;
              if (byteLength <= options.maxHtmlBytes) {
                body = html;
                contentType = "text/html; charset=utf-8";
                contentTruncated = false;
                if (options.evidence === "source" || options.evidence === "all")
                  sourceEvidence = html;
              } else {
                warnings.push(`Rendered DOM exceeded ${options.maxHtmlBytes} bytes; extracted the bounded readable fallback.`);
              }
            }
            if (browserPageProvenanceIntact && typeof title === "string" && title.trim() !== "")
              browserTitle = title;
          } else {
            browserPageProvenanceIntact = false;
            warnings.push("Rendered DOM capture returned no trustworthy page provenance; preserved the readable baseline.");
          }
        } catch (error) {
          browserPageProvenanceIntact = false;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Rendered DOM was unavailable; extracted the bounded readable fallback: ${message}`);
        }
      } else {
        warnings.push("Rendered DOM capture was skipped because post-expansion page provenance was not established.");
      }
      if (body.trim() === "")
        throw new Error("browser returned neither readable text nor a bounded rendered DOM");
      if (readable.truncated)
        warnings.push("Rendered text was truncated at its configured output boundary.");
      let screenshotPath;
      if ((options.evidence === "screenshot" || options.evidence === "all") && browserPageProvenanceIntact) {
        const requestedScreenshotPath = join2(temporaryDirectory, "page.png");
        screenshotPath = requestedScreenshotPath;
        try {
          await runBrowser(globalArgs, ["screenshot", requestedScreenshotPath], {
            ...commandOptions,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: 2 * 1024 * 1024
          });
          const afterScreenshot = readBrowserUrl(await runBrowser(globalArgs, ["get", "url"], commandOptions));
          if (!browserExpansionStayedOnPage(readable.finalUrl, afterScreenshot)) {
            rmSync(requestedScreenshotPath, { force: true });
            warnings.push("Browser screenshot changed pages during capture and was discarded.");
            screenshotPath = undefined;
          } else if (!existsSync2(requestedScreenshotPath)) {
            warnings.push("Browser screenshot was requested but agent-browser did not create it.");
            screenshotPath = undefined;
          }
        } catch (error) {
          rmSync(requestedScreenshotPath, { force: true });
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Browser screenshot was unavailable or had no trustworthy page provenance: ${message}`);
          screenshotPath = undefined;
        }
      } else if (options.evidence === "screenshot" || options.evidence === "all") {
        warnings.push("Browser screenshot was skipped because post-expansion page provenance was not established.");
      }
      return {
        body,
        contentType,
        finalUrl: options.currentTab ? new URL(sanitizeArtifactUrl(readable.finalUrl.href)) : readable.finalUrl,
        method,
        warnings,
        ...browserTitle === undefined ? {} : { browserTitle },
        ...screenshotPath === undefined ? {} : { screenshotPath },
        ...sourceEvidence === undefined ? {} : { sourceEvidence },
        ...contentTruncated ? { contentTruncated: true } : {},
        renderedText,
        ...readable.truncated ? { renderedTextTruncated: true } : {},
        renderedTextByteLimit: options.maxHtmlBytes
      };
    } finally {
      try {
        if (ownsBrowser) {
          try {
            await runBrowser(["--config", isolation.configPath, "--session", session], ["close"], {
              cwd: isolation.cwd,
              environment: isolation.environment,
              timeoutMs: 15000,
              maxOutputBytes: 1024 * 1024
            });
          } catch {
            warnings.push("Browser session did not close cleanly; terminated its isolated process group.");
          }
        }
        await terminateAgentBrowserSession(session, isolation.socketDirectory);
      } finally {
        await networkProxy?.close();
      }
    }
  } finally {
    rmSync(isolation.socketDirectory, { recursive: true, force: true });
  }
}
async function acquireHttp(options) {
  const response = await safeFetch(captureUrl(options), {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxHtmlBytes,
    allowPrivateNetwork: options.allowPrivateNetwork,
    userAgent: options.userAgent,
    retries: 2
  });
  return {
    body: decodeBytes(response.bytes, response.contentType),
    contentType: response.contentType,
    finalUrl: response.finalUrl,
    method: "http",
    warnings: []
  };
}
async function acquireCookieHttp(options) {
  if (options.cookieSources.length === 0 && options.cookiesFile === undefined) {
    throw new Error("cookie capture requires --cookie-source or --cookies-file");
  }
  const target = captureUrl(options);
  const cookieResult = await acquireCookieHeader(options, target);
  const response = await safeFetch(target, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxHtmlBytes,
    allowPrivateNetwork: options.allowPrivateNetwork,
    userAgent: options.userAgent,
    cookieHeader: cookieResult.header,
    retries: 2
  });
  return {
    body: decodeBytes(response.bytes, response.contentType),
    contentType: response.contentType,
    finalUrl: response.finalUrl,
    method: "cookie-http",
    warnings: cookieResult.warnings
  };
}
function createCookieRecordReader(reader) {
  return async (options, url) => {
    if (options.cookieSources.length === 0 && options.cookiesFile === undefined) {
      throw new Error("cookie capture requires --cookie-source or --cookies-file");
    }
    if (options.cookiesFile !== undefined) {
      const parsed = readCookieFile(options.cookiesFile, url, {
        requirePrivate: options.requireExplicitCookieScope === true
      });
      if (!parsed.ok) {
        throw new Error("the explicitly selected cookie file contained no usable cookies for this request");
      }
      if (options.requireExplicitCookieScope === true && parsed.scopeProvenance !== "explicit") {
        throw new Error("authenticated API cookie files require an explicit domain or URL on every cookie record");
      }
      const warnings2 = [];
      if (options.cookieSources.length > 0) {
        warnings2.push("The explicit cookie file took precedence over the selected browser cookie source.");
      }
      if (parsed.rejected > 0) {
        warnings2.push(`Ignored ${parsed.rejected} malformed, expired, or out-of-scope cookie record(s).`);
      }
      if (parsed.format === "cookie-header" || parsed.format === "curl") {
        warnings2.push("The cookie header did not encode attributes; browser replay inferred restrictive host-only, target-path, HTTPS-Secure, HttpOnly, and SameSite=Strict attributes. Use Cookie-Editor JSON or Netscape format when exact attributes matter.");
      }
      return { cookies: parsed.cookies, warnings: warnings2 };
    }
    if (options.cookieSources.length === 0) {
      throw new Error("cookie capture requires at least one explicit browser cookie source");
    }
    const chromiumSource = options.cookieSources.find((source) => source === "chrome" || source === "arc" || source === "brave" || source === "chromium");
    const selectedBrowsers = [];
    for (const source of options.cookieSources) {
      const backend = source === "arc" || source === "brave" || source === "chromium" ? "chrome" : source;
      if (!selectedBrowsers.includes(backend))
        selectedBrowsers.push(backend);
    }
    const cookieOptions = {
      url: url.href,
      mode: "first",
      timeoutMs: options.timeoutMs,
      debug: false,
      browsers: selectedBrowsers,
      profile: options.cookieProfile ?? "",
      chromeProfile: options.cookieProfile ?? "",
      edgeProfile: options.cookieProfile ?? "",
      firefoxProfile: options.cookieProfile ?? "",
      ...chromiumSource === undefined ? {} : { chromiumBrowser: chromiumSource },
      ...options.cookieProfile === undefined ? {} : {
        ...options.cookieSources.includes("safari") ? { safariCookiesFile: options.cookieProfile } : {}
      }
    };
    let provided;
    try {
      provided = await reader(cookieOptions);
    } catch {
      throw new Error("the explicitly selected browser cookie source could not be read");
    }
    const filtered = filterCookieProviderResult(provided, url);
    if (!filtered.validShape)
      throw new Error("the selected browser cookie provider returned malformed data");
    if (filtered.cookies.length === 0) {
      throw new Error(filtered.rejected === 0 ? "no matching cookies were found in the explicitly selected browser" : `no usable origin-scoped cookies were found; rejected ${filtered.rejected} malformed, expired, or out-of-scope record(s)`);
    }
    const warnings = [];
    if (filtered.rejected > 0) {
      warnings.push(`Ignored ${filtered.rejected} malformed, expired, or out-of-scope browser cookie record(s).`);
    }
    if (filtered.providerWarningCount > 0) {
      warnings.push(`The browser cookie provider reported ${filtered.providerWarningCount} non-fatal warning(s).`);
    }
    return { cookies: filtered.cookies, warnings };
  };
}
function createCookieHeaderReader(reader) {
  const records = createCookieRecordReader(reader);
  return async (options, url) => {
    const result = await records(options, url);
    return { header: renderCookieHeader(result.cookies), warnings: result.warnings };
  };
}
var acquireCookieRecords = createCookieRecordReader((options) => getCookies(options));
var acquireCookieHeader = async (options, url) => {
  const result = await acquireCookieRecords(options, url);
  return { header: renderCookieHeader(result.cookies), warnings: result.warnings };
};
async function readStdinBounded(maxBytes) {
  return readBoundedStream(Bun.stdin.stream(), maxBytes);
}
async function acquireFile(options) {
  if (options.htmlFile === undefined)
    throw new Error("file capture requires --html <path|->");
  const body = options.htmlFile === "-" ? await readStdinBounded(options.maxHtmlBytes) : (() => {
    const stats = statSync(options.htmlFile);
    if (!stats.isFile())
      throw new Error(`HTML input is not a regular file: ${options.htmlFile}`);
    if (stats.size > options.maxHtmlBytes) {
      throw new Error(`HTML input is ${stats.size} bytes; limit is ${options.maxHtmlBytes}`);
    }
    return readFileSync2(options.htmlFile, "utf8");
  })();
  return {
    body,
    contentType: "text/html; charset=utf-8",
    finalUrl: captureUrl(options),
    method: "file",
    warnings: options.htmlFile === "-" ? [] : [`Parsed rendered HTML from ${basename(options.htmlFile)}.`]
  };
}

export { findOhPackageRoot, agentBrowserCommand, isolatedAgentBrowserEnvironment, discoverChromeProfiles, mergeRenderedTextSnapshots, browserExpansionLimits, browserExpansionScript, readBrowserExpansionTelemetry, browserExpansionWarnings, browserExpansionStayedOnPage, browserNavigationReachedTarget, assertSafePersistentProfile, browserCookieCommands, seedOwnedBrowserCookies, browserProxyArguments, acquireBrowser, acquireHttp, acquireCookieHttp, createCookieRecordReader, createCookieHeaderReader, acquireCookieRecords, acquireCookieHeader, acquireFile };
