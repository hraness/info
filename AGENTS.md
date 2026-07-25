# Contents

- `src/` – deterministic vault graph, typed metadata queries, scoped repository-context routing and audits, structural navigation, optional local semantic search, initialization, CLI, capture, and diagnostic code with colocated tests.
- `dist/` – committed Bun-targeted ESM entrypoints and the compiled Defuddle worker.
- `skills/save-url-info/` – reusable agent workflow for bounded, auditable source capture.
- `skills/save-pdf-info/` – reusable agent workflow for converting local PDFs into auditable Markdown bundles.
- `skills/refresh-info/` – reusable agent workflow for refreshing the catalog, reviewing graph findings, and validating changed scope mappings.
- `skills/query-info/` – reusable agent workflow for loading repository-path context before bounded metadata, graph, keyword, or semantic retrieval.
- `skills/plan-info/` – reusable agent workflow for creating and growing durable implementation plans.
- `docs/` – design, capture, and agent-workflow documentation.
- `.github/workflows/` – read-only branch validation and checks-gated immutable GitHub Release automation.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` – public usage, project policy, threat model, and terms.
- `package.json`, `tsconfig.json`, and `bun.lock` – standalone package and frozen verification configuration.

# Guidelines

- Use Bun 1.3.14 for repository commands and keep the authored Markdown compatible with Obsidian and ordinary text tooling.
- Treat this repository as the complete project. Files and Git prose may use only its public names, paths, commands, and examples; do not refer to or infer a non-public source repository.
- Keep graph maintenance and exact metadata queries deterministic and local-first. Do not require a database, hosted service, model, API key, or hidden index for refresh, check, list, graph, link, or backlink commands.
- Keep QMD semantic state optional, local, dynamically loaded, and rebuildable from Markdown. Treat matches as discovery aids and join them to current authored metadata and graph state.
- Keep `AGENTS.md` normative and always loaded for ownership, prohibitions, required commands, invariants, and gates. Optional `type: agent-context` hubs under `scopes/` are pull-based rationale, history, examples, evidence, and links; they cannot override a guide or become the sole home of a load-bearing edit rule.
- Derive every scope-hub identity from the full exact repository-relative directory scope, with `.` for the root, and require one reciprocal `info:context` marker before the mapped guide's headings. Unmapped guides remain valid; moving a scope changes identity.
- Confine repository-context lookup and agent-guide audits to the selected repository. Require real scope directories and regular guide files, reject collisions and symlinked mappings, skip generated or vendor directories, and never follow symbolic-link directories.
- Treat agent-guide length, long-bullet, inherited-chain, and exact-duplicate audit findings as deterministic advisories rather than correctness. Keep required edit-time rules in the guide even when they exceed a suggested budget.
- Derive backlinks from explicit wikilinks. Keep the managed catalog navigational, never inject reciprocal links, and leave title or alias mentions advisory.
- Restrict generated edits to marked, tool-owned regions; preserve concurrent authored changes when refreshing; and fail closed on malformed markers or unsafe paths.
- Treat capture inputs and outputs as hostile. Keep network, browser, subprocess, byte, item, depth, path, credential, and terminal boundaries bounded and covered by named regressions.
- Keep security-sensitive runtime forks pinned to immutable commits and exercise their behavior through the standalone install gate.
- Pair concrete behavior tests with property tests for parsing, resolution, ordering, path confinement, and round-trip laws.
- Run `bun run check` before handing off a change. The check must leave committed `dist/` and `bun.lock` unchanged.
- Treat a `v*` tag as a release request, not a completed release. Before tagging, confirm repository-level immutable releases are enabled; use a strictly increasing stable package version, keep the tag equal to `v<package.json version>` on `main`, and let the read-only verification job complete before its write-scoped publisher creates the Release. Do not create the next tag until that workflow and Release are verified because GitHub concurrency is not a durable queue. After tagging, verify the matching non-draft immutable Release is Latest.
