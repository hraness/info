import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "../clip/network.js";
import { sanitizeArtifactUrl } from "../clip/persist.js";
import { pdfCaptureDefaults } from "./extract.js";
import type { PdfRemoteSource } from "./model.js";

export type PreparedPdfSource = {
  readonly inputPath: string;
  readonly remoteSource?: PdfRemoteSource;
  readonly dispose: () => void;
};

export type PdfSourceDependencies = {
  readonly fetch?: (url: URL, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  readonly makeTemporaryDirectory?: () => string;
  readonly writeFile?: typeof writeFileSync;
  readonly removeDirectory?: (path: string) => void;
};

const remoteUserAgent = "hraness-oh/0.7 PDF capture";

function parseRemoteUrl(input: string): URL | null {
  if (!/^https?:\/\//iu.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("PDF URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PDF URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PDF URL must not contain embedded credentials");
  }
  return url;
}

function remoteFilename(url: URL): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(basename(url.pathname));
  } catch {
    decoded = "source.pdf";
  }
  const normalized = decoded
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 180);
  const stem = normalized === "" ? "source" : normalized.replace(/\.pdf$/iu, "");
  return `${stem}.pdf`;
}

function assertPdfSignature(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 5
    || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
  ) {
    throw new Error("remote PDF input does not have a valid PDF signature");
  }
}

/** Resolve a local path directly or download one bounded public PDF into a disposable private directory. */
export async function preparePdfSource(
  input: string,
  options: {
    readonly timeoutMs?: number;
    readonly maxPdfBytes?: number;
  } = {},
  dependencies: PdfSourceDependencies = {},
): Promise<PreparedPdfSource> {
  const requestedUrl = parseRemoteUrl(input);
  if (requestedUrl === null) {
    return {
      inputPath: input,
      dispose: () => {},
    };
  }

  const result = await (dependencies.fetch ?? safeFetch)(requestedUrl, {
    timeoutMs: options.timeoutMs ?? pdfCaptureDefaults.timeoutMs,
    maxBytes: options.maxPdfBytes ?? pdfCaptureDefaults.maxPdfBytes,
    allowPrivateNetwork: false,
    userAgent: remoteUserAgent,
    accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
    retries: 2,
    maxRedirects: 5,
  });
  assertPdfSignature(result.bytes);

  const makeTemporaryDirectory = dependencies.makeTemporaryDirectory
    ?? (() => mkdtempSync(join(tmpdir(), "hraness-oh-pdf-source-")));
  const removeDirectory = dependencies.removeDirectory
    ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const directory = makeTemporaryDirectory();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeDirectory(directory);
  };
  try {
    chmodSync(directory, 0o700);
    const inputPath = join(directory, remoteFilename(result.finalUrl));
    (dependencies.writeFile ?? writeFileSync)(inputPath, result.bytes, {
      encoding: null,
      flag: "wx",
      mode: 0o600,
    });
    return {
      inputPath,
      remoteSource: {
        requestedUrl: sanitizeArtifactUrl(requestedUrl.href),
        finalUrl: sanitizeArtifactUrl(result.finalUrl.href),
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
