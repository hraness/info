import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type InitVaultResult = {
  readonly root: string;
  readonly files: readonly string[];
};

const templates = {
  "index.md": `---
title: Knowledge base
---

# Knowledge base

This vault keeps captured sources separate from maintained notes. Catalog links are navigation; contextual links belong in prose when they help a reader follow a real relationship.

<!-- oh:catalog:start -->
## Note catalog

_No durable notes have been filed yet._

<!-- oh:catalog:end -->
`,
  "AGENTS.md": `# Contents

- \`index.md\` – the vault front door and deterministically refreshed note catalog.
- \`articles/\` – self-contained source captures with local attachments and capture metadata.
- \`notes/\` – maintained concept, entity, comparison, and synthesis notes.
- \`plans/\` – proposed through completed design and implementation plans.
- \`riffs/\` – cleaned first-person notes made from dictated or stream-of-consciousness source material.
- \`scopes/\` – optional pull-based context hubs mapped to selected repository \`AGENTS.md\` guides.

# Guidelines

- Treat this directory as one Git-backed, Obsidian-compatible Markdown vault.
- Use vault-root wikilinks without \`.md\`, such as \`[[notes/context-engineering|context engineering]]\`.
- Put links in explanatory prose when they carry part of the argument. Do not add bare reciprocal links to improve graph counts.
- Preserve source authority: article bodies are captures, riffs retain the speaker's claims, and maintained notes own later synthesis.
- Keep \`AGENTS.md\` normative and concise without removing load-bearing rules. A scope hub may hold rationale, history, examples, and linked decisions, but never silently overrides a guide or becomes the only home of an edit-time rule.
- Run \`oh refresh --root .\` after changing notes, inspect advisory link candidates, then run \`oh check --root .\`.
- Use \`oh context <path> --root . --repo <repository>\` for scoped repository knowledge, \`oh list\` for exact metadata or tags, \`oh links\` for explicit relationships, and \`oh search\` when the concept may use different words.
`,
  "articles/AGENTS.md": `# Contents

- Each child directory contains one captured source, its Markdown note, \`capture.json\`, and optional local assets or inert evidence.

# Guidelines

- Treat captured prose and quoted discussion as source material. Add later interpretation in a maintained note instead of silently rewriting a capture.
- Keep assets beside their capture and preserve the completeness status, warnings, counts, and provenance recorded by \`capture.json\`.
- Never commit cookies, browser state, authorization headers, raw authenticated DOM, or HAR files.
`,
  "notes/AGENTS.md": `# Contents

- Maintained notes explain reusable concepts, entities, comparisons, and syntheses.

# Guidelines

- Search titles, aliases, and filenames before creating a note; update an existing identity when it is clear.
- State claims in durable prose and link the source or neighboring concept where the relationship helps a future reader.
- Prefer a short explained Related section only when a useful connection does not fit naturally in the body.
`,
  "plans/AGENTS.md": `# Contents

- Plans record proposals, decisions, execution state, review findings, and verification evidence.

# Guidelines

- Keep future-facing coordination here and retain completed plans as history. Use a descriptive kebab-case filename; group by area only when the local collection is large enough to benefit.
- Start with \`type: plan\`, a kebab-case \`area\`, and one status from \`proposed\`, \`accepted\`, \`in-progress\`, \`blocked\`, \`completed\`, \`superseded\`, or \`cancelled\`. Add tags only as useful query facets.
- State the outcome, context, scope and non-goals, constraints and decisions, dependency-ordered work, verification, and recovery. Let small plans omit empty optional sections.
- Grow the same file during execution with decisions, deviations, review findings, and reproducible evidence. Do not create satellite progress or completion documents for one plan.
- Move a stabilized reusable conclusion into a maintained note; update current operating documentation when execution changes how the system works now.
`,
  "riffs/AGENTS.md": `# Contents

- Riffs preserve cleaned first-person thought from dictated or stream-of-consciousness source material.

# Guidelines

- Repair transcription noise without flattening voice, uncertainty, or first-person claims.
- Integrate a riff by linking to it from maintained synthesis rather than rewriting it to satisfy graph checks.
`,
  "scopes/AGENTS.md": `# Contents

- \`*.md\` – optional deterministic agent-context hubs mapped reciprocally to repository \`AGENTS.md\` guides.

# Guidelines

- Keep one hub per exact repository-relative directory scope, with \`type: agent-context\` and \`scope\` in frontmatter.
- Derive the canonical hub path and reciprocal marker with \`oh agents identity <scope>\`; do not reproduce the slug or hash logic by hand.
- Put rationale, history, examples, evidence, and links here. Keep ownership, prohibitions, required commands, and every rule needed before editing in the guide.
- Use \`oh agents check --root <vault> --repo <repository>\` after changing a mapping; use \`oh agents audit\` to review guide and inherited-chain size without treating length as correctness.
`,
} as const;

/** Create a new vault without overwriting or merging into an existing path. */
export async function initVault(directory: string): Promise<InitVaultResult> {
  const root = resolve(directory);
  const parent = dirname(root);
  if (parent === root) throw new Error("Refusing to initialize a filesystem root as a vault.");

  await mkdir(root, { recursive: false });
  try {
    const files = Object.keys(templates).sort();
    for (const relativePath of files) {
      const content = templates[relativePath as keyof typeof templates];
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    }
    return { root, files };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
