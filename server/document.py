"""Document mutation: every operation that reads or writes the HTML file lives
here. No HTTP, no IO orchestration, no global state — just pure functions over
a BeautifulSoup tree (plus the disk read/write at the edges).

Every function takes a path or a soup explicitly. Adding a new editor capability
means adding one function here and one route in routes.py.
"""

from __future__ import annotations

import copy
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


def edit_id_index(soup: BeautifulSoup) -> dict[str, Tag]:
    """Return a one-pass data-edit-id lookup table for batch mutations.

    BeautifulSoup's ``find(attrs={...})`` is a full-tree scan. That is fine for
    one-off mutations but turns large range/table pastes into O(updates *
    nodes). Build this once for batch work and use plain dict lookups instead.
    """
    by_id: dict[str, Tag] = {}
    for el in soup.find_all(attrs={"data-edit-id": True}):
        # Preserve BeautifulSoup.find() semantics for malformed/source HTML
        # with duplicate ids: first element wins.
        by_id.setdefault(str(el["data-edit-id"]), el)
    return by_id


def find_by_edit_id(
    soup: BeautifulSoup,
    edit_id: str,
    index: Optional[dict[str, Tag]] = None,
) -> Optional[Tag]:
    if index is not None:
        return index.get(str(edit_id))
    return soup.find(attrs={"data-edit-id": edit_id})


# --- ensure-edit-ids --------------------------------------------------------

def assign_missing_edit_ids(soup: BeautifulSoup) -> bool:
    """Assign data-edit-id attributes to any newly-created editable elements.

    Returns True when the soup changed. This is the in-memory twin of
    ensure_edit_ids(), used by structural mutations that clone/insert nodes
    before the next page load.
    """
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

    return changed


def ensure_edit_ids(html_path: Path) -> BeautifulSoup:
    """Make sure every editable element has a data-edit-id. Persists changes to
    disk and returns the (possibly mutated) soup."""
    soup = load_soup(html_path)
    if assign_missing_edit_ids(soup):
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

def _apply_text_update(el: Tag, new_text: str, new_html: Optional[str]) -> None:
    el.clear()
    if isinstance(new_html, str):
        fragment = BeautifulSoup(new_html, "html.parser")
        for child in list(fragment.contents):
            el.append(child)
    else:
        el.append(NavigableString(new_text))


def update_text(
    soup: BeautifulSoup,
    edit_id: str,
    new_text: str,
    new_html: Optional[str],
    index: Optional[dict[str, Tag]] = None,
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id, index=index)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if not is_text_editable(el):
        return False, {"status": 400, "error":
            "structural components can't be text-edited; select text inside the component"}
    _apply_text_update(el, new_text, new_html)
    return True, {"ok": True, "tag": el.name}


def update_text_many(
    soup: BeautifulSoup,
    updates: list[dict],
) -> tuple[bool, dict]:
    if not isinstance(updates, list) or not updates:
        return False, {"status": 400, "error": "expected non-empty updates[]"}

    by_id = edit_id_index(soup)
    pending: list[tuple[str, Tag, str, Optional[str]]] = []
    for update_index, update in enumerate(updates):
        if not isinstance(update, dict):
            return False, {"status": 400, "error":
                f"update {update_index} must be an object"}
        edit_id = update.get("id")
        if not edit_id:
            return False, {"status": 400, "error":
                f"update {update_index} is missing id"}
        edit_id = str(edit_id)
        el = by_id.get(edit_id)
        if el is None:
            return False, {"status": 404, "error":
                f"update {update_index} ({edit_id}) failed: id {edit_id} not found"}
        if not is_text_editable(el):
            return False, {"status": 400, "error":
                f"update {update_index} ({edit_id}) failed: "
                "structural components can't be text-edited; select text inside the component"}
        html = update.get("html")
        pending.append((
            edit_id,
            el,
            str(update.get("text", "")),
            html if isinstance(html, str) else None,
        ))

    applied = []
    for edit_id, el, text, html in pending:
        _apply_text_update(el, text, html)
        applied.append({"id": edit_id, "tag": el.name})
    return True, {"ok": True, "count": len(applied), "updates": applied}


# --- table structure operations -------------------------------------------

TABLE_ACTIONS = {
    "row-insert-before", "row-insert-after", "row-delete",
    "row-copy-before", "row-copy-after",
    "row-move-up", "row-move-down", "row-move-to",
    "col-insert-before", "col-insert-after", "col-delete",
    "col-copy-before", "col-copy-after",
    "col-move-left", "col-move-right", "col-move-to",
}

TABLE_ACTIONS_NEED_TARGET = {"row-move-to", "col-move-to"}
TABLE_ACTIONS_NEED_SOURCE = {
    "row-copy-before", "row-copy-after",
    "col-copy-before", "col-copy-after",
}

