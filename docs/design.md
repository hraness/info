# Design

hraness/oh treats a knowledge base as durable Markdown plus replaceable views. A vault must remain useful when the CLI is absent, and a capture must remain inspectable when the original page changes or disappears. Exact graph and metadata views are deterministic; semantic search is optional derived state that can be deleted and rebuilt.

## Storage is the interface

The vault is an ordinary directory of Obsidian-compatible Markdown, suitable for a text editor, Git, and standard filesystem tools. Frontmatter, headings, prose, and wikilinks are owned content. Refresh, check, graph navigation, metadata queries, and capture require no hosted account or model. A local QMD index is an optional cache for semantic recall, never the authoritative copy of a note.

`oh init` creates a small set of authority boundaries:

- `articles/` contains captured sources and their local artifacts.
- `notes/` contains maintained concepts, entities, comparisons, and syntheses.
- `plans/` contains proposals, decisions, execution state, and verification.
- `riffs/` contains cleaned first-person thought from dictated or stream-of-consciousness material.
- `scopes/` contains optional pull-based context for selected repository directories.
- `index.md` is the front door and contains one marked, tool-managed catalog block.

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
oh agents identity src --json
```

The command returns the normalized scope, extensionless note ID, Markdown path,
owning guide path, and reciprocal marker. Use its output rather than
reimplementing slug or hash logic.

The guide points back to the extensionless note ID with one exact marker before
its headings:

```md
<!-- oh:context scopes/src--25a6634263c1 -->
# Contents

- ...

# Guidelines

