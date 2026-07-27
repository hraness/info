# kb

notes and sources for coding agents.

kb keeps a coding agent's sources, notes, plans, and repository context in
ordinary Markdown files you can open in Obsidian and track with Git. it saves
public or signed-in web pages and PDFs with their sources, connects selected
`AGENTS.md` guides to notes for that part of a codebase, follows links and typed
relationships between notes, helps agents surface reusable concepts, searches
locally by exact words or similar meaning, and can query the live Markdown as a
temporary Datalog graph.

```sh
bun add --global github:hraness/kb#v0.9.0
```

[article](https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path)

[website](https://hraness.com/kb)

the command-line tool runs with Bun. rebuilding the note catalog, finding
repository context, following links, filtering fields, and saving sources do
not require a model, API key, database, or hosted service. search by similar
meaning uses a replaceable local index; Markdown remains the source of truth.

<!-- article:a-durable-knowledge-base-is-a-write-path:start -->
## [A knowledge base for your coding agents](<https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path>)

> Keep load-bearing rules in scoped AGENTS.md files, then let agents grow concepts and relationships in a plain-Markdown KB vault with disposable local Datalog and semantic views.

A coding agent needs two kinds of repository memory. It needs rules that govern the edit now, and it needs explanations and evidence that may help it reason. Mixing both into one automatically loaded prompt makes every task pay for history it may not need. Putting hard rules only in an optional knowledge base lets an agent miss them.

[hraness/kb](<https://hraness.com/kb>) is an open-source knowledge base for coding agents that keeps those jobs separate. A scoped `AGENTS.md` file is the automatically loaded normative control plane: ownership, must and never constraints, and required checks. KB is the optional, pull-based knowledge plane for rationale, history, examples, evidence, plans, and linked neighboring decisions. KB may explain an applicable `AGENTS.md` rule, but it never silently overrides one.

![Four icon cards show sources flowing into durable memory, linked ideas, and search for reuse by future coding-agent sessions.](<https://hraness.pub/article-diagrams/a-durable-knowledge-base-is-a-write-path.light.webp>)

*hraness/kb turns source material into memory that agents can link and find again.*

The conceptual layout puts the control plane on the repository path and the knowledge plane in an ordinary Markdown vault. Scope hubs are optional, and application code imports neither KB nor its search index:

**Conceptual control plane, KB vault, and derived views**

```text
repository/
├── AGENTS.md                         # inherited root rules
├── packages/parser/
│   ├── AGENTS.md                     # scoped rules and checks
│   └── src/
└── kb/
    ├── scopes/
    │   └── packages-parser--94a91e4eddfa.md
    ├── articles/<slug>/              # captured evidence and assets
    ├── notes/                         # maintained synthesis
    ├── plans/                         # decisions and verification
    ├── riffs/                         # voice-preserving source thought
    └── index.md                       # regenerated catalog

authored Markdown + frontmatter + wikilinks
              ├── kb list / kb links
              ├── kb datalog / percolate  # in-memory DataScript view
              └── kb search               # derived local QMD index
```

Markdown is authoritative in this map. The catalog, backlink view, DataScript database, and semantic index can be deleted and rebuilt. Obsidian can browse the same files, but it is a compatible editor rather than a runtime dependency. Git supplies review, history, and recovery for both rules and knowledge.

### Separate rules from explanations

`AGENTS.md` belongs on the path to the code it governs. A root guide carries repository-wide policy; nested guides add the constraints owned by a package, product, or source boundary. Keep every load-bearing edit-time rule on that inherited path. If an edit would be wrong when the agent misses a sentence, that sentence does not belong only in KB. [Agent docs hygiene](<https://hraness.pub/articles/the-ai-codebase-agent-docs-hygiene>) explains how to keep that path scoped and checked.

KB holds material whose value depends on the question. A scope hub can explain why a parser rejects a tempting shortcut, link the plan that introduced the rule, preserve a source that supports it, and point to neighboring decisions. An agent pulls that prose when the task reaches the boundary. If a hub and an applicable guide disagree, the guide controls the edit and the hub needs repair.

A mapped hub declares optional frontmatter with `type: agent-context` and an exact repository-relative directory in `scope`. For `packages/parser`, the canonical hub at `kb/scopes/packages-parser--94a91e4eddfa.md` begins:

**Optional parser scope hub**

```markdown
---
title: Parser context
type: agent-context
scope: packages/parser
---
# Parser context
```

Its guide at `packages/parser/AGENTS.md` carries the reciprocal marker before the two required headings:

**Reciprocal source-guide marker**

```markdown
<!-- kb:context scopes/packages-parser--94a91e4eddfa -->
# Contents

- `src/` – parser implementation and tests.

# Guidelines

- Keep every load-bearing parser rule here.
```

`kb agents identity <scope>` emits the normalized scope, note ID and path, owning guide path, and exact marker without writing files. The canonical ID is `scopes/<readable normalized slug>--<12-char SHA-256 prefix>`. The bounded slug avoids mirroring a deep repository tree under `scopes/`, while the hash makes paths with the same leaf name, such as `packages/parser` and `projects/parser`, distinct. The full path remains in `scope` metadata. Moving a directory deliberately changes its identity, so the hub ID and reciprocal marker must change together.

### Pull context, then check the mapping

`kb context <path> --root kb --repo .` returns the inherited guide chain from the repository root to the target and identifies the valid hubs mapped to that chain. It does not load hub prose. The agent receives the normative rules first, then opens the nearest useful hub only when the task needs its explanation. Hraness School shows [how a coding-agent harness assembles instructions and context](<https://hraness.school/lessons/what-is-a-coding-agent#harness>) around the model before that more specialized repository-memory choice.

From that hub, the agent can expand a bounded neighborhood with `kb links`, inspect backlinks, filter exact metadata, or use semantic search when vocabulary differs. The command is a routing aid, not an instruction loader for the whole vault. A small guide that needs no explanatory neighborhood can remain unmapped.

`kb agents check` validates both sides of every declared mapping: the hub type and exact scope, canonical slug-and-hash identity, reciprocal guide marker, and real guide and scope paths confined to the repository. Missing mappings on otherwise valid small guides are allowed. The check catches broken identity and unsafe paths; it cannot decide whether the prose is true or the rule is wise.

`kb agents audit` is advisory. It ranks individual guides and cumulative inherited context, then surfaces long bullets and exact duplicates for review. Length is not a correctness test: a long guide may encode necessary constraints, and a short one may be wrong. The audit identifies where attention may pay off without turning a word limit into policy.

### Several systems converged on durable agent memory

This design direction did not begin with one recent proposal. Cognition's [2024 Devin release history](<https://docs.devin.ai/release-notes/2024>) described Knowledge that Devin could recall across future sessions by September 2024 and automatic Repo Knowledge from repository scans by November. On April 3, 2025, [Devin 2.0 introduced Devin Wiki and Devin Search](<https://cognition.com/blog/devin-2>). Cognition launched the public [DeepWiki service on May 5](<https://cognition.com/blog/deepwiki>), then a [DeepWiki Model Context Protocol server](<https://cognition.com/blog/deepwiki-mcp-server>) on May 22 for programmatic retrieval.

In April 2026, Andrej Karpathy published an [LLM Wiki proposal](<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>) with three layers: raw sources, an agent-maintained Markdown wiki, and an instruction schema. Its operations are ingest, query, and lint, with QMD suggested when the collection outgrows an index file. hraness/kb is not an implementation of Cognition's products, and the resemblance does not establish direct lineage. The sequence shows convergence on one pressure: useful reasoning must become a durable artifact before a session ends.

### Keep the files authoritative and portable

A knowledge base earns trust differently from a chat transcript. Its records need stable paths, reviewable changes, and a format that remains legible when the current agent is gone. Plain Markdown, YAML frontmatter, and explicit wikilinks meet that bar with little codebase coupling. An agent can begin with `index.md` and ordinary file tools or use the KB commands and skills. Neither path requires a hosted database or a proprietary document format.

Directory names express editing authority without becoming a framework. Captured articles preserve what a source said. Notes hold current synthesis. Plans record intended work, evidence, and outcomes. Riffs preserve a speaker's claims and uncertainty. Scope hubs organize optional repository context. The application under development does not import KB, and every derived view remains replaceable.

### Make evidence capture an auditable write path

Durable reasoning needs inspectable evidence. `kb clip` can read a public URL, saved HTML, rendered page, or the page already open in an authenticated browser. The [capture documentation](<https://github.com/hraness/kb/blob/main/docs/capture.md>) defines layered extraction routes. A capture writes readable Markdown beside localized assets and `capture.json`, whose manifest records the source URL, attempted routes, chosen extractor, completeness state, counts, warnings, and artifact hashes. “Complete” describes the selected bounded surface, not every hidden branch or future version of the page.

PDFs use the same durable bundle for a local path or public HTTP(S) URL. `kb pdf` sends remote input through a DNS-pinned acquisition boundary that denies private networks, then removes sensitive URL parameters from saved provenance. Local and remote capture preserve the original bytes, infer headings from native layout, extract bounded images, and use local optical character recognition for scans and screenshots.

**Capture a local or public remote PDF**

```shell
kb pdf "/absolute/path/to/document.pdf" --output articles
kb pdf "https://example.com/document.pdf" --output articles
```

The resulting bundle is evidence, not final interpretation. A maintained note can cite several captures, record disagreement, and change when later evidence warrants it. The sources stay available for audit. This boundary prevents an agent from silently replacing what a page said with what it now believes the page meant.

### Use exact structure before semantic similarity

Some retrieval questions have exact answers. `kb list` parses frontmatter such as `type`, `status`, `area`, dates, aliases, and tags into bounded scalar, list, and nested-object values. It can combine repeated filters with AND semantics, follow dotted metadata paths, match tags case-insensitively, and sort with a stable path tie-breaker. The parser makes a query reproducible; it does not impose one domain schema on every vault.

**Exact metadata filtering and bounded context traversal**

```shell
kb list --root kb --where type=plan --where status=in-progress --sort area --json
kb links scopes/packages-parser--94a91e4eddfa --root kb --direction both --depth 2 --limit 25 --json
```

Wikilinks answer another exact question: which relationships did an author state in prose? The scanner resolves exact and relative targets or a unique basename, and reports broken or ambiguous links rather than guessing. `kb links` walks an explicit number of incoming and outgoing hops with a result limit and cycle handling. Backlinks reverse those resolved edges at read time. Traversal never expands through semantic similarity, so an agent can inspect a bounded neighborhood without loading the vault.

### Let concepts and relationships percolate

A useful vault eventually contains ideas that recur across source boundaries. Keeping every occurrence as an isolated tag makes the pattern hard to inspect; moving all graph state into one generated file gives parallel agents a permanent merge conflict. KB uses a smaller convention. A reusable concept is an ordinary Markdown note with `type: concept`. A note stores only the typed outbound assertions it owns:

**A source-owned typed relationship**

```markdown
---
type: note
tags:
  - local-first
relations:
  supports:
    - notes/durable-agent-memory
  contrasts-with:
    - notes/conversation-history
---

# The write path

The local-first write path supports durable agent memory because ...
```

Predicates use lower-kebab-case and targets use exact vault-root note IDs. The explanatory sentence matters: frontmatter makes an assertion queryable, but it does not supply its reason. Inverse edges, backlinks, transitive paths, and shared-concept neighborhoods are derived at read time. KB does not inject them into another note.

`kb percolate <note>` reviews repeated tags without concept notes, notes that share ideas but lack a contextual edge, exact unlinked title or alias mentions, and relationship-hygiene findings. Each result carries inspectable support; relationship candidates count independent shared tags or concept neighbors, not both endpoints of one match. The command is read-only. An agent opens the cited notes, promotes only concepts likely to be reused, and authors a relationship only when the prose or evidence establishes it:

**Review, create, and relate without a central graph file**

```shell
kb percolate notes/write-path --root kb --limit 25 --json
kb note create notes/durable-agent-memory \
  --root kb --title "Durable agent memory" --type concept \
  --body-file /path/to/reviewed-concept.md
kb relation add notes/write-path supports notes/durable-agent-memory \
  --root kb
```

### Project Markdown into Datalog

KB projects the current notes into an immutable in-memory [DataScript](<https://github.com/tonsky/datascript>) database for each structural query. Notes, tags, typed metadata leaves, wikilinks, and relationship edges receive stable semantic string identities. DataScript's numeric entity IDs never appear in the public result. `kb datalog` can then express joins, aggregates, predicates, and recursive paths that would be awkward as a collection of bespoke commands:

The engine choice is intentionally narrow. [Datalevin getting-started guide](<https://datalevin.org/docs/02-getting-started>) and [CozoDB documentation](<https://docs.cozodb.org/en/latest/>) are compelling when the graph database itself owns durable state. KB already has a durable, mergeable source of truth in Git, so adding native storage, a JVM, migrations, or a second synchronization protocol would solve the wrong problem. DataScript supplies recursive Datalog over a temporary relation and then gets out of the way.

Raw queries run in a disposable one-shot subprocess with a 2-second default deadline, a 5-second ceiling, and bounded inputs and results. Fact projection spends its limit while it walks nested metadata, and the parent validates the result again before returning it to the CLI. An accidental Cartesian product therefore ends as a typed budget error or a terminated child process instead of occupying the agent indefinitely.

DataScript 1.7.8 evaluates recursive rules top-down. A rule that walks relationships which may cycle must carry an explicit remaining-depth argument and decrement it on every recursive hop; an unbounded recursive rule over a cycle is contained by the subprocess deadline. For ordinary path questions, `kb links` already provides bounded traversal and cycle handling.

**A bounded Datalog relationship query**

```shell
kb datalog '[
  :find ?source ?target
  :where
  [?edge :edge/predicate "supports"]
  [?edge :edge/source ?source-ref]
  [?source-ref :note/id ?source]
  [?edge :edge/target ?target-ref]
  [?target-ref :note/id ?target]
]' --root kb --limit 50 --json
```

The database is never committed, shared, or treated as storage. DataScript's JavaScript persistence serializes a complete database; using that snapshot as a repository artifact would create the central merge hotspot this design is meant to avoid. Rebuilding from Markdown keeps facts readable, diffs local to the note that owns them, and the query engine replaceable. During parallel work, each lane can run `kb check --no-catalog` without rewriting `index.md`; the integrating agent performs one final refresh.

Exact structure cannot find a note whose author used unexpected language. For that lane, hraness/kb embeds [QMD, a local search engine for Markdown](<https://github.com/tobi/qmd>). `kb index` builds or refreshes a derived database in a local cache outside the vault. `kb search` checks for changed Markdown, then returns semantic candidates joined to authored metadata, tags, backlinks, and edge counts. Keyword BM25 search remains available with `--mode keyword` when exact terms fit better.

A vector score means two passages occupy a nearby region in an embedding model's representation. It does not mean the passage is current, correct, or supported by its sources. Use semantic results to find candidates, metadata and Datalog to narrow them, links and typed edges to inspect stated relationships, and the Markdown plus cited captures to verify the answer. QMD remains optional and local; deleting its index does not delete knowledge.

### Keep plans durable and promote rules to AGENTS.md

A plan shown only in chat has the same session boundary as the reasoning that produced it. The `plan-kb` skill writes a normal Markdown file with an outcome, status, area, assumptions, dependencies, decisions, and verification method. During execution, the same plan accumulates deviations, review findings, command evidence, and the final result. Completed plans remain as history. A finding that becomes a load-bearing edit rule moves into the applicable `AGENTS.md`; its rationale and evidence may stay linked from the scope hub.

hraness/kb also ships six Agent Skills that preserve the same file contract. `save-url-kb` selects a URL acquisition route and records completeness; `save-pdf-kb` preserves a PDF's text, images, bytes, and provenance; `query-kb` chooses exact metadata, Datalog, graph, or semantic retrieval; `percolate-kb` reviews changed notes for reusable concepts and evidence-backed relationships; `refresh-kb` regenerates the catalog and reviews graph diagnostics; and `plan-kb` keeps execution knowledge durable. The [agent workflow documentation](<https://github.com/hraness/kb/blob/main/docs/agent-workflow.md>) defines how these skills meet the CLI contracts across agent runners. Skills guide writes and retrieval; they do not make application code depend on KB.

### Adopt the smallest useful split

Start with a short inherited `AGENTS.md` path for rules whose omission would make an edit wrong. Add a scope hub only when its rationale, evidence, plans, or linked decisions deserve pull-based retrieval. A small KB vault may need only Markdown, Git, an index, and ordinary file search. Add typed relationships, Datalog, metadata queries, graph traversal, QMD, browser capture, or PDF ingestion only when the simpler layer stops answering the repository's questions.

This is a file-backed control plane paired with an optional knowledge plane, not autonomous memory. Checks validate structure, not truth. Capture preserves a selected surface, not the source's trustworthiness. A typed edge records an authored assertion, not proof; Datalog derives answers, not facts; and semantic similarity supplies candidates, not conclusions. The design works only while people and agents keep hard rules in scope and revise the concepts, evidence, and explanations those rules point to.
<!-- article:a-durable-knowledge-base-is-a-write-path:end -->

## Install

[Bun](https://bun.sh/docs/installation) is the required runtime.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install hraness/kb and its bundled Agent Skills from
https://github.com/hraness/kb at the immutable v0.9.0 tag. Follow the repository
README, install the `kb` CLI, copy or link the skills I need into this agent
runner's configured skills directory, and verify the installation with
`kb doctor` and `kb --help`. Do not initialize or modify a vault until I ask.
```

The repository and packed package carry the same skill directories, so an agent
can inspect the tagged instructions before placing them in its runner-specific
discovery path.

Install the CLI from the immutable `v0.9.0` tag:

```sh
bun add --global github:hraness/kb#v0.9.0
kb --help
```

For programmatic use, declare the same pinned source in a project:

```json
{
  "dependencies": {
    "@hraness/kb": "github:hraness/kb#v0.9.0"
  }
}
```

Contributors can install from a checkout instead:

```sh
git clone https://github.com/hraness/kb.git
cd kb
bun install --frozen-lockfile
bun link
kb --help
```

HTTP capture works with the installed JavaScript dependencies. Rendered capture additionally needs a local Chromium-compatible browser. [yt-dlp](https://github.com/yt-dlp/yt-dlp) adds YouTube metadata, thumbnails, and transcripts; full audio or video localization is opt-in and some formats also need [FFmpeg](https://ffmpeg.org). PDF ingestion uses the open-source Poppler tools `pdfinfo` and `pdftohtml`; [Tesseract](https://github.com/tesseract-ocr/tesseract) adds local OCR for scans and screenshots.

Structural queries use [DataScript](https://github.com/tonsky/datascript) as a
disposable in-memory Datalog view over Markdown. It needs no service, model, or
committed database. Semantic search uses [QMD](https://github.com/tobi/qmd) and
its recommended compact local EmbeddingGemma model. The first `kb index` or
semantic `kb search` downloads the model (about 300 MB); keyword search and
every structural command work without it.

## Start a vault

```sh
kb init my-kb
cd my-kb
kb clip https://example.com/article --output articles
kb refresh --root .
kb check --root .
```

`kb init` creates an `index.md` front door plus `articles/`, `notes/`,
`plans/`, `riffs/`, and optional repository-context `scopes/` boundaries. The
generated Markdown remains ordinary Markdown: open it in Obsidian, edit it in a
text editor, search it with standard tools, and version it with Git.

When a vault lives at `kb/` inside a repository, inspect the instructions and
mapped context for a repository path from the repository root:

```sh
kb agents identity packages/parser --json
kb context packages/parser/src/index.ts --root kb --repo .
kb agents check --root kb --repo .
```

`kb agents identity` derives a canonical mapping without writing files.
`kb context` lists inherited `AGENTS.md` files from the repository root toward
the target and verified context hubs from the nearest scope back toward the
root. It prints hub summaries, not their full bodies. Open the useful hub, then
use `kb links`, `kb backlinks`, `kb list`, or `kb search` to expand the
question deliberately.

## Command surface

| Command | Purpose |
| --- | --- |
| `kb init [directory]` | Create a new vault without merging into or overwriting an existing path; the default directory is `kb`. |
| `kb clip <url\|current>` | Capture a source and write an article bundle. `current` reads an attached active tab without navigating it; `kb capture <url>` is the explicit URL form. |
| `kb inspect <url>` | Run acquisition and extraction without writing a bundle. |
| `kb pdf <file-or-url> [--slug <slug>]` | Convert a local or public remote PDF into Markdown while retaining the original bytes, extracted images, OCR-derived text, URL provenance, and page provenance. |
| `kb refresh --root <directory>` | Rebuild the managed catalog atomically and report graph findings. |
| `kb check --root <directory>` | Verify that the catalog is current and graph policy passes without changing files. `--no-catalog` gates an edit lane without requiring the shared catalog refresh. |
| `kb graph --root <directory>` | Print the resolved contextual and typed graph, broken or ambiguous targets, orphans, and advisory mention candidates. |
| `kb backlinks <note> --root <directory>` | Show incoming contextual links and typed relationships for a note resolved by path, title, or alias. |
| `kb links <note> --root <directory>` | Traverse incoming, outgoing, or bidirectional contextual links and typed relationships with explicit depth and node limits. |
| `kb note create <id> --title <title> --root <directory>` | Atomically create one confined Markdown note; use `--type concept` for a reusable concept. |
| `kb relation add\|remove <source> <predicate> <target>` | Idempotently edit one source note's typed outbound relationship using exact canonical note IDs. |
| `kb relation list <note> --root <directory>` | List a note's authored outbound and derived inbound typed relationships. |
| `kb datalog <query> --root <directory>` | Run a sorted, bounded Datalog query in a disposable one-shot subprocess over current Markdown; use `--query-file` and `--rules-file` for reviewed recursive programs, and `--timeout-ms` within the hard 5-second ceiling. |
| `kb percolate [note] --root <directory>` | Report evidence-backed recurring-concept and missing-relationship candidates without writing notes. |
| `kb list --root <directory>` | Filter typed, nested frontmatter and tags; sort by metadata, title, path, or graph counts. `kb notes` is an alias. |
| `kb index --root <directory>` | Build or incrementally refresh the optional local QMD embedding index. |
| `kb search <query> --root <directory>` | Search locally by semantic similarity, or use `--mode keyword` for full-text retrieval. |
| `kb context <repository-path> --root <vault> --repo <repository>` | List inherited guides root to nearest and reciprocal context hubs nearest to root. Use `--kind auto\|file\|directory` to control how the target path is interpreted. |
| `kb agents identity <repository-scope>` | Derive the normalized scope, canonical hub ID and path, owning guide path, and exact reciprocal marker without writing files. |
| `kb agents check --root <vault> --repo <repository>` | Validate context identities, exact scopes, reciprocal markers, real guide paths, collisions, confinement, and guide shape. Unmapped guides remain valid. |
| `kb agents audit --root <vault> --repo <repository>` | Run the same correctness gate, then report deterministic per-guide, section, inherited-chain, long-bullet, and exact-duplicate advisories. |
| `kb doctor` | Report required and optional local capture capabilities. |
| `kb adapters` | Print the installed platform capability matrix. |

Vault commands default to the current directory and `index.md`; use `--root` and `--index` to select alternatives. Commands that report structured data accept `--json`. Run `kb --help` for the complete top-level surface and `kb clip --help` for capture, authentication, evidence, and resource-bound options.

## Capture reference

Use the current browser tab without navigating it:

```sh
kb clip current --browser-live --output articles
kb clip current --cdp 9222 --output articles
```

For `--browser-live`, first enable Chrome's local debugging connection at `chrome://inspect/#remote-debugging` (Chrome 144+). If Chrome was launched with an explicit loopback debugging port, pass that numeric port to `--cdp` instead.

To open a URL with state from a path-backed Chromium profile, pass its path. The capture runs against a temporary copy, leaving the source profile unchanged. A named profile selects reusable agent-browser-managed state instead:

```sh
kb clip https://example.com/private --browser-profile <path> --output articles
```

Each web capture writes readable Markdown, `capture.json`, localized assets, and optional evidence under `articles/<slug>/`. Unless media is disabled, YouTube captures add the title, description, duration, channel, thumbnail, and a locally extracted transcript when available; other video surfaces retain a poster or thumbnail instead of downloading the video by default. See [Capture web content](docs/capture.md) for scopes, saved files, browser modes, media, evidence, completeness states, and limits.

PDF capture uses the same bundle boundary:

```sh
kb pdf "/absolute/path/to/document.pdf" --output articles
kb pdf "https://example.com/document.pdf" --output articles
```

The bundle includes byte-identical `source.pdf`, readable Markdown, `capture.json`, and content-addressed extracted images. A reviewed second pass also retains its hash-bound `annotations.json`. See [Capture PDF documents](docs/pdf.md) for heading inference, OCR, screenshot metadata, completeness, and review.

## Graph reference

Vault-root wikilinks such as
`[[notes/context-engineering|context engineering]]` and source-owned typed
frontmatter relationships are the graph's authored facts:

```yaml
type: concept
relations:
  supports:
    - notes/durable-agent-memory
```

Predicates use lower-kebab-case and targets use exact vault-root IDs without
`.md`. `kb graph`, `kb backlinks`, `kb links`, and `kb datalog` derive inverse
edges and paths without injecting reciprocal or inferred facts into notes.
`kb percolate` proposes reusable concepts and missing connections with explicit
support; an agent reviews the cited prose before authoring anything.

The DataScript projection is rebuilt from current Markdown for each query and
consumed only by its disposable query subprocess. KB never commits a graph database,
generated facts file, or engine entity ID. Parallel agents therefore keep
editing separate notes. Each lane can run `kb check --no-catalog`, and the
integrator runs one final `kb refresh` for the only shared generated region in
`index.md`.

Datalog evaluation is asynchronous and isolated behind a 2-second default
subprocess deadline, a hard 5-second ceiling, and bounded request and result
transfers validated on both sides of IPC. Projection also spends its fact
budget while traversing nested metadata.
Programmatic callers can branch on owned `DatalogBudgetError` and
`FactProjectionBudgetError` kinds instead of matching error text.

Datalog queries use the fixed `:kb/*`, `:note/*`, `:metadata/*`, and `:edge/*`
attribute vocabulary documented in [Design](docs/design.md). Edge endpoints are
semantic references; join them through `:note/id` to return canonical Markdown
IDs. Conventional EDN keyword spelling works at the CLI boundary.

Frontmatter retains nested objects, arrays, finite numbers with safe integer precision, booleans, strings, and nulls. `kb list --where type=plan --tag ingestion --sort metadata.updated --order desc` answers exact questions from that authored data. Unquoted `true`, `false`, `null`, and numeric filter values are typed; keep the quotes inside the argument to match a string with the same spelling, for example `kb list --where 'external_id="9007199254740993"'`. QMD search is a discovery layer: each match is joined back to the live metadata and graph view, and similarity never becomes a link automatically.

Repository context preserves a stricter authority boundary. `AGENTS.md` remains
the always-loaded, normative home for ownership, required commands,
prohibitions, and edit gates. An optional `type: agent-context` note under
`scopes/` holds rationale, history, examples, evidence, and links for one exact
repository-relative directory. Its reciprocal
`<!-- kb:context scopes/<id> -->` marker appears before the guide headings.
A hub cannot override its guide or become the only home of a load-bearing
editing rule. Moving the scoped directory changes its identity.

Scope hubs are ordinary Markdown in the graph and optional QMD index;
`AGENTS.md` files remain excluded. This workflow reads repository and vault
files at development time. Applications do not need to import KB or couple
their runtime to the vault.

The package exports its full programmatic surface from `@hraness/kb`; focused
entry points from `@hraness/kb/agent-context`,
`@hraness/kb/agent-guide-audit`, `@hraness/kb/authoring`,
`@hraness/kb/datalog`, `@hraness/kb/facts`, `@hraness/kb/graph`,
`@hraness/kb/navigation`, `@hraness/kb/percolate`, `@hraness/kb/query`, and
`@hraness/kb/semantic`; web-capture orchestration and
diagnostics from
`@hraness/kb/capture`; PDF ingestion from `@hraness/kb/pdf`; and reusable
disposable-profile helpers from `@hraness/kb/browser-profiles`. Embedders that
need the CLI's lower-level ingestion machinery can use the explicit
capture-primitive subpaths listed in `package.json`, including
`@hraness/kb/clip/acquire`, `@hraness/kb/clip/args`, and
`@hraness/kb/clip/network-proxy`.

## Agent skills

The repository and packed package ship six reusable Agent Skills under
`skills/`: `save-url-kb` for auditable web ingestion, `save-pdf-kb` for
local and public remote PDF conversion, `refresh-kb` for graph and
agent-context validation, `query-kb` for loading repository-path context
before bounded metadata, Datalog, graph, keyword, or semantic retrieval,
`percolate-kb` for reviewing and promoting reusable concepts and typed
relationships, and `plan-kb` for creating and growing durable implementation
plans. Copy or link a skill
directory into the location used by your agent runner. They invoke the installed
`kb` command and do not depend on a repository checkout path.

See [Design](docs/design.md), [Agent workflow](docs/agent-workflow.md), [PDF capture](docs/pdf.md), and [Contributing](CONTRIBUTING.md) for the durable contracts and development gate. hraness/kb is available under the [MIT License](LICENSE).