ROW_GROUP_TAGS = {"thead", "tbody", "tfoot"}


def _direct_table_rows(table: Tag) -> list[Tag]:
    rows: list[Tag] = []
    for child in table.children:
        if not isinstance(child, Tag):
            continue
        if child.name == "tr":
            rows.append(child)
        elif child.name in ROW_GROUP_TAGS:
            rows.extend(
                row for row in child.children
                if isinstance(row, Tag) and row.name == "tr"
            )
    return rows


def _row_cells(row: Tag) -> list[Tag]:
    return [
        child for child in row.children
        if isinstance(child, Tag) and child.name in {"td", "th"}
    ]


def _positive_span(cell: Tag, attr: str) -> int:
    try:
        value = int(cell.get(attr, "1") or "1")
    except (TypeError, ValueError):
        value = 1
    return value if value > 0 else 1


def _cell_for_edit_id(soup: BeautifulSoup, edit_id: str) -> Optional[Tag]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return None
    if el.name in {"td", "th"}:
        return el
    return el.find_parent(["td", "th"])


def _table_geometry(soup: BeautifulSoup, cell_id: str) -> tuple[bool, dict]:
    cell = _cell_for_edit_id(soup, cell_id)
    if cell is None:
        return False, {"status": 404, "error": f"table cell id {cell_id} not found"}
    table = cell.find_parent("table")
    if table is None:
        return False, {"status": 400, "error": "selected element is not in a table"}
    rows = _direct_table_rows(table)
    if not rows:
        return False, {"status": 400, "error": "table has no editable rows"}

    grid: list[list[Tag]] = []
    selected_row = selected_col = -1
    for row_index, row in enumerate(rows):
        cells = _row_cells(row)
        if not cells:
            return False, {"status": 400, "error":
                "table structure edits require every row to have cells"}
        grid.append(cells)
        for col_index, candidate in enumerate(cells):
            if _positive_span(candidate, "rowspan") != 1 or _positive_span(candidate, "colspan") != 1:
                return False, {"status": 400, "error":
                    "table structure edits currently support simple tables only (no rowspan/colspan)"}
            if candidate is cell:
                selected_row = row_index
                selected_col = col_index

    width = len(grid[0])
    if width == 0 or any(len(row) != width for row in grid):
        return False, {"status": 400, "error":
            "table structure edits currently require rectangular tables"}
    if selected_row < 0 or selected_col < 0:
        return False, {"status": 400, "error": "selected cell is not in this table"}
    return True, {
        "cell": cell,
        "table": table,
        "rows": rows,
        "grid": grid,
        "row_index": selected_row,
        "col_index": selected_col,
        "width": width,
    }


def _strip_clone_identity(el: Tag) -> None:
    for attr in ("data-edit-id", "id"):
        if el.has_attr(attr):
            del el[attr]
    for child in el.find_all(True):
        for attr in ("data-edit-id", "id"):
            if child.has_attr(attr):
                del child[attr]


def _blank_text_nodes(el: Tag) -> None:
    for child in list(el.contents):
        if isinstance(child, NavigableString):
            child.replace_with(NavigableString(""))
        elif isinstance(child, Tag):
            _blank_text_nodes(child)


def _blank_clone(el: Tag) -> Tag:
    clone = copy.deepcopy(el)
    _strip_clone_identity(clone)
    _blank_text_nodes(clone)
    return clone