- ...
```

Mappings are reciprocal: a hub requires the marker in the `AGENTS.md` at its
exact scope, and a marker requires that canonical hub. A guide without a marker
is valid and remains fully normative.

`oh context <repository-path> --root <vault> --repo <repository>` returns the
applicable guides from root to nearest and verified hubs from nearest to root.
The text view includes hub summaries, not hub bodies. Open the useful hub, then
use `oh links`, `oh backlinks`, `oh list`, or `oh search` for a bounded
expansion. `--kind auto` uses filesystem state and a conservative path hint;
`--kind file` or `--kind directory` makes the target interpretation explicit.

`oh agents check` verifies canonical IDs, `type` and `scope` metadata,
duplicate, case-fold, and Unicode-normalization collisions, repository
confinement, real scope directories and regular guide files, exact reciprocal
markers, and the required guide shape. `oh agents audit` runs the same gate
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

The graph is built from wikilinks in authored Markdown. A scan parses note identity, title, aliases, properties, readable text, and outgoing links; resolves each note target; and reports broken or ambiguous references rather than choosing a convenient match.

Three rules keep the result honest:

1. Backlinks are derived, never written into source notes.
2. The managed catalog is navigation, so links to or from its note (`index.md` by default) do not count as contextual edges.
3. A title or alias found in prose is only a mention candidate. It becomes an edge only after a person or agent decides that the link improves the sentence.

This makes inbound counts, outbound counts, backlinks, and orphans reproducible. It also prevents reciprocal link sections and index catalogs from making a disconnected vault appear healthy.

Fenced code, inline code, frontmatter, and HTML comments are excluded from mention analysis. Line breaks are preserved during masking so diagnostics continue to point at the authored source.

## Refresh owns one region

`oh refresh` scans the vault, renders a sorted catalog, and atomically replaces only the region between the catalog markers in the configured index note (`index.md` by default). Text outside those markers belongs to the author. If markers are malformed or duplicated, refresh fails instead of guessing.

`oh check` computes the expected catalog and graph policy without writing. It fails when the managed region is stale or required graph invariants do not hold. The split gives local work a deliberate mutation command and CI a read-only gate.

`oh graph` exposes the scan as a human-readable or structured report. `oh backlinks` uses the same identity rules to retrieve incoming contextual links for one note. `oh links` traverses incoming, outgoing, or bidirectional contextual edges to a bounded depth and node count, reporting when a high-degree neighborhood reaches the cap. There is no second graph state to synchronize.

## Exact metadata is authored

Frontmatter is parsed as typed, nested data rather than flattened strings. Scalars retain their string, number, boolean, or null type; arrays and objects retain their structure. Tags from frontmatter are normalized for matching while the original metadata remains available in structured output.

`oh list` filters that authored state by nested dotted paths, field existence, or tags, then sorts by title, path, graph counts, or nested metadata. Repeated filters are conjunctive. Missing sort values are placed last and ties are stable, so the same vault and query produce the same order.

Metadata is useful for exact questions such as “which implementation plans are in progress?” It is not inferred from prose and the tool does not invent tags to improve retrieval. Authors and agents can evolve conventions in the vault's scoped `AGENTS.md` files without migrating to a package-owned schema.

## Semantic recall is optional derived state

`oh search` uses [QMD](https://github.com/tobi/qmd) for local retrieval. Semantic mode is the default and uses QMD 2.5.3's recommended compact EmbeddingGemma model. Keyword mode uses QMD's local full-text index without embeddings. The first semantic index or query downloads the embedding model; later runs incrementally update only changed Markdown.

Each vault gets a path-derived SQLite cache under the user's cache directory unless `--database` selects another file. `index.md` and every `AGENTS.md` are excluded because they are navigation and always-loaded instructions rather than knowledge records. Scope hubs remain ordinary Markdown, so QMD indexes their rationale and evidence like any other note. The cache may be removed at any time and recreated with `oh index`.

Search results are joined back to a live vault scan, so each hit carries current typed metadata, tags, contextual link counts, and backlinks. Files outside the requested vault and stale indexed identities are discarded. A similarity score is a discovery aid, not a graph edge, a citation, or evidence that the result is true. Use `oh list` for exact metadata, `oh links` for authored relationships, and `oh search` when the same concept may be expressed in different words.

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

Live or CDP browser attachment keeps the browser's existing network stack and signed-in state. `oh clip current` reads the active tab without navigating or interacting with it and leaves the browser open. URL-based attached capture may navigate that tab and scroll within the configured bounds, taking bounded observations as content is rendered. Screenshots are also different from sanitized source evidence because private content can remain visible in pixels.

These boundaries are not entitlement mechanisms. Capture does not bypass authentication, access controls, paywalls, CAPTCHAs, rate limits, DRM, or platform policy.

## Dependencies follow capabilities

[Bun](https://bun.sh) is the required runtime. [YAML](https://eemeli.org/yaml/) parses typed frontmatter, and [QMD](https://github.com/tobi/qmd) supplies the optional local keyword and embedding index. QMD is loaded only by index and search commands, so deterministic graph and metadata commands do not initialize its native runtime or model.

[Defuddle](https://github.com/kepano/defuddle) performs article extraction. [agent-browser](https://github.com/vercel-labs/agent-browser) provides optional rendered acquisition. The pinned [Sweet Cookie safety fork](https://github.com/hraness/sweet-cookie) supports explicit browser-cookie import while retaining host-only scope and rejecting partitioned or container-scoped state that the capture lanes cannot replay faithfully.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org) remain optional because only full audio or video localization needs them. `oh doctor` reports what is installed without probing cookie stores, and `oh adapters` reports the installed platform claims. A missing optional capability narrows the available route; it does not change the storage or graph model.

## Extension boundaries

New platform adapters should improve the strength of a capture claim, not merely add another scraper. Each adapter declares the scopes, acquisition modes, authentication requirements, item semantics, and media behavior it can support. It must remain bounded and must downgrade honestly when pagination, hidden branches, virtualized content, or access controls prevent completeness.

New graph policy should remain a pure function of vault content and explicit configuration. Derived reports may guide an agent or person, but the tool should not silently mutate authored prose. This keeps automation reviewable and lets users replace any analysis layer without migrating their notes.

Repository context follows the same separation. The CLI reads the repository
and vault as development inputs, but no application needs to import Oh or
read a scope hub at runtime.
