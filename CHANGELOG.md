# Changelog

All notable changes to `html-editor` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Semantic Versioning](https://semver.org/).

## 0.1.7 — 2026-05-18

### Added

- **Range copy / paste / clear / cut.** Once you've extended a `Shift+Arrow`
  cell range, every Excel-style action now works on it:
  - `Cmd+C` copies the range as TSV (plain text) + a minimal `<table>` HTML
    fragment — paste cleanly into Excel/Numbers/Google Sheets, or back into
    the editor as a range.
  - `Cmd+V` pastes TSV/HTML into the range starting at the top-left anchor
    cell, clipped at the destination table's edge.
  - `Cmd+X` cuts the range (copy then clear) in a single undo step.
  - `Delete` / `Backspace` clears every cell in the range in a single undo
    step.
- **F2 / Enter / `e` on a range** — collapses to the anchor cell and enters
  edit mode.
- **`c` on a range** — collapses to the anchor cell and opens the comment
  composer.
- **Better `+` append pills** — 22 px tall (up from 16), visible at rest with
  a faint dashed border, glyph optically centered, proximity buffer bumped
  to 28 px so the cursor can travel from the table onto the pill without it
  disappearing.

### Notes

- Plain `Delete` on a single cell is still a no-op by design (Excel doesn't
  clear a single cell with Delete either — you'd hit `F2` to edit).
- Multi-row / multi-column structural ops (insert/delete row, cut-paste
  rows) still act on the first row/column only with a toast hint — same as
  v0.1.6.

## 0.1.6 — 2026-05-18

### Added

- **Excel-style cell range selection.** With a table cell selected, `Shift+→`,
  `Shift+←`, `Shift+↑`, `Shift+↓` extend a rectangular range from the anchor
  cell. Bare arrow keys collapse the range and move a single cell.
- **Promote a multi-cell range to rows/columns.** With a multi-cell range,
  `Shift+Space` selects every row the range spans and `Ctrl+Space` (or
  `Option+Space`) selects every column. The range is preserved so the
  promotion keeps growing/shrinking with subsequent `Shift+Arrow` presses
  in the same axis.
- **Whole-table mode.** From row mode, `Ctrl+Space` escalates to a
  whole-table selection; from column mode, `Shift+Space` does the same.
  `Escape` steps back down: `table → range/cell`, `row/col → range/cell`,
  `range → cell`, `cell → deselect`. (Table mode collapses straight to the
  range or anchor cell because we don't track which axis you came from.)
- **Edit-mode flip.** While editing a cell, `Shift+Space` / `Ctrl+Space` /
  `Option+Space` saves the in-progress edit and switches straight to row /
  column selection on that cell.

### Changed

- Multi-row / multi-column cut + paste (`Cmd+X` / `Cmd+V`) is rejected for
  now with an explanatory toast — single-line cut/paste only.
- Multi-row / multi-column insert/delete (`Ctrl+Shift+=` / `Ctrl+-`) acts on
  the first row/column of the selection and surfaces a hint toast.
- Toolbar / breadcrumb badge now shows `range`, `row`, `column`, or `table`
  to make the current selection mode explicit.

### Notes

- v0.1.6 keeps Excel's axis convention: `Shift+Space` → row,
  `Ctrl+Space` → column. Tell me if you'd prefer the inverse.

## 0.1.5 — 2026-05-18

### Added

- Drag the row or column selection handle to reorder that row/column inside the table; a purple drop indicator shows where the line will land.
- “+” append zones along the right and bottom edges of any hovered or selected table; click to add a new column on the right or row at the bottom (Notion/Obsidian style).
- Excel-style row/column move: select a row/column, `Cmd+X` marks it with marching ants, then select another row/column in the same table and `Cmd+V` moves the cut line into that position.
- `Ctrl+Shift+=` inserts a row/column before the current row/column selection.
- `Ctrl+-` deletes the selected row/column. `Cmd+Shift+=` and `Cmd+-` also work as Excel-for-Mac fallbacks.
- New server actions `row-move-to` and `col-move-to` with `target_index` / `mode="before"|"after"` parameters.

### Changed

- Native `Cmd+C` / `Cmd+V` no longer fires when a row or column is selected, so it can’t race with the new cut-paste move.
- `+` zones stay visible while a table cell is selected, even when the cursor leaves the table.

## 0.1.4 — 2026-05-18

### Added

- Row/column table selection UX: `Shift+Space` selects the current row, `Ctrl+Space` selects the current column, and `Option+Space` is available as a macOS-friendly column fallback.
- Clickable left/top table handles for selecting rows and columns.
- Scoped table menus: row selections show row actions, column selections show column actions.

### Fixed

- Undo after structural table edits is more robust, including `Cmd+Z` from a pristine newly-inserted blank cell.

## 0.1.3 — 2026-05-18

### Added

- Table row/column structure actions from the toolbar: insert, delete, and reorder rows/columns in simple rectangular tables.
- Duplicate selected elements with fresh edit IDs. Supports regular HTML blocks/tables and leaf SVG items; table internals stay guarded behind the table actions.

### Changed

- Structural mutations restore selection after the required page reload.

## 0.1.2 — 2026-05-18

### Added

- Excel/Sheets-style table range paste. Pasting tab/newline-delimited clipboard data into a selected table cell now fills existing table cells from that point, clipping at the current table bounds rather than creating new rows or columns.

## 0.1.1 — 2026-05-17

### Added

- Agent Skill bundled with the package (`skills/html-editor/SKILL.md`). Pi sessions with `html-editor` installed will surface the editor to agents automatically when generating an HTML/SVG document, dashboard, report, mockup, or one-pager the user will iterate on.

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
- Installable with `pi install git:github.com/tmustier/html-editor` (or local
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
