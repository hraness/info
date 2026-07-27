# Contents

- `SKILL.md` – capture triggers, command surface, workflow, and verification contract.
- `references/` – platform routing and authentication safety guidance.
- `agents/openai.yaml` – user-facing skill metadata.

# Guidelines

- Invoke the installed `kb` CLI; do not depend on a source checkout or implementation path.
- Preserve missing, blocked, deleted, cyclic, paginated, and limit-boundary states in every report.
- Keep public APIs, HTTP, cookies, browser rendering, media, and evidence as independent fallbacks with auditable attempts.
- Never claim a thread or discussion is complete when declared counts, cursors, pagination nodes, or configured bounds disagree.
- Keep credentials in memory, user-owned private files, or short-lived mode-`0600` operating-system temporary files. Never place cookies, authorization values, browser state, authenticated raw DOM, or HARs in capture artifacts.
- Capture only public or user-entitled content. Do not bypass access controls, CAPTCHA, rate limits, DRM, or platform policy.
- Treat screenshots as potentially private evidence because pixels are not structurally sanitized.
- Verify the installed environment with `kb doctor` and the current platform matrix with `kb adapters`.
