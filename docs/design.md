# Design

hraness/kb treats a knowledge base as durable Markdown plus replaceable views.
A vault must remain useful when the CLI is absent, and a capture must remain
inspectable when the original page changes or disappears. Exact graph and
metadata views are deterministic; semantic search is optional derived state
that can be deleted and rebuilt.

## Storage is the interface

The vault is an ordinary directory of Obsidian-compatible Markdown, suitable for a text editor, Git, and standard filesystem tools. Frontmatter, headings, prose, and wikilinks are owned content. Refresh, check, graph navigation, metadata queries, and capture require no hosted account or model. A local QMD index is an optional cache for semantic recall, never the authoritative copy of a note.

`kb init` creates a small set of authority boundaries:

- `articles/` contains captured sources and their local artifacts.
- `notes/` contains maintained concepts, entities, comparisons, and syntheses.
- `plans/` contains proposals, decisions, execution state, and verification.
- `riffs/` contains cleaned first-person thought from dictated or stream-of-consciousness material.
- `scopes/` contains optional pull-based context for selected repository directories.
- `index.md` is the front door. It can be a short authored page or contain one marked, tool-managed catalog block.

The boundaries separate what a source said from what the vault currently concludes. They are conventions expressed in Markdown and agent guides, not proprietary file formats.

## Repository instructions and context have different authority

An `AGENTS.md` file is normative, path-scoped, and always loaded before an
agent edits within its directory. It owns the information that must be present
at edit time: directory ownership, required commands, prohibitions, invariants,
and release or verification gates.

A scope hub is optional and pull-based. It explains why a rule exists and
carries the history, examples, evidence, rejected alternatives, and links that
would make an always-loaded guide too large. A hub cannot override a guide, and
it cannot be the only home of a rule whose omission could make an edit unsafe
or invalid.

Each hub maps to one exact repository-relative directory:

```md
---
title: Source context
summary: Design history and evidence for work under src.
type: agent-context
scope: src
---

# Source context
```

The corresponding file is `scopes/src--25a6634263c1.md`. The identity consists
of a lowercase ASCII slug made from the full scope, bounded to 48 characters,
followed by the first 12 lowercase hexadecimal characters of the SHA-256 digest
of the full NFC-normalized scope. The root scope is `.` and has the reserved
identity `scopes/repository--cdb4ee2aea69`. The full exact scope remains in
frontmatter; the readable filename is not a substitute for it. Moving a
directory changes its scope and therefore its hub identity.

Derive the exact tuple without writing files:

```sh
kb agents identity src --json
```

The command returns the normalized scope, extensionless note ID, Markdown path,
owning guide path, and reciprocal marker. Use its output rather than
reimplementing slug or hash logic.

The guide points back to the extensionless note ID with one exact marker before
its headings:

```md
<!-- kb:context scopes/src--25a6634263c1 -->
# Contents

- ...

# Guidelines

- ...
```

Mappings are reciprocal: a hub requires the marker in the `AGENTS.md` at its
exact scope, and a marker requires that canonical hub. A guide without a marker
is valid and remains fully normative.

`kb context <repository-path> --root <vault> --repo <repository>` returns the
applicable guides from root to nearest, verified hubs from nearest to root, and
the authored memory records whose `repository_scopes` contain the target. The
text view includes summaries, not bodies. It keeps maintained knowledge, active
plans, dated research, reports, and terminal plans in separate bounded groups,
reports the exact declaration that matched, and prefers the deepest matching
scope. Open only the useful record, then use `kb links`, `kb backlinks`, `kb
list`, or `kb search` for a bounded expansion. `--kind auto` uses filesystem
state and a conservative path hint; `--kind file` or `--kind directory` makes
the target interpretation explicit.

`repository_scopes` is an optional array of exact, canonical,
repository-relative paths. Matching is case-sensitive and lexical. A directory
scope matches itself and descendants; a file scope matches only that file.
Scopes can name future or retired paths, so existence is reported separately
from validity. Active plans and maintained notes with missing scopes produce an
advisory; terminal plans may retain a retired path as historical evidence. The
tool never follows Git renames or writes inferred scopes back into Markdown.

