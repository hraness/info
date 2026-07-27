export const captureModes = ["auto", "http", "browser", "file"] as const;
export type CaptureMode = (typeof captureModes)[number];

export const captureScopes = ["auto", "page", "thread", "comments"] as const;
export type CaptureScope = (typeof captureScopes)[number];

export const mediaModes = ["none", "images", "all"] as const;
export type MediaMode = (typeof mediaModes)[number];

export const evidenceModes = ["none", "source", "screenshot", "all"] as const;
export type EvidenceMode = (typeof evidenceModes)[number];

export const cookieSources = ["chrome", "arc", "brave", "chromium", "edge", "firefox", "safari"] as const;
export type CookieSource = (typeof cookieSources)[number];

export type CaptureArguments = {
  readonly command: "capture" | "inspect";
  /** Null only for the `current` target before its attached tab has been read. */
  readonly url: URL | null;
  readonly currentTab: boolean;
  readonly slug: string | undefined;
  readonly mode: CaptureMode;
  readonly scope: CaptureScope;
  readonly media: MediaMode;
  readonly evidence: EvidenceMode;
  readonly htmlFile: string | undefined;
  readonly outputBase: string;
  readonly force: boolean;
  readonly stdout: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly browserProfile: string | undefined;
  /** Internal embedding contract: the path is an owned, disposable clone. */
  readonly browserProfileOwnership?: "borrowed" | "owned";
  /** Internal Chromium profile selection inside an owned user-data clone. */
  readonly browserProfileDirectory?: "Default";
  /** Trusted embedding contract: exact browser binary paired with the selected profile. */
  readonly browserExecutable?: string;
  readonly browserLive: boolean;
  readonly cdp: string | undefined;
  readonly cookieSources: readonly CookieSource[];
  readonly cookieProfile: string | undefined;
  readonly cookiesFile: string | undefined;
  readonly timeoutMs: number;
  readonly maxItems: number;
  readonly maxDepth: number;
  readonly maxHtmlBytes: number;
  readonly maxAssetBytes: number;
  readonly maxTotalAssetBytes: number;
  readonly allowPrivateNetwork: boolean;
  readonly userAgent: string;
};

export type CliArguments =
  | CaptureArguments
  | { readonly command: "doctor"; readonly json: boolean }
  | { readonly command: "adapters"; readonly json: boolean }
  | { readonly command: "help" };

export type ParseArgumentsResult =
  | { readonly ok: true; readonly value: CliArguments }
  | { readonly ok: false; readonly message: string };

/** Require a URL after a `current` target has been resolved from its attached tab. */
export function captureUrl(options: Pick<CaptureArguments, "url">): URL {
  if (options.url === null) throw new Error("the current browser target has not resolved its URL yet");
  return options.url;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const defaults = {
  timeoutMs: 30_000,
  maxItems: 500,
  maxDepth: 16,
  maxHtmlBytes: 25 * 1024 * 1024,
  maxAssetBytes: 100 * 1024 * 1024,
  maxTotalAssetBytes: 500 * 1024 * 1024,
} as const;

const valueOptions = new Set([
  "--mode",
  "--scope",
  "--media",
  "--evidence",
  "--html",
  "--output",
  "--browser-profile",
  "--cdp",
  "--cookie-profile",
  "--cookies-file",
  "--user-agent",
  "--cookie-source",
  "--timeout-ms",
  "--max-items",
  "--max-depth",
  "--max-html-bytes",
  "--max-asset-bytes",
  "--max-total-asset-bytes",
]);

function enumValue<T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string } {
  const match = values.find((candidate) => candidate === value);
  return match === undefined
    ? { ok: false, message: `${label} must be one of ${values.join(", ")}` }
    : { ok: true, value: match };
}

function positiveInteger(value: string, label: string, maximum: number): number | string {
  if (!/^\d+$/.test(value)) return `${label} must be a positive integer`;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return `${label} must be between 1 and ${maximum}`;
  }
  return parsed;
}

