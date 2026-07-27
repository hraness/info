import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localizeAssets, sniffImage } from "./assets.js";
import { CONTENT_REWRITE_TRUNCATION_WARNING } from "./lib.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("asset signature validation", () => {
  test.each([
    [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
    [new TextEncoder().encode("GIF89a rest"), "image/gif"],
    [new TextEncoder().encode("RIFF1234WEBPrest"), "image/webp"],
    [Uint8Array.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]), "image/avif"],
  ])("detects $expected", (bytes, expected) => expect(sniffImage(bytes)?.mimeType).toBe(expected));

  test("rejects HTML and active SVG even when a caller might label them images", () => {
    expect(sniffImage(new TextEncoder().encode("<html>challenge</html>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg onload='alert(1)'></svg>"))).toBeNull();
  });
});

test("reserves one strict aggregate network budget across concurrent assets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-assets-budget-"));
  temporaryDirectories.push(directory);
  const requested: number[] = [];
  const result = await localizeAssets(
    [1, 2, 3].map((id) => `![image ${id}](https://images.example/${id}.png)`).join("\n"),
    {
      assetsDirectory: directory,
      baseUrl: new URL("https://example.com/post"),
      userAgent: "test",
      timeoutMs: 1_000,
      maxAssetBytes: 8,
      maxTotalAssetBytes: 16,
      allowPrivateNetwork: false,
      concurrency: 2,
      fetchResource: (url, options) => {
        requested.push(options.maxBytes);
        return Promise.resolve({
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          finalUrl: url,
          status: 200,
          contentType: "image/png",
          etag: null,
          lastModified: null,
        });
      },
    },
  );
  expect(requested).toEqual([8, 8]);
  expect(requested.reduce((sum, value) => sum + value, 0)).toBe(16);
  expect(result.warnings.join(" ")).toContain("network-byte budget");
  expect(result.truncated).toBeFalse();
});

test("caps image-source fanout independently of the byte budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-assets-count-"));
  temporaryDirectories.push(directory);
  const requested: string[] = [];
  const result = await localizeAssets(
    [1, 2, 3].map((id) => `![image ${id}](https://images.example/${id}.png)`).join("\n"),
    {
      assetsDirectory: directory,
      baseUrl: new URL("https://example.com/post"),
      userAgent: "test",
      timeoutMs: 1_000,
      maxAssetBytes: 8,
      maxTotalAssetBytes: 24,
      maxSources: 2,
      allowPrivateNetwork: false,
      fetchResource: (url) => {
        requested.push(url.href);
        return Promise.resolve({
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          finalUrl: url,
          status: 200,
          contentType: "image/png",
          etag: null,
          lastModified: null,
        });
      },
    },
  );
  expect(requested).toHaveLength(2);
  expect(result.warnings.join(" ")).toContain("1 additional remote image");
  expect(result.content).toContain("[remote image: image 3]");
  expect(result.truncated).toBeFalse();
});

test("keeps dense multi-megabyte image discovery bounded and reports truncation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-assets-dense-count-"));
  temporaryDirectories.push(directory);
  const content = Array.from(
    { length: 100_000 },
    (_, index) => `![image ${index}](https://images.example/${index}.png)`,
  ).join("\n");
  expect(content.length).toBeGreaterThan(4 * 1024 * 1024);
  const requested: string[] = [];
  const result = await localizeAssets(content, {
    assetsDirectory: directory,
    baseUrl: new URL("https://example.com/post"),
    userAgent: "test",
    timeoutMs: 10_000,
    maxAssetBytes: 8,
    maxTotalAssetBytes: 16,
    maxSources: 2,
    allowPrivateNetwork: false,
    fetchResource: (url) => {
      requested.push(url.href);
      return Promise.resolve({
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        finalUrl: url,
        status: 200,
        contentType: "image/png",
        etag: null,
        lastModified: null,
      });
    },
  });

  expect(requested).toEqual([]);
  expect(result.assets).toEqual([]);
  expect(result.warnings.join(" ")).toContain("at least 1 additional remote image");
  expect(result.warnings.join(" ")).toContain("Image discovery reached a safety limit");
  expect(result.warnings).toContain(CONTENT_REWRITE_TRUNCATION_WARNING);
  expect(result.truncated).toBeTrue();
  expect(result.content).toContain("image-candidate safety limit was exceeded");
  expect(result.content).toContain("source code unit(s) omitted");
  expect(result.content.length).toBeLessThan(1_500_000);
});

test("never reflects signed image URLs from network failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-assets-warning-"));
  temporaryDirectories.push(directory);
  const result = await localizeAssets(
    "![private](https://cdn.example/i.jpg?kb=opaque987&oe=deadline)",
    {
      assetsDirectory: directory,
      baseUrl: new URL("https://example.com/post"),
      userAgent: "test",
      timeoutMs: 1_000,
      maxAssetBytes: 1_024,
      maxTotalAssetBytes: 1_024,
      allowPrivateNetwork: false,
      fetchResource: (url) => Promise.reject(new Error(`request timed out: ${url.href}`)),
    },
  );
  const output = `${result.content}\n${result.warnings.join("\n")}`;
  expect(output).toContain("https://cdn.example/i.jpg");
  expect(output).toContain("image request failed");
  expect(output).not.toContain("opaque987");
  expect(output).not.toContain("kb=");
  expect(output).not.toContain("oe=");
});

test("does not echo unsupported image targets in warnings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clip-assets-unsupported-"));
  temporaryDirectories.push(directory);
  const source = "data:image/svg+xml,HOSTILE_SOURCE_VALUE";
  const result = await localizeAssets(`![private](${source})`, {
    assetsDirectory: directory,
    baseUrl: new URL("https://example.com/post"),
    userAgent: "test",
    timeoutMs: 1_000,
    maxAssetBytes: 1_024,
    maxTotalAssetBytes: 1_024,
    allowPrivateNetwork: false,
  });
  expect(result.warnings).toEqual(["Skipped a non-web image target."]);
  expect(result.warnings.join(" ")).not.toContain("HOSTILE_SOURCE_VALUE");
});