The dated-research group is deliberately narrower than an arbitrary note with
a date. A record must live under `projects/<domain>/market/`, declare `type:
market-research`, `status: snapshot`, a valid `as_of` date, and at least one
repository scope. Reports analogously declare `type: report`, a valid
`generated` date, and a repository scope. Records outside those contracts stay
available to ordinary metadata, text, and graph queries without being labeled
current path memory.

`kb agents check` verifies canonical IDs, `type` and `scope` metadata,
duplicate, case-fold, and Unicode-normalization collisions, repository
confinement, real scope directories and regular guide files, exact reciprocal
markers, and the required guide shape. `kb agents audit` runs the same gate
and adds deterministic measurements for every guide and section, inherited
chains, long guideline bullets, and exact duplicate rules. Those measurements
identify review candidates. Length is not a correctness test, and moving a
load-bearing rule out of an `AGENTS.md` file to satisfy a budget makes the
system worse.

Guide discovery skips common version-control, dependency, cache, coverage, and
build-output directories. It never follows symbolic-link directories, and a
mapped or discovered `AGENTS.md` symbolic link is invalid. These constraints
keep the inherited chain reproducible and confined to the selected repository.

## The graph is explicit

The graph is built from wikilinks and typed relationships in authored Markdown.
A scan parses note identity, title, aliases, tags, typed metadata, readable
text, outgoing links, and outbound assertions. It resolves each target and
reports broken or ambiguous references rather than choosing a convenient
match.

Reusable concepts are ordinary notes:

```md
---
type: concept
title: Durable agent memory
aliases:
  - persistent agent memory
---

# Durable agent memory
```

A note owns each typed assertion it makes:

```yaml
relations:
  supports:
    - notes/durable-agent-memory
  contrasts-with:
    - notes/conversation-history
```

Predicates use lower-kebab-case and targets use exact vault-root note IDs
without `.md`. The source note is the implicit subject. Different agents can
therefore edit relationships on different notes without contending on a central
ontology or edge file.

Four rules keep the result honest:

1. Backlinks and inverse relationships are derived, never written into source
   notes.
2. The catalog or authored front door is navigation, so links to or from its
   note (`index.md` by default) do not count as contextual edges.
3. A title, alias, recurring tag, shared neighborhood, or semantic match is a
   candidate. It becomes an edge only after an agent or person reviews the
   evidence and authors the assertion.
4. Transitive paths and other inferred relationships remain query results.
   They never silently become Markdown facts.

This makes inbound and outbound counts, backlinks, relationships, and orphans
reproducible. It also prevents reciprocal sections and generated catalogs from
making a disconnected vault appear healthy.

Fenced code, inline code, frontmatter, and HTML comments are excluded from
mention analysis. Line breaks are preserved during masking so diagnostics
continue to point at the authored source.

## Focused graph views are rebuilt from Markdown

Every structural command scans the current notes and resolves canonical note
identities, contextual wikilinks, and source-owned typed relationships. The
package does not maintain a second graph database or generated fact file.
`kb graph` returns the whole resolved graph and its diagnostics;
`kb backlinks` and `kb relation list` answer focused inbound or typed-edge
questions; and `kb links` performs cycle-safe traversal with explicit depth and
result limits.

`kb percolate` runs named, read-only analyses that surface repeated tags
without concept notes, unconnected shared-concept neighborhoods, exact
unlinked mentions, and relationship-hygiene findings. The output cites the
authored evidence that caused each candidate. A person or agent decides whether
to run `kb note create` or `kb relation add`.

This named-command surface is deliberate. Common graph questions receive a
small typed contract, deterministic ordering, and an operation-specific bound
instead of requiring every agent to construct an ad hoc query program. A
one-off whole-vault question can inspect `kb graph --json`; a recurring question
earns a focused command and regression tests when real use demonstrates the
need.

Commands that only need links and typed relationships skip quadratic
prose-mention discovery. A scoped `kb percolate <note>` considers only mention
pairs touching the resolved note; vault-wide percolation and ordinary graph
maintenance use explicit pair and result budgets. Scans reject more than 10,000
notes before parsing, then bound each note at 16 MiB of valid UTF-8 and the
vault at 256 MiB. These are package ceilings; callers may select lower
operation-specific limits.

