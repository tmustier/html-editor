# Changelog

All notable changes to `pi-html` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-05-17

Initial tagged release of the local HTML collaboration editor.

### Editing

- Click-to-edit text on paragraphs, headings, list items, and table cells.
- Inline-mixed editing preserves `<b>`, `<code>`, `<a>`, and similar inline tags.
- SVG label editing preserves `<tspan>` formatting when the edit stays within
  one segment; falls back to plain text and warns on cross-segment edits.
- `F2`, `Enter`, `E`, and double-click all enter edit mode. `Cmd+Enter` saves,
  `Esc` cancels.
- Removed the dashed orange "editing" outline; the toolbar `EDITING` badge is
  now the explicit signal.

### Move + resize

- Drag the selection border to reorder HTML blocks; corner/edge handles still
  resize HTML elements with `width` / `height` / `max-width: none`.
- SVG groups can be repositioned spatially via the toolbar drag handle.
- Selection box hides border-drag zones during an active drag and during text
  editing.

### Tables and grids

- Plain arrow keys navigate cells in tables/grids when a cell is selected.
- `Cmd+Arrow` jumps to the edge of the current row/column (Excel-style).
- `Tab` / `Shift+Tab` walks cells in document order; while editing, it commits
  the current cell first.
- `Option+Arrow` keeps DOM-structural navigation (parent / first child /
  previous / next sibling).

### Clipboard

- `Cmd+C` copies the selected text box or table cell as both `text/plain` and
  sanitised `text/html`.
- `Cmd+V` prefers rich HTML and strips `data-edit-id` to avoid duplicate ids;
  plain-text paste into a single-pill cell preserves the badge wrapper and
  updates known status classes (`shipped`, `partial`, `next`, `deferred`).
- `Cmd+C` no longer falls through to the comment shortcut.

### Undo / redo

- `Cmd+Z` / `Cmd+Y` / `Cmd+Shift+Z` undo and redo the last saved edit, move,
  or resize. History is snapshotted on disk and persists across reloads.

### Comments

- Per-element comments stored in a sidecar `<file>.comments.json`.
- Sidebar list with copy/refresh/collapse controls and inline dot markers.
- Comments can be routed back to the Pi session that launched the server via
  `HTML_EDITOR_COMMENTS_BRIDGE` (per-session JSONL bridge file).
- Server flag `--comments-bridge <path|none>` overrides routing explicitly.
- Legacy shared `/tmp/html-editor-comments.jsonl` broadcast file is no longer
  used or written to.

### Pi integration

- New `extensions/html-editor-comments.ts` packaged as part of the repo.
- `package.json` declares a Pi package manifest:
  `"pi": { "extensions": ["./extensions/html-editor-comments.ts"] }`.
- Installable with `pi install git:github.com/tmustier/pi-html` (or local
  paths). The extension exports a per-session bridge path so any editor
  server launched from that Pi session receives in-browser comments
  automatically as user messages.

### Server architecture

- Thin `serve.py` launcher; real logic lives in `server/{app,routes,document,history,comments,assets}.py`.
- All BeautifulSoup mutations live in `server/document.py` as pure
  `(ok, payload)` functions; routes are thin JSON glue.

### Client architecture

- Native ES modules under `client/*.js`; no bundler, no transpiler.
- Modules split by concern: state, config, api, interaction helpers, DOM,
  semantic targets, events, editing, drag, comments, init.
- Styles split into numbered CSS files concatenated at serve time.

### Tests

- 65 Python unit tests covering `server/document.py`, `server/comments.py`,
  and `server/history.py`.
- 35 Playwright e2e tests across boot, HTML text editing, SVG editing,
  undo/redo, comments, move/resize, and keyboard navigation.
- `scripts/check.sh` runs unit tests + JS syntax check.
- `scripts/test.sh` runs unit + e2e; supports `--fast` and `--ui`.

### Licensing

- MIT licensed.
