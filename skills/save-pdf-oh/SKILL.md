---
name: save-pdf-oh
description: >-
  Convert a local or public remote PDF into an auditable Markdown knowledge-base bundle with the
  original document, inferred headings, page provenance, OCR text, image
  metadata, and local visual assets. Use when the user asks to save, import,
  archive, extract, or turn a PDF into Oh Markdown, especially scanned
  documents and PDFs containing screenshots, Slack messages, charts, photos,
  or a mix of native text and images.
---

# Save a PDF to the knowledge base

Use the installed `oh` CLI. Resolve `<vault>` to the directory containing the
managed `index.md`, then set the shell-local `OH_ROOT` to that path
(`OH_ROOT=oh` from a typical repository root).

Check the local conversion routes, then capture the PDF:

```sh
oh doctor
oh pdf "/absolute/path/to/document.pdf" --output "$OH_ROOT/articles"
oh pdf "https://example.com/document.pdf" --output "$OH_ROOT/articles"
```

Pass a stable slug or replace a prior tool-owned bundle only when needed:

```sh
oh pdf "/absolute/path/to/document.pdf" --slug ben-leaves-zo --output "$OH_ROOT/articles"
oh pdf "/absolute/path/to/document.pdf" --output "$OH_ROOT/articles" --force
```

The command installs one atomic bundle:

```text
<slug>/
  <slug>.md
  capture.json
  source.pdf
  annotations.json  # present after a reviewed annotation pass
  assets/
```

`source.pdf` is the byte-identical input. The manifest records its original
name, hash, byte count, page count, bounded document metadata, processed-page
and block counts, image geometry, OCR status, and warnings without retaining
the original absolute path. A reviewed second pass also retains the exact
normalized annotation array as `annotations.json`; the manifest records its
path, count, byte count, and SHA-256 so the image interpretation remains
reproducible.

## Preserve text and visual evidence

Treat native PDF text and image text as two independent extraction surfaces.
Native text supplies layout, heading, link, and reading-order evidence. Local
OCR supplies candidate text for scans and screenshots. Keep every extracted
image as an asset even when its text is converted to Markdown.

For recognizable conversations, review the source image and turn OCR into
readable message blocks with available platform, author, channel, and timestamp
metadata. Preserve uncertain words explicitly instead of silently repairing
them. Read [references/review.md](references/review.md) before refining
screenshot-heavy or mixed-media PDFs.

The first capture supplies stable image IDs and hashes in `capture.json`.
For screenshot-heavy documents, write reviewed interpretations to a JSON array
and rerun the capture:

```json
[
  {
    "id": "page-5-image-1-0123456789ab",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "kind": "mixed",
    "method": "agent",
    "markdown": "> bg @ Oct 15, 2024 at 4:26 PM\n> Message text",
    "metadata": {
      "platform": "Slack",
      "contentType": "message screenshot",
      "author": "bg",
      "timestamp": "Oct 15, 2024 at 4:26 PM",
      "participants": ["bg"]
    }
  }
]
```

```sh
oh pdf "/absolute/path/to/document.pdf" \
  --output "$OH_ROOT/articles" \
  --annotations /tmp/pdf-image-annotations.json \
  --force
```

Use only IDs and SHA-256 values from the first manifest. The command rejects a
stale interpretation if the extracted image changed. Omit metadata fields that
are not visible, and use `kind: "visual"` with an optional `alt` instead of
inventing a transcription for a non-text image. Put only the transcribed body
in `markdown`; the renderer owns the image embed, “Text visible in…” heading,
and visible metadata line.

Embed primarily visual images in the Markdown. For text-bearing or mixed
images, keep the source image embedded beside the transcription so diagrams,
photos, UI state, and spatial meaning remain inspectable. The embed is the
source-image reference; do not duplicate it inside an annotation.

Heading inference follows native font, emphasis, spacing, and page geometry.
Review semantic hierarchy separately: typography can identify a heading without
proving whether it is a peer or a child of the preceding section. Report an
ambiguous or incorrect level instead of silently treating the inference as
source truth.

## Report completeness literally

Use `complete` only when every page was processed and every extracted image was
classified. Preserve `partial` when a tool, page, image, byte, time, or OCR
boundary was reached. A usable native-text extraction does not make
unprocessed screenshot pages complete.

Review:

1. Compare the manifest page count with the PDF.
2. Review inferred headings and report ambiguous or incorrect hierarchy.
3. Sample native-text, screenshot, scanned, and visual-only pages.
4. Confirm every retained asset resolves from the Markdown or manifest.
5. Check that source-image links accompany OCR-derived text.
6. Report the output path, status, page and image counts, OCR coverage, and
   unresolved warnings.

After adding or linking the capture, run the vault's normal refresh and check:

```sh
oh percolate "<maintained-note-id>" --root "$OH_ROOT" --limit 25 --json
oh refresh --root "$OH_ROOT"
oh check --root "$OH_ROOT"
```