Rebuilding views from Markdown keeps Git history on assertions people can read
and avoids a repository-wide merge hotspot. A future cache may live outside the
vault only if measurements justify it; it must be content-addressed by source
and analysis version and rebuild on any mismatch.

## Catalog ownership is explicit

A managed vault gives one marked region in `index.md` to the tool. `kb refresh`
renders a sorted catalog and atomically replaces only that region. Text outside
the markers belongs to the author. Malformed or duplicate markers fail closed.

An authored vault declares `kb_catalog: authored` in `index.md`. Refresh and
check leave the complete file untouched, while `kb catalog` renders the same
exhaustive inventory on demand. This removes a repository-wide generated-file
hotspot without weakening the scan, graph, metadata, attachment, plan, research,
or context checks.

`kb check` computes the expected managed catalog when one exists and applies
the remaining vault policy in either mode. `kb check --no-catalog` skips only
catalog freshness, which lets independent lanes validate their notes before
integration. A managed vault still performs one final refresh after lanes join;
an authored vault has no shared generated Markdown write.

`kb graph` exposes the scan as a human-readable or structured report.
`kb backlinks` and `kb relation list` use the same identities to retrieve
incoming links and typed assertions. `kb links` traverses both kinds of authored
edge to a bounded depth and node count, reporting when a high-degree
neighborhood reaches the cap. There is no second graph state to synchronize.

Single-note authoring commands confine paths to the vault, reject symbolic and
hard-linked targets, serialize local same-note writers, compare an optimistic
source revision, and atomically replace the source file. Different-note writes
do not share a lock or graph file. Git remains the cross-worktree review and
merge mechanism.

## Exact metadata is authored

Frontmatter is parsed as typed, nested data rather than flattened strings. Scalars retain their string, number, boolean, or null type; arrays and objects retain their structure. Tags from frontmatter are normalized for matching while the original metadata remains available in structured output.

`kb list` filters that authored state by nested dotted paths, field existence,
tags, or repeated exact repository scopes, then sorts by title, path, graph
counts, or nested metadata. `kb search` and the SDK expose the same
case-sensitive scope constraint. Repeated filters are conjunctive; repeated
scope values form one exact allowlist. Missing sort values are placed last and
ties are stable, so the same vault and query produce the same order.

Metadata is useful for exact questions such as “which implementation plans are in progress?” It is not inferred from prose and the tool does not invent tags to improve retrieval. Authors and agents can evolve conventions in the vault's scoped `AGENTS.md` files without migrating to a package-owned schema.

## Hybrid retrieval keeps its evidence visible

`kb search` starts with the current Markdown. Its exact lane scans note identity,
title, aliases, path, tags, typed metadata, and prose. Exact title and alias
identities remain visible in the result evidence and stay ahead of broader
matches.

