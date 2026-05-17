# HTML collaboration editor

Prototype local editor for any generated HTML file. The server injects a small browser overlay into the target HTML and writes edits back to the source file. There is no build step.

## Run

```bash
python3 serve.py path/to/some.html --port 8765 --no-open
```

Open `http://127.0.0.1:8765/`.

Comments are stored next to the HTML file in `<file>.comments.json`. Delivery
into a pi session is **off by default** so local tests and ad-hoc editor
servers cannot broadcast to every live pi session. To route comments into one
specific pi session:

1. In that pi session, run `/html-comments status` and copy the session-scoped
   bridge path.
2. Start the editor with `--comments-bridge <that-path>`.

Do not use the historical shared `/tmp/html-editor-comments.jsonl` bridge unless
you deliberately want broadcast-style legacy behaviour.

## Structure

- `serve.py` — 14-line launcher pointing at `server.app:main`.
- `server/` — server package:
  - `app.py` argparse and `ThreadingHTTPServer` wiring
  - `routes.py` HTTP route handlers (one per editor capability)
  - `document.py` pure BeautifulSoup mutations (no IO, no HTTP)
  - `history.py` thread-safe undo/redo over disk snapshots
  - `comments.py` comment store + pi extension JSONL bridge
  - `assets.py` reads `client/*.js` and `styles/*.css` at import time
- `client/*.js` — native ES modules. The server serves them at `/__editor/client/<name>.js`; only `main.js` is referenced from the host page (the rest are pulled in by `import`).
- `styles/*.css` — overlay styles, concatenated in filename order and served at `/__editor/main.css`.

### Client module map

- `main.js` boot entrypoint (initDom, initEvents, initSidebarButtons, initRuntime)
- `state.js` shared mutable state singleton
- `config.js` icon SVGs, endpoint URLs, inline-text tag set
- `api.js` fetch wrappers for every server endpoint
- `interaction.js` click-lock and reload timing helpers
- `dom.js` builds the overlay DOM, exposes `dom.*` element refs, `icon()`, `flash()`
- `targets.js` semantic target model + DOM walks + breadcrumb + placement
- `events.js` mouse/keyboard/toolbar wiring + `selectElement`/`deselect`/`performHistory`
- `editing.js` HTML inline text edit + SVG label edit (+ caret math)
- `drag.js` HTML reorder, SVG spatial drag, HTML resize
- `comments.js` comment box, sidebar list, dot markers
- `init.js` reflow loop, comment polling, `window.__edit` debug API
- `tests/` — stdlib `unittest` coverage for `server/` plus Playwright e2e coverage in `tests/e2e/`.

## Behaviour model

Each selected DOM element resolves to a semantic target:

- `html-text` — inline editable text/mixed-inline blocks.
- `html-structural` — selectable/commentable/reorderable containers; not directly text-editable.
- `svg-item` — labelled SVG leaf groups; commentable, spatially draggable, label-editable inline.
- `svg-container` — larger SVG groups; selectable/commentable/drill-down only.
- `svg-text` — orphan/flat SVG `<text>` labels; selectable/commentable and text-editable, but not spatially draggable.

Raw SVG primitives other than standalone `<text>` (`rect`, `path`, markers, etc.) are not independent editor targets.

## Quick checks

```bash
./scripts/check.sh            # syntax + fast unit tests
./scripts/test.sh --fast      # unit tests only (sub-second)
./scripts/test.sh             # unit tests + headless Playwright e2e
./scripts/test.sh --ui        # unit tests + Playwright UI runner
curl -s http://127.0.0.1:8765/healthz
```

## Adding a new editor capability

1. Add a pure function in `server/document.py` that mutates a BeautifulSoup tree and returns `(ok: bool, payload: dict)`.
2. Add the route in `server/routes.py` — a handler that reads the JSON body, calls your function, snapshots history, saves, and returns the payload. Register it in `_ROUTES`.
3. Add tests in `tests/test_document.py`.
4. Call the new endpoint from the client.
