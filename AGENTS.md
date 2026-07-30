# Contents

- `src/` – deterministic Markdown graph analysis, typed metadata and exact queries, local hybrid retrieval, bounded Git provenance, code-mode sessions and DAG workflows, retrieval benchmarks, safe single-note authoring, percolation, scoped repository-context routing and audits, structural navigation, initialization, CLI, capture, and diagnostic code with colocated tests.
- `src/workflows/` – reusable code-mode decision-context, change-explanation, and plan-radar workflows with bounded parallel execution.
- `dist/` – committed Bun-targeted ESM entrypoints plus the compiled Defuddle worker.
- `skills/save-url-kb/` – reusable agent workflow for bounded, auditable source capture.
- `skills/save-pdf-kb/` – reusable agent workflow for converting local PDFs into auditable Markdown bundles.
- `skills/refresh-kb/` – reusable agent workflow for refreshing the catalog, reviewing graph findings, and validating changed scope mappings.
- `skills/query-kb/` – reusable agent workflow for loading repository-path context before bounded metadata, graph, keyword, or semantic retrieval.
- `skills/plan-kb/` – reusable agent workflow for creating and growing durable implementation plans.
- `skills/percolate-kb/` – reusable agent workflow for promoting evidence-backed concepts and typed relationships.
- `docs/` – design, capture, and agent-workflow documentation.
- `.github/workflows/` – read-only branch validation and checks-gated immutable GitHub Release automation.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` – public usage, project policy, threat model, and terms.
- `package.json`, `tsconfig.json`, and `bun.lock` – standalone package and frozen verification configuration.

# Guidelines

- Use Bun 1.3.14 for repository commands and keep the authored Markdown compatible with Obsidian and ordinary text tooling.
- Treat this repository as the complete project. Files and Git prose may use only its public names, paths, commands, and examples; do not refer to or infer a non-public source repository.
- Keep Markdown authoritative and graph maintenance deterministic and local-first. Derive focused metadata, backlink, traversal, and percolation views directly from the current files; never commit a second graph database, event log, or generated fact file.
- Keep concepts as ordinary `type: concept` notes and source-owned typed relationships as compact frontmatter. Never write reciprocal, inferred, transitive, or similarity-derived edges into notes.
- Keep QMD state optional, local, dynamically loaded, and rebuildable from Markdown. The default hybrid path may combine local full-text and vector ranks, but query expansion and reranking remain opt-in costs. Join every match to current authored metadata and graph state.
- Keep exact matches and QMD results inspectable as separate retrieval evidence. Return graph neighbors and Git history as context and provenance, not silent relevance boosts, authored links, or inferred facts.
- Treat a code-mode session as a read-only snapshot that shares one vault scan. Reopen it after Markdown changes. Validate workflow DAGs before execution, cap nodes and concurrency, serialize QMD nodes, and bound Git workers below the global limit.
- Keep bundled workflows free of hidden writes and process-global state. Require explicit vault and repository inputs and return structured results that agents can inspect or compose.
- Keep `AGENTS.md` normative and always loaded for ownership, prohibitions, required commands, invariants, and gates. Optional `type: agent-context` hubs under `scopes/` are pull-based rationale, history, examples, evidence, and links; they cannot override a guide or become the sole home of a load-bearing edit rule.
- Derive every scope-hub identity from the full exact repository-relative directory scope, with `.` for the root, and require one reciprocal `kb:context` marker before the mapped guide's headings. Unmapped guides remain valid; moving a scope changes identity.
- Confine repository-context lookup and agent-guide audits to the selected repository. Require real scope directories and regular guide files, reject collisions and symlinked mappings, skip generated or vendor directories, and never follow symbolic-link directories.
- Treat agent-guide length, long-bullet, inherited-chain, and exact-duplicate audit findings as deterministic advisories rather than correctness. Keep required edit-time rules in the guide even when they exceed a suggested budget.
- Derive backlinks from explicit wikilinks and typed relationships. Keep the managed catalog navigational, never inject reciprocal links, and leave title, alias, and percolation candidates advisory until their evidence is reviewed.
- Keep parallel note edits sharded by source file. Serialize same-note local writers, make replacements atomic and revision-checked, let edit lanes check graph policy without refreshing the catalog, and reserve the single managed catalog write for integration.
- Restrict generated edits to marked, tool-owned regions; preserve concurrent authored changes when refreshing; and fail closed on malformed markers or unsafe paths.
- Treat capture inputs and outputs as hostile. Keep network, browser, subprocess, byte, item, depth, path, credential, and terminal boundaries bounded and covered by named regressions.
- Keep security-sensitive runtime forks pinned to immutable commits and exercise their behavior through the standalone install gate.
- Pair concrete behavior tests with property tests for parsing, resolution, ordering, path confinement, and round-trip laws.
- Run the labeled retrieval benchmark when changing rank fusion or defaults, then run `bun run check` before handing off a change. The check must leave committed `dist/` and `bun.lock` unchanged.
- Treat a `v*` tag as a release request, not a completed release. Before tagging, confirm repository-level immutable releases are enabled; use a strictly increasing stable package version, keep the tag equal to `v<package.json version>` on `main`, and let the read-only verification job complete before its write-scoped publisher creates the Release. Do not create the next tag until that workflow and Release are verified because GitHub concurrency is not a durable queue. After tagging, verify the matching non-draft immutable Release is Latest.
