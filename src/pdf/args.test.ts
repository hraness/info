import { describe, expect, test } from "bun:test";

import { parsePdfArguments } from "./args.js";

describe("PDF CLI argument parsing", () => {
  test("parses the default output and bounded capture options", () => {
    expect(parsePdfArguments([
      "document.pdf",
      "--slug",
      "durable-document",
      "--annotations",
      "images.json",
      "--timeout-ms",
      "90000",
      "--max-pdf-bytes",
      "600mb",
      "--max-pages",
      "250",
      "--max-images",
      "750",
      "--max-asset-bytes",
      "25mb",
      "--max-total-asset-bytes",
      "300mb",
      "--force",
      "--json",
    ], { KB_PDF_OUTPUT: "vault/articles" })).toEqual({
      ok: true,
      value: {
        command: "capture",
        input: "document.pdf",
        outputBase: "vault/articles",
        slug: "durable-document",
        interpretationsPath: "images.json",
        force: true,
        json: true,
        quiet: false,
        timeoutMs: 90_000,
        maxPdfBytes: 600 * 1024 * 1024,
        maxPages: 250,
        maxImages: 750,
        maxAssetBytes: 25 * 1024 * 1024,
        maxTotalAssetBytes: 300 * 1024 * 1024,
      },
    });
  });

  test("supports delegated save syntax and explicit output", () => {
    expect(parsePdfArguments(["save", "document.pdf", "--output", "articles", "--quiet"]))
      .toEqual({
        ok: true,
        value: {
          command: "capture",
          input: "document.pdf",
          outputBase: "articles",
          force: false,
          json: false,
          quiet: true,
        },
      });
  });

  test("rejects ambiguous paths, missing option values, and unsafe bounds", () => {
    expect(parsePdfArguments(["one.pdf", "two.pdf"])).toEqual({
      ok: false,
      message: "kb pdf requires exactly one PDF path or public URL",
    });
    expect(parsePdfArguments(["document.pdf", "--slug"])).toEqual({
      ok: false,
      message: "--slug requires a value",
    });
    expect(parsePdfArguments(["document.pdf", "--max-pages", "0"])).toEqual({
      ok: false,
      message: "--max-pages must be between 1 and 10000",
    });
  });

  test("routes help without touching the filesystem", () => {
    expect(parsePdfArguments(["--help"])).toEqual({
      ok: true,
      value: { command: "help" },
    });
  });

  test("accepts a public PDF URL", () => {
    expect(parsePdfArguments(["https://arxiv.org/pdf/2507.09369"])).toEqual({
      ok: true,
      value: {
        command: "capture",
        input: "https://arxiv.org/pdf/2507.09369",
        outputBase: "kb/articles",
        force: false,
        json: false,
        quiet: false,
      },
    });
  });
});
