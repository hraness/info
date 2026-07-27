# Review image-derived text

Read this guide when a PDF contains screenshots, scans, or mixed text and
visual media.

## Keep the source inspectable

- Retain every extracted image in `assets/`.
- Embed primarily visual images.
- Keep a source-image link beside OCR-derived or manually corrected text.
- Preserve page number, image index, bounding box, extraction method, and
  confidence in `capture.json`.
- Never replace a mixed image with text alone. Screenshots can contain a
  message, chart, photograph, code sample, or UI state at the same time.
- The renderer embeds the source image and adds its metadata and “Text visible
  in…” heading. Annotation `markdown` should contain only the transcription.

## Structure conversations

When the surface is recognizable, use available metadata rather than flattening
the screenshot into one paragraph:

```markdown
> bg @ Oct 15, 2024 at 4:26 PM
> Substrate did look very well designed and ambitious from the outside...
```

Use the platform's visible display name. Include channel, thread, or reply
context only when the screenshot shows it. Split a multi-message screenshot
into distinct message blocks, including each visible message author and
timestamp in that message's Markdown header. Annotation metadata describes
shared or whole-image context: use its scalar `author` or `timestamp` only when
one value accurately characterizes the image, and use `participants` for
multiple visible authors. The generated image embed is the shared source-image
reference.

Do not invent missing authors, dates, channels, or thread relationships. Mark
uncertain OCR as `[unclear]`; do not silently turn a plausible guess into source
text.

## Distinguish image roles

- `text`: a scan or crop is adequately represented by its prose, code, table,
  or labels, although the source asset is still retained.
- `visual`: the image remains meaningful without recognized text.
- `mixed`: both recognized text and non-text visual or spatial context matter.
  Use this for most message and application screenshots because avatars,
  grouping, thread layout, reactions, and UI state can remain evidentiary.

When classification is uncertain, choose `mixed`, keep the image visible, and
preserve the OCR warning.
