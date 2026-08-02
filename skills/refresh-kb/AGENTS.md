# Contents

- `SKILL.md` – reusable refresh-review-check workflow for a hraness/kb vault.
- `agents/openai.yaml` – user-facing skill metadata and invocation prompt.

# Guidelines

- Keep this bundle self-contained under the public hraness/kb identity and free of repository-specific policy, paths, names, or provenance.
- Keep the primary workflow aligned with catalog-skipping parallel-lane checks, bounded percolation, one integrating managed-catalog `kb refresh --root <vault>`, contextual review, and `kb check --root <vault>`. Authored mode leaves the front door untouched.
- Describe catalog links as navigation and backlinks, inverse relationships, orphans, mentions, and percolation candidates as derived graph analysis.
- Never direct agents to inject reciprocal, transitive, or similarity-derived relationships, generate backlink sections, or mutate authored prose automatically.
- Keep the skill concise, imperative, and usable without loading files outside this directory.
