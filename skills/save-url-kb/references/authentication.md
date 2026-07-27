# Browser sessions and signed-in capture

Use the browser state already available on the machine. Choose the route that matches where the page is currently readable.

These examples assume `KB_ROOT` is the resolved vault directory containing the managed `index.md`.

## Read the current tab

When the desired page is already open and signed in, capture it in place:

```sh
kb clip current --browser-live --output "$KB_ROOT/articles"
kb clip current --cdp 9222 --output "$KB_ROOT/articles"
```

For `--browser-live`, first enable Chrome's local debugging connection at `chrome://inspect/#remote-debugging` (Chrome 144+). If Chrome was launched with an explicit loopback debugging port, pass that numeric port to `--cdp` instead. Both routes read the current HTTP or HTTPS tab, derive its URL and platform, and leave the external browser open.

Current-tab capture does not navigate, click, type, submit, upload, or scroll. Use it for feeds, inboxes, private documents, issue trackers, WhatsApp Web, and other signed-in surfaces where changing the active page would lose the view the user wants saved.

## Open a URL with profile state

Use `--browser-profile` when the tool should open a URL with existing cookies, local storage, IndexedDB, and related browser state:

```sh
kb clip https://example.com/member/article --browser-profile "$KB_CAPTURE_PROFILE" --output "$KB_ROOT/articles"
kb clip https://example.com/member/article --browser-profile "Work" --output "$KB_ROOT/articles"
```

A path-backed profile is copied to a private temporary browser snapshot before navigation. The copy keeps the selected profile data and Chromium `Local State`, omits caches and lock files, runs as the owned capture session, and is deleted afterward. Page activity therefore does not change the source profile.

A profile display name delegates selection to the browser helper. Use a path when an exact profile directory matters.

URL-based browser capture can navigate to the requested page and scroll within fixed limits, taking bounded observations so loaded replies or timeline entries become visible. It never invokes account actions or submits forms.

## Reuse an attached browser for a URL

When an existing browser should navigate to a specific URL instead of preserving the current tab, use the URL form:

```sh
kb clip https://example.com/member/article --browser-live --output "$KB_ROOT/articles"
kb clip https://example.com/member/article --cdp 9222 --output "$KB_ROOT/articles"
```

The external browser remains open. Choose `kb clip current` instead when the already-open view is the source of truth.

## Use cookies for HTTP, assets, or media

Cookie-backed HTTP capture is useful when the source does not depend on browser-only state:

```sh
kb clip https://example.com/member/article --cookie-source chrome --cookie-profile "Default" --output "$KB_ROOT/articles"
kb clip https://example.com/member/article --cookie-source firefox --cookie-profile "work" --output "$KB_ROOT/articles"
kb clip https://example.com/member/article --cookies-file "$KB_COOKIES_FILE" --output "$KB_ROOT/articles"
```

Supported cookie sources include Chrome, Arc, Brave, Chromium, Edge, Firefox, and Safari. Select one cookie source or one cookie file per command. Cookie-Editor JSON and Netscape files retain domain and path metadata; a bare Cookie header or Copy-as-cURL file is narrowed to the captured host and path.

An attached browser's session state stays in that browser. Combine its capture with one explicit cookie input when later image or media downloads also need the same signed-in access:

```sh
kb clip current --browser-live --cookie-source chrome --cookie-profile "Default" --media all --output "$KB_ROOT/articles"
```

The output bundle records which acquisition lanes ran, but it does not include cookie values, browser-profile files, or attached browser state.

## Import a page saved by the browser

Saved HTML is a useful fallback for any page the browser can render:

```sh
kb clip https://example.com/member/article --html "$KB_SAVED_HTML" --output "$KB_ROOT/articles"
kb clip https://example.com/member/article --html - --output "$KB_ROOT/articles" < page.html
```

The URL remains the provenance anchor while the saved file supplies the page representation. Review the resulting manifest because a saved document cannot prove whether unloaded or virtualized content existed outside that representation.