def table_operation(
    soup: BeautifulSoup,
    cell_id: str,
    action: str,
    *,
    target_index: Optional[int] = None,
    source_cell_id: Optional[str] = None,
    mode: str = "before",
    include_table_html: bool = False,
    include_table_patch: bool = False,
) -> tuple[bool, dict]:
    if action not in TABLE_ACTIONS:
        return False, {"status": 400, "error":
            "unknown table action"}
    if action in TABLE_ACTIONS_NEED_TARGET:
        if target_index is None:
            return False, {"status": 400, "error":
                f"{action} requires target_index"}
        if mode not in {"before", "after"}:
            return False, {"status": 400, "error":
                "mode must be 'before' or 'after'"}
    if action in TABLE_ACTIONS_NEED_SOURCE and not source_cell_id:
        return False, {"status": 400, "error":
            f"{action} requires source_cell_id"}
    ok, geometry = _table_geometry(soup, cell_id)
    if not ok:
        return ok, geometry

    table: Tag = geometry["table"]
    if action.startswith("col-") and (
        table.find("colgroup", recursive=False) or table.find("col", recursive=False)
    ):
        return False, {"status": 400, "error":
            "column structure edits don't support tables with colgroup/col yet"}

    source_geometry: Optional[dict] = None
    if action in TABLE_ACTIONS_NEED_SOURCE:
        ok, source_geometry = _table_geometry(soup, str(source_cell_id))
        if not ok:
            return ok, source_geometry
        if source_geometry["table"] is not table:
            return False, {"status": 400, "error":
                "can't insert copied rows or columns across tables yet"}

    rows: list[Tag] = geometry["rows"]
    grid: list[list[Tag]] = geometry["grid"]
    row_index: int = geometry["row_index"]
    col_index: int = geometry["col_index"]
    width: int = geometry["width"]
    row = rows[row_index]
    cell = geometry["cell"]
    selection: Optional[Tag] = cell
    patch: Optional[dict] = None
    table_id = table.get("data-edit-id")

    if action == "row-insert-before" or action == "row-insert-after":
        new_row = _blank_clone(row)
        if action.endswith("before"):
            row.insert_before(new_row)
        else:
            row.insert_after(new_row)
        assign_missing_edit_ids(soup)
        new_cells = _row_cells(new_row)
        selection = new_cells[min(col_index, len(new_cells) - 1)] if new_cells else new_row
        patch = {
            "kind": "row-insert",
            "table_id": table_id,
            "parent_id": new_row.parent.get("data-edit-id") if isinstance(new_row.parent, Tag) else None,
            "index": row_index if action.endswith("before") else row_index + 1,
            "row_html": str(new_row),
        }

    elif action == "row-copy-before" or action == "row-copy-after":
        assert source_geometry is not None
        source_row = source_geometry["rows"][source_geometry["row_index"]]
        new_row = copy.deepcopy(source_row)
        _strip_clone_identity(new_row)
        if action.endswith("before"):
            row.insert_before(new_row)
        else:
            row.insert_after(new_row)
        assign_missing_edit_ids(soup)
        new_cells = _row_cells(new_row)
        selection = new_cells[min(col_index, len(new_cells) - 1)] if new_cells else new_row
        patch = {
            "kind": "row-insert",
            "table_id": table_id,
            "parent_id": new_row.parent.get("data-edit-id") if isinstance(new_row.parent, Tag) else None,
            "index": row_index if action.endswith("before") else row_index + 1,
            "row_html": str(new_row),
        }

    elif action == "row-delete":
        if len(rows) <= 1:
            return False, {"status": 400, "error": "can't delete the only row in a table"}
        neighbor_row = rows[row_index + 1] if row_index + 1 < len(rows) else rows[row_index - 1]
        neighbor_cells = _row_cells(neighbor_row)
        selection = neighbor_cells[min(col_index, len(neighbor_cells) - 1)]
        patch = {"kind": "row-delete", "table_id": table_id, "index": row_index}
        row.decompose()

    elif action == "row-move-up" or action == "row-move-down":
        sibling_rows = [
            child for child in row.parent.children
            if isinstance(child, Tag) and child.name == "tr"
        ]
        sibling_index = sibling_rows.index(row)
        if action.endswith("up"):
            if sibling_index == 0:
                return False, {"status": 400, "error": "row is already first in its section"}
            sibling_rows[sibling_index - 1].insert_before(row.extract())
        else:
            if sibling_index == len(sibling_rows) - 1:
                return False, {"status": 400, "error": "row is already last in its section"}
            sibling_rows[sibling_index + 1].insert_after(row.extract())
        selection = cell
        patch = {
            "kind": "row-move",
            "table_id": table_id,
            "source_index": row_index,
            "target_index": row_index - 1 if action.endswith("up") else row_index + 1,
            "mode": "before" if action.endswith("up") else "after",
        }

    elif action == "col-insert-before" or action == "col-insert-after":
        inserted: list[Tag] = []
        for cells in grid:
            reference = cells[col_index]
            new_cell = _blank_clone(reference)
            if action.endswith("before"):
                reference.insert_before(new_cell)
            else:
                reference.insert_after(new_cell)
            inserted.append(new_cell)
        assign_missing_edit_ids(soup)
        selection = inserted[row_index]
        patch = {
            "kind": "col-insert",
            "table_id": table_id,
            "index": col_index if action.endswith("before") else col_index + 1,
            "cells_html": [str(inserted_cell) for inserted_cell in inserted],
        }

    elif action == "col-copy-before" or action == "col-copy-after":
        assert source_geometry is not None
        source_col_index = source_geometry["col_index"]
        source_grid: list[list[Tag]] = source_geometry["grid"]
        inserted = []
        for target_cells, source_cells in zip(grid, source_grid):
            reference = target_cells[col_index]
            new_cell = copy.deepcopy(source_cells[source_col_index])
            _strip_clone_identity(new_cell)
            if action.endswith("before"):
                reference.insert_before(new_cell)
            else:
                reference.insert_after(new_cell)
            inserted.append(new_cell)
        assign_missing_edit_ids(soup)
        selection = inserted[row_index]
        patch = {
            "kind": "col-insert",
            "table_id": table_id,
            "index": col_index if action.endswith("before") else col_index + 1,
            "cells_html": [str(inserted_cell) for inserted_cell in inserted],
        }

    elif action == "col-delete":
        if width <= 1:
            return False, {"status": 400, "error": "can't delete the only column in a table"}
        target_col = col_index + 1 if col_index < width - 1 else col_index - 1
        selection = grid[row_index][target_col]
        patch = {"kind": "col-delete", "table_id": table_id, "index": col_index}
        for cells in grid:
            cells[col_index].decompose()

    elif action == "col-move-left" or action == "col-move-right":
        if action.endswith("left"):
            if col_index == 0:
                return False, {"status": 400, "error": "column is already first"}
            for cells in grid:
                cells[col_index - 1].insert_before(cells[col_index].extract())
        else:
            if col_index == width - 1:
                return False, {"status": 400, "error": "column is already last"}
            for cells in grid:
                cells[col_index + 1].insert_after(cells[col_index].extract())
        selection = cell
        patch = {
            "kind": "col-move",
            "table_id": table_id,
            "source_index": col_index,
            "target_index": col_index - 1 if action.endswith("left") else col_index + 1,
            "mode": "before" if action.endswith("left") else "after",
        }

    elif action == "row-move-to":
        if not (0 <= target_index < len(rows)):
            return False, {"status": 400, "error": "target_index out of range"}
        target_row = rows[target_index]
        if target_row is row:
            return False, {"status": 400, "error":
                "row is already at that position"}
        if target_row.parent is not row.parent:
            return False, {"status": 400, "error":
                "can't move rows across thead/tbody/tfoot boundaries"}
        # Reject no-op moves (e.g. dropping just below current row with before).
        if target_index < row_index:
            new_index = target_index if mode == "before" else target_index + 1
        else:
            new_index = target_index - 1 if mode == "before" else target_index
        if new_index == row_index:
            return False, {"status": 400, "error":
                "row is already at that position"}
        moved = row.extract()
        if mode == "before":
            target_row.insert_before(moved)
        else:
            target_row.insert_after(moved)
        selection = cell

    elif action == "col-move-to":
        if not (0 <= target_index < width):
            return False, {"status": 400, "error": "target_index out of range"}
        if target_index == col_index:
            return False, {"status": 400, "error":
                "column is already at that position"}
        if target_index < col_index:
            new_index = target_index if mode == "before" else target_index + 1
        else:
            new_index = target_index - 1 if mode == "before" else target_index
        if new_index == col_index:
            return False, {"status": 400, "error":
                "column is already at that position"}
        for cells in grid:
            source_cell = cells[col_index]
            target_cell = cells[target_index]
            moved_cell = source_cell.extract()
            if mode == "before":
                target_cell.insert_before(moved_cell)
            else:
                target_cell.insert_after(moved_cell)
        selection = cell

    selection_id = selection.get("data-edit-id") if selection else None
    result = {
        "ok": True,
        "action": action,
        "cell_id": cell_id,
        "selection_id": selection_id,
    }
    if include_table_patch and patch:
        result["table_patch"] = patch
    if include_table_html:
        result["table_id"] = table_id
        result["table_html"] = str(table)
    return True, result


