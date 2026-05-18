"""HTTP routing for the editor server.

The Handler is intentionally thin: each route reads the request body, calls a
pure function in document.py / history.py / comments.py, and translates the
return value into a JSON response. All the actual logic lives elsewhere.

Adding a new editor capability is now a 3-step change:
  1. add the pure function in server/document.py
  2. add the route in this file's _route_table
  3. call the new endpoint from the client
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

from . import assets, document
from .comments import DEFAULT_BRIDGE_FILE, CommentStore
from .history import History


def _inject_overlay(soup) -> str:
    """Inject the editor's CSS link + module script tags into the page.

    The cache buster keeps reloads honest while we iterate. The script tag
    is type=module so the browser fetches the rest of client/*.js itself.
    """
    html = str(soup)
    version = json.dumps(str(int(time.time() * 1000)))
    css_link = (
        f'<link id="__edit_css" rel="stylesheet" '
        f'href="/__editor/main.css?v={version[1:-1]}">'
    )
    js_tag = (
        f'<script type="module" id="__edit_js" '
        f'src="/__editor/client/{assets.CLIENT_ENTRY}?v={version[1:-1]}">'
        '</script>'
    )
    if "</head>" in html:
        html = html.replace("</head>", css_link + "\n</head>", 1)
    else:
        html = css_link + html
    if "</body>" in html:
        html = html.replace("</body>", js_tag + "\n</body>", 1)
    else:
        html = html + js_tag
    return html


def make_handler(
    html_path: Path,
    comments_path: Path,
    bridge_path: Optional[Path] = DEFAULT_BRIDGE_FILE,
) -> type[BaseHTTPRequestHandler]:
    """Build a Handler class bound to one document. Per-server state lives in
    closure so we never juggle class-level globals.

    bridge_path controls the pi extension JSONL bridge for this server.
    Pass None to disable it (recommended for e2e tests).
    """
    history = History(html_path)
    comment_store = CommentStore(comments_path, bridge_path=bridge_path)
    mutation_lock = threading.RLock()

    class Handler(BaseHTTPRequestHandler):
        # Quiet the default access log; we print our own structured events.
        def log_message(self, fmt: str, *args) -> None:  # noqa: D401
            return

        # ---- low-level helpers ----
        def _send_json(self, code: int, payload) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> Optional[dict]:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None

        def _send_result(self, ok: bool, payload: dict) -> None:
            if ok:
                self._send_json(200, payload)
            else:
                status = payload.pop("status", 400)
                self._send_json(status, payload)

        def _mutate_document(self, mutate: Callable) -> tuple[bool, dict]:
            """Run one read/mutate/history/save sequence under a document lock."""
            with mutation_lock:
                soup = document.load_soup(html_path)
                ok, result = mutate(soup)
                if ok:
                    history.remember()
                    document.save_soup(html_path, soup)
                return ok, result

        # ---- routes ----
        def _send_bytes(self, body: bytes, content_type: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            url = urlparse(self.path)
            if url.path in ("/", "/index.html"):
                with mutation_lock:
                    soup = document.ensure_edit_ids(html_path)
                self._send_bytes(
                    _inject_overlay(soup).encode("utf-8"),
                    "text/html; charset=utf-8")
                return
            if url.path == "/__editor/main.css":
                self._send_bytes(assets.read_bundled_css(),
                                 "text/css; charset=utf-8")
                return
            if url.path.startswith("/__editor/client/"):
                name = url.path[len("/__editor/client/"):]
                body = assets.read_client_module(name)
                if body is None:
                    self.send_error(404)
                    return
                self._send_bytes(body, "application/javascript; charset=utf-8")
                return
            if url.path == "/comments":
                self._send_json(200, comment_store.load())
                return
            if url.path == "/healthz":
                self._send_json(200, {
                    "ok": True,
                    "file": str(html_path),
                    "bridge_file": (
                        str(bridge_path) if bridge_path is not None else None
                    ),
                })
                return
            self.send_error(404)

        def do_POST(self):  # noqa: N802
            url = urlparse(self.path)
            payload = self._read_json()
            if payload is None:
                self._send_json(400, {"error": "invalid JSON"})
                return

            route = _ROUTES.get(url.path)
            if route is None:
                self.send_error(404)
                return
            route(self, payload)

        # ---- handlers ----
        # Each handler:
        #   1. validates inputs (returns 400 on bad shape)
        #   2. asks document.py to mutate the soup
        #   3. on success, takes a history snapshot, writes the file, logs
        #   4. returns the result as JSON
        def _save_text(self, payload):
            edit_id = (payload or {}).get("id")
            text = (payload or {}).get("text", "")
            html = (payload or {}).get("html")
            if not edit_id:
                self._send_json(400, {"error": "missing id"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.update_text(soup, edit_id, text, html))
            if not ok:
                self._send_result(ok, result)
                return
            excerpt = text.strip().replace("\n", " ")[:80]
            sys.stderr.write(
                f"[edit] saved text for {edit_id} <{result['tag']}>: "
                f"{excerpt!r}\n")
            sys.stderr.flush()
            self._send_json(200, {"ok": True})

        def _save_text_many(self, payload):
            updates = (payload or {}).get("updates")
            ok, result = self._mutate_document(
                lambda soup: document.update_text_many(soup, updates))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(f"[edit-many] saved {result['count']} text cells\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _save_svg_labels(self, payload):
            edit_id = (payload or {}).get("id")
            lines = (payload or {}).get("lines")
            if not edit_id or not isinstance(lines, list):
                self._send_json(400, {"error": "expected id and lines[]"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.update_svg_labels(soup, edit_id, lines))
            if not ok:
                self._send_result(ok, result)
                return
            excerpt = " | ".join(str(x).strip() for x in lines)[:120]
            sys.stderr.write(
                f"[edit-svg] saved labels for {edit_id}: {excerpt!r}"
                + (" (formatting partially lost)" if result["formatting_lost"] else "")
                + "\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _move_element(self, payload):
            edit_id = (payload or {}).get("id")
            target_id = (payload or {}).get("target_id")
            position = (payload or {}).get("position")
            if not edit_id or not target_id:
                self._send_json(400, {"error":
                    "expected id, target_id, position=before|after"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.move_element(soup, edit_id, target_id, position))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(f"[move] {edit_id} {position} {target_id}\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _move_svg(self, payload):
            edit_id = (payload or {}).get("id")
            try:
                tx = float((payload or {}).get("translate_x", 0))
                ty = float((payload or {}).get("translate_y", 0))
            except (TypeError, ValueError):
                self._send_json(400, {"error":
                    "translate_x and translate_y must be numbers"})
                return
            if not edit_id:
                self._send_json(400, {"error": "missing id"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.move_svg(soup, edit_id, tx, ty))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(
                f"[move-svg] {edit_id} translate({tx:.2f} {ty:.2f})\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _resize_element(self, payload):
            edit_id = (payload or {}).get("id")
            if not edit_id:
                self._send_json(400, {"error": "missing id"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.resize_element(
                    soup, edit_id,
                    width=(payload or {}).get("width"),
                    height=(payload or {}).get("height"),
                    max_width=(payload or {}).get("max_width"),
                    max_height=(payload or {}).get("max_height"),
                ))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(f"[resize] {edit_id} -> {result['style']!r}\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _table_operation(self, payload):
            cell_id = (payload or {}).get("cell_id")
            action = (payload or {}).get("action")
            target_index_raw = (payload or {}).get("target_index")
            source_cell_id = (payload or {}).get("source_cell_id")
            mode = (payload or {}).get("mode") or "before"
            include_table_html = (payload or {}).get("include_table_html") is True
            include_table_patch = (payload or {}).get("include_table_patch") is True
            if not cell_id or not action:
                self._send_json(400, {"error": "expected cell_id and action"})
                return
            target_index = None
            if target_index_raw is not None:
                try:
                    target_index = int(target_index_raw)
                except (TypeError, ValueError):
                    self._send_json(400, {"error": "target_index must be an integer"})
                    return
            ok, result = self._mutate_document(
                lambda soup: document.table_operation(
                    soup, str(cell_id), str(action),
                    target_index=target_index,
                    source_cell_id=str(source_cell_id) if source_cell_id else None,
                    mode=str(mode),
                    include_table_html=include_table_html,
                    include_table_patch=include_table_patch))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(f"[table] {action} at {cell_id}\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _duplicate_element(self, payload):
            edit_id = (payload or {}).get("id")
            if not edit_id:
                self._send_json(400, {"error": "missing id"})
                return
            ok, result = self._mutate_document(
                lambda soup: document.duplicate_element(soup, str(edit_id)))
            if not ok:
                self._send_result(ok, result)
                return
            sys.stderr.write(f"[duplicate] {edit_id} -> {result['new_id']}\n")
            sys.stderr.flush()
            self._send_json(200, result)

        def _undo(self, _payload):
            with mutation_lock:
                ok = history.undo()
            if not ok:
                self._send_json(409, {"error": "nothing to undo"})
                return
            sys.stderr.write("[history] undo\n")
            sys.stderr.flush()
            self._send_json(200, {"ok": True})

        def _redo(self, _payload):
            with mutation_lock:
                ok = history.redo()
            if not ok:
                self._send_json(409, {"error": "nothing to redo"})
                return
            sys.stderr.write("[history] redo\n")
            sys.stderr.flush()
            self._send_json(200, {"ok": True})

        def _add_comment(self, payload):
            edit_id = (payload or {}).get("id")
            comment = ((payload or {}).get("comment") or "").strip()
            excerpt = ((payload or {}).get("excerpt") or "")[:240]
            tag = (payload or {}).get("tag") or ""
            if not edit_id or not comment:
                self._send_json(400, {"error": "missing id or comment"})
                return
            entry = comment_store.add(edit_id, tag, comment, excerpt, html_path)
            sys.stderr.write(
                f"[comment] {entry['timestamp']}  {edit_id} <{tag}>  "
                f'"{comment}"  (on: {excerpt!r})\n')
            sys.stderr.flush()
            self._send_json(200, {
                "ok": True, "entry": entry,
                "bridge": str(bridge_path) if bridge_path is not None else None,
            })

    # POST route table — the canonical list of editor capabilities.
    _ROUTES: dict[str, Callable] = {
        "/save-text":        Handler._save_text,
        "/save-text-many":   Handler._save_text_many,
        "/save-svg-labels":  Handler._save_svg_labels,
        "/move-element":     Handler._move_element,
        "/move-svg":         Handler._move_svg,
        "/resize-element":   Handler._resize_element,
        "/table-operation":  Handler._table_operation,
        "/duplicate-element": Handler._duplicate_element,
        "/undo":             Handler._undo,
        "/redo":             Handler._redo,
        "/comment":          Handler._add_comment,
    }
    return Handler
