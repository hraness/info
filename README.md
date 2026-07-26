# oh

notes and sources for coding agents.

oh keeps a coding agent's sources, notes, plans, and repository context in
ordinary Markdown files you can open in Obsidian and track with Git. it saves
public or signed-in web pages and PDFs with their sources, connects selected
`AGENTS.md` guides to notes for that part of a codebase, follows links between
notes, and searches locally by exact words or similar meaning.

```sh
bun add --global github:hraness/oh#v0.7.0
```

[article](https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path)

the command-line tool runs with Bun. rebuilding the note catalog, finding
repository context, following links, filtering fields, and saving sources do
not require a model, API key, database, or hosted service. search by similar
meaning uses a replaceable local index; Markdown remains the source of truth.

<!-- article:a-durable-knowledge-base-is-a-write-path:start -->
## [A knowledge base for your coding agents](<https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path>)

> Keep load-bearing rules in scoped AGENTS.md files, then pull rationale, evidence, plans, and linked decisions from a plain-Markdown Oh vault when a task needs them.

A coding agent needs two kinds of repository memory. It needs rules that govern the edit now, and it needs explanations and evidence that may help it reason. Mixing both into one automatically loaded prompt makes every task pay for history it may not need. Putting hard rules only in an optional knowledge base lets an agent miss them.

