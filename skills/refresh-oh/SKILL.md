---
name: refresh-oh
description: Refresh and validate a hraness/oh Markdown vault after notes or repository-context mappings change. Use when an agent needs to update the managed catalog, inspect graph findings, validate scope hubs and reciprocal guide markers, review deterministic agent-guide advisories, or complete a vault health check.
---

# Refresh a knowledge base

Use a refresh-review-check loop. Keep authored prose under deliberate editorial control; only the marked catalog region is tool-owned.

## 1. Locate the vault

- Resolve `<vault>` to the directory containing the managed `index.md`, then
  set the shell-local `OH_ROOT` to that path (`OH_ROOT=oh` from a typical
  repository root, or `OH_ROOT=.` from inside the vault).
- When the change concerns `scopes/` or an `oh:context` marker, resolve the
  repository root and set `OH_REPO` to that path (`OH_REPO=.` from the
  repository root).
- Read the vault's applicable agent instructions and note conventions before editing.
- Preserve note voice, frontmatter, filenames, and link intent unless a reported finding justifies a specific change.

## 2. Refresh the managed catalog

Run:

```sh
oh refresh --root "$OH_ROOT"
```

This command atomically updates only the marked catalog region in `index.md` and reports graph findings. Catalog links are navigation, so they do not count as contextual graph edges.

## 3. Review the advisories

Open every reported source line and the relevant target notes before deciding whether to edit.

- Repair a broken wikilink only when its intended target is clear. Otherwise, report the uncertainty.
- Disambiguate a wikilink with a vault-root path only after confirming the author's intent.
- Treat a contextual orphan as a prompt to inspect the note, not as a demand to add a link.
- Treat an unlinked title or alias mention as a candidate, not proof that the sentence should link.
- Add a contextual wikilink only when it improves the meaning or navigation of the sentence.

Backlinks are derived from explicit contextual wikilinks, and mention candidates are derived analysis. Never inject reciprocal links or generated backlink sections to improve graph counts. Never mutate authored prose automatically or apply link suggestions mechanically in bulk.

Intentional orphans and unlinked mentions may remain. Record the reason instead of manufacturing a connection.

## 4. Validate changed repository-context mappings

If the change adds, removes, renames, or moves a scope hub, changes its
`type` or `scope`, or edits an `oh:context` marker, run:

```sh
oh agents identity "<repository-scope>" --json
oh agents check --root "$OH_ROOT" --repo "$OH_REPO"
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
oh agents audit --root "$OH_ROOT" --repo "$OH_REPO"
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
oh check --root "$OH_ROOT"
```

Finish only when the graph check and any required agent-context check succeed,
the managed catalog is current, and broken or ambiguous links are resolved.
Summarize deliberate link edits, mapping changes, and advisories intentionally
left in place.
