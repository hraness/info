# Contents

- `SKILL.md` – PDF ingestion workflow, completeness contract, and review loop.
- `references/` – guidance for reviewing OCR, conversations, and mixed-media images.
- `agents/openai.yaml` – user-facing skill metadata.

# Guidelines

- Invoke the installed `kb` CLI; do not depend on a source checkout or implementation path.
- Preserve the source PDF byte-for-byte, record sanitized remote URL provenance when present, and never persist its original absolute path.
- Keep native text, image text, and visual assets as independent evidence surfaces.
- Retain every extracted image even when its text is converted to Markdown.
- Preserve page, geometry, OCR method, confidence, and classification metadata.
- Never invent conversation authors, channels, timestamps, or reply relationships.
- Downgrade completeness when any page, image, tool, byte, time, or OCR boundary is reached.