[hraness/oh](<https://github.com/hraness/oh>) is an open-source knowledge base for coding agents that keeps those jobs separate. A scoped `AGENTS.md` file is the automatically loaded normative control plane: ownership, must and never constraints, and required checks. Oh is the optional, pull-based knowledge plane for rationale, history, examples, evidence, plans, and linked neighboring decisions. Oh may explain an applicable `AGENTS.md` rule, but it never silently overrides one.

![Four icon cards show sources flowing into durable memory, linked ideas, and search for reuse by future coding-agent sessions.](<https://hraness.pub/article-diagrams/a-durable-knowledge-base-is-a-write-path.light.webp>)

*hraness/oh turns source material into memory that agents can link and find again.*

The conceptual layout puts the control plane on the repository path and the knowledge plane in an ordinary Markdown vault. Scope hubs are optional, and application code imports neither Oh nor its search index:

**Conceptual control plane, Oh vault, and derived views**

```text
repository/
├── AGENTS.md                         # inherited root rules
├── packages/parser/
│   ├── AGENTS.md                     # scoped rules and checks
│   └── src/
└── oh/
    ├── scopes/
    │   └── packages-parser--94a91e4eddfa.md
    ├── articles/<slug>/              # captured evidence and assets
    ├── notes/                         # maintained synthesis
    ├── plans/                         # decisions and verification
    ├── riffs/                         # voice-preserving source thought
    └── index.md                       # regenerated catalog

authored Markdown + frontmatter + wikilinks
              ├── oh list / oh links
              └── oh search               # derived local QMD index
```

Markdown is authoritative in this map. The catalog, backlink view, and semantic database can be deleted and rebuilt. Obsidian can browse the same files, but it is a compatible editor rather than a runtime dependency. Git supplies review, history, and recovery for both rules and knowledge.

### Separate rules from explanations

`AGENTS.md` belongs on the path to the code it governs. A root guide carries repository-wide policy; nested guides add the constraints owned by a package, product, or source boundary. Keep every load-bearing edit-time rule on that inherited path. If an edit would be wrong when the agent misses a sentence, that sentence does not belong only in Oh. [Agent docs hygiene](<https://hraness.pub/articles/the-ai-codebase-agent-docs-hygiene>) explains how to keep that path scoped and checked.

Oh holds material whose value depends on the question. A scope hub can explain why a parser rejects a tempting shortcut, link the plan that introduced the rule, preserve a source that supports it, and point to neighboring decisions. An agent pulls that prose when the task reaches the boundary. If a hub and an applicable guide disagree, the guide controls the edit and the hub needs repair.

A mapped hub declares optional frontmatter with `type: agent-context` and an exact repository-relative directory in `scope`. For `packages/parser`, the canonical hub at `oh/scopes/packages-parser--94a91e4eddfa.md` begins:

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
<!-- oh:context scopes/packages-parser--94a91e4eddfa -->
# Contents

- `src/` – parser implementation and tests.

# Guidelines

- Keep every load-bearing parser rule here.
```

`oh agents identity <scope>` emits the normalized scope, note ID and path, owning guide path, and exact marker without writing files. The canonical ID is `scopes/<readable normalized slug>--<12-char SHA-256 prefix>`. The bounded slug avoids mirroring a deep repository tree under `scopes/`, while the hash makes paths with the same leaf name, such as `packages/parser` and `projects/parser`, distinct. The full path remains in `scope` metadata. Moving a directory deliberately changes its identity, so the hub ID and reciprocal marker must change together.

### Pull context, then check the mapping

`oh context <path> --root oh --repo .` returns the inherited guide chain from the repository root to the target and identifies the valid hubs mapped to that chain. It does not load hub prose. The agent receives the normative rules first, then opens the nearest useful hub only when the task needs its explanation. Hraness School shows [how a coding-agent harness assembles instructions and context](<https://hraness.school/lessons/what-is-a-coding-agent#harness>) around the model before that more specialized repository-memory choice.

From that hub, the agent can expand a bounded neighborhood with `oh links`, inspect backlinks, filter exact metadata, or use semantic search when vocabulary differs. The command is a routing aid, not an instruction loader for the whole vault. A small guide that needs no explanatory neighborhood can remain unmapped.

`oh agents check` validates both sides of every declared mapping: the hub type and exact scope, canonical slug-and-hash identity, reciprocal guide marker, and real guide and scope paths confined to the repository. Missing mappings on otherwise valid small guides are allowed. The check catches broken identity and unsafe paths; it cannot decide whether the prose is true or the rule is wise.

`oh agents audit` is advisory. It ranks individual guides and cumulative inherited context, then surfaces long bullets and exact duplicates for review. Length is not a correctness test: a long guide may encode necessary constraints, and a short one may be wrong. The audit identifies where attention may pay off without turning a word limit into policy.

### Several systems converged on durable agent memory

This design direction did not begin with one recent proposal. Cognition's [2024 Devin release history](<https://docs.devin.ai/release-notes/2024>) described Knowledge that Devin could recall across future sessions by September 2024 and automatic Repo Knowledge from repository scans by November. On April 3, 2025, [Devin 2.0 introduced Devin Wiki and Devin Search](<https://cognition.com/blog/devin-2>). Cognition launched the public [DeepWiki service on May 5](<https://cognition.com/blog/deepwiki>), then a [DeepWiki Model Context Protocol server](<https://cognition.com/blog/deepwiki-mcp-server>) on May 22 for programmatic retrieval.

In April 2026, Andrej Karpathy published an [LLM Wiki proposal](<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>) with three layers: raw sources, an agent-maintained Markdown wiki, and an instruction schema. Its operations are ingest, query, and lint, with QMD suggested when the collection outgrows an index file. hraness/oh is not an implementation of Cognition's products, and the resemblance does not establish direct lineage. The sequence shows convergence on one pressure: useful reasoning must become a durable artifact before a session ends.

### Keep the files authoritative and portable

A knowledge base earns trust differently from a chat transcript. Its records need stable paths, reviewable changes, and a format that remains legible when the current agent is gone. Plain Markdown, YAML frontmatter, and explicit wikilinks meet that bar with little codebase coupling. An agent can begin with `index.md` and ordinary file tools or use the Oh commands and skills. Neither path requires a hosted database or a proprietary document format.

Directory names express editing authority without becoming a framework. Captured articles preserve what a source said. Notes hold current synthesis. Plans record intended work, evidence, and outcomes. Riffs preserve a speaker's claims and uncertainty. Scope hubs organize optional repository context. The application under development does not import Oh, and every derived view remains replaceable.

### Make evidence capture an auditable write path

Durable reasoning needs inspectable evidence. `oh clip` can read a public URL, saved HTML, rendered page, or the page already open in an authenticated browser. The [capture documentation](<https://github.com/hraness/oh/blob/main/docs/capture.md>) defines layered extraction routes. A capture writes readable Markdown beside localized assets and `capture.json`, whose manifest records the source URL, attempted routes, chosen extractor, completeness state, counts, warnings, and artifact hashes. “Complete” describes the selected bounded surface, not every hidden branch or future version of the page.

PDFs use the same durable bundle for a local path or public HTTP(S) URL. `oh pdf` sends remote input through a DNS-pinned acquisition boundary that denies private networks, then removes sensitive URL parameters from saved provenance. Local and remote capture preserve the original bytes, infer headings from native layout, extract bounded images, and use local optical character recognition for scans and screenshots.

**Capture a local or public remote PDF**

```shell
oh pdf "/absolute/path/to/document.pdf" --output articles
oh pdf "https://example.com/document.pdf" --output articles
```

The resulting bundle is evidence, not final interpretation. A maintained note can cite several captures, record disagreement, and change when later evidence warrants it. The sources stay available for audit. This boundary prevents an agent from silently replacing what a page said with what it now believes the page meant.

### Use exact structure before semantic similarity

Some retrieval questions have exact answers. `oh list` parses frontmatter such as `type`, `status`, `area`, dates, aliases, and tags into bounded scalar, list, and nested-object values. It can combine repeated filters with AND semantics, follow dotted metadata paths, match tags case-insensitively, and sort with a stable path tie-breaker. The parser makes a query reproducible; it does not impose one domain schema on every vault.

**Exact metadata filtering and bounded context traversal**

```shell
oh list --root oh --where type=plan --where status=in-progress --sort area --json
oh links scopes/packages-parser--94a91e4eddfa --root oh --direction both --depth 2 --limit 25 --json
```

Wikilinks answer another exact question: which relationships did an author state? The scanner resolves exact and relative targets or a unique basename, and reports broken or ambiguous links rather than guessing. `oh links` walks an explicit number of incoming and outgoing hops with a result limit and cycle handling. Backlinks reverse those resolved edges at read time. Traversal never expands through semantic similarity, so an agent can inspect a bounded neighborhood without loading the vault.

Exact structure cannot find a note whose author used unexpected language. For that lane, hraness/oh embeds [QMD, a local search engine for Markdown](<https://github.com/tobi/qmd>). `oh index` builds or refreshes a derived database in a local cache outside the vault. `oh search` checks for changed Markdown, then returns semantic candidates joined to authored metadata, tags, backlinks, and edge counts. Keyword BM25 search remains available with `--mode keyword` when exact terms fit better.

A vector score means two passages occupy a nearby region in an embedding model's representation. It does not mean the passage is current, correct, or supported by its sources. Use semantic results to find candidates, metadata to narrow them, links to inspect stated relationships, and the Markdown plus cited captures to verify the answer. QMD remains optional and local; deleting its index does not delete knowledge.

### Keep plans durable and promote rules to AGENTS.md

A plan shown only in chat has the same session boundary as the reasoning that produced it. The `plan-oh` skill writes a normal Markdown file with an outcome, status, area, assumptions, dependencies, decisions, and verification method. During execution, the same plan accumulates deviations, review findings, command evidence, and the final result. Completed plans remain as history. A finding that becomes a load-bearing edit rule moves into the applicable `AGENTS.md`; its rationale and evidence may stay linked from the scope hub.

hraness/oh also ships five Agent Skills that preserve the same file contract. `save-url-oh` selects a URL acquisition route and records completeness; `save-pdf-oh` preserves a PDF's text, images, bytes, and provenance; `query-oh` chooses exact metadata, graph, or semantic retrieval; `refresh-oh` regenerates the catalog and reviews link diagnostics; and `plan-oh` keeps execution knowledge durable. The [agent workflow documentation](<https://github.com/hraness/oh/blob/main/docs/agent-workflow.md>) defines how these skills meet the CLI contracts across agent runners. Skills guide writes and retrieval; they do not make application code depend on Oh.

### Adopt the smallest useful split

Start with a short inherited `AGENTS.md` path for rules whose omission would make an edit wrong. Add a scope hub only when its rationale, evidence, plans, or linked decisions deserve pull-based retrieval. A small Oh vault may need only Markdown, Git, an index, and ordinary file search. Add metadata queries, graph traversal, QMD, browser capture, or PDF ingestion only when the simpler layer stops answering the repository's questions.

This is a file-backed control plane paired with an optional knowledge plane, not autonomous memory. Checks validate mappings, not truth. Capture preserves a selected surface, not the source's trustworthiness. A link records a relationship, not agreement, and semantic similarity supplies candidates, not conclusions. The design works only while people and agents keep hard rules in scope and revise the evidence and explanations those rules point to.
<!-- article:a-durable-knowledge-base-is-a-write-path:end -->

## Install

[Bun](https://bun.sh/docs/installation) is the required runtime.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install hraness/oh and its bundled Agent Skills from
https://github.com/hraness/oh at the immutable v0.7.0 tag. Follow the repository
README, install the `oh` CLI, copy or link the skills I need into this agent
runner's configured skills directory, and verify the installation with
`oh doctor` and `oh --help`. Do not initialize or modify a vault until I ask.
```

The repository and packed package carry the same skill directories, so an agent
can inspect the tagged instructions before placing them in its runner-specific
discovery path.

Install the CLI from the immutable `v0.7.0` tag:

```sh
bun add --global github:hraness/oh#v0.7.0
oh --help
```

For programmatic use, declare the same pinned source in a project:

```json
{
  "dependencies": {
    "@hraness/oh": "github:hraness/oh#v0.7.0"
  }
}
```

Contributors can install from a checkout instead:

```sh
git clone https://github.com/hraness/oh.git
cd oh
bun install --frozen-lockfile
bun link
oh --help
```

HTTP capture works with the installed JavaScript dependencies. Rendered capture additionally needs a local Chromium-compatible browser. [yt-dlp](https://github.com/yt-dlp/yt-dlp) adds YouTube metadata, thumbnails, and transcripts; full audio or video localization is opt-in and some formats also need [FFmpeg](https://ffmpeg.org). PDF ingestion uses the open-source Poppler tools `pdfinfo` and `pdftohtml`; [Tesseract](https://github.com/tesseract-ocr/tesseract) adds local OCR for scans and screenshots.

Semantic search uses [QMD](https://github.com/tobi/qmd) and its recommended compact local EmbeddingGemma model. The first `oh index` or semantic `oh search` downloads the model (about 300 MB); keyword search and every structural command work without it.

## Start a vault

```sh
oh init my-oh
cd my-oh
oh clip https://example.com/article --output articles
oh refresh --root .
oh check --root .
```

`oh init` creates an `index.md` front door plus `articles/`, `notes/`,
`plans/`, `riffs/`, and optional repository-context `scopes/` boundaries. The
generated Markdown remains ordinary Markdown: open it in Obsidian, edit it in a
text editor, search it with standard tools, and version it with Git.

When a vault lives at `oh/` inside a repository, inspect the instructions and
mapped context for a repository path from the repository root:

```sh
oh agents identity packages/parser --json
oh context packages/parser/src/index.ts --root oh --repo .
oh agents check --root oh --repo .
```

`oh agents identity` derives a canonical mapping without writing files.
`oh context` lists inherited `AGENTS.md` files from the repository root toward
the target and verified context hubs from the nearest scope back toward the
root. It prints hub summaries, not their full bodies. Open the useful hub, then
use `oh links`, `oh backlinks`, `oh list`, or `oh search` to expand the
question deliberately.

## Command surface

| Command | Purpose |
| --- | --- |
| `oh init [directory]` | Create a new vault without merging into or overwriting an existing path; the default directory is `oh`. |
| `oh clip <url\|current>` | Capture a source and write an article bundle. `current` reads an attached active tab without navigating it; `oh capture <url>` is the explicit URL form. |
| `oh inspect <url>` | Run acquisition and extraction without writing a bundle. |
| `oh pdf <file-or-url> [--slug <slug>]` | Convert a local or public remote PDF into Markdown while retaining the original bytes, extracted images, OCR-derived text, URL provenance, and page provenance. |
| `oh refresh --root <directory>` | Rebuild the managed catalog atomically and report graph findings. |
| `oh check --root <directory>` | Verify that the catalog is current and that graph policy passes without changing files. |
| `oh graph --root <directory>` | Print the resolved contextual graph, broken or ambiguous links, orphans, and advisory mention candidates. |
| `oh backlinks <note> --root <directory>` | Show incoming contextual links for a note resolved by path, title, or alias. |
| `oh links <note> --root <directory>` | Traverse incoming, outgoing, or bidirectional contextual links with explicit depth and node limits. |
| `oh list --root <directory>` | Filter typed, nested frontmatter and tags; sort by metadata, title, path, or graph counts. `oh notes` is an alias. |
| `oh index --root <directory>` | Build or incrementally refresh the optional local QMD embedding index. |
| `oh search <query> --root <directory>` | Search locally by semantic similarity, or use `--mode keyword` for full-text retrieval. |
| `oh context <repository-path> --root <vault> --repo <repository>` | List inherited guides root to nearest and reciprocal context hubs nearest to root. Use `--kind auto\|file\|directory` to control how the target path is interpreted. |
| `oh agents identity <repository-scope>` | Derive the normalized scope, canonical hub ID and path, owning guide path, and exact reciprocal marker without writing files. |
| `oh agents check --root <vault> --repo <repository>` | Validate context identities, exact scopes, reciprocal markers, real guide paths, collisions, confinement, and guide shape. Unmapped guides remain valid. |
| `oh agents audit --root <vault> --repo <repository>` | Run the same correctness gate, then report deterministic per-guide, section, inherited-chain, long-bullet, and exact-duplicate advisories. |
| `oh doctor` | Report required and optional local capture capabilities. |
| `oh adapters` | Print the installed platform capability matrix. |

Vault commands default to the current directory and `index.md`; use `--root` and `--index` to select alternatives. Commands that report structured data accept `--json`. Run `oh --help` for the complete top-level surface and `oh clip --help` for capture, authentication, evidence, and resource-bound options.

## Capture reference

Use the current browser tab without navigating it:

```sh
oh clip current --browser-live --output articles
oh clip current --cdp 9222 --output articles
```

For `--browser-live`, first enable Chrome's local debugging connection at `chrome://inspect/#remote-debugging` (Chrome 144+). If Chrome was launched with an explicit loopback debugging port, pass that numeric port to `--cdp` instead.

To open a URL with state from a path-backed Chromium profile, pass its path. The capture runs against a temporary copy, leaving the source profile unchanged. A named profile selects reusable agent-browser-managed state instead:

```sh
oh clip https://example.com/private --browser-profile <path> --output articles
```

Each web capture writes readable Markdown, `capture.json`, localized assets, and optional evidence under `articles/<slug>/`. Unless media is disabled, YouTube captures add the title, description, duration, channel, thumbnail, and a locally extracted transcript when available; other video surfaces retain a poster or thumbnail instead of downloading the video by default. See [Capture web content](docs/capture.md) for scopes, saved files, browser modes, media, evidence, completeness states, and limits.

PDF capture uses the same bundle boundary:

```sh
oh pdf "/absolute/path/to/document.pdf" --output articles
oh pdf "https://example.com/document.pdf" --output articles
```

The bundle includes byte-identical `source.pdf`, readable Markdown, `capture.json`, and content-addressed extracted images. A reviewed second pass also retains its hash-bound `annotations.json`. See [Capture PDF documents](docs/pdf.md) for heading inference, OCR, screenshot metadata, completeness, and review.

## Graph reference

Vault-root wikilinks such as `[[notes/context-engineering|context engineering]]` are the graph's source of truth. `oh graph`, `oh backlinks`, and `oh links` derive relationships without injecting reciprocal links into authored notes. `oh refresh` owns only the marked catalog block in `index.md`; `oh check` verifies the same state without writing.

Frontmatter retains nested objects, arrays, finite numbers with safe integer precision, booleans, strings, and nulls. `oh list --where type=plan --tag ingestion --sort metadata.updated --order desc` answers exact questions from that authored data. Unquoted `true`, `false`, `null`, and numeric filter values are typed; keep the quotes inside the argument to match a string with the same spelling, for example `oh list --where 'external_id="9007199254740993"'`. QMD search is a discovery layer: each match is joined back to the live metadata and graph view, and similarity never becomes a link automatically.

Repository context preserves a stricter authority boundary. `AGENTS.md` remains
the always-loaded, normative home for ownership, required commands,
prohibitions, and edit gates. An optional `type: agent-context` note under
`scopes/` holds rationale, history, examples, evidence, and links for one exact
repository-relative directory. Its reciprocal
`<!-- oh:context scopes/<id> -->` marker appears before the guide headings.
A hub cannot override its guide or become the only home of a load-bearing
editing rule. Moving the scoped directory changes its identity.

Scope hubs are ordinary Markdown in the graph and optional QMD index;
`AGENTS.md` files remain excluded. This workflow reads repository and vault
files at development time. Applications do not need to import Oh or couple
their runtime to the vault.

The package exports its full programmatic surface from `@hraness/oh`; focused
entry points from `@hraness/oh/agent-context`,
`@hraness/oh/agent-guide-audit`, `@hraness/oh/graph`, `@hraness/oh/navigation`,
`@hraness/oh/query`, and `@hraness/oh/semantic`; web-capture orchestration and
diagnostics from
`@hraness/oh/capture`; PDF ingestion from `@hraness/oh/pdf`; and reusable
disposable-profile helpers from `@hraness/oh/browser-profiles`. Embedders that
need the CLI's lower-level ingestion machinery can use the explicit
capture-primitive subpaths listed in `package.json`, including
`@hraness/oh/clip/acquire`, `@hraness/oh/clip/args`, and
`@hraness/oh/clip/network-proxy`.

## Agent skills

The repository and packed package ship five reusable Agent Skills under
`skills/`: `save-url-oh` for auditable web ingestion, `save-pdf-oh` for
local and public remote PDF conversion, `refresh-oh` for graph and
agent-context validation, `query-oh` for loading repository-path context
before bounded metadata, graph, keyword, or semantic retrieval, and `plan-oh`
for creating and growing durable implementation plans. Copy or link a skill
directory into the location used by your agent runner. They invoke the installed
`oh` command and do not depend on a repository checkout path.

See [Design](docs/design.md), [Agent workflow](docs/agent-workflow.md), [PDF capture](docs/pdf.md), and [Contributing](CONTRIBUTING.md) for the durable contracts and development gate. hraness/oh is available under the [MIT License](LICENSE).
