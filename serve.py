#!/usr/bin/env python3
"""html-collab-edit — collaboratively edit an HTML file in Chrome.

Serves an HTML file with an injected editor overlay:
  • hover highlights elements
  • click an element to select it
  • Edit text in place; saves write back to the source HTML
  • Drag selected elements before/after other elements; moves persist to source HTML
  • Add a comment on an element; comments are appended to <file>.comments.json
    and printed to stderr so the agent driving this script can pick them up

Usage:
    python3 serve.py /path/to/file.html [--port 8765] [--no-open]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    from bs4 import BeautifulSoup, NavigableString
except ImportError:
    sys.stderr.write("bs4 is required: pip install beautifulsoup4\n")
    sys.exit(1)

HERE = Path(__file__).resolve().parent
CLIENT_JS_DIR = HERE / "client"
STYLE_DIR = HERE / "styles"


def _read_ordered_text(directory: Path, pattern: str, kind: str) -> str:
    """Read injection assets in filename order; no build step required."""
    files = sorted(directory.glob(pattern)) if directory.exists() else []
    if not files:
        raise RuntimeError(f"no {kind} files found in {directory}")
    chunks = []
    for path in files:
        chunks.append(f"\n/* ---- {path.relative_to(HERE)} ---- */\n" + path.read_text(encoding="utf-8"))
    return "\n".join(chunks)


EDITOR_JS = _read_ordered_text(CLIENT_JS_DIR, "*.js", "client JavaScript")
EDITOR_CSS = _read_ordered_text(STYLE_DIR, "*.css", "editor CSS")

# Tags we never tag (or even consider) as editable targets.
SVG_PRIMITIVE_TAGS = {
    "svg", "defs", "clippath", "clipPath", "lineargradient", "linearGradient",
    "radialgradient", "radialGradient", "stop", "marker", "mask", "pattern",
    "filter", "fegaussianblur", "feGaussianBlur", "feoffset", "feOffset",
    "feblend", "feBlend", "fecolormatrix", "feColorMatrix", "symbol", "use",
    "rect", "text", "line", "path", "circle", "ellipse", "polygon", "polyline", "tspan",
}
INLINE_TEXT_TAGS = {
    "a", "abbr", "b", "br", "code", "em", "i", "kbd", "mark", "s", "small",
    "span", "strong", "sub", "sup", "time", "u", "var",
}
SKIP_TAGS = {
    "script", "style", "meta", "link", "title", "head", "html", "body",
    "br", "hr", *SVG_PRIMITIVE_TAGS,
}

# ---- HTML manipulation -----------------------------------------------------


def _load_soup(path: Path) -> BeautifulSoup:
    return BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")


def _save_soup(path: Path, soup: BeautifulSoup) -> None:
    path.write_text(str(soup), encoding="utf-8")


def ensure_edit_ids(html_path: Path) -> BeautifulSoup:
    """Make sure every editable element has a data-edit-id; persist if changed."""
    soup = _load_soup(html_path)
    existing = []
    for el in soup.find_all(attrs={"data-edit-id": True}):
        m = re.match(r"e(\d+)$", el.get("data-edit-id", ""))
        if m:
            existing.append(int(m.group(1)))
    next_id = max(existing, default=0) + 1
    changed = False
    for el in soup.find_all():
        if el.name in SKIP_TAGS:
            continue
        if el.name == "g" and el.find_parent("svg") and not el.find("text"):
            # Only logical labelled SVG groups are selectable. Utility groups
            # with no visible text are not useful editor targets.
            continue
        if not el.get("data-edit-id"):
            el["data-edit-id"] = f"e{next_id}"
            next_id += 1
            changed = True
    # Second pass: orphan SVG <text> elements (not inside a labelled <g> with
    # its own data-edit-id). These become directly-editable text targets in
    # diagrams that aren't built from labelled groups.
    for text_el in soup.find_all("text"):
        if not text_el.find_parent("svg"):
            continue
        enclosing = text_el.find_parent("g", attrs={"data-edit-id": True})
        if enclosing is not None:
            continue
        if not text_el.get("data-edit-id"):
            text_el["data-edit-id"] = f"e{next_id}"
            next_id += 1
            changed = True
    if changed:
        _save_soup(html_path, soup)
    return soup


def inject_overlay(soup: BeautifulSoup) -> str:
    """Return HTML string with editor CSS + JS injected."""
    html = str(soup)
    css_tag = f"<style id=\"__edit_css\">{EDITOR_CSS}</style>"
    js_tag = (
        "<script id=\"__edit_js\">"
        f"window.__EDIT_VERSION = {json.dumps(time.time())};\n"
        f"{EDITOR_JS}"
        "</script>"
    )
    if "</head>" in html:
        html = html.replace("</head>", css_tag + "\n</head>", 1)
    else:
        html = css_tag + html
    if "</body>" in html:
        html = html.replace("</body>", js_tag + "\n</body>", 1)
    else:
        html = html + js_tag
    return html


# ---- HTTP server -----------------------------------------------------------


# ---- bridge / OS helpers --------------------------------------------------

TRIGGER_FILE = Path("/tmp/html-editor-comments.jsonl")
MAX_HISTORY = 50


def _is_inside_svg(el) -> bool:
    return bool(el and (el.name == "svg" or el.find_parent("svg")))


def _is_svg_primitive(el) -> bool:
    return bool(el and (el.name in SVG_PRIMITIVE_TAGS or (_is_inside_svg(el) and el.name != "g")))


def _parse_inline_style(s: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (s or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k = k.strip()
            v = v.strip()
            if k:
                out[k] = v
    return out


def _stringify_inline_style(d: dict[str, str]) -> str:
    return "; ".join(f"{k}: {v}" for k, v in d.items() if v)


def _smart_update_svg_text(text_node, new_text: str) -> bool:
    """Update an SVG <text> element's visible text content while preserving any
    inline <tspan> formatting whenever possible.

    Strategy: flatten contents into segments (raw text runs and tspans),
    compute the changed character range via prefix/suffix match, and if the
    change is contained in a single segment, splice into that segment so other
    segments keep their tspan attributes intact.

    Returns True if formatting was preserved (including the trivial cases of
    no tspans or no change). Returns False if the structure was simple enough
    to merge but the edit crossed segment boundaries, forcing a plain-text
    fallback — callers can surface a warning.
    """
    from bs4 import NavigableString as _NS, Tag as _Tag  # local import to avoid name pollution

    segments = []  # list of dicts: {"text", "kind", "ref"}
    for child in list(text_node.contents):
        if isinstance(child, _NS):
            segments.append({"text": str(child), "kind": "text", "ref": child})
            continue
        if isinstance(child, _Tag) and child.name == "tspan":
            # We can only safely splice a tspan that wraps a single text node.
            if any(not isinstance(c, _NS) for c in child.contents):
                # Nested structure — give up; preserve nothing, fall back.
                text_node.clear()
                text_node.append(_NS(new_text))
                return False
            inner = "".join(str(c) for c in child.contents)
            segments.append({"text": inner, "kind": "tspan", "ref": child})
            continue
        # Unknown child kind (e.g. comment, other element). Bail.
        text_node.clear()
        text_node.append(_NS(new_text))
        return False

    if not segments:
        text_node.append(_NS(new_text))
        return True

    old_text = "".join(s["text"] for s in segments)
    if old_text == new_text:
        return True

    # Trivial: single segment — just update its inner text.
    if len(segments) == 1:
        seg = segments[0]
        if seg["kind"] == "text":
            seg["ref"].replace_with(_NS(new_text))
        else:
            seg["ref"].clear()
            seg["ref"].append(_NS(new_text))
        return True

    # Mixed segments: diff against old_text via longest common prefix/suffix.
    pi = 0
    max_pi = min(len(old_text), len(new_text))
    while pi < max_pi and old_text[pi] == new_text[pi]:
        pi += 1
    si = 0
    max_si = min(len(old_text) - pi, len(new_text) - pi)
    while si < max_si and old_text[len(old_text) - 1 - si] == new_text[len(new_text) - 1 - si]:
        si += 1
    change_start = pi
    change_end = len(old_text) - si
    new_chunk = new_text[pi: len(new_text) - si]

    # Map segments to character ranges and find which segment(s) the change
    # range intersects.
    pos = 0
    seg_ranges = []  # (start, end, seg)
    for seg in segments:
        seg_ranges.append((pos, pos + len(seg["text"]), seg))
        pos += len(seg["text"])

    if change_start == change_end:
        # Pure insert at boundary — pick the segment whose range strictly
        # contains the insertion point; if at a seam, prefer the left (earlier)
        # one so insertions "extend" the prior segment naturally.
        affected = []
        for r in seg_ranges:
            start, end, _ = r
            if start < change_start < end:
                affected = [r]
                break
            if change_start == end or change_start == start:
                affected.append(r)
        if len(affected) > 1:
            # At seam: prefer earlier segment.
            affected = [affected[0]]
    else:
        affected = [r for r in seg_ranges if not (r[1] <= change_start or r[0] >= change_end)]

    if len(affected) != 1:
        # Cross-segment change — fall back to plain text and report loss.
        text_node.clear()
        text_node.append(_NS(new_text))
        return False

    s_start, s_end, seg = affected[0]
    local_change_start = max(0, change_start - s_start)
    local_change_end = min(s_end - s_start, change_end - s_start)
    old_seg_text = seg["text"]
    new_seg_text = (
        old_seg_text[:local_change_start]
        + new_chunk
        + old_seg_text[local_change_end:]
    )
    if seg["kind"] == "text":
        seg["ref"].replace_with(_NS(new_seg_text))
    else:
        seg["ref"].clear()
        seg["ref"].append(_NS(new_seg_text))
    return True


def _is_text_editable(el) -> bool:
    """True for leaf text nodes and mixed-content text blocks with only inline children."""
    if el is None or _is_inside_svg(el):
        return False
    child_tags = [c for c in el.find_all(True)]
    if not child_tags:
        return True
    return all((not _is_inside_svg(c)) and c.name in INLINE_TEXT_TAGS for c in child_tags)


def append_trigger(entry: dict) -> None:
    """Append a single JSONL line read by the pi extension bridge."""
    TRIGGER_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TRIGGER_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    html_path: Path = None  # type: ignore[assignment]
    comments_path: Path = None  # type: ignore[assignment]
    undo_stack: list[str] = []
    redo_stack: list[str] = []
    history_lock = threading.Lock()

    # Quiet the default access log; we print our own structured events.
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        return

    # ---- helpers ----
    def _send_json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    # ---- routes ----
    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            soup = ensure_edit_ids(self.html_path)
            html = inject_overlay(soup)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/comments":
            data = self._load_comments()
            self._send_json(200, data)
            return
        if url.path == "/healthz":
            self._send_json(200, {
                "ok": True,
                "file": str(self.html_path),
                "bridge_file": str(TRIGGER_FILE),
            })
            return
        self.send_error(404)

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if url.path == "/save-text":
            return self._save_text(payload)
        if url.path == "/save-svg-labels":
            return self._save_svg_labels(payload)
        if url.path == "/move-element":
            return self._move_element(payload)
        if url.path == "/move-svg":
            return self._move_svg(payload)
        if url.path == "/resize-element":
            return self._resize_element(payload)
        if url.path == "/undo":
            return self._undo()
        if url.path == "/redo":
            return self._redo()
        if url.path == "/comment":
            return self._add_comment(payload)
        self.send_error(404)

    # ---- comment store ----
    def _load_comments(self):
        if not self.comments_path.exists():
            return []
        try:
            data = json.loads(self.comments_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return []
        return data if isinstance(data, list) else []

    def _save_comments(self, data):
        self.comments_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    # ---- mutation history ----
    def _remember_history(self) -> None:
        with self.history_lock:
            self.undo_stack.append(self.html_path.read_text(encoding="utf-8"))
            if len(self.undo_stack) > MAX_HISTORY:
                self.undo_stack.pop(0)
            self.redo_stack.clear()

    def _undo(self):
        with self.history_lock:
            if not self.undo_stack:
                self._send_json(409, {"error": "nothing to undo"})
                return
            current = self.html_path.read_text(encoding="utf-8")
            previous = self.undo_stack.pop()
            self.redo_stack.append(current)
            self.html_path.write_text(previous, encoding="utf-8")
        sys.stderr.write("[history] undo\n")
        sys.stderr.flush()
        self._send_json(200, {"ok": True})

    def _redo(self):
        with self.history_lock:
            if not self.redo_stack:
                self._send_json(409, {"error": "nothing to redo"})
                return
            current = self.html_path.read_text(encoding="utf-8")
            next_state = self.redo_stack.pop()
            self.undo_stack.append(current)
            if len(self.undo_stack) > MAX_HISTORY:
                self.undo_stack.pop(0)
            self.html_path.write_text(next_state, encoding="utf-8")
        sys.stderr.write("[history] redo\n")
        sys.stderr.flush()
        self._send_json(200, {"ok": True})

    # ---- handlers ----
    def _save_text(self, payload):
        edit_id = (payload or {}).get("id")
        new_text = (payload or {}).get("text", "")
        new_html = (payload or {}).get("html")
        if not edit_id:
            self._send_json(400, {"error": "missing id"})
            return

        soup = _load_soup(self.html_path)
        el = soup.find(attrs={"data-edit-id": edit_id})
        if el is None:
            self._send_json(404, {"error": f"id {edit_id} not found"})
            return
        if not _is_text_editable(el):
            self._send_json(400, {"error": "structural components can't be text-edited; select text inside the component"})
            return

        self._remember_history()
        el.clear()
        if isinstance(new_html, str):
            fragment = BeautifulSoup(new_html, "html.parser")
            for child in list(fragment.contents):
                el.append(child)
        else:
            el.append(NavigableString(new_text))

        _save_soup(self.html_path, soup)
        excerpt = new_text.strip().replace("\n", " ")[:80]
        sys.stderr.write(f"[edit] saved text for {edit_id} <{el.name}>: {excerpt!r}\n")
        sys.stderr.flush()
        self._send_json(200, {"ok": True})

    def _save_svg_labels(self, payload):
        edit_id = (payload or {}).get("id")
        lines = (payload or {}).get("lines")
        if not edit_id or not isinstance(lines, list):
            self._send_json(400, {"error": "expected id and lines[]"})
            return

        soup = _load_soup(self.html_path)
        el = soup.find(attrs={"data-edit-id": edit_id})
        if el is None:
            self._send_json(404, {"error": f"id {edit_id} not found"})
            return
        if not el.find_parent("svg") and el.name != "svg":
            self._send_json(400, {"error": "element is not inside an SVG"})
            return
        if el.name == "text":
            # Single orphan <text> target.
            text_nodes = [el]
        elif el.name == "g":
            if el.find("g", attrs={"data-edit-id": True}):
                self._send_json(400, {"error": "edit a leaf diagram item, not a container SVG group"})
                return
            text_nodes = el.find_all("text")
            if not text_nodes:
                self._send_json(400, {"error": "selected SVG item has no text labels"})
                return
        else:
            self._send_json(400, {"error": "target is not an editable SVG group or text element"})
            return
        if len(lines) != len(text_nodes):
            self._send_json(400, {"error": f"expected {len(text_nodes)} label line(s), got {len(lines)}"})
            return

        self._remember_history()
        formatting_lost = False
        for text_node, line in zip(text_nodes, lines):
            if not _smart_update_svg_text(text_node, str(line)):
                formatting_lost = True

        _save_soup(self.html_path, soup)
        excerpt = " | ".join(str(x).strip() for x in lines)[:120]
        sys.stderr.write(f"[edit-svg] saved labels for {edit_id}: {excerpt!r}"
                         + (" (formatting partially lost)" if formatting_lost else "") + "\n")
        sys.stderr.flush()
        self._send_json(200, {
            "ok": True,
            "id": edit_id,
            "lines": lines,
            "formatting_lost": formatting_lost,
        })

    def _move_element(self, payload):
        edit_id = (payload or {}).get("id")
        target_id = (payload or {}).get("target_id")
        position = (payload or {}).get("position")
        if not edit_id or not target_id or position not in {"before", "after"}:
            self._send_json(400, {"error": "expected id, target_id, position=before|after"})
            return
        if edit_id == target_id:
            self._send_json(400, {"error": "can't move an element relative to itself"})
            return

        soup = _load_soup(self.html_path)
        el = soup.find(attrs={"data-edit-id": edit_id})
        target = soup.find(attrs={"data-edit-id": target_id})
        if el is None:
            self._send_json(404, {"error": f"id {edit_id} not found"})
            return
        if target is None:
            self._send_json(404, {"error": f"target id {target_id} not found"})
            return
        if _is_inside_svg(el) or _is_inside_svg(target):
            self._send_json(400, {"error": "SVG diagram items can't be moved independently; drag the containing diagram/component"})
            return
        if any(desc is target for desc in el.descendants):
            self._send_json(400, {"error": "can't move an element relative to one of its own descendants"})
            return
        if target.parent is None:
            self._send_json(400, {"error": "target has no parent"})
            return

        self._remember_history()
        moved = el.extract()
        if position == "before":
            target.insert_before(moved)
        else:
            target.insert_after(moved)

        _save_soup(self.html_path, soup)
        sys.stderr.write(f"[move] {edit_id} {position} {target_id}\n")
        sys.stderr.flush()
        self._send_json(200, {
            "ok": True,
            "id": edit_id,
            "target_id": target_id,
            "position": position,
        })

    def _move_svg(self, payload):
        edit_id = (payload or {}).get("id")
        try:
            tx = float((payload or {}).get("translate_x", 0))
            ty = float((payload or {}).get("translate_y", 0))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "translate_x and translate_y must be numbers"})
            return
        if not edit_id:
            self._send_json(400, {"error": "missing id"})
            return

        soup = _load_soup(self.html_path)
        el = soup.find(attrs={"data-edit-id": edit_id})
        if el is None:
            self._send_json(404, {"error": f"id {edit_id} not found"})
            return
        if el.name != "g" or not el.find_parent("svg"):
            self._send_json(400, {"error": "only labelled SVG groups can be moved spatially"})
            return
        if el.find("g", attrs={"data-edit-id": True}):
            self._send_json(400, {"error": "move leaf diagram items, not container SVG groups"})
            return

        current = el.get("transform") or ""
        replacement = f"translate({tx:.2f} {ty:.2f})"
        if re.search(r"translate\s*\([^)]*\)", current):
            new_transform = re.sub(r"translate\s*\([^)]*\)", replacement, current, count=1).strip()
        else:
            new_transform = (replacement + " " + current).strip()
        self._remember_history()
        el["transform"] = new_transform
        _save_soup(self.html_path, soup)
        sys.stderr.write(f"[move-svg] {edit_id} translate({tx:.2f} {ty:.2f})\n")
        sys.stderr.flush()
        self._send_json(200, {"ok": True, "id": edit_id, "translate_x": tx, "translate_y": ty})

    def _resize_element(self, payload):
        edit_id = (payload or {}).get("id")
        width = (payload or {}).get("width")
        height = (payload or {}).get("height")
        if not edit_id:
            self._send_json(400, {"error": "missing id"})
            return

        soup = _load_soup(self.html_path)
        el = soup.find(attrs={"data-edit-id": edit_id})
        if el is None:
            self._send_json(404, {"error": f"id {edit_id} not found"})
            return
        if _is_inside_svg(el):
            self._send_json(400, {"error": "SVG elements aren't resizable via this endpoint"})
            return

        max_width = (payload or {}).get("max_width")
        max_height = (payload or {}).get("max_height")

        # Parse + mutate inline style preserving order & other properties.
        style_dict = _parse_inline_style(el.get("style", ""))

        def _apply(key: str, val):
            if val is None:
                return
            if isinstance(val, str) and val.strip():
                style_dict[key] = val.strip()
            else:
                style_dict.pop(key, None)

        _apply("width", width)
        _apply("height", height)
        _apply("max-width", max_width)
        _apply("max-height", max_height)

        self._remember_history()
        new_style = _stringify_inline_style(style_dict)
        if new_style:
            el["style"] = new_style
        elif el.has_attr("style"):
            del el["style"]

        _save_soup(self.html_path, soup)
        sys.stderr.write(f"[resize] {edit_id} -> {new_style!r}\n")
        sys.stderr.flush()
        self._send_json(200, {"ok": True, "id": edit_id, "style": new_style})

    def _add_comment(self, payload):
        edit_id = (payload or {}).get("id")
        comment = ((payload or {}).get("comment") or "").strip()
        excerpt = ((payload or {}).get("excerpt") or "")[:240]
        tag = (payload or {}).get("tag") or ""
        if not edit_id or not comment:
            self._send_json(400, {"error": "missing id or comment"})
            return
        data = self._load_comments()
        entry = {
            "id": edit_id,
            "tag": tag,
            "comment": comment,
            "excerpt": excerpt,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "file": str(self.html_path),
        }
        data.append(entry)
        self._save_comments(data)

        # Pi extension bridge: appends to the JSONL the watcher reads.
        append_trigger(entry)

        sys.stderr.write(
            f"[comment] {entry['timestamp']}  {edit_id} <{tag}>  "
            f"\"{comment}\"  (on: {excerpt!r})\n"
        )
        sys.stderr.flush()
        self._send_json(200, {"ok": True, "entry": entry, "bridge": str(TRIGGER_FILE)})


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", help="Path to the HTML file to edit")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true",
                    help="Don't auto-open the browser")
    args = ap.parse_args()

    html_path = Path(args.file).resolve()
    if not html_path.exists():
        sys.stderr.write(f"file not found: {html_path}\n")
        sys.exit(1)

    Handler.html_path = html_path
    Handler.comments_path = html_path.with_suffix(html_path.suffix + ".comments.json")

    ensure_edit_ids(html_path)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    sys.stderr.write(
        f"\n  serving:   {html_path}\n"
        f"  url:       {url}\n"
        f"  comments:  {Handler.comments_path}\n"
        f"  bridge:    {TRIGGER_FILE}  (load pi extension html-editor-comments + /reload)\n"
        f"  (Ctrl-C to stop)\n\n"
    )
    sys.stderr.flush()

    if not args.no_open:
        threading.Thread(
            target=lambda: (time.sleep(0.35), webbrowser.open(url)),
            daemon=True,
        ).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nbye\n")


if __name__ == "__main__":
    main()
