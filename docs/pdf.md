# Capture PDF documents

`kb pdf` converts a local PDF or a public HTTP(S) PDF into an auditable Markdown
bundle. Remote downloads use the same DNS-pinned, private-network-denying
acquisition boundary as web capture, and sensitive URL parameters are removed
before provenance is persisted. It preserves
the original bytes, reconstructs native document structure, extracts embedded
images, and uses local OCR for text that exists only inside scans or
screenshots.

## Capture a PDF

```sh
kb doctor
kb pdf "/absolute/path/to/document.pdf" --output articles
kb pdf "https://example.com/document.pdf" --output articles
kb pdf "/absolute/path/to/document.pdf" --slug stable-slug --output articles
```

The output mirrors a web capture without pretending the local file is a URL:

```text
articles/<slug>/
  <slug>.md
  capture.json
  source.pdf
  annotations.json  # present after a reviewed annotation pass
  assets/
```

`source.pdf` is byte-identical to the input. `capture.json` records the
original filename, SHA-256, bytes, page count, bounded PDF metadata, processed
page count, tool versions, text blocks, inferred headings, image geometry, OCR
method and confidence, embedded platforms, and warnings. It never records the
input's original absolute path.

When `--annotations` is used, the bundle also retains the normalized annotation
array as `annotations.json`. Its path, count, byte count, and SHA-256 in
`capture.json` bind the reviewed interpretation to the saved evidence and make
the second pass reproducible.

Pass `--force` only to replace a compatible PDF bundle previously created at
the same slug. Installation stages beside the target and commits with an
atomic rename.

## Text, headings, and page order

Poppler supplies native text, font, emphasis, link, geometry, and page data.
The converter infers a body style from the document and promotes only
well-supported heading candidates. Uncertain structure remains a paragraph
instead of becoming a confident but invented hierarchy.

Every emitted page is marked in the Markdown, and the manifest records
processed-page and block counts. Repeated page headers and footers can be
omitted from the readable Markdown while remaining accounted for by the source
PDF. Font and spacing can identify a likely heading without proving its
semantic depth, so review peer-versus-child levels against the source.

## Images and OCR

Every extracted image becomes a content-addressed local asset and remains
embedded in the Markdown. A text-bearing image also receives a Markdown
transcription. A mixed screenshot keeps both
representations so a message, chart, photograph, code sample, or UI state is
not discarded merely because OCR found words.

Tesseract is the local OCR fallback. Its output is bounded and records method,
word count, and confidence. Missing OCR or an unclassified image makes the
capture `partial` but never removes the image. Screenshot-heavy captures
should be visually reviewed; recognizable Slack or other conversation images
can preserve visible platform, author, channel, timestamp, and reply metadata
without inventing fields the image does not show.

For a reviewed second pass, copy each image's `id` and `asset.sha256` from the
first `capture.json` into an annotation array. A text or mixed annotation
accepts `markdown`, optional `method` (`agent` or `manual`), and optional
`metadata` fields for `platform`, `contentType`, `channel`, `author`,
`timestamp`, and `participants`. A visual annotation accepts an optional
`alt`. Re-run against the same bundle with:

```sh
kb pdf "/absolute/path/to/document.pdf" \
  --output articles \
  --annotations /tmp/pdf-image-annotations.json \
  --force
```

IDs and hashes bind the interpretation to the exact extracted image; stale or
misaddressed annotations are rejected. Annotation `markdown` contains only the
transcription; the renderer supplies the image embed, metadata line, and
“Text visible in…” heading. The normalized input is copied into the installed
bundle, so the path passed to `--annotations` does not need to remain available.

## Local tools

PDF ingestion uses the open-source Poppler command-line tools `pdfinfo` and
`pdftohtml`. Tesseract enables image text extraction. `kb doctor` reports
whether each route is available.

Tool processes run with fixed argument shapes, bounded output, wall-time
limits, page and image caps, per-asset limits, and an aggregate asset budget.
Reaching any boundary is recorded and makes the result `partial`.

## Review

1. Compare source and processed page counts.
2. Sample native-text, screenshot, scanned, and visual-only pages.
3. Confirm heading levels match the source.
4. Confirm every asset is referenced by the Markdown or manifest.
5. Inspect low-confidence OCR against its source image.
6. Keep later summaries and interpretations in maintained notes linked to the
   capture.
