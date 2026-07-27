# Capture web content

`kb clip` saves public and signed-in web content as an auditable Markdown bundle. It combines bounded structured adapters, HTTP extraction, browser rendering, localized assets, and explicit completeness metadata.

## Check local capabilities

Run the diagnostics before using browser state, PDF ingestion, or video capture:

```sh
kb doctor
kb adapters
```

`kb doctor --json` reports the installed runtime, extraction dependencies,
browser support, profile display names, yt-dlp, ffmpeg, Poppler
(`pdfinfo` and `pdftohtml`), and Tesseract. The Poppler pair is required by
`kb pdf`; Tesseract adds local OCR for scans and screenshots.
`kb adapters --json` returns the current platform capability matrix.

## Capture or inspect a page

```sh
kb clip https://example.com/article
kb inspect https://example.com/article
kb inspect https://example.com/article --json
```

The default route tries stable public structured data when available, bounded HTTP extraction, and a rendered browser when the platform or result requires one. Inspection returns the selected Markdown and capture report without writing artifacts.

By default, a capture writes `kb/articles/<slug>/`:

```text
<slug>/
  <slug>.md
  capture.json
  assets/
  evidence/       # only when requested
```

The Markdown records source and capture metadata. `capture.json` records the acquisition attempts, selected extractor, scope, status, item counts, warnings, asset hashes, and requested artifact outcomes. Writes stage beside the target and install with an atomic rename. `--force` replaces only a compatible clip-owned bundle and restores the previous bundle if installation fails.

Set `KB_CLIP_OUTPUT` to change the default output root, or pass `--output <directory>` for one command. Set `KB_CLIP_USER_AGENT` or pass `--user-agent <value>` to override the default request user agent.

## Select acquisition and scope

```sh
kb clip https://example.com/article --mode http
kb clip https://example.com/application --mode browser
kb clip https://example.com/post --scope page
kb clip https://example.com/post --scope thread
kb clip https://example.com/discussion --scope comments
```

`auto` is the normal acquisition mode. `http` disables browser fallback. `browser` requires rendered state. Saved HTML can be imported without browser automation:

```sh
kb clip https://example.com/article --html "$KB_SAVED_HTML"
kb clip https://example.com/article --html - < page.html
```

Default resource bounds are 30 seconds per request, process, or extraction operation; 500 scoped items; depth 16; 25 MB of HTML; 100 MB per asset; and 500 MB across assets. Browser observation also has fixed DOM and scroll ceilings. Reaching a bound is recorded and can downgrade a result to `partial`.

## Capture images, media, and evidence

```sh
kb clip https://example.com/article --media none
kb clip https://example.com/article --media images
kb clip https://example.com/video --media all
kb clip https://example.com/article --evidence source
kb clip https://example.com/article --evidence screenshot
kb clip https://example.com/article --evidence all
```

Image downloads are signature-checked, content-addressed, byte-bounded, and
rewritten to relative bundle paths. Failed images remain inert links. Video
posters and thumbnails exposed by the page are localized without downloading
the full video.

For YouTube, the normal capture route uses yt-dlp to retain the title,
description, duration, channel, thumbnail, and one exact-language transcript
when those fields are available. Full audio/video download remains opt-in:
`--media all` invokes yt-dlp for accessible media, and ffmpeg may be required
for merging or remuxing.

Source evidence is sanitized into inert HTML with credential-shaped values redacted and a deny-all content security policy. Screenshots are viewport-only pixels and are not structurally sanitized. They may contain private content or notifications, so review them before retaining or sharing a bundle.

## Capture a signed-in page

If the page is already open, read the current tab without navigating it:

```sh
kb clip current --browser-live
kb clip current --cdp 9222
```

For `--browser-live`, first enable Chrome's local debugging connection at `chrome://inspect/#remote-debugging` (Chrome 144+). If Chrome was launched with an explicit loopback debugging port, pass that numeric port to `--cdp` instead.

To open a URL with existing browser state, select a profile name or path. Path-backed profiles run from a temporary copy, so the source profile is unchanged:

```sh
kb clip https://example.com/member/article --browser-profile "$KB_CAPTURE_PROFILE"
```

Cookie-backed HTTP capture is useful when the page does not require local storage, IndexedDB, or other browser-only state:

```sh
kb clip https://example.com/member/article --cookie-source chrome --cookie-profile "Default"
kb clip https://example.com/member/article --cookies-file "$KB_COOKIES_FILE"
```

Choose at most one browser session and one cookie input. A browser session may use a separate cookie input for later asset or media downloads because attached browser state is not exported.

Current-tab capture issues no navigation, click, form, typing, upload, or submit command. URL-based browser capture may navigate and scroll within fixed work limits, taking bounded observations as content is rendered. Both routes are ingestion-only: they do not post, like, follow, send, delete, or submit.

## Interpret status and counts

Capture status is one of:

- `complete`: the selected bounded representation was acquired without a known missing boundary.
- `partial`: useful content was retained, but a count, cursor, configured bound, hidden branch, or generic rendered representation prevents a completeness claim.
- `auth-required`: the selected routes reached an authentication gate.
- `blocked`: the source returned a block or verification shell.
- `unsupported`: no route produced a usable representation.

For page scope, counts cover primary entries. For thread and comment scopes, counts cover replies or comments and exclude roots, quotes, ancestors, and pagination markers. Generic rendered conversations often report `capturedItems: 0` because visible prose does not prove a trustworthy per-item tree.

A `complete` or `partial` capture exits with status 0. Authentication, blocked, and unsupported outcomes use status 3. Argument errors use status 2, environment diagnostic failures use status 4, and operational errors use status 1. Automation should inspect the structured status and warnings rather than relying only on the process exit code.

## Platform routes

- Hacker News uses the official Firebase item API for bounded recursive discussions.
- Bluesky uses public AT Protocol resolution and thread APIs.
- Reddit first tries its unofficial public listing JSON and falls back when that surface is denied or changes.
- X uses article extraction plus rendered capture; unloaded or virtualized replies remain partial.
- Substack uses article extraction and a signed-in browser for subscriber text when selected.
- GitHub issues, pull requests, and discussions use the Defuddle GitHub extractor, with a signed-in browser fallback for private repositories.
- Discourse topics use the Defuddle Discourse extractor and rendered fallback.
- YouTube adds bounded yt-dlp video context—title, description, duration,
  channel, thumbnail, and an available exact-language transcript—to HTTP or
  rendered page capture. Full audio/video remains opt-in with `--media all`.
- Instagram, Facebook, LinkedIn, TikTok, Threads, WhatsApp Web, and arbitrary
  applications use rendered or saved-HTML capture. They do not gain a
  trustworthy item tree without a dedicated adapter.

Platform markup and endpoints change. Run `kb adapters` for the installed version's current claims.
