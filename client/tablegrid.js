// Table-grid geometry, range state, and spreadsheet-style cell navigation.
//
// This module intentionally stays DOM-only and framework-free. It owns the
// rectangular matrix view of semantic HTML tables that keyboard navigation,
// range copy/paste, row/column handles, drag targets, and structural table
// operations all share.

import { INLINE_TEXT_TAGS } from "./config.js";
import { rectOf } from "./dom.js";
import { state } from "./state.js";

const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
const isInlineTextTag = (el) => INLINE_TEXT_TAGS.has(tagName(el));

function isEditable(el) {
  if (!el || !el.getAttribute || !el.getAttribute("data-edit-id")) return false;
  return !isInsideSvg(el) || tagName(el) === "g" || tagName(el) === "text";
}

function hasChildElements(el) {
  return !!(el && el.querySelector && el.querySelector("*"));
}

function hasOnlyInlineDescendants(el) {
  if (!el || !el.querySelectorAll) return true;
  return Array.from(el.querySelectorAll("*")).every((child) =>
    !isInsideSvg(child) && INLINE_TEXT_TAGS.has(tagName(child))
  );
}

function isTextEditableElement(el) {
  return isEditable(el) && !isInsideSvg(el)
    && (!hasChildElements(el) || hasOnlyInlineDescendants(el));
}

function firstEditableChild(el) {
  if (!el || !el.querySelectorAll) return null;
  return Array.from(el.querySelectorAll("[data-edit-id]")).find((child) =>
    isEditable(child) && !(isInlineTextTag(child) && child.parentElement === el)
  ) || null;
}

export function gridCellFrom(el) {
  if (!el || isInsideSvg(el)) return null;
  const node = el.nodeType === Node.ELEMENT_NODE ? el : el.parentElement;
  const cell = node && node.closest ? node.closest("td, th") : null;
  return cell && isEditable(cell) ? cell : null;
}

function positiveSpan(value, fallback) {
  const n = Number.parseInt(value || String(fallback || 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function selectableInCell(cell) {
  if (!cell) return null;
  if (isEditable(cell)) return cell;
  return firstEditableChild(cell);
}

function gridForCell(cell) {
  const table = cell && cell.closest ? cell.closest("table") : null;
  if (!table) return null;
  const rows = Array.from(table.rows || table.querySelectorAll("tr"));
  const matrix = [];
  const cells = [];
  let position = null;

  rows.forEach((row, rowIndex) => {
    matrix[rowIndex] = matrix[rowIndex] || [];
    let colIndex = 0;
    Array.from(row.cells || row.querySelectorAll("th, td")).forEach((cellEl) => {
      while (matrix[rowIndex][colIndex]) colIndex += 1;
      const rowSpan = positiveSpan(cellEl.getAttribute("rowspan"), cellEl.rowSpan);
      const colSpan = positiveSpan(cellEl.getAttribute("colspan"), cellEl.colSpan);
      const entry = { cell: cellEl, row: rowIndex, col: colIndex, rowSpan, colSpan };
      cells.push(entry);
      if (cellEl === cell) position = entry;
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        matrix[r] = matrix[r] || [];
        for (let c = colIndex; c < colIndex + colSpan; c += 1) {
          matrix[r][c] = cellEl;
        }
      }
      colIndex += colSpan;
    });
  });

  return position ? { table, rows, matrix, cells, position } : null;
}

function differentCellAt(matrix, row, col, current) {
  const cell = matrix[row] && matrix[row][col];
  if (!cell || cell === current) return null;
  return selectableInCell(cell);
}

function uniqueCells(cells) {
  const seen = new Set();
  return cells.filter((cell) => {
    if (!cell || seen.has(cell)) return false;
    seen.add(cell);
    return true;
  });
}

// Cells the current table selection covers, given the active mode. Honors
// `state.tableRange` when it refers to the same table so multi-row, multi-col,
// and multi-cell ranges all light up.
export function tableSelectionCells(el, mode) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid || !mode) return [];
  const { matrix, position } = grid;
  const range = state.tableRange && state.tableRange.table === grid.table
    ? state.tableRange
    : null;

  if (mode === "table") {
    return uniqueCells(matrix.flatMap((row) => row || []).filter(Boolean));
  }

  if (mode === "range") {
    if (!range) return [cell];
    const r1 = Math.min(range.anchor.row, range.focus.row);
    const r2 = Math.max(range.anchor.row, range.focus.row);
    const c1 = Math.min(range.anchor.col, range.focus.col);
    const c2 = Math.max(range.anchor.col, range.focus.col);
    const out = [];
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (matrix[r] && matrix[r][c]) out.push(matrix[r][c]);
      }
    }
    return uniqueCells(out);
  }

  if (mode === "row") {
    const r1 = range ? Math.min(range.anchor.row, range.focus.row) : position.row;
    const r2 = range ? Math.max(range.anchor.row, range.focus.row) : position.row;
    const out = [];
    for (let r = r1; r <= r2; r += 1) out.push(...(matrix[r] || []));
    return uniqueCells(out);
  }

  if (mode === "column") {
    const c1 = range ? Math.min(range.anchor.col, range.focus.col) : position.col;
    const c2 = range ? Math.max(range.anchor.col, range.focus.col) : position.col;
    const out = [];
    matrix.forEach((row) => {
      for (let c = c1; c <= c2; c += 1) {
        if (row && row[c]) out.push(row[c]);
      }
    });
    return uniqueCells(out);
  }

  return [];
}

