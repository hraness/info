# info

agent librarian.

info keeps a coding agent's sources, notes, and plans in ordinary Markdown files
you can open in Obsidian and version with Git. it captures public or signed-in
web pages and converts local or remote PDFs into auditable bundles with
provenance and local assets. it filters typed frontmatter, traverses explicit
wikilinks and derived backlinks, checks the graph, and searches locally by
keyword or meaning with a rebuildable embedding index.

```sh
bun add --global github:hraness/info#v0.4.0
```

[article](https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path)

the CLI is Bun-first. refresh, graph navigation, exact metadata queries, and
capture do not require a model, API key, database, or hosted service. semantic
search uses a replaceable local QMD index; Markdown remains the source of truth.

<!-- article:a-durable-knowledge-base-is-a-write-path:start -->
## [A knowledge base for your coding agents](<https://hraness.pub/articles/a-durable-knowledge-base-is-a-write-path>)

> Coding agents need memory that survives the chat. hraness/info keeps it in ordinary Markdown files with web and PDF capture, explicit link graphs, and local search.

A coding agent can inspect a repository and finish a task, then begin the next session without the decisions, evidence, or rejected approaches that shaped the first one. A longer context window delays that loss. It does not create maintained memory that another agent can inspect and improve.

[hraness/info](<https://github.com/hraness/info>) is an open-source knowledge base for coding agents. It captures web pages and PDFs, filters exact metadata, derives link graphs from explicit wikilinks, and runs local keyword or embedding search. The package stays deliberately close to files so a team can change agents, editors, or search tools without migrating its memory.

![Four icon cards show sources flowing into durable memory, linked ideas, and search for reuse by future coding-agent sessions.](<https://hraness.pub/article-diagrams/a-durable-knowledge-base-is-a-write-path.light.webp>)

*hraness/info turns source material into memory that agents can link and find again.*

The default layout separates authored records from derived views. These directories are useful conventions, not a framework that application code must import:

**Default hraness/info vault and its derived views**

```text
info/
├── articles/<slug>/  # captured source, manifest, and local assets
├── notes/            # maintained synthesis
├── plans/            # decisions, progress, and verification
├── riffs/            # voice-preserving source thought
└── index.md          # regenerated catalog

Markdown + frontmatter + wikilinks
              │
              ├── info list / info links   # deterministic views
              └── info search              # local derived QMD index
```

Markdown is the authority in this map. The catalog, backlink view, and semantic database can all be deleted and rebuilt. Obsidian can browse the same files, but it is a compatible editor rather than a runtime dependency. Git supplies history, review, and recovery for the records that agents edit.

### Several systems converged on durable agent memory

This design direction did not begin with one recent proposal. Cognition's [2024 Devin release history](<https://docs.devin.ai/release-notes/2024>) described Knowledge that Devin could recall across future sessions by September 2024 and automatic Repo Knowledge from repository scans by November. On April 3, 2025, [Devin 2.0 introduced Devin Wiki and Devin Search](<https://cognition.com/blog/devin-2>). Cognition then launched the public [DeepWiki service on May 5](<https://cognition.com/blog/deepwiki>), followed on May 22 by a [DeepWiki Model Context Protocol server](<https://cognition.com/blog/deepwiki-mcp-server>) for programmatic retrieval. Those products are codebase-oriented and managed by Cognition, but the chronology matters: they predate the later public LLM-wiki discussion.

In April 2026, Andrej Karpathy published an [LLM Wiki proposal](<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>) with three layers: raw sources, an agent-maintained Markdown wiki, and an instruction schema. Its operations are ingest, query, and lint, with QMD suggested when the collection outgrows an index file. hraness/info is not an implementation of Cognition's products, and the similar pieces do not establish direct lineage. They show convergence on the same pressure: useful reasoning must become a durable artifact before a session ends.

### Keep the substrate boring and portable

A knowledge base earns trust differently from a chat transcript. Its records need stable paths, reviewable changes, and a format that remains legible when the current agent is gone. Plain Markdown and YAML frontmatter meet that bar with little codebase coupling. The application being developed does not depend on the knowledge-base package, and the vault does not need to know which agent will read it next.

The directory names encode only a few distinctions that affect editing authority. Captured articles preserve what a source said. Notes hold current synthesis and may change as evidence changes. Plans record intended work and its outcome. Riffs preserve a speaker's claims and uncertainty. A different domain can add its own directories and frontmatter without changing the graph or search model.

This low level of opinion has a practical payoff. An agent can start with `index.md`, use standard file tools, or ignore the CLI entirely. Another agent can use the package's commands and skills. Neither path requires a hosted database, a proprietary document format, or knowledge-base hooks inside production code. Optional indexes accelerate retrieval; they do not become another source of truth.

### Make ingestion an auditable write path

Durable memory starts with a reliable way to acquire evidence. `info clip` can read a public URL, saved HTML, a rendered page, or the page already open in a signed-in browser. The [capture documentation](<https://github.com/hraness/info/blob/main/docs/capture.md>) defines layered extraction routes for ordinary pages and specialized surfaces. Each route reports what it actually obtained rather than treating any nonempty response as a complete capture.

When the useful page is already visible, `info clip current --browser-live` reads the active tab through the attached browser session. `info clip current --cdp 9222` uses a browser's Chrome DevTools Protocol port instead. Both use the authentication already present on the machine and read the current document without navigating it. For ingestion, this is the programmatic equivalent of Save Page. A new source surface needs an extractor, representative fixtures, or the generic rendered-page path; it does not need an action API.

A capture produces readable Markdown beside `capture.json` and any localized assets. The manifest records the source URL, attempted routes, chosen extractor, completeness state, counts, warnings, and artifact hashes. “Complete” refers to the selected bounded representation, not every hidden branch of a service or a future version of the page. Bundle installation is atomic, so an interrupted write does not leave a source record that only looks finished.

Media follows the same evidence rule. Images from ordinary pages, X, LinkedIn, and other rendered surfaces are localized into the bundle, while exposed video posters remain inspectable without downloading the full video. A normal YouTube capture adds available title, description, duration, channel, thumbnail, and transcript context; full audio or video remains an explicit opt-in.

PDFs use the same durable bundle whether the input is a local path or a public HTTP(S) URL. `info pdf` sends remote input through the same DNS-pinned, private-network-denying acquisition boundary as web capture, then removes sensitive URL parameters before saving provenance. Local and remote captures keep the original PDF byte-for-byte, infer headings from native layout, extract embedded images within recorded bounds, and use local OCR for scans and screenshots.

**Capture a local or public remote PDF**

```shell
info pdf "/absolute/path/to/document.pdf" --output articles
info pdf "https://example.com/document.pdf" --output articles
```

Text-bearing images become inspectable Markdown with page and geometry metadata while the source image remains available; primarily visual images stay embedded. This matters for hybrid documents such as exported reports whose later pages are really Slack messages, diagrams, or photographs.

The bundle is evidence, not the final interpretation. A maintained note can cite several captures, record disagreement, and change when later evidence warrants it. The captures stay available for audit. This source-versus-synthesis boundary prevents an agent from silently replacing what a page said with what the agent now believes it meant.

### Use structure before semantic guesswork

Some retrieval questions have exact answers. Frontmatter values such as `type`, `status`, `area`, dates, aliases, and tags are parsed into bounded scalar, list, and nested-object values. `info list` can filter repeated fields with AND semantics, match tags case-insensitively, follow dotted metadata paths, and sort with a stable path tie-breaker. The parser makes these queries deterministic; it does not impose one domain schema on every vault.

Links answer a different exact question: which relationships did an author state? Vault-root wikilinks are contextual edges. The scanner resolves each target as an exact or relative path, or as a unique basename, and reports broken or ambiguous targets rather than guessing. The `info links` and `info backlinks` commands can resolve a note argument by path, title, or alias. Backlinks reverse resolved links at read time. Generated catalog links in `index.md` do not count as context, and a title mentioned in prose is only a review candidate until an author links it.

**Exact metadata filtering and bounded link traversal**

```shell
info list --root . --where type=plan --where status=in-progress --tag browser --sort area --order asc --json
info links plans/browser-ingestion --root . --direction both --depth 2 --limit 25 --json
```

The first command finds active browser plans in a reproducible order. The second walks both incoming and outgoing contextual links for at most two hops and 25 notes. Depth is explicit, cycles are handled, the default result cap is 50 notes, and the traversal never expands through semantic similarity. This bounded traversal lets an agent gather nearby decisions without pulling the whole vault into context.

### Let semantic search find language, not truth

Exact structure cannot find a note whose author used an unexpected phrase. For that lane, hraness/info embeds [QMD, a local search engine for Markdown](<https://github.com/tobi/qmd>). `info search` defaults to QMD's vector-only search path. It uses the recommended English-optimized `embeddinggemma-300M-Q8_0` model, roughly a 300 MB download, without loading QMD's query-expansion or reranking models. The model and index stay local.

**Prewarm the local index and search by meaning**

```shell
info index --root .
info search "why current-tab capture does not navigate" --root . --json
```

`info index` builds or incrementally refreshes the derived database. `info search` also checks for changed Markdown before searching, then joins each hit back to its authored metadata, tags, backlinks, and contextual edge counts. The database lives in a local cache outside the vault and can be rebuilt from the files. Keyword BM25 search remains available with `--mode keyword` when exact terms are a better fit.

A vector score means that two passages occupy a nearby region in an embedding model's representation. It does not mean the passage is current, correct, or supported by its sources. An agent should use semantic results to discover candidate notes, metadata to narrow them, links to inspect stated relationships, and the Markdown plus cited captures to verify the answer.

### Write plans and operating rules back into the vault

A plan shown only in chat has the same session boundary as the reasoning that produced it. The package's `plan-info` skill writes the plan as a normal file with an outcome, status, area, assumptions, dependencies, decisions, and a verification method. During execution, the same file accumulates deviations, review findings, command evidence, and the final result. Completed plans remain as history; current operating truth moves into code, documentation, or maintained notes.

hraness/info ships five Agent Skills with the installed package. `save-url-info` selects an acquisition route and records completeness. `save-pdf-info` turns local files and public PDF URLs into Markdown while preserving native text, image text, visual assets, original bytes, and source provenance. `query-info` chooses among exact metadata, graph traversal, and semantic search. `refresh-info` regenerates the catalog and reviews link diagnostics without manufacturing edges. `plan-info` keeps execution knowledge durable. Their shared `-info` suffix makes the skill family easy to scan and invoke consistently. The [agent workflow documentation](<https://github.com/hraness/info/blob/main/docs/agent-workflow.md>) defines how those skills meet the same CLI contracts across agent runners.

### Adopt the parts that prevent repeated rediscovery

A small vault may need only Markdown, Git, an index, and ordinary file search. Add deterministic metadata queries when filenames stop answering exact questions. Add link traversal when relationships matter. Add QMD when vocabulary drift makes exact search miss useful notes. Add browser clipping when important evidence lives on signed-in or rendered surfaces. Add PDF ingestion when documents mix native text, scans, screenshots, and visual evidence. Each layer is optional because the lower layer remains readable on its own.

The limits are equally modular. Capture records what a selected surface exposed; it does not decide whether the source deserves trust. A wikilink records a relationship, not agreement. Metadata encodes an author's classification, not an objective fact. Semantic similarity supplies candidates, not conclusions. The durable part is the inspectable record and the discipline of revising it. With those in place, the next coding agent can begin from maintained evidence and decisions instead of reconstructing them from a previous chat.
<!-- article:a-durable-knowledge-base-is-a-write-path:end -->

## Install

[Bun](https://bun.sh/docs/installation) is the required runtime.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install hraness/info and its bundled Agent Skills from
https://github.com/hraness/info at the immutable v0.4.0 tag. Follow the repository
README, install the `info` CLI, copy or link the skills I need into this agent
runner's configured skills directory, and verify the installation with
`info doctor` and `info --help`. Do not initialize or modify a vault until I ask.
```

The repository and packed package carry the same skill directories, so an agent
can inspect the tagged instructions before placing them in its runner-specific
discovery path.

Install the CLI from the immutable `v0.4.0` tag:

```sh
bun add --global github:hraness/info#v0.4.0
info --help
```

For programmatic use, declare the same pinned source in a project:

```json
{
  "dependencies": {
    "@cclrte/info": "github:hraness/info#v0.4.0"
  }
}
```

Contributors can install from a checkout instead:

```sh
git clone https://github.com/hraness/info.git
cd info
bun install --frozen-lockfile
bun link
info --help
```

HTTP capture works with the installed JavaScript dependencies. Rendered capture additionally needs a local Chromium-compatible browser. [yt-dlp](https://github.com/yt-dlp/yt-dlp) adds YouTube metadata, thumbnails, and transcripts; full audio or video localization is opt-in and some formats also need [FFmpeg](https://ffmpeg.org). PDF ingestion uses the open-source Poppler tools `pdfinfo` and `pdftohtml`; [Tesseract](https://github.com/tesseract-ocr/tesseract) adds local OCR for scans and screenshots.

Semantic search uses [QMD](https://github.com/tobi/qmd) and its recommended compact local EmbeddingGemma model. The first `info index` or semantic `info search` downloads the model (about 300 MB); keyword search and every structural command work without it.

## Start a vault

```sh
info init my-info
cd my-info
info clip https://example.com/article --output articles
info refresh --root .
info check --root .
```

`info init` creates an `index.md` front door plus `articles/`, `notes/`, `plans/`, and `riffs/` boundaries. The generated Markdown remains ordinary Markdown: open it in Obsidian, edit it in a text editor, search it with standard tools, and version it with Git.

## Command surface

| Command | Purpose |
| --- | --- |
| `info init [directory]` | Create a new vault without merging into or overwriting an existing path; the default directory is `info`. |
| `info clip <url\|current>` | Capture a source and write an article bundle. `current` reads an attached active tab without navigating it; `info capture <url>` is the explicit URL form. |
| `info inspect <url>` | Run acquisition and extraction without writing a bundle. |
| `info pdf <file-or-url> [--slug <slug>]` | Convert a local or public remote PDF into Markdown while retaining the original bytes, extracted images, OCR-derived text, URL provenance, and page provenance. |
| `info refresh --root <directory>` | Rebuild the managed catalog atomically and report graph findings. |
| `info check --root <directory>` | Verify that the catalog is current and that graph policy passes without changing files. |
| `info graph --root <directory>` | Print the resolved contextual graph, broken or ambiguous links, orphans, and advisory mention candidates. |
| `info backlinks <note> --root <directory>` | Show incoming contextual links for a note resolved by path, title, or alias. |
| `info links <note> --root <directory>` | Traverse incoming, outgoing, or bidirectional contextual links with explicit depth and node limits. |
| `info list --root <directory>` | Filter typed, nested frontmatter and tags; sort by metadata, title, path, or graph counts. `info notes` is an alias. |
| `info index --root <directory>` | Build or incrementally refresh the optional local QMD embedding index. |
| `info search <query> --root <directory>` | Search locally by semantic similarity, or use `--mode keyword` for full-text retrieval. |
| `info doctor` | Report required and optional local capture capabilities. |
| `info adapters` | Print the installed platform capability matrix. |

Vault commands default to the current directory and `index.md`; use `--root` and `--index` to select alternatives. Commands that report structured data accept `--json`. Run `info --help` for the complete top-level surface and `info clip --help` for capture, authentication, evidence, and resource-bound options.

## Capture reference

Use the current browser tab without navigating it:

```sh
info clip current --browser-live --output articles
info clip current --cdp 9222 --output articles
```

For `--browser-live`, first enable Chrome's local debugging connection at `chrome://inspect/#remote-debugging` (Chrome 144+). If Chrome was launched with an explicit loopback debugging port, pass that numeric port to `--cdp` instead.

To open a URL with state from a path-backed Chromium profile, pass its path. The capture runs against a temporary copy, leaving the source profile unchanged. A named profile selects reusable agent-browser-managed state instead:

```sh
info clip https://example.com/private --browser-profile <path> --output articles
```

Each web capture writes readable Markdown, `capture.json`, localized assets, and optional evidence under `articles/<slug>/`. Unless media is disabled, YouTube captures add the title, description, duration, channel, thumbnail, and a locally extracted transcript when available; other video surfaces retain a poster or thumbnail instead of downloading the video by default. See [Capture web content](docs/capture.md) for scopes, saved files, browser modes, media, evidence, completeness states, and limits.

PDF capture uses the same bundle boundary:

```sh
info pdf "/absolute/path/to/document.pdf" --output articles
info pdf "https://example.com/document.pdf" --output articles
```

The bundle includes byte-identical `source.pdf`, readable Markdown, `capture.json`, and content-addressed extracted images. A reviewed second pass also retains its hash-bound `annotations.json`. See [Capture PDF documents](docs/pdf.md) for heading inference, OCR, screenshot metadata, completeness, and review.

## Graph reference

Vault-root wikilinks such as `[[notes/context-engineering|context engineering]]` are the graph's source of truth. `info graph`, `info backlinks`, and `info links` derive relationships without injecting reciprocal links into authored notes. `info refresh` owns only the marked catalog block in `index.md`; `info check` verifies the same state without writing.

Frontmatter retains nested objects, arrays, finite numbers with safe integer precision, booleans, strings, and nulls. `info list --where type=plan --tag ingestion --sort metadata.updated --order desc` answers exact questions from that authored data. Unquoted `true`, `false`, `null`, and numeric filter values are typed; keep the quotes inside the argument to match a string with the same spelling, for example `info list --where 'external_id="9007199254740993"'`. QMD search is a discovery layer: each match is joined back to the live metadata and graph view, and similarity never becomes a link automatically.

The package exports its full programmatic surface from `@cclrte/info`; focused entry points from `@cclrte/info/graph`, `@cclrte/info/navigation`, `@cclrte/info/query`, and `@cclrte/info/semantic`; web-capture orchestration and diagnostics from `@cclrte/info/capture`; PDF ingestion from `@cclrte/info/pdf`; and reusable disposable-profile helpers from `@cclrte/info/browser-profiles`. Embedders that need the CLI's lower-level ingestion machinery can use the explicit capture-primitive subpaths listed in `package.json`, including `@cclrte/info/clip/acquire`, `@cclrte/info/clip/args`, and `@cclrte/info/clip/network-proxy`.

## Agent skills

The repository and packed package ship five reusable Agent Skills under `skills/`: `save-url-info` for auditable web ingestion, `save-pdf-info` for local and public remote PDF conversion, `refresh-info` for graph maintenance, `query-info` for choosing exact, structural, keyword, or semantic retrieval, and `plan-info` for creating and growing durable implementation plans. Copy or link a skill directory into the location used by your agent runner. They invoke the installed `info` command and do not depend on a repository checkout path.

See [Design](docs/design.md), [Agent workflow](docs/agent-workflow.md), [PDF capture](docs/pdf.md), and [Contributing](CONTRIBUTING.md) for the durable contracts and development gate. hraness/info is available under the [MIT License](LICENSE).
