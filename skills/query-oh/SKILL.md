---
name: query-oh
description: Load scoped repository context, then search and navigate a hraness/oh Markdown vault with exact metadata, bounded links and typed relationships, Datalog, backlinks, keyword search, or local semantic retrieval. Use when an agent needs the applicable repository instructions, rationale, prior knowledge, plans, captures, decisions, concepts, relationships, or evidence before answering, planning, or changing code.
---

# Query the knowledge base

Use the cheapest precise view first, then broaden. Markdown files remain the
authority; search scores, metadata rows, and graph results are derived views.

## Locate the vault

- Resolve `<vault>` to the directory containing the managed `index.md`, then
  set the shell-local `OH_ROOT` to that path (`OH_ROOT=oh` from a typical
  repository root, or `OH_ROOT=.` from inside the vault).
- Resolve `<repository>` to the repository root when the question concerns a
  repository path (`OH_REPO=.` from that root).
- Read the vault's applicable agent instructions and note conventions.
- Pass the resolved path to every `--root`; do not scan a repository root merely
  because that is where the agent session started.

## Choose the retrieval lane

- Repository file or directory: run `oh context` first. Read its inherited
  guides root to nearest, then open only useful context hubs from nearest to
  root.
- Known frontmatter field or tag such as type, status, or area: use `oh list`.
- Known note title, path, or alias: use `oh links` or `oh backlinks`, which
  resolve note identities before returning authored relationships.
- A join, recursive path, aggregate, concept neighborhood, or relationship
  predicate: use `oh datalog` against the disposable local graph projection.
- Concept expressed with different vocabulary: use `oh search`.
- Broad orientation: read `index.md`, then follow the smallest useful link trail.

```sh
oh context src/parser.ts --root "$OH_ROOT" --repo "$OH_REPO"
oh list --root "$OH_ROOT" --where type=plan --where status=in-progress --sort area --json
oh list --root "$OH_ROOT" --tag retrieval --sort title --json
oh backlinks "Plan title or path" --root "$OH_ROOT" --json
oh links "Plan title or path" --root "$OH_ROOT" --direction both --depth 1 --limit 25 --json
oh relation list "Plan title or path" --root "$OH_ROOT" --json
oh datalog '[:find ?source ?target :where [?edge :edge/predicate "supports"] [?edge :edge/source ?source-ref] [?source-ref :note/id ?source] [?edge :edge/target ?target-ref] [?target-ref :note/id ?target]]' --root "$OH_ROOT" --limit 50 --json
oh search "why browser capture uses the current tab" --root "$OH_ROOT" --json
```

`oh context` prints hub titles and summaries, not hub bodies. Guides remain
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

`oh search` incrementally updates a local QMD index and defaults to QMD's small
embedding-only model. The first semantic query downloads the model; later
queries reuse the local cache. Prewarm explicitly when useful:

```sh
oh index --root "$OH_ROOT"
```

Use `--mode keyword` for exact BM25 retrieval without loading an embedding
model. Treat semantic rank as a lead, not a fact. Open the returned Markdown,
read enough surrounding context, and confirm claims against linked sources or
capture manifests.

## Use Datalog for relationships

`oh datalog` rebuilds an immutable DataScript view from current Markdown, then
evaluates the query in a disposable one-shot subprocess. It can join notes, tags, typed
metadata leaves, wikilinks, and authored relationships or apply recursive
rules. Results expose canonical string IDs rather than engine entity numbers
and are sorted and bounded.

Queries run against EAV tuples. Every entity has `:oh/id` and `:oh/kind`.
Notes expose `:note/id`, `:note/path`, `:note/title`, `:note/summary`,
`:note/alias`, `:note/tag`, `:note/type`, and `:note/concept`. Metadata-leaf
entities expose `:metadata/note`, `:metadata/path`, `:metadata/value`, and
`:metadata/value-type`. Edges expose `:edge/kind`, `:edge/source`,
`:edge/target`, `:edge/predicate`, `:edge/line`, `:edge/provenance`, and
`:edge/authored-target`. Edge references are stable semantic entity IDs; join
them through `:note/id` when the answer should contain canonical note IDs.
Use these fixed attributes with conventional EDN keyword spelling; Oh maps that
vocabulary to the underlying JavaScript relation without changing quoted
strings. For recursive paths, put an EDN rule vector in a bounded file, declare
`:in $ %` in the query, and pass it explicitly:

```sh
oh datalog --query-file reachability-query.edn \
  --rules-file reachability-rules.edn \
  --root "$OH_ROOT" --limit 50 --timeout-ms 2000 --json
```

DataScript evaluates recursive rules top-down. If relationship edges may form
a cycle, give the rule a numeric remaining-depth argument, require it to stay
positive, and decrement it on every recursive hop; invoke it with a fixed
bound from the query. Never use an unbounded recursive rule on cyclic graph
data. The subprocess deadline contains a mistaken program, while `oh links`
provides the simpler cycle-safe path traversal for ordinary neighborhood work.

Keep queries narrow and use `--limit`. Evaluation defaults to a 2-second
deadline and cannot exceed 5 seconds; input and result counts and bytes are
also bounded on both sides of the process boundary. A timeout, row, value, or
byte-budget error means the query should be narrowed. A Datalog result is a derived answer over authored
facts. Open the returned notes and inspect provenance before claiming that the
relationship is correct. The database is never authored, committed, or shared
between agents.

## Combine meaning with structure

1. For a repository-path question, use `oh context` before broader retrieval.
2. Use semantic search to discover candidate identities when exact structure
   does not answer the question.
3. Use `oh list` to narrow by authored metadata such as `type`, `status`,
   `area`, or `tags`.
4. Use `oh links` at depth 1 to inspect immediate explicit relationships and
   `oh backlinks` for a focused inbound view. Increase depth only when the
   first neighborhood is insufficient. Traversal defaults to 50 notes and
   reports truncation; lower `--limit` for tighter agent context or raise it
   deliberately when a high-degree hub is genuinely relevant.
5. Use Datalog only when the question needs a join, aggregate, predicate, or
   recursive path that bounded navigation cannot express.
6. Read the authoritative notes and cited captures before synthesizing.

A title match may identify a prerequisite, prior version, or supporting note
rather than the artifact that owns the current outcome. Confirm status and
ownership in the candidate Markdown before answering or editing it.

Do not infer an edge from semantic similarity, or a conclusion from a tag. Do
not write generated backlink sections into notes. If the query exposes stale
metadata or a broken link, repair the authored Markdown and finish with
`oh refresh --root "$OH_ROOT"` and `oh check --root "$OH_ROOT"`.