// Cells spanning the *rows* the current selection covers (for handle placement
// regardless of selection mode). Multi-row in range/row mode, full table in
// table mode, single row in cell/column mode.
export function tableRowSpanCells(el) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return [];
  const { matrix, position } = grid;
  if (state.tableSelectionMode === "table") {
    return uniqueCells(matrix.flatMap((row) => row || []).filter(Boolean));
  }
  const range = state.tableRange && state.tableRange.table === grid.table
    ? state.tableRange
    : null;
  const wantMulti = state.tableSelectionMode === "row"
    || state.tableSelectionMode === "range";
  const r1 = (range && wantMulti) ? Math.min(range.anchor.row, range.focus.row) : position.row;
  const r2 = (range && wantMulti) ? Math.max(range.anchor.row, range.focus.row) : position.row;
  const out = [];
  for (let r = r1; r <= r2; r += 1) out.push(...(matrix[r] || []));
  return uniqueCells(out);
}

// Cells spanning the *columns* the current selection covers.
export function tableColSpanCells(el) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return [];
  const { matrix, position } = grid;
  if (state.tableSelectionMode === "table") {
    return uniqueCells(matrix.flatMap((row) => row || []).filter(Boolean));
  }
  const range = state.tableRange && state.tableRange.table === grid.table
    ? state.tableRange
    : null;
  const wantMulti = state.tableSelectionMode === "column"
    || state.tableSelectionMode === "range";
  const c1 = (range && wantMulti) ? Math.min(range.anchor.col, range.focus.col) : position.col;
  const c2 = (range && wantMulti) ? Math.max(range.anchor.col, range.focus.col) : position.col;
  const out = [];
  matrix.forEach((row) => {
    for (let c = c1; c <= c2; c += 1) {
      if (row && row[c]) out.push(row[c]);
    }
  });
  return uniqueCells(out);
}

// Range bounds for `state.tableRange` (or null if there's no active range).
// Always returns rows/cols in canonical (min..max) order.
export function rangeBounds(range = state.tableRange) {
  if (!range) return null;
  return {
    table: range.table,
    r1: Math.min(range.anchor.row, range.focus.row),
    r2: Math.max(range.anchor.row, range.focus.row),
    c1: Math.min(range.anchor.col, range.focus.col),
    c2: Math.max(range.anchor.col, range.focus.col),
  };
}

// 2D matrix of *text-editable* target elements covering the active range.
// Returns [] when there's no usable range. Missing cells become `null`
// (callers should treat them as no-ops).
export function tableRangeMatrix(range = state.tableRange) {
  const bounds = rangeBounds(range);
  if (!bounds) return [];
  const cell = gridCellFrom(state.selected);
  const grid = cell && gridForCell(cell);
  if (!grid || grid.table !== bounds.table) return [];
  const { matrix } = grid;
  const out = [];
  for (let r = bounds.r1; r <= bounds.r2; r += 1) {
    const row = [];
    for (let c = bounds.c1; c <= bounds.c2; c += 1) {
      const targetCell = matrix[r] && matrix[r][c];
      const target = targetCell ? selectableInCell(targetCell) : null;
      row.push(target && isTextEditableElement(target) ? target : null);
    }
    out.push(row);
  }
  return out;
}

// Anchor target element (top-left of the range or just the active cell).
export function rangeAnchorElement(range = state.tableRange) {
  const bounds = rangeBounds(range);
  if (!bounds) return state.selected || null;
  const cell = gridCellFrom(state.selected);
  const grid = cell && gridForCell(cell);
  if (!grid || grid.table !== bounds.table) return state.selected || null;
  const anchorCell = grid.matrix[bounds.r1] && grid.matrix[bounds.r1][bounds.c1];
  if (!anchorCell) return state.selected || null;
  const target = selectableInCell(anchorCell);
  return target && isTextEditableElement(target) ? target : null;
}

