# Contents

- `decision-context.ts` retrieves ranked knowledge, explicit graph context, and Git provenance before packing a bounded handoff.
- `explain-change.ts` searches maintained rationale and Git evolution concurrently, with optional structural navigation from a named note.
- `plan-radar.ts` combines exact plan metadata, semantic retrieval, backlinks, and recent plan provenance.
- `index.ts` is the stable public workflow export surface.
- `workflows.test.ts` proves dependency shape, resource-aware parallelism, and deterministic outputs with an in-memory SDK boundary.

# Guidelines

- Keep workflows finite, read-only, and useful as editable TypeScript examples.
- Use the `qmd` resource for model-backed retrieval and `git` for history so the runner can enforce independent limits.
- Keep exact graph structure and Git provenance separate from primary relevance ranking.
- Depend on `KnowledgeBaseSession`, not repository-specific paths or private helpers.
- Bound every result and context handoff. Do not execute shell strings or arbitrary untrusted workflow data.