function byteSize(value: string, label: string): number | string {
  const match = /^(\d+)(b|kb|mb|gb)?$/i.exec(value);
  if (match === null || match[1] === undefined) {
    return `${label} must be an integer byte size such as 500000, 25mb, or 1gb`;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  const parsed = amount * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8 * 1024 ** 3) {
    return `${label} must be between 1 byte and 8gb`;
  }
  return parsed;
}

function readOptionValue(args: readonly string[], index: number, flag: string): string | ParseArgumentsResult {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--")
    ? { ok: false, message: `${flag} requires a value` }
    : value;
}

function parseUrl(value: string, label = "URL"): URL | string {
  if (value.length > 64 * 1024) return `${label} exceeds the 65536 code-unit safety limit`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${label} must use http or https`;
    if (url.username !== "" || url.password !== "") {
      return `${label} must not contain embedded credentials; use --cookies-file or a browser session`;
    }
    return url;
  } catch {
    return `${label} is not a valid URL`;
  }
}

/** Parse the stable CLI surface without touching the filesystem or network. */
export function parseArguments(
  rawArgs: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): ParseArgumentsResult {
  if (rawArgs.length === 0 || rawArgs[0] === "help" || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
    return { ok: true, value: { command: "help" } };
  }

  const first = rawArgs[0];
  if (first === "doctor" || first === "adapters") {
    const extra = rawArgs.slice(1);
    if (extra.some((value) => value !== "--json")) {
      return { ok: false, message: `${first} only accepts --json` };
    }
    return { ok: true, value: { command: first, json: extra.includes("--json") } };
  }

  let command: "capture" | "inspect" = "capture";
  let cursor = 0;
  if (first === "capture" || first === "inspect") {
    command = first;
    cursor += 1;
  }

  const positional: string[] = [];
  let mode: CaptureMode = "auto";
  let scope: CaptureScope = "auto";
  let media: MediaMode = command === "inspect" ? "none" : "images";
  let evidence: EvidenceMode = "none";
  let mediaExplicit = false;
  let evidenceExplicit = false;
  let htmlFile: string | undefined;
  let outputBase = environment.KB_CLIP_OUTPUT ?? "kb/articles";
  let force = false;
  let stdout = command === "inspect";
  let stdoutExplicit = false;
  let json = false;
  let quiet = false;
  let browserProfile: string | undefined;
  let browserLive = false;
  let cdp: string | undefined;
  const selectedCookieSources: CookieSource[] = [];
  let cookieProfile: string | undefined;
  let cookiesFile: string | undefined;
  let timeoutMs: number = defaults.timeoutMs;
  let maxItems: number = defaults.maxItems;
  let maxDepth: number = defaults.maxDepth;
  let maxHtmlBytes: number = defaults.maxHtmlBytes;
  let maxAssetBytes: number = defaults.maxAssetBytes;
  let maxTotalAssetBytes: number = defaults.maxTotalAssetBytes;
  let allowPrivateNetwork = false;
  let userAgent = environment.KB_CLIP_USER_AGENT ?? DEFAULT_USER_AGENT;

  for (; cursor < rawArgs.length; cursor += 1) {
    const argument = rawArgs[cursor];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }

    if (argument === "--force") force = true;
    else if (argument === "--stdout") {
      stdout = true;
      stdoutExplicit = true;
    }
    else if (argument === "--json") json = true;
    else if (argument === "--quiet") quiet = true;
    else if (argument === "--browser-live") browserLive = true;
    else if (argument === "--allow-private-network") allowPrivateNetwork = true;
    else {
      if (!valueOptions.has(argument)) return { ok: false, message: `unknown option: ${argument}` };
      const value = readOptionValue(rawArgs, cursor, argument);
      if (typeof value !== "string") return value;
      cursor += 1;
      if (argument === "--mode") {
        const parsed = enumValue(value, captureModes, "--mode");
        if (!parsed.ok) return { ok: false, message: parsed.message };
        mode = parsed.value;
      } else if (argument === "--scope") {
        const parsed = enumValue(value, captureScopes, "--scope");
        if (!parsed.ok) return { ok: false, message: parsed.message };
        scope = parsed.value;
      } else if (argument === "--media") {
        const parsed = enumValue(value, mediaModes, "--media");
        if (!parsed.ok) return { ok: false, message: parsed.message };
        media = parsed.value;
        mediaExplicit = true;
      } else if (argument === "--evidence") {
        const parsed = enumValue(value, evidenceModes, "--evidence");
        if (!parsed.ok) return { ok: false, message: parsed.message };
        evidence = parsed.value;
        evidenceExplicit = true;
      } else if (argument === "--html") htmlFile = value;
      else if (argument === "--output") outputBase = value;
      else if (argument === "--browser-profile") browserProfile = value;
      else if (argument === "--cdp") {
        const parsed = positiveInteger(value, "--cdp", 65_535);
        if (typeof parsed === "string") {
          return { ok: false, message: "--cdp accepts only a local remote-debugging port between 1 and 65535" };
        }
        cdp = String(parsed);
      }
      else if (argument === "--cookie-profile") cookieProfile = value;
      else if (argument === "--cookies-file") cookiesFile = value;
      else if (argument === "--user-agent") userAgent = value;
      else if (argument === "--cookie-source") {
        const parsed = enumValue(value, cookieSources, "--cookie-source");
        if (!parsed.ok) return { ok: false, message: parsed.message };
        selectedCookieSources.push(parsed.value);
      } else if (argument === "--timeout-ms") {
        const parsed = positiveInteger(value, argument, 10 * 60_000);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        timeoutMs = parsed;
      } else if (argument === "--max-items") {
        const parsed = positiveInteger(value, argument, 10_000);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        maxItems = parsed;
      } else if (argument === "--max-depth") {
        const parsed = positiveInteger(value, argument, 64);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        maxDepth = parsed;
      } else if (argument === "--max-html-bytes") {
        const parsed = byteSize(value, argument);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        maxHtmlBytes = parsed;
      } else if (argument === "--max-asset-bytes") {
        const parsed = byteSize(value, argument);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        maxAssetBytes = parsed;
      } else if (argument === "--max-total-asset-bytes") {
        const parsed = byteSize(value, argument);
        if (typeof parsed === "string") return { ok: false, message: parsed };
        maxTotalAssetBytes = parsed;
      }
    }
  }

  if (positional.length === 0) return { ok: false, message: `${command} requires a URL or current` };
  if (positional.length > 2) return { ok: false, message: `${command} accepts one URL/current target and one optional slug` };
  const currentTab = positional[0] === "current";
  const parsedUrl = currentTab ? null : parseUrl(positional[0] ?? "");
  if (typeof parsedUrl === "string") return { ok: false, message: parsedUrl };
  if (mode === "file" && htmlFile === undefined) return { ok: false, message: "--mode file requires --html <path|->" };
  if (htmlFile !== undefined && mode !== "auto" && mode !== "file") {
    return { ok: false, message: "--html can only be used with --mode auto or --mode file" };
  }
  if (browserLive && browserProfile !== undefined) {
    return { ok: false, message: "--browser-live and --browser-profile are mutually exclusive" };
  }
  if (cdp !== undefined && (browserLive || browserProfile !== undefined)) {
    return { ok: false, message: "--cdp cannot be combined with --browser-live or --browser-profile" };
  }
  if (currentTab && browserProfile !== undefined) {
    return { ok: false, message: "the current target attaches with --browser-live or --cdp; it cannot use --browser-profile" };
  }
  if (currentTab && !browserLive && cdp === undefined) {
    return { ok: false, message: "the current target requires --browser-live or --cdp <loopback-port>" };
  }
  const hasBrowserSelection = browserLive || cdp !== undefined || browserProfile !== undefined;
  if (hasBrowserSelection && (mode === "http" || mode === "file" || htmlFile !== undefined)) {
    return { ok: false, message: "browser selection requires --mode auto or --mode browser and cannot be combined with --html" };
  }
  if ((evidence === "screenshot" || evidence === "all") && (mode === "http" || mode === "file" || htmlFile !== undefined)) {
    return { ok: false, message: "screenshot evidence requires --mode auto or --mode browser" };
  }
  if (selectedCookieSources.length > 1) {
    return { ok: false, message: "select at most one --cookie-source so profile and media behavior stay unambiguous" };
  }
  if (selectedCookieSources.length > 0 && cookiesFile !== undefined) {
    return { ok: false, message: "--cookie-source and --cookies-file are mutually exclusive authentication sources" };
  }
  if (cookieProfile !== undefined && selectedCookieSources.length === 0) {
    return { ok: false, message: "--cookie-profile requires at least one --cookie-source" };
  }
  if (maxTotalAssetBytes < maxAssetBytes) {
    return { ok: false, message: "--max-total-asset-bytes cannot be smaller than --max-asset-bytes" };
  }
  if (stdoutExplicit && json) return { ok: false, message: "--stdout and --json cannot be combined" };
  if (stdout && force) return { ok: false, message: "--stdout and --force cannot be combined" };
  if (command === "inspect" && media !== "none") {
    return { ok: false, message: "inspect does not persist media; use capture or pass --media none" };
  }
  if (command === "inspect" && evidence !== "none") {
    return { ok: false, message: "inspect does not persist evidence; use capture or pass --evidence none" };
  }
  if (stdout && mediaExplicit && media !== "none") {
    return { ok: false, message: "--stdout does not persist media; use capture without --stdout or pass --media none" };
  }
  if (stdout && evidenceExplicit && evidence !== "none") {
    return { ok: false, message: "--stdout does not persist evidence; use capture without --stdout or pass --evidence none" };
  }

  return {
    ok: true,
    value: {
      command,
      url: parsedUrl,
      currentTab,
      slug: positional[1],
      mode: htmlFile === undefined ? (currentTab ? "browser" : mode) : "file",
      scope,
      media: stdout ? "none" : media,
      evidence: stdout ? "none" : evidence,
      htmlFile,
      outputBase,
      force,
      stdout,
      json,
      quiet,
      browserProfile,
      browserLive,
      cdp,
      cookieSources: selectedCookieSources,
      cookieProfile,
      cookiesFile,
      timeoutMs,
      maxItems,
      maxDepth,
      maxHtmlBytes,
      maxAssetBytes,
      maxTotalAssetBytes,
      allowPrivateNetwork,
      userAgent,
    },
  };
}

export const usage = `Usage:
  kb clip <url> [slug] [options]
  kb clip current [slug] --browser-live [options]
  kb clip current [slug] --cdp <loopback-port> [options]
  kb clip capture <url> [slug] [options]
  kb clip inspect <url> [options]
  kb doctor [--json]
  kb adapters [--json]

Capture options:
  --mode auto|http|browser|file     Acquisition strategy (default: auto)
  --scope auto|page|thread|comments Content scope (default: platform-aware)
  --html <path|->                  Parse saved/rendered HTML; - reads stdin
  --browser-profile <name|path>    Use a signed-in or persistent Chrome profile
  --browser-live                   Attach to a live Chrome session
  --cdp <loopback-port>            Attach to a local CDP-capable browser
  --cookie-source <browser>        chrome|arc|brave|chromium|edge|firefox|safari
  --cookie-profile <name|path>     Browser profile; Safari expects a Cookies.binarycookies path
  --cookies-file <path>            Cookie-Editor JSON/base64, Netscape, Cookie header, or cURL input
  --media none|images|all          Localize images or all supported media
  --evidence none|source|screenshot|all
  --output <directory>             Output base (default: kb/articles)
  --stdout                         Print Markdown without writing a clip
  --json                           Print a machine-readable result summary
  --force                          Atomically replace an existing clip
  --timeout-ms <n>                 Per-request/process/extraction timeout
  --max-items <n>                  Bound comments/thread items (default: 500)
  --max-depth <n>                  Bound nested replies (default: 16)
  --max-html-bytes <size>          HTML cap (default: 25mb)
  --max-asset-bytes <size>         Per-asset cap (default: 100mb)
  --max-total-asset-bytes <size>   Total asset cap (default: 500mb)
  --allow-private-network          Permit private targets in every network lane
  --user-agent <value>             Override the browser-like user agent
  --quiet                          Suppress progress output
`;