// Mutate `state.tableRange` to extend the focus corner by one cell.
// Returns true if a visible change happened.
export function extendTableRange(direction) {
  const cell = gridCellFrom(state.selected);
  const grid = cell && gridForCell(cell);
  if (!grid) return false;
  const table = grid.table;
  const here = state.tableRange && state.tableRange.table === table
    ? state.tableRange
    : {
        table,
        anchor: { row: grid.position.row, col: grid.position.col },
        focus: { row: grid.position.row, col: grid.position.col },
      };
  const maxRow = grid.matrix.length - 1;
  const maxCol = (grid.matrix[0] || []).length - 1;
  const next = { row: here.focus.row, col: here.focus.col };
  if (direction === "up")    next.row = Math.max(0, here.focus.row - 1);
  if (direction === "down")  next.row = Math.min(maxRow, here.focus.row + 1);
  if (direction === "left")  next.col = Math.max(0, here.focus.col - 1);
  if (direction === "right") next.col = Math.min(maxCol, here.focus.col + 1);
  if (next.row === here.focus.row && next.col === here.focus.col) return false;
  here.focus = next;
  state.tableRange = here;
  const collapsed = next.row === here.anchor.row && next.col === here.anchor.col;
  // Range extension keeps row/column promotion when the user is already in
  // those modes; otherwise it lights up the rectangle.
  if (state.tableSelectionMode !== "row" && state.tableSelectionMode !== "column") {
    state.tableSelectionMode = collapsed ? null : "range";
  }
  if (collapsed) state.tableRange = null;
  return true;
}

export function clearTableRange() {
  state.tableRange = null;
}

export function gridForElement(el) {
  const cell = gridCellFrom(el);
  return cell && gridForCell(cell);
}

// Returns the table this cell lives in along with the index of the row that
// contains the cell within _all_ rows of the table (including thead/tfoot).
export function tableRowIndexOf(cell) {
  const table = cell && cell.closest && cell.closest("table");
  if (!table) return null;
  const allRows = Array.from(table.querySelectorAll("tr"));
  const row = cell.closest("tr");
  const index = allRows.indexOf(row);
  if (index < 0) return null;
  return { table, row, index, total: allRows.length };
}

