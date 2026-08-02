# Durable plan structure

Use the smallest version that still makes execution and verification
unambiguous. Omit empty optional sections; do not pad a small change into a
program document.

## Frontmatter

```yaml
---
title: Descriptive outcome
description: One sentence naming the change and dominant result.
type: plan
area: product-or-system
status: proposed
repository_scopes:
  - packages/example
aliases:
  - Short plan name
tags:
  - migration
---
```

`type`, `area`, `status`, and a non-empty description are the stable plan query
surface. Use a kebab-case `area`. Add `repository_scopes` when the plan owns
repository work; each entry is one exact canonical repository-relative file or
directory path, without globs. Omit the field for plans with no code-path
ownership. Tags are optional facets, not a replacement for prose or links.

## Core sections

```md
# Descriptive outcome

## Outcome

What will be true when this plan succeeds. Prefer observable behavior over a
list of files to edit.

## Context

The present state, evidence, and reason the change is needed. Link the notes,
captures, code, or prior plans that carry necessary context.

## Scope

### In scope

- Work required for the outcome.

### Non-goals

- Adjacent work deliberately excluded.

## Constraints and decisions

- Constraints that shape the implementation.
- Decisions already made and why.
- Open questions whose answers can change the plan.

## Plan

1. A dependency-ordered phase with its concrete output.
2. The next phase and its gate from the prior phase.

## Verification

- Behavior or invariant → exact check, test, observation, or evidence.

## Risks and recovery

- Failure mode → prevention, detection, and rollback or recovery.
```

## Sections that grow with the work

Add these when execution starts:

```md
## Execution evidence

- YYYY-MM-DD — Result, command or artifact, and what it proved.

## Review findings

- Finding, disposition, and resulting plan or implementation change.

## Result

What shipped or why work stopped, what was verified, and what intentionally
remains.

## Durable memory

Link each reusable conclusion to the maintained note, guide, documentation, or
checked code contract that now owns it. If no conclusion warrants promotion,
state that no durable promotion was needed and explain why.
```

Keep evidence compact but reproducible. A test name, checked invariant, or link
to an artifact is stronger than “validation passed.” Preserve superseded
decisions when they explain the final shape; mark their disposition instead of
silently deleting them. Require both Result and Durable memory when the status
becomes `completed`, `superseded`, or `cancelled`.
