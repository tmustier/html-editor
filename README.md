# html-editor

A little local editor for HTML your agent makes. Run a Python server, open the page in your browser, and click-to-edit the HTML in place — text, table cells, diagram labels, drag-to-reorder, resize, undo/redo. Edits are written straight back to the source file.

Optionally pairs with [Pi](https://github.com/earendil-works/pi-coding-agent) so in-browser comments are delivered back to the same Pi session that launched the editor.

No build step, no framework. Pure Python `http.server` + native ES modules.

## Install

Requirements: Python 3.10+, `beautifulsoup4`, a modern browser. For tests: Node 18+ and Playwright.

```bash
git clone https://github.com/tmustier/html-editor
cd html-editor
pip install beautifulsoup4   # or use your preferred env
```

## Quick start

```bash
python3 serve.py path/to/some.html --port 8765 --no-open
# then open http://127.0.0.1:8765/
```

Click on a paragraph, a heading, a list item, a table cell, an SVG label — type — `Cmd+Enter` to save, `Esc` to cancel. The file on disk updates.

Comments are stored next to the HTML file in `<file>.comments.json`.

## What you can do

- **Edit text in place** — paragraphs, headings, list items, table cells, mixed inline blocks (preserves `<b>`, `<code>`, `<a>`, etc.).
- **Edit SVG labels** — click a labelled diagram group; preserves `<tspan>` formatting when possible.
- **Move things** — drag the selection border to reorder HTML blocks; drag SVG groups to reposition them.
- **Resize** — drag handles on the selection box for HTML elements with sensible width/height.
- **Comment** — leave comments anchored to specific elements; they show up in a sidebar and survive reloads.
- **Undo / redo** — every save and move is snapshotted on disk.
- **Spreadsheet paste** — paste an Excel/Sheets-style range into a table cell to fill the existing table rectangle from that cell; overflow is clipped rather than adding rows/columns.
- **Navigate by structure or by grid** — see shortcuts below.

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| Click on text | Select and drop straight into edit mode |
| `F2` / `Enter` / `E` | Edit selected text or label |
| `Cmd+Enter` | Save edit / send comment |
| `Esc` | Cancel / dismiss / deselect |
| `C` | Add a comment on the selected element |
| `Cmd+C` / `Cmd+V` | Copy / paste the selected text box or table cell; spreadsheet ranges fill existing table cells and clip at table bounds |
| `Cmd+Z` / `Cmd+Y` (`Cmd+Shift+Z`) | Undo / redo last saved edit or move |
| Arrow keys | Move between table/grid cells when a cell is selected |
| `Cmd+Arrow keys` | Jump to the edge of the current table row/column |
| `Tab` / `Shift+Tab` | Next / previous table cell (saves the current cell first while editing) |
| `Option+Left` / `Right` | Previous / next sibling |
| `Option+Up` / `Down` | Parent / first editable child |
| `Drag border` / `Drag handle` | Reorder HTML or reposition diagram item |
| `Drag edge` | Resize an HTML element (E / S / SE handles) |
| `?` | Toggle the in-browser shortcut help overlay |

## Pi integration

`html-editor` is also a Pi package. Installing it loads the optional `html-editor-comments` extension, which gives every Pi session its own `HTML_EDITOR_COMMENTS_BRIDGE` path. Any editor server launched from that Pi session reads the env var automatically, and in-browser comments are delivered back into that same session as user messages.

```bash
# Install from GitHub
pi install git:github.com/tmustier/html-editor

# Or try it for one Pi process only
pi -e git:github.com/tmustier/html-editor

# Or from a local checkout
pi install /path/to/html-editor
# project-scoped variant: pi install -l /path/to/html-editor
```

After install, launch the editor from inside the Pi session so the server inherits the bridge env var:

```bash
python3 /path/to/html-editor/serve.py path/to/some.html --port 8765 --no-open
```

If you installed via `pi install git:…`, Pi clones the repo to `~/.pi/agent/git/github.com/tmustier/html-editor/` and you can launch `serve.py` from there.

If you have not installed the package, you can still set the bridge manually:

```bash
python3 serve.py page.html --comments-bridge /path/to/session.jsonl
# or disable pi delivery explicitly:
python3 serve.py page.html --comments-bridge none
```

Avoid loading two copies of the extension. If you previously copied `html-editor-comments.ts` into `~/.pi/agent/extensions/`, remove that copy before `pi install`ing this package.

The legacy shared bridge file `/tmp/html-editor-comments.jsonl` is intentionally unused now — comments are never broadcast to every running Pi session.

### Agent discoverability

The package also ships an Agent Skill (`skills/html-editor/SKILL.md`). Once installed, Pi-loaded agents see the editor as an option whenever they generate an HTML or SVG document the user is going to iterate on, and they'll launch the server themselves and share the URL with you.

## Run / develop / test

```bash
./scripts/check.sh            # syntax + fast unit tests
./scripts/test.sh --fast      # unit tests only (sub-second)
./scripts/test.sh             # unit tests + headless Playwright e2e
./scripts/test.sh --ui        # unit tests + Playwright UI runner
curl -s http://127.0.0.1:8765/healthz
```

## How it works

The server injects a small overlay (one CSS link + one ES module script tag) into the HTML it serves. The overlay listens for clicks, drags, and keys, sends edits to JSON endpoints on the server, and the server mutates the source file using BeautifulSoup. Every mutation is snapshotted for undo/redo.

### Layout

- `serve.py` — thin launcher pointing at `server.app:main`.
- `server/` — server package:
  - `app.py` argparse + `ThreadingHTTPServer` wiring
  - `routes.py` HTTP route handlers (one per editor capability)
  - `document.py` pure BeautifulSoup mutations (no IO, no HTTP)
  - `history.py` thread-safe undo/redo over disk snapshots
  - `comments.py` comment store + Pi-extension JSONL bridge
  - `assets.py` reads `client/*.js` and `styles/*.css` at import time
- `client/*.js` — native ES modules served at `/__editor/client/<name>.js`; only `main.js` is referenced from the host page.
- `styles/*.css` — overlay styles concatenated in filename order and served at `/__editor/main.css`.
- `extensions/html-editor-comments.ts` — optional Pi extension (the session bridge).
- `skills/html-editor/SKILL.md` — Agent Skill that makes the editor discoverable to Pi-loaded agents.
- `tests/` — stdlib `unittest` for `server/` plus Playwright e2e in `tests/e2e/`.

### Client modules

- `main.js` boot entrypoint
- `state.js` shared mutable state singleton
- `config.js` icon SVGs, endpoint URLs, inline-text tag set
- `api.js` fetch wrappers for every server endpoint
- `interaction.js` click-lock and reload helpers
- `dom.js` overlay DOM, `dom.*` refs, `icon()`, `flash()`
- `targets.js` semantic target model + DOM walks + grid navigation + breadcrumb + placement
- `events.js` mouse/keyboard/toolbar wiring, clipboard, deselect
- `editing.js` HTML inline text edit + SVG label edit
- `drag.js` HTML reorder, SVG spatial drag, HTML resize
- `comments.js` comment box, sidebar list, dot markers
- `init.js` reflow loop, comment polling, `window.__edit` debug API

### Semantic target model

Each selected DOM element resolves to one of:

- `html-text` — inline editable text/mixed-inline blocks
- `html-structural` — selectable/commentable/reorderable containers; not directly text-editable
- `svg-item` — labelled SVG leaf groups; commentable, spatially draggable, label-editable inline
- `svg-container` — larger SVG groups; selectable/commentable/drill-down only
- `svg-text` — orphan/flat SVG `<text>` labels; text-editable but not spatially draggable

Raw SVG primitives other than standalone `<text>` (`rect`, `path`, markers, etc.) are not independent editor targets.

## Adding a new editor capability

1. Add a pure function in `server/document.py` that mutates a BeautifulSoup tree and returns `(ok: bool, payload: dict)`.
2. Add the route in `server/routes.py` — read JSON body, call your function, snapshot history, save, return the payload. Register it in `_ROUTES`.
3. Add tests in `tests/test_document.py`.
4. Call the new endpoint from the client (`client/api.js`, then wire from `client/events.js` or `client/editing.js`).

## License

MIT. See [LICENSE](LICENSE).
