# Contents

- `SKILL.md` – agent workflow for hybrid text, metadata, graph, Git, and code-mode retrieval.
- `agents/openai.yaml` – agent-runner display metadata.

# Guidelines

- Keep Markdown authoritative and every index or query result explicitly derived.
- Prefer exact metadata or graph queries when the target is known; use fused exact and local QMD rank for discovery.
- Keep the default hybrid path local and free of query expansion and reranking models.
- Reuse one read-only SDK snapshot for related operations, then reopen it after writes.
- Keep graph context and Git provenance separate from primary text relevance.
- Never turn similarity into an authored relationship without reading the notes in context.
