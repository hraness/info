# Working in a hraness/oh vault

This guide gives coding agents a conservative workflow for reading and maintaining a vault. The Markdown is the durable record. Tool output, catalogs, backlinks, and mention candidates are views over that record.

## Orient before editing

1. For a repository-path question, run `oh context` and read the returned
   `AGENTS.md` files from root to nearest before opening any optional hubs.
2. Read `index.md`, then search filenames, frontmatter titles, aliases, and note
   text before creating a new identity.
3. Read the notes that already own the concept or source in question.
4. Use the narrowest view that answers the question:
   - `oh list` for exact frontmatter or tag filters.
   - `oh links <note>` or `oh backlinks <note>` for authored relationships.
   - `oh search` when the same idea may be expressed in different words.
   - `oh graph` for whole-vault diagnostics.

Update an existing note when the identity is unambiguous. Create a new note when the subject has a distinct durable identity, not merely because a search phrase differs.

## Load repository context by path

When the question concerns a repository file or directory, start from the
repository root:

```sh
oh context src/index.ts --root oh --repo .
```

The command lists inherited guides from the repository root toward the nearest
scope, then verified Oh hubs from the nearest scope back toward the root. It
prints the hub title and summary, not the full body. Read every returned guide;
they are the normative, always-loaded source for ownership, required commands,
prohibitions, invariants, and edit gates. Open only the hubs whose summaries
apply, then expand through a bounded command:

```sh
oh links scopes/src--25a6634263c1 --root oh --depth 1 --limit 25
oh backlinks scopes/src--25a6634263c1 --root oh
oh list --root oh --where area=source --json
oh search "why source errors retain source ranges" --root oh --json
```

Use the exact hub ID returned by `oh context`. Use `--kind file` or
`--kind directory` when a missing path cannot be classified reliably by
`--kind auto`.

A mapped scope hub carries pull-based rationale, history, examples, evidence,
and links. It cannot override its guide or become the only home of a
load-bearing edit rule. A guide does not need a hub.

## Query before reading broadly

Use typed metadata for exact selection and sorting:

```sh
oh list --where type=plan --where status=in-progress --sort metadata.updated --order desc
oh list --tag retrieval --sort inbound --order desc --json
```

Filters can address nested fields with dotted paths. Repeat `--where`, `--has`, or `--tag` to require every condition. Unquoted `true`, `false`, `null`, and numeric values are typed; retain inner quotes to select a string with the same spelling, as in `--where 'external_id="9007199254740993"'`. JSON output includes the live metadata, tags, backlinks, and inbound and outbound contextual counts for each result.

Use bounded traversal to understand explicit context around a note:

```sh
oh links plans/improve-ingestion --direction both --depth 2 --limit 25
```

Traversal defaults to at most 50 notes and reports when that cap truncates a high-degree neighborhood. Lower the limit for agent context discipline; raise it deliberately when the structural question requires a wider view.

Use semantic search for recall rather than exact selection:

```sh
oh search "capturing a signed-in virtualized page"
oh search "browser profile" --mode keyword
```

Semantic mode uses QMD's recommended compact local embedding model. The first semantic query downloads it and builds a local cache; subsequent queries incrementally index changed Markdown. `oh index` can prewarm that cache. Search results suggest what to read next—they do not create links or establish that a claim is correct.

## Preserve authority boundaries

- Captured articles preserve what the source said and how it was acquired. Put later interpretation in a maintained note.
- Riffs preserve the speaker's first-person claims and uncertainty. Clean transcription noise without converting the riff into an essay by someone else.
- Maintained notes own synthesis, comparison, and current understanding.
- Plans own proposed work, decisions, execution state, and verification evidence.

Do not silently rewrite a capture to match a later conclusion. Link the source to the maintained interpretation instead.

## Grow durable plans

Before creating a plan, use `oh list --where type=plan` and search the vault for an existing artifact that owns the outcome. Prefer extending that file to creating a parallel progress log.

A durable plan records an observable outcome, context, scope and non-goals, constraints, decisions, dependency-ordered work, verification, and recovery. Keep its frontmatter easy to query—at minimum `type: plan`, an area, and one status from `proposed`, `accepted`, `in-progress`, `blocked`, `completed`, `superseded`, or `cancelled`. Add dated findings, decisions, review evidence, and the final result to the same file as the work develops.

The packaged `plan-oh` Agent Skill provides the complete authoring workflow. It treats a plan as a growing implementation record, not a disposable checklist or a directory of satellite status documents.

## Link for meaning

Use vault-root wikilinks without `.md`, for example:

```md
The capture strategy follows [[notes/bounded-acquisition|bounded acquisition]] so incomplete threads remain visible as incomplete.
```

Use ordinary Markdown links for external URLs. Add an internal link where the relationship helps a reader understand the sentence. Do not add bare reciprocal links, manufactured `Related` lists, or links whose only purpose is to improve graph counts.

Backlinks are derived from explicit wikilinks. Never paste generated backlink sections into notes. Catalog links in `index.md` are navigation and do not establish contextual relationships. Mention candidates are prompts for review, not instructions to edit.

## Capture a source

Check the local environment and the installed adapters before relying on optional capabilities:

```sh
oh doctor
oh adapters
```

Inspect an unfamiliar source before writing it:

```sh
oh inspect https://example.com/article
oh inspect https://example.com/article --json
```

Capture a URL or the page already open in the signed-in browser:

```sh
oh clip https://example.com/article --output articles
oh clip current --browser-live --output articles
```

Review the Markdown and `capture.json` together. Preserve the recorded status, warnings, counts, acquisition attempts, and artifact outcomes. `partial` is a useful result, not a defect to hide. Do not infer thread completeness from visible prose alone.

The capture command reads content and writes a local bundle. It does not post, like, follow, send, delete, or submit on the source service.

Capture a local or public remote PDF through its separate ingestion path:

```sh
oh pdf "/absolute/path/to/document.pdf" --output articles
oh pdf "https://example.com/document.pdf" --output articles
```

Review native headings, OCR-derived text, and retained source images together.
The bundle keeps `source.pdf` byte-for-byte and never records its original
absolute path. A text-bearing screenshot still needs its source-image
reference; a useful native-text result does not hide an unprocessed image or
page.

## Finish every change

After adding, renaming, moving, or materially revising notes:

```sh
oh refresh --root .
oh graph --root .
oh check --root .
```

Review broken and ambiguous links first. Then inspect orphans and high-confidence title or alias mentions in context. Add a suggested link only when it improves the prose. Finish with a clean `oh check` and inspect the resulting diff so the managed catalog is the only derived Markdown change.

If the change adds, removes, renames, or moves a scope hub, changes its
`type` or `scope`, or edits an `oh:context` marker, also run:

```sh
oh agents identity packages/parser --json
oh agents check --root oh --repo .
```

Use `oh agents identity` when creating or moving a mapping; it derives the
canonical path and marker without writing either file. The gate checks
canonical content-derived IDs, exact repository-relative
scopes, collisions, real confined scope directories and guide files, guide
shape, and reciprocal markers. A scope move changes identity, so rename the hub
and marker together. Unmapped `AGENTS.md` files are valid.

Use the audit when reviewing instruction size or inheritance:

```sh
oh agents audit --root oh --repo .
oh agents audit --root oh --repo . --json
```

The audit adds deterministic per-guide and per-section measurements,
inherited-chain totals, long-bullet advisories, and exact duplicate-rule
advisories. Inspect them as refactoring leads. Length is not correctness, and a
rule that must be known before editing stays in `AGENTS.md` even when it is
long. Guide discovery skips common generated and vendor directories and never
follows symbolic-link directories.
