# Contents

- `SKILL.md` – agent workflow for semantic, metadata, and graph retrieval.
- `agents/openai.yaml` – agent-runner display metadata.

# Guidelines

- Keep Markdown authoritative and every index or query result explicitly derived.
- Prefer exact metadata or graph queries when the target is known; use semantic rank for discovery.
- Keep the default semantic path local and embedding-only so routine queries do not load QMD's larger models.
- Never turn similarity into an authored relationship without reading the notes in context.
