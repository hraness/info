# Platform routing

Use the strongest available read route, then describe exactly what it retained. Every route is bounded by item count, tree depth, time, HTML bytes, per-asset bytes, and aggregate asset bytes.

| Surface | Preferred route | Conversation behavior | Honest limit |
| --- | --- | --- | --- |
| Generic articles and papers | Structured data or HTTP + Defuddle; rendered browser fallback | Captures the page body and any comments present in that representation | JavaScript-only or unusual layouts can remain partial |
| X | Defuddle X extraction plus rendered text; current tab or profile for signed-in views | Preserves the root post, quote context, visible metrics, media, and loaded replies | Virtualized or unloaded replies remain partial |
| Substack | HTTP + Defuddle; signed-in current tab or profile for subscriber text | Preserves the article plus visible rendered discussion context | Email/app-only or virtualized comments can be absent; rendered comments keep conservative counts |
| Hacker News | Official Firebase item API | Recursively preserves ordered comments, deleted/dead nodes, cycles, and configured boundaries | Item and depth bounds remain explicit in the manifest |
| Bluesky | Public AT Protocol handle resolution and `getPostThread` | Preserves parents, replies, quotes, images, video, links, and unavailable records exposed by the service | Thread item and depth bounds remain explicit |
| Reddit | Public listing JSON when available, then rendered page + Defuddle fallback | Preserves bounded nesting, deletion markers, and `more` or pagination boundaries | Denied or changed JSON falls back; incomplete branches remain partial |
| GitHub issues, pull requests, and discussions | Defuddle GitHub extractor; current signed-in tab for private repositories | Preserves the loaded issue, PR, discussion, comments, reviews, and visible timeline context | Collapsed or paginated timeline history remains partial |
| Discourse topics | Defuddle Discourse extractor; rendered fallback for signed-in or application-rendered topics | Preserves the topic and loaded posts | Long, virtualized, or not-yet-loaded topics remain partial |
| Threads | Current tab, rendered profile, or saved HTML | Preserves rendered posts and replies as page context | Virtualized or unloaded replies remain partial; no dedicated item tree is claimed |
| WhatsApp Web | Current signed-in tab; rendered profile when opening a URL is useful | Preserves the open conversation as rendered page context | Older virtualized messages outside the loaded view remain partial |
| YouTube | HTTP + Defuddle or rendered browser, plus yt-dlp context unless media is disabled | Preserves available title, description, duration, channel, local thumbnail, one exact-language transcript, and loaded page context; full audio/video is opt-in with `--media all` | Missing transcripts, unloaded comments, and member regions outside the selected representation remain explicit |
| Instagram, Facebook, LinkedIn, and TikTok | Current tab, rendered profile, or saved HTML; yt-dlp for accessible media | Preserves the loaded post, caption, visible discussion, inline images, and exposed video poster or thumbnail | Lazy loading, collapsed branches, and virtualization remain partial |
| Other signed-in pages, feeds, inboxes, and private documents | Current tab first; temporary path-backed profile copy when the tool should open a URL; cookie-backed HTTP or saved HTML when sufficient | Preserves the content rendered by the selected source surface | Content outside the current loaded representation is not inferred |

Run `kb adapters --json` when software needs the installed capability matrix. Platform markup and routes change; a successful rendered fallback does not upgrade a partial tree to `complete` unless declared counts, cursors, and boundaries agree.

For foreign structured data, parse from `unknown`. Keep missing, deleted, blocked, cyclic, depth-limited, item-limited, and pagination-boundary nodes visible instead of dropping them. For generic rendered discussions, retain the visible prose but use conservative item counts rather than inventing a thread structure.

Clipping remains ingestion-only across every surface. Adding support means adding a structured reader, HTML extractor, fixture, or generic rendered fallback—not post, reply, reaction, follow, send, delete, or form-submission behavior.
