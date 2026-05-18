"""Semantic HTML table structure operations.

This module owns rectangular table geometry and row/column mutations. It stays
independent of document.py by receiving edit-id helpers from its caller.
"""

from __future__ import annotations

import copy
from typing import Callable, Optional

from bs4 import BeautifulSoup, NavigableString, Tag

FindByEditId = Callable[[BeautifulSoup, str], Optional[Tag]]
AssignMissingEditIds = Callable[[BeautifulSoup], bool]

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


def _cell_for_edit_id(
    soup: BeautifulSoup,
    edit_id: str,
    find_by_edit_id: FindByEditId,
) -> Optional[Tag]:
    el = find_by_edit_id(soup, edit_id)
    if el is None:
        return None
    if el.name in {"td", "th"}:
        return el
    return el.find_parent(["td", "th"])


def _table_geometry(
    soup: BeautifulSoup,
    cell_id: str,
    find_by_edit_id: FindByEditId,
) -> tuple[bool, dict]:
    cell = _cell_for_edit_id(soup, cell_id, find_by_edit_id)
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
    find_by_edit_id: FindByEditId,
    assign_missing_edit_ids: AssignMissingEditIds,
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
    ok, geometry = _table_geometry(soup, cell_id, find_by_edit_id)
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
        ok, source_geometry = _table_geometry(soup, str(source_cell_id), find_by_edit_id)
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
