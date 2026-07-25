---
name: query-info
description: Load scoped repository context, then search and navigate a hraness/info Markdown vault with exact metadata, bounded links, backlinks, keyword search, or local semantic retrieval. Use when an agent needs the applicable repository instructions, rationale, prior knowledge, plans, captures, decisions, or evidence before answering, planning, or changing code.
---

# Query the knowledge base

Use the cheapest precise view first, then broaden. Markdown files remain the
authority; search scores, metadata rows, and graph results are derived views.

## Locate the vault

- Resolve `<vault>` to the directory containing the managed `index.md`, then
  set the shell-local `INFO_ROOT` to that path (`INFO_ROOT=info` from a typical
  repository root, or `INFO_ROOT=.` from inside the vault).
- Resolve `<repository>` to the repository root when the question concerns a
  repository path (`INFO_REPO=.` from that root).
- Read the vault's applicable agent instructions and note conventions.
- Pass the resolved path to every `--root`; do not scan a repository root merely
  because that is where the agent session started.

## Choose the retrieval lane

- Repository file or directory: run `info context` first. Read its inherited
  guides root to nearest, then open only useful context hubs from nearest to
  root.
- Known frontmatter field or tag such as type, status, or area: use `info list`.
- Known note title, path, or alias: use `info links` or `info backlinks`, which
  resolve note identities before returning authored relationships.
- Concept expressed with different vocabulary: use `info search`.
- Broad orientation: read `index.md`, then follow the smallest useful link trail.

```sh
info context src/parser.ts --root "$INFO_ROOT" --repo "$INFO_REPO"
info list --root "$INFO_ROOT" --where type=plan --where status=in-progress --sort area --json
info list --root "$INFO_ROOT" --tag retrieval --sort title --json
info backlinks "Plan title or path" --root "$INFO_ROOT" --json
info links "Plan title or path" --root "$INFO_ROOT" --direction both --depth 1 --limit 25 --json
info search "why browser capture uses the current tab" --root "$INFO_ROOT" --json
```

`info context` prints hub titles and summaries, not hub bodies. Guides remain
the normative, always-loaded home for ownership, required commands,
prohibitions, invariants, and edit gates. Scope hubs are optional pull-based
rationale, history, examples, evidence, and links; they cannot override a guide
or become the only home of a load-bearing rule. Use `--kind file` or
`--kind directory` when `auto` cannot classify a missing target reliably.

Repeated filters use AND semantics. Metadata paths may be dotted. String and
tag comparisons are case-insensitive; array metadata matches by membership.
Missing sort values come last, with path as the deterministic tie-breaker.
`--where` addresses authored frontmatter only; it does not filter derived H1
titles or file paths. Unquoted `true`, `false`, `null`, and numeric filter
values are typed. Keep quotes inside the argument to match a string with the
same spelling, for example `--where 'external_id="9007199254740993"'`.

## Use semantic search as discovery

`info search` incrementally updates a local QMD index and defaults to QMD's small
embedding-only model. The first semantic query downloads the model; later
queries reuse the local cache. Prewarm explicitly when useful:

```sh
info index --root "$INFO_ROOT"
```

Use `--mode keyword` for exact BM25 retrieval without loading an embedding
model. Treat semantic rank as a lead, not a fact. Open the returned Markdown,
read enough surrounding context, and confirm claims against linked sources or
capture manifests.

## Combine meaning with structure

1. For a repository-path question, use `info context` before broader retrieval.
2. Use semantic search to discover candidate identities when exact structure
   does not answer the question.
3. Use `info list` to narrow by authored metadata such as `type`, `status`,
   `area`, or `tags`.
4. Use `info links` at depth 1 to inspect immediate explicit relationships and
   `info backlinks` for a focused inbound view. Increase depth only when the
   first neighborhood is insufficient. Traversal defaults to 50 notes and
   reports truncation; lower `--limit` for tighter agent context or raise it
   deliberately when a high-degree hub is genuinely relevant.
5. Read the authoritative notes and cited captures before synthesizing.

A title match may identify a prerequisite, prior version, or supporting note
rather than the artifact that owns the current outcome. Confirm status and
ownership in the candidate Markdown before answering or editing it.

Do not infer an edge from semantic similarity, or a conclusion from a tag. Do
not write generated backlink sections into notes. If the query exposes stale
metadata or a broken link, repair the authored Markdown and finish with
`info refresh --root "$INFO_ROOT"` and `info check --root "$INFO_ROOT"`.
