---
name: tool-master
description: Operational manual for OpenChat's own tools — exact behaviors, limits, failure modes, and decision rules for bash, python, web_search/fetch/crawl, file operations, view_image, read_output, and load_skill. Load before complex multi-tool work or when a tool call behaves unexpectedly.
---

# Tool Master — OpenChat tool manual

Everything below is verified behavior of this deployment, not generic advice.

## Environment (bash / python / fs tools share one sandbox)

- Tools run inside a per-session Docker container. Your workspace is mounted
  at `/workspace` and it is the CWD. **Host absolute paths do not exist
  inside** — never try `/root/...`; use workspace-relative paths everywhere.
- Network access IS allowed (pip, curl, git all work).
- Preinstalled: python3.12, pip, git, ripgrep (`rg`), jq, unzip, httpie,
  playwright + chromium (for rendering/screenshots). NOT preinstalled: pandas,
  numpy, node — `pip install` what you need (it persists for the session).
- `PAGER=cat`, so commands like `git log` print directly.
- Timeouts kill the process and return partial output marked
  `[timed out after Ns]`: bash 45s, python 30s, web_fetch 45s, web_crawl 60s,
  fs ops 30s. For longer jobs run `nohup ... &` in background and poll.
- Very large outputs are archived in full and replaced by a receipt like
  `[bash · ok · 78.9KB · full copy: read_output {"id": 42}]` — retrieve with
  `read_output`. Truncation is TAIL-biased for bash/python (the end, where
  errors appear, is kept) and HEAD-biased for read_file/web_*.
- A timeout or user abort restarts the container; the workspace volume
  survives, installed pip packages may reset.

## Per-tool notes

### bash
- Multi-line scripts OK via heredoc. stderr arrives in a separate `[stderr]`
  block; non-zero exits are reported explicitly — treat them as signal, not noise.
- Prefer `rg` over grep, `jq` for JSON. Don't `cat` big files — range them
  (`sed -n '1,80p'`) or you burn your own context.

### python
- Same sandbox, `python3 -c`, state does NOT persist between calls — write a
  `.py` file and run it when logic must survive across steps.

### web_search
- DuckDuckGo top 10: title / url / snippet. Snippets are teasers — fetch the
  page for substance before drawing conclusions.

### web_fetch
- Single page fetcher (Scrapling). Engines: `http` (default, fast static),
  `stealth` (Cloudflare/Turnstile), `dynamic` (JS rendering). Escalate in that
  order only after the cheaper one fails.
- Options: `selector`+`selector_type` (css/xpath/text/regex) for extraction,
  `extract_format` (markdown default), `wait_for` selector, `adaptive`
  relocation, `screenshot: true` writes a PNG into the workspace you can
  `view_image`.

### web_crawl
- Multi-page spider: `start_urls`, `crawl_type follow_links|sitemap`,
  `link_pattern` regex filter, `max_pages` (default 10), `concurrency`.
- Results land in `<output_file>` (default `crawl_results.json`) in the
  workspace — read it with read_file afterwards. Use for documentation sites /
  many pages; use web_fetch for one page.

### read_file / write_file / patch_file
- read_file pages by lines: `offset` is 1-based; honor the trailing hint
  `[showing lines X-Y of Z total; use offset=... ]` instead of guessing.
- write_file ALWAYS overwrites the whole file (parents auto-created) — use it
  for new files or full rewrites only.
- patch_file replaces an exact string that must occur EXACTLY ONCE: 0 matches
  → re-read the region (whitespace differs); >1 match → include more surrounding
  lines to disambiguate. Always read_file before patching; after two failed
  patches, stop and re-read rather than guessing again.

### view_image
- The only way to SEE pixels: attachments (markers like
  `[첨부 이미지: uploads/x.png · 240KB]`), screenshots, generated charts.
  Path is workspace-relative; formats PNG/JPEG/GIF/WebP detected by content;
  5MB limit (downscale bigger ones first).

### read_output
- `{"id": <number>, "offset": <1-based line>, "limit": <lines>}` — retrieves
  archived outputs referenced by receipts. Session-scoped; old ones are pruned.

### load_skill
- Call when a task matches a skill's description in `<available_skills>`;
  the full instructions arrive as `<skill_content>`.

## Decision rules

1. Read → modify → verify by re-reading. Never blind-patch.
2. Independent calls (multiple searches, several reads) go in ONE turn,
   parallel; dependent calls wait for results.
3. Snippet insufficient → web_fetch that URL. Many pages → web_crawl once.
4. Building UI/HTML? screenshot it and view_image — judge what rendered, not
   what you intended.
5. Unexpected tool behavior? Check this manual's limits above before retrying
   blindly (timeout vs error vs truncation have different remedies).
