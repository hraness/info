---
name: refresh-kb
description: Refresh and validate a hraness/kb Markdown and Datalog knowledge graph after notes, concepts, typed relationships, or repository-context mappings change. Use when an agent needs to update the managed catalog, inspect graph and percolation findings, validate scope hubs and reciprocal guide markers, or complete a vault health check.
---

# Refresh a knowledge base

Use a refresh-review-check loop. Keep authored prose under deliberate editorial control; only the marked catalog region is tool-owned.

## 1. Locate the vault

- Resolve `<vault>` to the directory containing the managed `index.md`, then
  set the shell-local `KB_ROOT` to that path (`KB_ROOT=kb` from a typical
  repository root, or `KB_ROOT=.` from inside the vault).
- When the change concerns `scopes/` or an `kb:context` marker, resolve the
  repository root and set `KB_REPO` to that path (`KB_REPO=.` from the
  repository root).
- Read the vault's applicable agent instructions and note conventions before editing.
- Preserve note voice, frontmatter, filenames, and link intent unless a reported finding justifies a specific change.

## 2. Refresh the managed catalog

When several agents are still editing different notes, do not refresh the
shared catalog in each lane. Validate the lane's Markdown and graph facts with:

```sh
kb check --root "$KB_ROOT" --no-catalog
```

The integrating agent performs the refresh once after the lanes join.

Run:

```sh
kb refresh --root "$KB_ROOT"
```

This command atomically updates only the marked catalog region in `index.md` and reports graph findings. Catalog links are navigation, so they do not count as contextual graph edges.

## 3. Review the advisories

Open every reported source line and the relevant target notes before deciding whether to edit.

- Repair a broken wikilink only when its intended target is clear. Otherwise, report the uncertainty.
- Repair a broken or ambiguous typed relationship only after confirming its exact canonical target and predicate from the source note.
- Disambiguate a wikilink with a vault-root path only after confirming the author's intent.
- Treat a contextual orphan as a prompt to inspect the note, not as a demand to add a link.
- Treat an unlinked title or alias mention as a candidate, not proof that the sentence should link.
- Add a contextual wikilink only when it improves the meaning or navigation of the sentence.

Backlinks are derived from explicit contextual wikilinks and typed
relationships. Mention and percolation candidates are derived analysis. Never
inject reciprocal, transitive, or similarity-derived relationships or generated
backlink sections to improve graph counts. Never mutate authored prose
automatically or apply suggestions mechanically in bulk.

Run a bounded percolation review for each materially changed note:

```sh
kb percolate "<changed-note-id>" --root "$KB_ROOT" --limit 25 --json
```

Open the cited notes before deciding whether to create a reusable
`type: concept` note or a source-owned typed relationship.

Intentional orphans and unlinked mentions may remain. Record the reason instead of manufacturing a connection.

## 4. Validate changed repository-context mappings

If the change adds, removes, renames, or moves a scope hub, changes its
`type` or `scope`, or edits an `kb:context` marker, run:

```sh
kb agents identity "<repository-scope>" --json
kb agents check --root "$KB_ROOT" --repo "$KB_REPO"
```

Use the non-mutating identity command to derive the hub path and exact marker
when creating or moving a mapping. The check command verifies canonical IDs,
exact repository-relative
directory scopes, collisions, repository confinement, real scope directories
and guide files, guide shape, and reciprocal markers. A moved scope has a new
identity, so update the hub filename and guide marker together. An unmapped
`AGENTS.md` is valid.

Use the audit when the change affects guide structure, inheritance, or repeated
rules:

```sh
kb agents audit --root "$KB_ROOT" --repo "$KB_REPO"
```

The audit runs the correctness checks and adds deterministic per-guide,
per-section, inherited-chain, long-bullet, and exact-duplicate advisories.
Review each advisory in context. Length is not correctness: do not move a
load-bearing ownership rule, prohibition, command, invariant, or gate out of
`AGENTS.md` merely to satisfy a suggested budget. Guide discovery skips common
generated and vendor directories and never follows symbolic-link directories.

## 5. Re-refresh and check

After any note or link edit, run the refresh command again so the catalog and advisories reflect the final content. Then run the read-only gate:

```sh
kb check --root "$KB_ROOT"
```

Finish only when the graph check and any required agent-context check succeed,
the managed catalog is current, and broken or ambiguous links and relationships
are resolved. Summarize deliberate concept, relationship, link, and mapping
edits plus advisories intentionally left in place.
