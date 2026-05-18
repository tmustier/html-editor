"""Document mutation: every operation that reads or writes the HTML file lives
here. No HTTP, no IO orchestration, no global state — just pure functions over
a BeautifulSoup tree (plus the disk read/write at the edges).

Every function takes a path or a soup explicitly. Adding a new editor capability
means adding one function here and one route in routes.py.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from bs4 import BeautifulSoup, NavigableString, Tag

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


# --- loading / saving -------------------------------------------------------

def load_soup(path: Path) -> BeautifulSoup:
    return BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")


def save_soup(path: Path, soup: BeautifulSoup) -> None:
    path.write_text(str(soup), encoding="utf-8")


# --- predicates / lookups ---------------------------------------------------

def is_inside_svg(el: Optional[Tag]) -> bool:
    return bool(el and (el.name == "svg" or el.find_parent("svg")))


def is_text_editable(el: Optional[Tag]) -> bool:
    """A leaf or mixed-inline HTML element whose contents are safe to overwrite
    as plain text or inline-only HTML. Excludes anything inside an SVG."""
    if el is None or is_inside_svg(el):
        return False
    child_tags = list(el.find_all(True))
    if not child_tags:
        return True
    return all((not is_inside_svg(c)) and c.name in INLINE_TEXT_TAGS for c in child_tags)


def find_by_edit_id(soup: BeautifulSoup, edit_id: str) -> Optional[Tag]:
    return soup.find(attrs={"data-edit-id": edit_id})


# --- ensure-edit-ids --------------------------------------------------------

def ensure_edit_ids(html_path: Path) -> BeautifulSoup:
    """Make sure every editable element has a data-edit-id. Persists changes to
    disk and returns the (possibly mutated) soup."""
    soup = load_soup(html_path)
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
    # its own data-edit-id). Direct text targets for flat SVG diagrams.
    for text_el in soup.find_all("text"):
        if not text_el.find_parent("svg"):
            continue
        if text_el.find_parent("g", attrs={"data-edit-id": True}) is not None:
            continue
        if not text_el.get("data-edit-id"):
            text_el["data-edit-id"] = f"e{next_id}"
            next_id += 1
            changed = True

    if changed:
        save_soup(html_path, soup)
    return soup


# --- inline-style helpers ---------------------------------------------------

def parse_inline_style(s: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (s or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k = k.strip()
            v = v.strip()
            if k:
                out[k] = v
    return out


def stringify_inline_style(d: dict[str, str]) -> str:
    return "; ".join(f"{k}: {v}" for k, v in d.items() if v)


# --- SVG text smart merge ---------------------------------------------------

def smart_update_svg_text(text_node: Tag, new_text: str) -> bool:
    """Update an SVG <text> element's visible text while preserving inline
    <tspan> formatting whenever possible.

    Strategy: flatten contents into segments (raw text runs and tspans),
    compute the changed character range via longest common prefix/suffix
    matching, and splice the change into the single affected segment so other
    segments keep their tspan attributes intact.

    Returns True if formatting was preserved (including trivial cases of no
    tspans or no change). Returns False if the structure had to be flattened
    to plain text because the edit crossed segment boundaries or the tspan
    structure was too complex to safely splice — callers can surface a warning.
    """
    segments = []  # list of dicts: {"text", "kind", "ref"}
    for child in list(text_node.contents):
        if isinstance(child, NavigableString):
            segments.append({"text": str(child), "kind": "text", "ref": child})
            continue
        if isinstance(child, Tag) and child.name == "tspan":
            # We can only safely splice a tspan that wraps a single text node.
            if any(not isinstance(c, NavigableString) for c in child.contents):
                text_node.clear()
                text_node.append(NavigableString(new_text))
                return False
            inner = "".join(str(c) for c in child.contents)
            segments.append({"text": inner, "kind": "tspan", "ref": child})
            continue
        # Unknown child kind (e.g. comment, other element). Bail.
        text_node.clear()
        text_node.append(NavigableString(new_text))
        return False

    if not segments:
        text_node.append(NavigableString(new_text))
        return True

    old_text = "".join(s["text"] for s in segments)
    if old_text == new_text:
        return True

    # Trivial: single segment — just update its inner text.
    if len(segments) == 1:
        seg = segments[0]
        if seg["kind"] == "text":
            seg["ref"].replace_with(NavigableString(new_text))
        else:
            seg["ref"].clear()
            seg["ref"].append(NavigableString(new_text))
        return True

    # Mixed segments: diff via longest common prefix/suffix.
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

    pos = 0
    seg_ranges = []  # (start, end, seg)
    for seg in segments:
        seg_ranges.append((pos, pos + len(seg["text"]), seg))
        pos += len(seg["text"])

    if change_start == change_end:
        # Pure insert at a boundary. Prefer the segment strictly containing
        # the insertion point; if exactly at a seam, prefer the earlier one
        # so insertions "extend" the prior segment naturally.
        affected = []
        for r in seg_ranges:
            start, end, _ = r
            if start < change_start < end:
                affected = [r]
                break
            if change_start == end or change_start == start:
                affected.append(r)
        if len(affected) > 1:
            affected = [affected[0]]
    else:
        affected = [r for r in seg_ranges if not (r[1] <= change_start or r[0] >= change_end)]

    if len(affected) != 1:
        # Cross-segment change — fall back to plain text and report loss.
        text_node.clear()
        text_node.append(NavigableString(new_text))
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
        seg["ref"].replace_with(NavigableString(new_seg_text))
    else:
        seg["ref"].clear()
        seg["ref"].append(NavigableString(new_seg_text))
    return True


# --- the actual mutations ---------------------------------------------------
#
# Each mutation returns (ok, payload). On ok=False, payload is {"error": str,
# "status": int}. On ok=True, payload is a JSON-serialisable dict. The routes
# layer turns these into HTTP responses.

def update_text(
    soup: BeautifulSoup,
    edit_id: str,
    new_text: str,
    new_html: Optional[str],
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if not is_text_editable(el):
        return False, {"status": 400, "error":
            "structural components can't be text-edited; select text inside the component"}
    el.clear()
    if isinstance(new_html, str):
        fragment = BeautifulSoup(new_html, "html.parser")
        for child in list(fragment.contents):
            el.append(child)
    else:
        el.append(NavigableString(new_text))
    return True, {"ok": True, "tag": el.name}


def update_text_many(
    soup: BeautifulSoup,
    updates: list[dict],
) -> tuple[bool, dict]:
    if not isinstance(updates, list) or not updates:
        return False, {"status": 400, "error": "expected non-empty updates[]"}
    applied = []
    for index, update in enumerate(updates):
        if not isinstance(update, dict):
            return False, {"status": 400, "error":
                f"update {index} must be an object"}
        edit_id = update.get("id")
        if not edit_id:
            return False, {"status": 400, "error":
                f"update {index} is missing id"}
        html = update.get("html")
        ok, result = update_text(
            soup,
            str(edit_id),
            str(update.get("text", "")),
            html if isinstance(html, str) else None,
        )
        if not ok:
            prefix = f"update {index} ({edit_id}) failed: "
            return False, {**result, "error": prefix + result.get("error", "unknown error")}
        applied.append({"id": edit_id, "tag": result.get("tag")})
    return True, {"ok": True, "count": len(applied), "updates": applied}


def update_svg_labels(
    soup: BeautifulSoup,
    edit_id: str,
    lines: list[str],
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if not el.find_parent("svg") and el.name != "svg":
        return False, {"status": 400, "error": "element is not inside an SVG"}

    if el.name == "text":
        text_nodes = [el]
    elif el.name == "g":
        if el.find("g", attrs={"data-edit-id": True}):
            return False, {"status": 400, "error":
                "edit a leaf diagram item, not a container SVG group"}
        text_nodes = el.find_all("text")
        if not text_nodes:
            return False, {"status": 400, "error":
                "selected SVG item has no text labels"}
    else:
        return False, {"status": 400, "error":
            "target is not an editable SVG group or text element"}

    if len(lines) != len(text_nodes):
        return False, {"status": 400, "error":
            f"expected {len(text_nodes)} label line(s), got {len(lines)}"}

    formatting_lost = False
    for text_node, line in zip(text_nodes, lines):
        if not smart_update_svg_text(text_node, str(line)):
            formatting_lost = True

    return True, {
        "ok": True,
        "id": edit_id,
        "lines": lines,
        "formatting_lost": formatting_lost,
    }


def move_element(
    soup: BeautifulSoup,
    edit_id: str,
    target_id: str,
    position: str,
) -> tuple[bool, dict]:
    if position not in {"before", "after"}:
        return False, {"status": 400, "error":
            "expected position=before|after"}
    if edit_id == target_id:
        return False, {"status": 400, "error":
            "can't move an element relative to itself"}

    el = find_by_edit_id(soup, edit_id)
    target = find_by_edit_id(soup, target_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if target is None:
        return False, {"status": 404, "error":
            f"target id {target_id} not found"}
    if is_inside_svg(el) or is_inside_svg(target):
        return False, {"status": 400, "error":
            "SVG diagram items can't be moved independently; "
            "drag the containing diagram/component"}
    if any(desc is target for desc in el.descendants):
        return False, {"status": 400, "error":
            "can't move an element relative to one of its own descendants"}
    if target.parent is None:
        return False, {"status": 400, "error": "target has no parent"}

    moved = el.extract()
    if position == "before":
        target.insert_before(moved)
    else:
        target.insert_after(moved)
    return True, {
        "ok": True,
        "id": edit_id,
        "target_id": target_id,
        "position": position,
    }


def move_svg(
    soup: BeautifulSoup,
    edit_id: str,
    tx: float,
    ty: float,
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if el.name != "g" or not el.find_parent("svg"):
        return False, {"status": 400, "error":
            "only labelled SVG groups can be moved spatially"}
    if el.find("g", attrs={"data-edit-id": True}):
        return False, {"status": 400, "error":
            "move leaf diagram items, not container SVG groups"}

    current = el.get("transform") or ""
    replacement = f"translate({tx:.2f} {ty:.2f})"
    if re.search(r"translate\s*\([^)]*\)", current):
        new_transform = re.sub(r"translate\s*\([^)]*\)", replacement,
                               current, count=1).strip()
    else:
        new_transform = (replacement + " " + current).strip()
    el["transform"] = new_transform
    return True, {"ok": True, "id": edit_id,
                  "translate_x": tx, "translate_y": ty}


def resize_element(
    soup: BeautifulSoup,
    edit_id: str,
    width: Optional[str] = None,
    height: Optional[str] = None,
    max_width: Optional[str] = None,
    max_height: Optional[str] = None,
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if is_inside_svg(el):
        return False, {"status": 400, "error":
            "SVG elements aren't resizable via this endpoint"}

    style_dict = parse_inline_style(el.get("style", ""))

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

    new_style = stringify_inline_style(style_dict)
    if new_style:
        el["style"] = new_style
    elif el.has_attr("style"):
        del el["style"]
    return True, {"ok": True, "id": edit_id, "style": new_style}
