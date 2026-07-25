---
name: plan-oh
description: Create or evolve a durable Markdown plan inside a hraness/oh vault. Use when a user asks for an implementation plan, proposal, RFC, migration plan, execution audit, phased checklist, or an update to an existing plan's decisions, progress, review findings, verification evidence, or final result.
---

# Write a durable plan

Keep the plan useful before, during, and after execution. It is the coordination
record, not a disposable answer or a duplicate task tracker.

## Find the plan's owner

1. Resolve `<vault>` to the directory containing the managed `index.md`, then
   set the shell-local `OH_ROOT` to that path (`OH_ROOT=oh` from a typical
   repository root, or `OH_ROOT=.` from inside the vault). Read the vault's
   `AGENTS.md` and the nearest guide under `<vault>/plans/`. Pass that resolved
   root to every command; do not assume the starting directory is the vault.
2. Search existing plans before creating one:

```sh
oh list --root "$OH_ROOT" --where type=plan --sort area --json
oh search "the intended outcome" --root "$OH_ROOT" --json
```

If `oh` is not installed, do not let retrieval tooling block the plan: use
`rg` or the available file search over `<vault>/plans/`, titles, aliases, and relevant
terms. If the directory is not an initialized hraness/oh vault, follow the
repository's existing planning convention instead of initializing one without
being asked. Semantic search writes only a derived local cache; when that cache
location is not writable, use exact search or point `XDG_CACHE_HOME` at a
writable cache directory.

3. Update an existing plan when it already owns the outcome. Create a new file
   only for independently executable work.
4. Use `<vault>/plans/<descriptive-kebab-name>.md` unless the local guide already groups
   plans by area. Do not reorganize older plans merely to impose a new tree.

## Write from evidence

Read [the plan structure reference](references/structure.md), then tailor it to
the work. Preserve these invariants:

- State one concrete outcome and the current status.
- Record what is known, what is assumed, and what remains to discover.
- Separate in-scope work from non-goals.
- Put constraints and decisions before the steps they shape.
- Make dependencies and ordering visible.
- Give each acceptance claim a verification method.
- Include rollback or recovery when a change can leave durable state behind.

Turn a missing implementation detail into an ordered discovery gate when the
outcome and authorization are already clear and the decision can be made from
in-scope evidence. Stop and request direction when the unknown would change the
intended outcome, expand authority or external coordination, or choose between
materially different products.

Use small frontmatter. Start with `type: plan`, a kebab-case `area`, and one of
`proposed`, `accepted`, `in-progress`, `blocked`, `completed`, `superseded`, or
`cancelled`. Add `title`, `description`, `aliases`, or `tags` only when they help
humans or structured queries.

## Grow the same file during execution

- Change status when reality changes, not in anticipation.
- Check off completed work without deleting the original intent.
- Incorporate decisions, review findings, deviations, and command or test
  evidence where a future reader can understand their consequence.
- When blocked, name the exact missing condition and the safe work already
  completed.
- On completion, summarize the result and residual limits. Link reusable current
  understanding into `notes/` and move current operating truth into code or
  documentation. Retain the completed plan as history.
- Do not create separate progress, review, or completion files for the same
  plan.

## Connect and verify

Add wikilinks only where the prose explains a useful relationship. Then run:

```sh
oh refresh --root "$OH_ROOT"
oh check --root "$OH_ROOT"
```

Run those commands when the plan lives in an initialized hraness/oh vault. In a
repository-native planning directory, use that repository's own validation
instead. Review broken links first, then inspect orphan and mention advisories
in context. An independently useful plan may legitimately remain an orphan in
a new or sparse vault. Record that disposition mentally or in the task handoff;
do not manufacture links merely to improve graph counts.
