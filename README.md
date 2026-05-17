# HTML collaboration editor

Prototype local editor for any generated HTML file. The server injects a small browser overlay into the target HTML and writes edits back to the source file. There is no build step.

## Run

```bash
python3 serve.py path/to/some.html --port 8765 --no-open
```

Open `http://127.0.0.1:8765/`.

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
- `api.js` fetch wrappers for every server endpoint + `reloadAfterMutation`
- `dom.js` builds the overlay DOM, exposes `dom.*` element refs, `icon()`, `flash()`
- `targets.js` semantic target model + DOM walks + breadcrumb + placement
- `events.js` mouse/keyboard/toolbar wiring + `selectElement`/`deselect`/`performHistory`
- `editing.js` HTML inline text edit + SVG label edit (+ caret math)
- `drag.js` HTML reorder, SVG spatial drag, HTML resize
- `comments.js` comment box, sidebar list, dot markers
- `init.js` reflow loop, comment polling, `window.__edit` debug API
- `tests/` — stdlib `unittest` suite covering every `document.py` function plus `history.py` and `comments.py`.

## Client file map

- `client/00-bootstrap.js` — IIFE wrapper, endpoint constants, icons.
- `client/10-ui.js` — injected overlay DOM.
- `client/20-targets.js` — target model, selection helpers, toolbar placement, navigation, undo/redo trigger.
- `client/30-drag.js` — HTML reorder drag and SVG spatial drag.
- `client/40-events.js` — mouse/keyboard/toolbar event wiring.
- `client/50-editing.js` — HTML inline text editing and SVG inline label editing.
- `client/60-comments.js` — comment box and send endpoint.
- `client/70-comment-list.js` — sidebar comment list and dots.
- `client/90-init.js` — reflow, polling, and debug API.

## Behaviour model

Each selected DOM element resolves to a semantic target:

- `html-text` — inline editable text/mixed-inline blocks.
- `html-structural` — selectable/commentable/reorderable containers; not directly text-editable.
- `svg-item` — labelled SVG leaf groups; commentable, spatially draggable, label-editable inline.
- `svg-container` — larger SVG groups; selectable/commentable/drill-down only.

Raw SVG primitives (`rect`, `text`, `path`, markers, etc.) are not independent editor targets.

## Quick checks

```bash
./scripts/check.sh            # syntax + unit tests (sub-second)
./scripts/test.sh             # unit tests only
curl -s http://127.0.0.1:8765/healthz
```

## Adding a new editor capability

1. Add a pure function in `server/document.py` that mutates a BeautifulSoup tree and returns `(ok: bool, payload: dict)`.
2. Add the route in `server/routes.py` — a handler that reads the JSON body, calls your function, snapshots history, saves, and returns the payload. Register it in `_ROUTES`.
3. Add tests in `tests/test_document.py`.
4. Call the new endpoint from the client.