def duplicate_element(
    soup: BeautifulSoup,
    edit_id: str,
) -> tuple[bool, dict]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return False, {"status": 404, "error": f"id {edit_id} not found"}
    if el.parent is None:
        return False, {"status": 400, "error": "selected element has no parent"}
    if not is_inside_svg(el) and el.find_parent("table") is not None and el.name != "table":
        return False, {"status": 400, "error":
            "table internals should be duplicated with the row/column table actions"}
    if is_inside_svg(el):
        if el.name == "g":
            if not el.find("text") or el.find("g", attrs={"data-edit-id": True}):
                return False, {"status": 400, "error":
                    "only leaf labelled SVG groups can be duplicated"}
        elif el.name == "text":
            if el.find_parent("g", attrs={"data-edit-id": True}):
                return False, {"status": 400, "error":
                    "duplicate the labelled SVG group, not text inside it"}
        else:
            return False, {"status": 400, "error":
                "only labelled SVG groups/text can be duplicated"}

    clone = copy.deepcopy(el)
    _strip_clone_identity(clone)
    if is_inside_svg(el):
        current = clone.get("transform") or ""
        clone["transform"] = ("translate(12.00 12.00) " + current).strip()
    el.insert_after(clone)
    assign_missing_edit_ids(soup)
    new_id = clone.get("data-edit-id")
    return True, {
        "ok": True,
        "id": edit_id,
        "new_id": new_id,
        "tag": clone.name,
    }


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
