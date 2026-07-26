# Contents

- `SKILL.md` – reusable concept-and-relationship percolation workflow for a hraness/oh vault.
- `agents/openai.yaml` – user-facing skill metadata and invocation prompt.

# Guidelines

- Keep this bundle self-contained under the public hraness/oh identity and free of repository-specific policy, paths, names, or provenance.
- Keep percolation read-only until an agent reviews the cited Markdown and chooses a specific concept or relationship edit.
- Treat concepts as ordinary notes and outbound relationships as source-owned assertions; never direct agents to write reciprocal, inferred, or similarity-derived edges.
- During parallel work, defer the shared catalog refresh to the integrating agent and use the graph-only check in each edit lane.
- Keep the skill concise, imperative, and usable without loading files outside this directory.
