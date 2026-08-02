# kb

durable local memory for coding agents.

kb keeps sources, notes, plans, and repository context beside your code in
ordinary Markdown and Git. Agents can retrieve an exact identifier, filter
metadata and tags, search locally by words or meaning, follow explicit
backlinks and typed relations, and inspect the Git history behind a note. The
TypeScript SDK reuses one live vault scan across queries, while bounded DAG
workflows let independent retrieval steps run in parallel.

The vault stays independent from application code. Markdown and repository Git
history are authoritative; the QMD search database, graph views, catalog, and
Git index are derived and replaceable.

```sh
bun add --global github:hraness/kb#v0.12.0
```

[article](https://hraness.com/engineering/a-durable-knowledge-base-is-a-write-path)

[website](https://hraness.com/kb)

the command-line tool runs with Bun. exact search, metadata filters, repository
context, links, Git provenance, capture, and PDF conversion need no hosted
service. hybrid search adds QMD's local keyword and embedding index. graph and
Git evidence stay separate from the primary exact and text relevance rank.

<!-- article:a-durable-knowledge-base-is-a-write-path:start -->
## [A knowledge base for your coding agents](<https://hraness.com/engineering/a-durable-knowledge-base-is-a-write-path>)

> Give coding agents durable, searchable memory beside the repository with plain Markdown, Git history, and replaceable local search.

Coding agents lose useful context when a session ends. The next agent can search the code again, but it cannot recover a source that was never saved, a decision that stayed in chat, or the relationship between two notes that nobody recorded. Repeating that work costs time and produces inconsistent answers.

Search alone cannot preserve agent memory. The system also needs a write path into inspectable files under version control: evidence can be captured, current understanding can be revised, plans can accumulate outcomes, and mandatory edit rules can move onto the instruction path. Search indexes, graph views, and embeddings used for meaning-based similarity should remain derived and replaceable.

[hraness/kb](<https://hraness.com/kb>) implements that split as repository-adjacent Markdown and Git. Exact lookup, metadata filters, local search, explicit links, and Git provenance help an agent find and inspect the files without making application code depend on the knowledge system.

### The pattern converged across agent tools

[Devin's 2024 release history](<https://docs.devin.ai/release-notes/2024>) records Knowledge that could be recalled across future sessions and Repo Knowledge produced by scanning repositories. Its [2025 release history](<https://docs.devin.ai/release-notes/2025>) records DeepWiki in April, codebase intelligence inside Devin in May, and a DeepWiki Model Context Protocol server later that month.

In April 2026, Andrej Karpathy published an [LLM Wiki proposal](<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>) with immutable raw sources, an agent-maintained interlinked Markdown wiki, and an instruction schema. Its operations are ingest, query, and lint, with QMD as an optional search layer when a simple index stops being enough. These systems converged on durable agent-readable knowledge. The sequence does not establish direct lineage between them or hraness/kb.

### Separate rules from explanations

A repository needs two kinds of memory. Rules that must govern an edit belong in a scoped `AGENTS.md` file on the path to the code. Rationale, history, examples, evidence, plans, and neighboring decisions belong in a knowledge base that an agent pulls only when the task needs them. This keeps mandatory instructions short without throwing away the context behind them.

A root guide carries repository-wide policy, and nested guides add constraints owned by a package or product. A nearby knowledge note can explain why a parser rejects a tempting shortcut, preserve the source behind the decision, and link the plan that introduced it. If the note and the applicable guide disagree, the guide controls the edit and the note needs repair. [Agent docs hygiene](<https://hraness.com/engineering/the-ai-codebase-agent-docs-hygiene>) covers that instruction path in more detail.

The result has two concrete parts: scoped instruction files govern edits, while an ordinary Markdown vault stores supporting context. Application code imports neither the vault nor its search indexes:

**Repository rules beside durable knowledge**

```text
repository/
├── AGENTS.md                         # inherited root rules
├── packages/parser/
│   ├── AGENTS.md                     # scoped rules and checks
│   └── src/
└── kb/
    ├── articles/<slug>/              # captured evidence and assets
    ├── notes/                         # maintained explanations
    ├── plans/                         # decisions and outcomes
    └── index.md                       # regenerated catalog
```

### Keep the implementation small and the files authoritative

hraness/kb packages the pattern as a small file contract. A useful vault can begin with Markdown, Git, `index.md`, and standard file search. Source capture, metadata queries, QMD, typed relationships, graph traversal, and TypeScript sessions are layers to add when the simpler setup stops answering the repository's questions. Application code need not import KB, and no hosted service or graph database owns its records.

Captured sources preserve evidence, notes hold current explanations, and plans retain decisions and outcomes. YAML frontmatter adds queryable metadata without requiring one domain schema for every vault. Stable paths, explicit links, and reviewable Git changes keep the material legible outside the CLI.

The Markdown files are authoritative. The catalog, QMD database, backlink view, graph traversal, and bounded Git index are derived and replaceable. Deleting one of those views removes a way to retrieve knowledge, not the knowledge itself.

### Preserve evidence and plans as working records

Durable reasoning needs inspectable evidence. `kb clip` can read a public URL, saved HTML, rendered page, or a page already open in an authenticated browser. The [capture documentation](<https://github.com/hraness/kb/blob/main/docs/capture.md>) defines the supported routes. A capture writes readable Markdown beside localized assets and `capture.json`, whose manifest records where the material came from, how it was extracted, what was saved, and any warnings. “Complete” describes the selected page surface, not every hidden branch or future version of the site.

**Capture a web source or local PDF**

```shell
kb clip "https://example.com/article" --output articles
kb pdf "/absolute/path/to/document.pdf" --output articles
```

The resulting bundle is evidence, not final interpretation. A maintained note can cite several captures, record disagreement, and change when later evidence warrants it. The sources stay available for audit. This prevents an agent from silently replacing what a page said with what it now believes the page meant.

The `plan-kb` skill creates a normal Markdown file under `kb/plans/` with an outcome, status, area, assumptions, dependencies, decisions, and verification method. The file grows during execution as agents record deviations, review findings, evidence, and the final result. Completed plans remain in Git as the history of the work. When a finding becomes a rule whose omission would make a future edit wrong, move that rule into the applicable `AGENTS.md` and retain the plan as its rationale.

### Search and connect with bounded signals

An identifier, title, alias, path, tag, or quoted phrase should not depend on an embedding. Exact mode reads the live Markdown. The default hybrid mode combines those results with keyword and vector result orders from [QMD, a local search engine for Markdown](<https://github.com/tobi/qmd>), while keeping exact identity matches first. Graph context and Git provenance remain separate evidence, so neither silently changes the primary text rank.

**Exact, hybrid, and requested Git retrieval**

```shell
kb search "parser-v2" --root kb --mode exact
kb search "why does the parser reject this input?" --root kb \
  --tag architecture --where status=active --json
kb search "why did the parser change?" --root kb --history --json
```

`--mode keyword` uses QMD's local full-text index without loading an embedding model. Hybrid and semantic modes use a pinned local embedding model. KB reconciles every QMD hit with current Markdown before returning it, and applies metadata and tag filters to those live notes. Search modes remain explicit through `--mode exact`, `--mode keyword`, `--mode semantic`, and `--mode hybrid`.

Retrieval is bounded. The high-level `kb search` and `KnowledgeBaseSession.search` surfaces return at most 100 primary results and request at most 500 candidates from each QMD retrieval lane. Selective filters can discard stale or ineligible rows from that window. When those discards prevent KB from filling the requested eligible result set, KB marks the QMD lane degraded and the overall result partial instead of presenting the bounded approximation as complete. Scores are local ranking signals, not probabilities, and cannot be compared across modes.

Each note owns its outbound typed relationships in frontmatter. KB derives backlinks, inverse edges, and bounded traversal at read time, so parallel agents do not contend on one generated fact file. `kb percolate <note>` reports recurring concepts and missing-link candidates with inspectable support but writes nothing. An agent reads the cited notes before creating a reusable concept or relationship. Semantic similarity never creates an edge automatically.

Git provenance is opt-in. A search without `--history` performs no Git indexing. `--history` requests best-effort provenance, while `--require-history` rejects unavailable history or incomplete provenance for the selected notes. If one commit exceeds the 2,000-path detail limit, KB retains its identity and vault-local note associations, marks its co-change detail incomplete, and continues through later commits. Best-effort search reports that requested lane as partial.

Search finds candidates. Similarity does not establish that a passage is current, correct, or supported by its sources. The checked six-case rank-fusion fixture is a deterministic regression, not a real-corpus retrieval, latency, or RAG benchmark. The Markdown, cited captures, explicit relationships, and requested Git history supply the material a reader must inspect.

### Adopt the smallest useful split

Start with a short inherited `AGENTS.md` path for rules whose omission would make an edit wrong. A small knowledge base may need only Markdown, Git, an index page, and ordinary file search. Add source capture when evidence keeps disappearing. Add metadata or hybrid search when file search stops answering the repository's questions. Add links and graph views only when the relationships themselves help people make decisions.

Treat the knowledge base as repository-adjacent durable memory. Authored Markdown and Git are the record; catalogs, indexes, embeddings, and graph views are replaceable ways to find and inspect it. Checks can validate structure, captures can preserve a selected surface, and similarity can suggest candidates. None of those mechanisms proves that a source is trustworthy or an explanation is still true. People and agents must revise the knowledge as the repository changes.
<!-- article:a-durable-knowledge-base-is-a-write-path:end -->

## Install

[Bun](https://bun.sh/docs/installation) is the required runtime.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install hraness/kb and its bundled Agent Skills from
https://github.com/hraness/kb at the immutable v0.12.0 tag. Follow the repository
README, install the `kb` CLI, copy or link the skills I need into this agent
runner's configured skills directory, and verify the installation with
`kb doctor` and `kb --help`. Do not initialize or modify a vault until I ask.
```

The repository and packed package carry the same skill directories, so an agent
can inspect the tagged instructions before placing them in its runner-specific
discovery path.

Install the CLI from the immutable `v0.12.0` tag:

```sh
bun add --global github:hraness/kb#v0.12.0
kb --help
```

For programmatic use, declare the same pinned source in a project:

```json
{
  "dependencies": {
    "@hraness/kb": "github:hraness/kb#v0.12.0"
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

Structural commands and exact search read the current Markdown directly and
need no service, model, or graph database. KB pins
[QMD](https://github.com/tobi/qmd) 2.5.3 for local keyword and vector search.
`--mode keyword` uses its full-text index without an embedding model. Hybrid
and semantic search use a revision-pinned compact local EmbeddingGemma model;
the first index or vector query downloads about 300 MB. On macOS with Bun,
install extension-capable Homebrew SQLite with `brew install sqlite` before
using vector retrieval.

`kb doctor` statically checks the pinned QMD, SQLite, sqlite-vec,
node-llama-cpp, and matching native packages without importing native code or
downloading the model. Exact and keyword search remain model-free. KB also
refuses an older adjacent `.snapshot` directory that lacks its ownership
marker; inspect and remove only the explicitly named disposable directory,
then retry so KB never guesses that unrelated files are cache data.

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
| `kb percolate [note] --root <directory>` | Report evidence-backed recurring-concept and missing-relationship candidates without writing notes. |
| `kb list --root <directory>` | Filter typed, nested frontmatter and tags; sort by metadata, title, path, or graph counts. `kb notes` is an alias. |
| `kb index --root <directory>` | Build or incrementally refresh the optional local QMD embedding index. |
| `kb search <query> --root <directory>` | Combine live exact matches with local QMD keyword and vector retrieval. Use `--mode exact\|keyword\|semantic\|hybrid`, metadata and tag filters, or bounded graph context. Omitted history performs no Git work; `--history` requests best-effort provenance and `--require-history` rejects unavailable or incomplete selected-note provenance. |
| `kb context <repository-path> --root <vault> --repo <repository>` | List inherited guides root to nearest and reciprocal context hubs nearest to root. Use `--kind auto\|file\|directory` to control how the target path is interpreted. |
| `kb agents identity <repository-scope>` | Derive the normalized scope, canonical hub ID and path, owning guide path, and exact reciprocal marker without writing files. |
| `kb agents check --root <vault> --repo <repository>` | Validate context identities, exact scopes, reciprocal markers, real guide paths, collisions, confinement, and guide shape. Unmapped guides remain valid. |
| `kb agents audit --root <vault> --repo <repository>` | Run the same correctness gate, then report deterministic per-guide, section, inherited-chain, long-bullet, and exact-duplicate advisories. |
| `kb doctor` | Report capture capabilities and statically inspect local QMD, SQLite, sqlite-vec, node-llama-cpp, and native search prerequisites without loading a model. |
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
`.md`. `kb graph`, `kb backlinks`, `kb relation list`, and `kb links` derive
inverse edges and bounded paths without injecting reciprocal or inferred facts into notes.
`kb percolate` proposes reusable concepts and missing connections with explicit
support; an agent reviews the cited prose before authoring anything.

These focused views are rebuilt from current Markdown. KB never commits a graph
database, generated fact file, or engine entity ID. Parallel agents therefore
keep editing separate notes. Each lane can run `kb check --no-catalog`, and the
integrator runs one final `kb refresh` for the only shared generated region in
`index.md`. Use `kb graph --json` for a whole-vault structural question; when a
question recurs, prefer adding a focused command with a bounded output contract
over introducing a parallel query store.

Frontmatter retains nested objects, arrays, finite numbers with safe integer precision, booleans, strings, and nulls. `kb list --where type=plan --tag ingestion --sort metadata.updated --order desc` answers exact questions from that authored data. Unquoted `true`, `false`, `null`, and numeric filter values are typed; keep the quotes inside the argument to match a string with the same spelling, for example `kb list --where 'external_id="9007199254740993"'`. Hybrid search fuses exact and QMD result orders, then joins each match back to live metadata. Graph neighbors and Git provenance are returned as separate evidence. Similarity never becomes a link automatically.

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

The package exports its full programmatic surface from `@hraness/kb`. Open one
read-only vault session through `@hraness/kb/sdk` to share a live Markdown scan
across exact search, metadata queries, reads, navigation, hybrid search, and Git
provenance. Compose finite parallel retrieval graphs with
`@hraness/kb/workflow`. `@hraness/kb/workflows` includes editable
`decision-context`, `explain-change`, and `plan-radar` compositions. Focused
lower-level entry points include
`@hraness/kb/search`, `@hraness/kb/git`,
`@hraness/kb/agent-context`,
`@hraness/kb/agent-guide-audit`, `@hraness/kb/authoring`,
`@hraness/kb/graph`, `@hraness/kb/navigation`, `@hraness/kb/percolate`,
`@hraness/kb/query`, and `@hraness/kb/semantic`; web-capture orchestration and
diagnostics from
`@hraness/kb/capture`; PDF ingestion from `@hraness/kb/pdf`; and reusable
disposable-profile helpers from `@hraness/kb/browser-profiles`. Embedders that
need the CLI's lower-level ingestion machinery can use the explicit
capture-primitive subpaths listed in `package.json`, including
`@hraness/kb/clip/acquire`, `@hraness/kb/clip/args`, the DNS-pinned request and
connection-pool boundary at `@hraness/kb/clip/network`, and the browser proxy at
`@hraness/kb/clip/network-proxy`.

## Agent skills

The repository and packed package ship six reusable Agent Skills under
`skills/`: `save-url-kb` for auditable web ingestion, `save-pdf-kb` for
local and public remote PDF conversion, `refresh-kb` for graph and
agent-context validation, `query-kb` for loading repository-path context
before bounded exact, metadata, hybrid, graph, or Git retrieval,
`percolate-kb` for reviewing and promoting reusable concepts and typed
relationships, and `plan-kb` for creating and growing durable implementation
plans. Copy or link a skill
directory into the location used by your agent runner. They invoke the installed
`kb` command and do not depend on a repository checkout path.

See [Design](docs/design.md), [Agent workflow](docs/agent-workflow.md), [PDF capture](docs/pdf.md), and [Contributing](CONTRIBUTING.md) for the durable contracts and development gate. hraness/kb is available under the [MIT License](LICENSE).