Hybrid mode is the default. It runs the exact lane alongside [QMD](https://github.com/tobi/qmd).
KB requests QMD's direct local full-text and vector rankings at the declared
candidate bound, then fuses them without query expansion or reranking models.
This avoids QMD 2.5.3's smaller fixed structured-hybrid pool. Both the inner
QMD lists and the outer exact/QMD lists receive neutral equal weights in
reciprocal-rank fusion. Exact title, alias, and path identities are
pinned separately, while agreement between lanes outranks single-lane evidence.
Each result reports the lane ranks and contributions that produced its final
position. `--mode exact` stays model-free,
`--mode keyword` uses QMD's full-text index, and `--mode semantic` selects its
vector lane.

KB pins QMD 2.5.3 and one full upstream revision of its compact
EmbeddingGemma model for local vector retrieval. The revision prevents branch
drift and gives the model a revision-specific cache identity. Without an
explicit local source, the first hybrid or semantic query downloads that
revision; later runs reuse the local cache and incrementally update changed
Markdown.

An explicit model file is accepted only when its SHA-256 matches the pinned
artifact. KB gives QMD that file as the per-store load source while retaining
the stable model URI and digest as derived-index identity. QMD 2.5.3's public
vector method falls back to a process-global model for query embeddings, so KB
uses QMD's exposed per-store vector boundary for both query and document
inference. That QMD release also asks its process-global model to tokenize fresh
document chunks and legacy fingerprint samples. KB pins an [immutable public
Hraness QMD compatibility commit](https://github.com/hraness/qmd/commit/aa993dceb3ef8cfb71d470554ca437570f5a2b3c)
that routes those two internal calls through QMD's existing store-local model
without changing its public chunking API. The
fork includes compiled distribution files so standalone Git installs do not
depend on consumer-relative patches or installation-time compilation. The local model-file path does not
enter reports, SDK results, or generation identity, and moving identical model
bytes does not require a new logical index.

Each vault gets a path-derived SQLite cache under the user's cache directory unless `--database` selects another file outside the vault. KB refuses a database symlink or multiply linked database file and claims its adjacent snapshot directory with a versioned ownership record before cleanup. It scans and bounds the live Markdown first, then atomically refreshes a disposable validated source projection beside the database. QMD indexes that projection, so it cannot read a note that bypassed KB's per-note or aggregate vault limits or recursively ingest its own cache. Cached files are checked against the manifest before reuse. An older snapshot directory without the ownership record is never removed automatically; delete the explicitly named disposable `.snapshot` directory and retry.

A database-scoped process lease serializes projection installation, store updates, and embedding writes across agents. The generation identity includes the immutable note bytes and the QMD version, embedding model, collection configuration, and projection contract that interpret the shared SQLite state. Sessions with the same identity may read concurrently; an identity change waits for older readers to close before mutating the database. QMD operations within one open session remain serialized. `index.md` and every `AGENTS.md` are excluded because they are navigation and always-loaded instructions rather than knowledge records. Scope hubs remain ordinary Markdown, so QMD indexes their rationale and evidence like any other note. The database and source projection may be removed at any time and recreated with `kb index`.

Search results are joined back to the live session snapshot, so each hit carries
current typed metadata and tags. Files outside the requested vault and stale
indexed identities are discarded. Metadata and tag constraints are authoritative
at that join boundary. QMD 2.5.3 cannot rank against a path allowlist, so a
filtered search uses a bounded global candidate window. Selective searches use
the largest supported window by default. Any observed QMD rows discarded by
live reconciliation or filters leave an underfilled request explicitly degraded,
even when QMD's chunk-level retrieval returned fewer rows than requested. QMD failure
does not erase exact results; the response marks a failed lane unavailable or
an incomplete embedding pass degraded, and reports that the result is partial. A
retrieval score is a discovery aid, not a graph edge, a citation, or evidence
that the result is true.

Immediate explicit links and typed relationships can be returned with search,
along with a bounded neighborhood around the strongest results. These graph
neighbors remain a separate context collection. They do not enter primary text
rank or become authored edges. When explicitly requested, bounded Git history
can likewise explain when a note changed and which paths changed with it. `kb
history <note>` retrieves one note's provenance directly, and `kb history
search <query-or-path>` searches commit subjects, note paths, and co-change
paths without running text retrieval. `--history`, `--require-history`, or SDK
history options enable that separate lane on search. Omitted history performs
no Git indexing, and an explicit request with no
primary results has nothing to enrich. Query, note, and detail bounds are
validated before the Git index opens. A commit that exceeds the per-commit
changed-path detail limit retains its
hash, subject, time, and vault-local note associations while its co-change set
is marked incomplete. Later commits continue indexing. Automatic history
returns the usable provenance with a degraded diagnostic only when the selected
notes are affected. Optional Git failure returns an explicit unavailable
diagnostic. Both cases mark the search partial. `history: "required"` or an
options object with `policy: "required"` rejects unavailable or incomplete
selected-note provenance instead. Aggregate process time, output, commit, and
path-observation limits remain hard failures. Git evidence is provenance and
historical recall, not a recency boost.

## Code mode shares one bounded snapshot

Agents that need several retrieval operations can use the SDK without spawning
one CLI process per question:

```ts
import { openKnowledgeBase, packSearchContext } from "@hraness/kb/sdk";

const kb = await openKnowledgeBase({ root: "kb", repository: "." });
try {
  const result = await kb.search({
    query: "why captures preserve incomplete threads",
    tags: ["capture"],
    graph: { depth: 1 },
    history: "auto",
  });
  console.log(packSearchContext(result).content);
} finally {
  await kb.close();
}
```

Opening a session performs one confined vault scan. `grep`, `list`, `read`,
`links`, `backlinks`, `search`, `history`, and `searchHistory` reuse that
snapshot. QMD and Git are opened lazily. The session is intentionally read-only
and does not watch the filesystem. Close it and open a new session after any
Markdown write so later work cannot mistake an old snapshot for current state.

Code-mode DAGs use `defineWorkflow` and `runWorkflow`. The staged
`defineWorkflow<Input>("id").node(...).output(...)` builder infers each node's
result and the final output while exposing only declared dependencies. A
definition has at most 64 nodes, must be acyclic, and names one output node.
Ready nodes run in declaration order with a default global concurrency of four
and a maximum of eight. QMD work is always serialized; Git permits at most four
nodes, bounded again by the global limit. The runner applies an aggregate
structured-output byte limit. Failure or abort stops dependent nodes from
starting and waits for already-running siblings to settle. The packaged
workflows are ordinary imports, accept explicit inputs, and return structured
results without writing the vault.

```ts
import { openKnowledgeBase } from "@hraness/kb/sdk";
import { runWorkflow } from "@hraness/kb/workflow";
import { explainChangeWorkflow } from "@hraness/kb/workflows";

const kb = await openKnowledgeBase({ root: "kb", repository: "." });
try {
  const explanation = await runWorkflow(explainChangeWorkflow, {
    kb,
    input: { query: "why the capture path changed" },
  });
  console.log(explanation.output);
} finally {
  await kb.close();
}
```

`decisionContextWorkflow` assembles ranked rationale and note provenance,
`explainChangeWorkflow` searches authored rationale and Git evolution in
parallel, and `planRadarWorkflow` joins exact plan state with retrieval and
history.

Changes to retrieval ranking use the exported deterministic metric helpers for
recall at k, reciprocal rank, and nDCG. The six-case synthetic rank-fusion
fixture supplies already-ranked IDs for identity, conceptual, and mixed
examples. It checks metric and fusion arithmetic only.

The real-corpus evaluator accepts a versioned manifest with query text,
independently authored relevance judgments, query classes, and structured lane
inputs. `kb evaluate` fails before retrieval unless the checkout's exact `HEAD`,
the `HEAD:<vault-root>` tree, and the clean vault match the frozen manifest. It
then runs built-in exact, keyword, semantic, hybrid, graph, metadata,
path-context, and Git adapters through one immutable session. Human query prose
is never parsed into tool arguments; each adapter receives only its explicit
input object.

The report retains raw rankings and evidence, unavailable and failed lanes,
backend and wall timings, bounded resource counters, aggregate and per-class
quality, no-answer accuracy, and deterministic paired bootstrap intervals.
Machine-local home and temporary roots are redacted from persisted hit evidence,
diagnostics, and failures while relative document identities and the surrounding
evidence remain intact.
Semantic or hybrid runs require `--model-file`. The evaluator verifies those
bytes against the pinned model digest before retrieval, gives that file to QMD,
and verifies it again before reporting. Reports retain the stable model URI,
revision, and digest without persisting the machine path. Cache state and
hardware remain explicit environment evidence. The evaluator does not turn a
local fixture into an industry claim: model download, cold and warm runs,
scale, concurrency, and agent-task outcomes still need measured protocols of
their own.

## Local artifacts remain inspectable

Graph validation also checks local Markdown and Obsidian attachments. Relative
image, PDF, and tldraw targets must resolve to one regular confined file with
matching case. Symlinks, hard links, ambiguous case-fold matches, missing files,
and paths outside the vault fail. External URLs and fragment-only links remain
outside this local integrity lane.

`kb inbox` is a bounded advisory view over recent captured sources that have no
maintained-note disposition. Source-to-source and catalog links do not count as
synthesis. A capture may intentionally remain a leaf, so the inbox never writes
links, creates notes, or fails the vault merely because an item is present.

## Capture preserves an audit trail

Web capture is a bounded selection process rather than a promise to reproduce an unlimited website. Given a URL and requested scope, the capture pipeline can try:

1. A platform-specific public structured adapter when one can make a stronger completeness claim.
2. Bounded HTTP acquisition and article extraction.
3. Optional browser rendering for client-side or authenticated pages.
4. Explicit saved-HTML input when the user already has a saved representation.

Candidates retain their attempt results. The selected representation becomes readable Markdown, while `capture.json` records the routes attempted, extractor, scope, status, counts, warnings, limits reached, asset hashes, and requested artifact outcomes. A failed lane does not erase useful output from another lane, and an uncertain fallback does not promote a conversation to `complete`.

A bundle is installed atomically:

```text
<slug>/
  <slug>.md
  capture.json
  assets/
  evidence/
```

The capture body is source material. Later synthesis belongs in a maintained note so recapture and interpretation do not silently overwrite each other.

## Completeness is a data property

Capture status distinguishes `complete`, `partial`, `auth-required`, `blocked`, and `unsupported`. The status describes the selected bounded representation, not the importance or quality of its prose.

Counts use scope-specific semantics. Page counts cover primary entries; thread and comment counts cover replies or comments rather than roots, quotes, or pagination markers. Generic rendered prose does not prove a trustworthy item tree, so it may remain `partial` with a zero structured-item count even when the Markdown is useful.

## Safety is part of acquisition

URLs, redirects, DNS answers, response bodies, browser pages, cookies, subprocess output, and filesystem paths are foreign input. The controlled acquisition lanes therefore share several invariants:

- Only HTTP and HTTPS source URLs are accepted, with embedded credentials rejected.
- Private, reserved, and locally assigned network targets are denied by default.
- DNS answers are validated and accepted addresses are pinned across requests and redirects.
- Time, HTML bytes, asset bytes, total bytes, item counts, depth, browser actions, and process output are bounded.
- Cookies are read only from an explicitly selected source, filtered to matching targets, and kept out of persisted artifacts.
- Active source evidence is converted to inert HTML with credential-shaped values redacted.
- Bundle paths are owned, staged beside the target, and installed by atomic rename; forced replacement requires a compatible manifest and rollback.

Live or CDP browser attachment keeps the browser's existing network stack and signed-in state. `kb clip current` reads the active tab without navigating or interacting with it and leaves the browser open. URL-based attached capture may navigate that tab and scroll within the configured bounds, taking bounded observations as content is rendered. Screenshots are also different from sanitized source evidence because private content can remain visible in pixels.

These boundaries are not entitlement mechanisms. Capture does not bypass authentication, access controls, paywalls, CAPTCHAs, rate limits, DRM, or platform policy.

## Dependencies follow capabilities

[Bun](https://bun.sh) is the required runtime.
[YAML](https://eemeli.org/yaml/) parses typed frontmatter,
and [QMD](https://github.com/tobi/qmd) supplies the optional local keyword and
embedding index. QMD is loaded only by index and search commands, so
deterministic graph and metadata commands do not initialize its native runtime
or model.

[Defuddle](https://github.com/kepano/defuddle) performs article extraction. [agent-browser](https://github.com/vercel-labs/agent-browser) provides optional rendered acquisition. The pinned [Sweet Cookie safety fork](https://github.com/hraness/sweet-cookie) supports explicit browser-cookie import while retaining host-only scope and rejecting partitioned or container-scoped state that the capture lanes cannot replay faithfully.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org) remain optional because only full audio or video localization needs them. `kb doctor` reports what is installed without probing cookie stores, and `kb adapters` reports the installed platform claims. A missing optional capability narrows the available route; it does not change the storage or graph model.

## Extension boundaries

New platform adapters should improve the strength of a capture claim, not merely add another scraper. Each adapter declares the scopes, acquisition modes, authentication requirements, item semantics, and media behavior it can support. It must remain bounded and must downgrade honestly when pagination, hidden branches, virtualized content, or access controls prevent completeness.

New graph policy should remain a pure function of vault content and explicit configuration. Derived reports may guide an agent or person, but the tool should not silently mutate authored prose. This keeps automation reviewable and lets users replace any analysis layer without migrating their notes.

Repository context follows the same separation. The CLI reads the repository
and vault as development inputs, but no application needs to import KB or
read a scope hub at runtime.
