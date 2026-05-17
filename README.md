# HTML collaboration editor

Prototype local editor for any generated HTML file. The server injects a small browser overlay into the target HTML and writes edits back to the source file. There is no build step.

## Run

```bash
python3 serve.py path/to/some.html --port 8765 --no-open
```

Open `http://127.0.0.1:8765/`.

## Structure

- `serve.py` — local HTTP server, source-file mutation endpoints, comments, undo/redo history, pi comment bridge.
- `client/*.js` — browser overlay code, concatenated in filename order by `serve.py` at startup.
- `styles/*.css` — overlay styles, concatenated in filename order by `serve.py` at startup.

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
./scripts/check.sh
curl -s http://127.0.0.1:8765/healthz
```
