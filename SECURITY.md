# Security

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/hraness/kb/security/advisories/new). Do not include sensitive details, credentials, private capture content, or raw HAR files in a public issue.

Security fixes target the latest version tag. Maintainers will coordinate disclosure and publish a new immutable release when a fix is ready.

## Capture security model

hraness/kb treats every URL, redirect, response, browser page, cookie record, process output, and filesystem path as untrusted input.

- Controlled HTTP, structured-data, asset, owned-browser, and media lanes deny private, reserved, and locally assigned network addresses by default. DNS is validated and the accepted address is pinned for the request.
- Owned browser and media subprocesses use a filtering loopback proxy with bounded time, bytes, output, and cleanup.
- Cookie stores are read only when the user selects one. Matching cookies stay in memory, except for a short-lived host-pinned mode-`0600` yt-dlp jar.
- Markdown, manifests, terminal output, URLs, and optional source evidence pass through credential and active-content sanitizers before persistence.
- Capture bundles stage in an owned directory and install atomically. Replacement requires `--force` and a compatible clip manifest.

Attached live or CDP browser sessions keep their existing network stack. `kb clip current` reads the active tab without navigation or interaction and leaves the browser open. A URL-based attached capture can navigate and scroll within the configured bounds, taking bounded observations as content is rendered.

Screenshots are not structurally sanitized. They can contain private text, account names, notifications, or other personal data as pixels. Treat every screenshot and authenticated capture as sensitive until reviewed.

## Responsible use

Use capture only for public content or content you are entitled and permitted to automate. Do not use hraness/kb to bypass login, paywall, CAPTCHA, rate-limit, DRM, audience, or platform-policy controls, or to access another person's private data.

When reporting a vulnerability, include the affected version, operating system, command shape with secrets replaced, observed result, and a minimal synthetic reproduction when possible.