function unionDocumentRect(elements) {
  const rects = elements.filter(Boolean).map(rectOf);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

function unionViewportRect(elements) {
  const rects = elements.filter(Boolean).map((el) => el.getBoundingClientRect());
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Lists every line (row or column) of the table containing `cell` as a set of
// {index, rect} entries in document coordinates. Used for drag-reorder drop
// indicators and "+" zone placement.
export function tableLineRects(cell, axis) {
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const lines = [];
  if (axis === "row") {
    grid.matrix.forEach((row, rowIdx) => {
      const cells = uniqueCells(row || []);
      const rect = unionDocumentRect(cells);
      if (rect) lines.push({ index: rowIdx, rect });
    });
  } else if (axis === "column") {
    const width = grid.matrix[0] ? grid.matrix[0].length : 0;
    for (let c = 0; c < width; c += 1) {
      const cells = uniqueCells(grid.matrix.map((row) => row && row[c]).filter(Boolean));
      const rect = unionDocumentRect(cells);
      if (rect) lines.push({ index: c, rect });
    }
  }
  const tableRect = grid.table ? rectOf(grid.table) : null;
  return { lines, tableRect, table: grid.table };
}

// Given a viewport-space pointer, find the row/column drop slot relative to
// the table the source cell belongs to. Returns { axis, targetIndex, mode,
// rect, sourceIndex } or null.
export function dropSlotFor(sourceCell, axis, clientX, clientY, cachedInfo = null) {
  const info = cachedInfo || tableLineRects(sourceCell, axis);
  if (!info || !info.lines.length) return null;
  const x = clientX + window.scrollX;
  const y = clientY + window.scrollY;
  const sourceIndex = info.sourceIndex ?? (axis === "row"
    ? tableRowIndexOf(sourceCell)?.index
    : gridForCell(sourceCell)?.position.col);
  let best = null;
  for (const { index, rect } of info.lines) {
    if (axis === "row") {
      const mid = rect.top + rect.height / 2;
      const candidate = y < mid
        ? { axis, targetIndex: index, mode: "before", rect, sourceIndex }
        : { axis, targetIndex: index, mode: "after", rect, sourceIndex };
      const distance = Math.abs(y - mid);
      if (!best || distance < best._d) best = { ...candidate, _d: distance };
    } else {
      const mid = rect.left + rect.width / 2;
      const candidate = x < mid
        ? { axis, targetIndex: index, mode: "before", rect, sourceIndex }
        : { axis, targetIndex: index, mode: "after", rect, sourceIndex };
      const distance = Math.abs(x - mid);
      if (!best || distance < best._d) best = { ...candidate, _d: distance };
    }
  }
  if (!best) return null;
  // Detect drops that would be no-ops (same effective position).
  if (best.sourceIndex != null) {
    let newIndex;
    if (best.targetIndex < best.sourceIndex) {
      newIndex = best.mode === "before" ? best.targetIndex : best.targetIndex + 1;
    } else if (best.targetIndex > best.sourceIndex) {
      newIndex = best.mode === "before" ? best.targetIndex - 1 : best.targetIndex;
    } else {
      newIndex = best.sourceIndex;
    }
    best.noop = newIndex === best.sourceIndex;
  }
  delete best._d;
  return best;
}

// Bounding-rect helper for the table around `el`, used by edge "+" zones.
export function tableRectFor(el) {
  const cell = gridCellFrom(el);
  const table = cell && cell.closest ? cell.closest("table") : null;
  if (!table) return null;
  return { rect: rectOf(table), table, cell };
}

export function tableEdgeSelectionModeFromEvent(event, el) {
  const cell = gridCellFrom(el);
  if (!cell || !event) return null;
  const rowRect = unionViewportRect(tableSelectionCells(cell, "row"));
  const colRect = unionViewportRect(tableSelectionCells(cell, "column"));
  const tolerance = 10;
  if (rowRect && event.clientX >= rowRect.left && event.clientX <= rowRect.left + tolerance
      && event.clientY >= rowRect.top && event.clientY <= rowRect.bottom) {
    return "row";
  }
  if (colRect && event.clientY >= colRect.top && event.clientY <= colRect.top + tolerance
      && event.clientX >= colRect.left && event.clientX <= colRect.right) {
    return "column";
  }
  return null;
}

export function gridNeighbor(el, direction) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const { matrix, position } = grid;
  const cols = Array.from(
    { length: position.colSpan },
    (_, i) => position.col + i,
  );

  if (direction === "up") {
    for (let r = position.row - 1; r >= 0; r -= 1) {
      for (const c of cols) {
        const target = differentCellAt(matrix, r, c, cell);
        if (target) return target;
      }
    }
  }
  if (direction === "down") {
    for (let r = position.row + position.rowSpan; r < matrix.length; r += 1) {
      for (const c of cols) {
        const target = differentCellAt(matrix, r, c, cell);
        if (target) return target;
      }
    }
  }
  if (direction === "left") {
    for (let c = position.col - 1; c >= 0; c -= 1) {
      const target = differentCellAt(matrix, position.row, c, cell);
      if (target) return target;
    }
  }
  if (direction === "right") {
    const row = matrix[position.row] || [];
    for (let c = position.col + position.colSpan; c < row.length; c += 1) {
      const target = differentCellAt(matrix, position.row, c, cell);
      if (target) return target;
    }
  }
  return null;
}

export function gridTabNeighbor(el, forward = true) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const ordered = grid.cells
    .map((entry) => entry.cell)
    .filter((candidate) => selectableInCell(candidate));
  const index = ordered.indexOf(cell);
  if (index < 0) return null;
  return selectableInCell(ordered[index + (forward ? 1 : -1)]);
}

export function gridPasteTargets(el, values) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid || !Array.isArray(values)) return [];
  const { matrix, position } = grid;
  const targets = [];
  const seen = new Set();
  values.forEach((row, rowOffset) => {
    if (!Array.isArray(row)) return;
    row.forEach((text, colOffset) => {
      const targetCell = matrix[position.row + rowOffset]
        && matrix[position.row + rowOffset][position.col + colOffset];
      if (!targetCell || seen.has(targetCell)) return;
      const target = selectableInCell(targetCell);
      if (!target || !isTextEditableElement(target)) return;
      seen.add(targetCell);
      targets.push({ el: target, text: String(text ?? "") });
    });
  });
  return targets;
}

export function gridEdgeNeighbor(el, direction) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const { matrix, position } = grid;
  const targetAt = (candidate) =>
    candidate && candidate !== cell ? selectableInCell(candidate) : null;

  if (direction === "left") {
    const row = matrix[position.row] || [];
    for (let c = 0; c < position.col; c += 1) {
      const target = targetAt(row[c]);
      if (target) return target;
    }
  }
  if (direction === "right") {
    const row = matrix[position.row] || [];
    for (let c = row.length - 1; c >= position.col + position.colSpan; c -= 1) {
      const target = targetAt(row[c]);
      if (target) return target;
    }
  }
  if (direction === "up") {
    for (let r = 0; r < position.row; r += 1) {
      const target = targetAt(matrix[r] && matrix[r][position.col]);
      if (target) return target;
    }
  }
  if (direction === "down") {
    for (let r = matrix.length - 1; r >= position.row + position.rowSpan; r -= 1) {
      const target = targetAt(matrix[r] && matrix[r][position.col]);
      if (target) return target;
    }
  }

  return null;
}
