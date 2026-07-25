# Contributing

Issues and focused pull requests are welcome in the [hraness/info repository](https://github.com/hraness/info).

Open an issue before starting a broad command-surface, manifest-schema, adapter, or security-boundary change so compatibility and threat-model expectations can be agreed first.

Run the public repository gate before opening a pull request:

```sh
bun install --frozen-lockfile
bun run check
```

Keep changes platform-neutral unless the feature is explicitly capability-detected. Add a named regression test for every parser, path, network, credential, status, or rollback bug. Add property tests for laws over arbitrary input, including parsing, normalization, ordering, cardinality, and round trips.

Capture changes must preserve bounded time, bytes, item counts, depth, process output, filesystem paths, and cleanup. A fallback may retain useful content, but it must not upgrade an uncertain conversation to `complete`. Security-sensitive changes should include failure cases for private-network access, DNS rebinding, redirects, cookie scope, credential redaction, symlinks, and subprocess termination as applicable.

Use synthetic fixtures. Do not commit real cookies, browser profiles, HARs, authenticated HTML, private screenshots, signed URLs, or captured source material that the project cannot redistribute.

Keep runtime dependency versions deliberate. When changing Defuddle, agent-browser, Sweet Cookie, yt-dlp integration, or ffmpeg behavior, update diagnostics and test the installed command surface. Live verification must use public, non-sensitive content and must not depend on a personal account.

Metadata parsing and queries must preserve YAML value types and nested structure. Pair named examples with property tests for repeated-filter conjunction, normalized tags, stable ordering, missing values, and arbitrary metadata trees.

QMD is a derived search capability, not the storage layer. Keep it dynamically loaded so graph, metadata, and capture commands do not initialize its native runtime. Unit tests must inject a fake store and cover update, embed, search, result confinement, and close-on-failure behavior without downloading a model or using the network. When changing the pinned QMD version or model, also run a real local index-and-query smoke test and document any new system requirement.

Repository-context changes must preserve the authority boundary between
`AGENTS.md` and Info hubs. Guides own always-loaded ownership, prohibitions,
required commands, invariants, and gates. Optional `type: agent-context` hubs
under `scopes/` may add pull-based rationale, history, examples, evidence, and
links, but cannot override a guide or become the only home of a load-bearing
edit rule.

Pair named context regressions with property tests for repository-scope
normalization, bounded canonical IDs, full-scope identity, marker parsing,
inheritance order, path confinement, collision handling, and file-versus-
directory targets. Moving a scope changes identity. Cover missing and symlinked
directories and guides without following symbolic-link directories during
agent-guide discovery. Keep scope hubs available to ordinary graph and QMD
indexing while `AGENTS.md` remains excluded.

Run `info agents check --root <vault> --repo <repository>` after changing a
scope hub or reciprocal marker. Use `info agents audit` to inspect deterministic
per-guide, section, inherited-chain, long-bullet, and exact-duplicate
advisories; do not treat a length advisory as a correctness failure.

Update public documentation when commands, defaults, status meanings, manifest fields, supported platforms, or security boundaries change.
