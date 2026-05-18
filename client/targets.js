// Target model: every selectable element resolves to a semantic Target
// describing its capabilities (canEditText, canMove, kind). Other modules
// dispatch off this rather than re-deriving from the DOM each time.
//
// Also owns: predicates (isSvgGroup, isHtmlResizable, ...), DOM walks
// (editableFrom, nextEditableSibling, ...), navigation, breadcrumb
// rendering, and the toolbar-placement code.

import { INLINE_TEXT_TAGS } from "./config.js";
import { dom, flash, isOverlay, rectOf } from "./dom.js";
import { state } from "./state.js";

// --- predicates -----------------------------------------------------------

export const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
export const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
export const isSvgGroup = (el) => tagName(el) === "g" && isInsideSvg(el);
export const isSvgText  = (el) => tagName(el) === "text" && isInsideSvg(el);
export const hasChildElements = (el) => !!(el && el.querySelector && el.querySelector("*"));
const isInlineTextTag = (el) => INLINE_TEXT_TAGS.has(tagName(el));

export function isEditable(el) {
  if (!el || !el.getAttribute || !el.getAttribute("data-edit-id")) return false;
  return !isInsideSvg(el) || isSvgGroup(el) || isSvgText(el);
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

function isDraggableSvgGroup(el) {
  if (!isSvgGroup(el)) return false;
  return !Array.from(el.querySelectorAll("g[data-edit-id]")).some(isEditable);
}

export function isHtmlResizable(el) {
  if (!isEditable(el) || isInsideSvg(el)) return false;
  const tag = tagName(el);
  if (tag === "html" || tag === "body" || tag === "head") return false;
  if (INLINE_TEXT_TAGS.has(tag)) return false;
  const display = (window.getComputedStyle(el).display || "").toLowerCase();
  if (display === "inline" || display === "contents" || display === "none") return false;
  return true;
}

function svgTextNodes(el) {
  if (isSvgGroup(el)) return Array.from(el.querySelectorAll("text"));
  if (isSvgText(el)) return [el];
  return [];
}

export function svgTextFromHit(target) {
  if (!(target && target.closest)) return null;
  const text = target.closest("text");
  if (text) return text;
  const tspan = target.closest("tspan");
  return tspan && tspan.closest ? tspan.closest("text") : null;
}

export function isSvgLabelHit(target) {
  return !!svgTextFromHit(target);
}

// --- target model ---------------------------------------------------------

export function targetFor(el) {
  if (!isEditable(el)) return null;
  if (isSvgText(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-text",
      canEditText: true, canComment: true, canMove: false, moveMode: null,
    };
  }
  if (isDraggableSvgGroup(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-item",
      canEditText: svgTextNodes(el).length > 0,
      canComment: true, canMove: true, moveMode: "spatial",
    };
  }
  if (isInsideSvg(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-container",
      canEditText: false, canComment: true, canMove: false, moveMode: null,
    };
  }
  const canEditText = isTextEditableElement(el);
  return {
    el, id: el.getAttribute("data-edit-id"),
    kind: canEditText ? "html-text" : "html-structural",
    canEditText, canComment: true, canMove: true, moveMode: "reorder",
  };
}

export function currentTarget() {
  return targetFor(state.selected);
}

// --- DOM walks ------------------------------------------------------------

function textEditableRootFromHit(target) {
  if (!target || isInsideSvg(target)) return null;
  let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  let cur = el && el.closest ? el.closest("[data-edit-id]") : null;
  let best = null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (isTextEditableElement(cur) && !isInlineTextTag(cur)) best = cur;
    cur = cur.parentElement && cur.parentElement.closest
      ? cur.parentElement.closest("[data-edit-id]")
      : null;
  }
  return best;
}

export function editableFrom(target) {
  if (isInsideSvg(target)) {
    // Prefer a labelled <g> wrapping the hit; otherwise allow direct editing
    // of an orphan <text>. Anything else falls through to the generic
    // ancestor walk (which lands on the enclosing SVG container itself).
    const group = target.closest && target.closest("g[data-edit-id]");
    if (group && isEditable(group)) return group;
    const text = target.closest && target.closest("text[data-edit-id]");
    if (text && isEditable(text)) return text;
  }

  // Inline formatting/code runs are not independent text boxes. If a click
  // lands on <code>, <b>, <span>, etc. inside a larger editable text block,
  // edit/select the containing text box so arrow keys can move across the
  // style boundary like PowerPoint/Keynote text.
  const textRoot = textEditableRootFromHit(target);
  if (textRoot) return textRoot;

  let el = target;
  while (el && !isEditable(el)) el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return el;
}

export function editableAncestor(el) {
  while (el && !isEditable(el)) el = el.parentElement;
  return el && el !== document.body && el !== document.documentElement ? el : null;
}

export function prevEditableSibling(el) {
  let s = el && el.previousElementSibling;
  while (s) { if (isEditable(s)) return s; s = s.previousElementSibling; }
  return null;
}

export function nextEditableSibling(el) {
  let s = el && el.nextElementSibling;
  while (s) { if (isEditable(s)) return s; s = s.nextElementSibling; }
  return null;
}

export function firstEditableChild(el) {
  if (!el || !el.querySelectorAll) return null;
  if (el.querySelector("svg") || isSvgGroup(el)) {
    const groups = Array.from(el.querySelectorAll("g[data-edit-id]")).filter(isEditable);
    if (groups.length) {
      return groups.find((g) => !Array.from(g.querySelectorAll("g[data-edit-id]")).some(isEditable)) || groups[0];
    }
    const texts = Array.from(el.querySelectorAll("text[data-edit-id]")).filter(isEditable);
    if (texts.length) return texts[0];
    return null;
  }
  return Array.from(el.querySelectorAll("[data-edit-id]")).find((child) =>
    isEditable(child) && !(isInlineTextTag(child) && textEditableRootFromHit(child) === el)
  ) || null;
}

// --- grid/table navigation ------------------------------------------------

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

function selectionRectFor(el) {
  const mode = state.tableSelectionMode;
  if (mode && gridCellFrom(el)) {
    const selectionRect = unionDocumentRect(tableSelectionCells(el, mode));
    if (selectionRect) return selectionRect;
  }
  return rectOf(el);
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

export function selectTableDimension(mode) {
  const cell = gridCellFrom(state.selected);
  if (!cell || !["row", "column"].includes(mode)) {
    flash("Select a table cell first.", { kind: "warning" });
    return false;
  }
  selectElementInternal(cell, mode);
  ensureVisible(cell);
  return true;
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

// --- breadcrumbs / labels -------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function labelFor(el) {
  if (isSvgGroup(el)) {
    const label = Array.from(el.querySelectorAll("text"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 48);
    return label || "svg group";
  }
  if (isSvgText(el)) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return text ? `text "${text}"` : "svg text";
  }
  let label = tagName(el);
  const cls = typeof el.className === "string"
    ? el.className.split(/\s+/).filter((c) => c && !c.startsWith("__edit_"))[0]
    : "";
  if (el.id) label += "#" + el.id;
  else if (cls) label += "." + cls;
  return label;
}

export function breadcrumb(el) {
  if (isSvgGroup(el) || isSvgText(el)) {
    return `<span class="cur">${escapeHtml(labelFor(el))}</span>`;
  }
  const parts = [];
  let cur = el;
  while (cur && isEditable(cur) && parts.length < 4) {
    parts.unshift(labelFor(cur));
    cur = cur.parentElement;
  }
  return parts.map((p, i) =>
    i === parts.length - 1
      ? `<span class="cur">${escapeHtml(p)}</span>`
      : `<span>${escapeHtml(p)}</span>`
  ).join('<span class="arrow">›</span>');
}

// --- layout / placement ---------------------------------------------------

function canDuplicateElement(el, target) {
  if (!el || !target) return false;
  if (target.kind === "svg-text") return true;
  if (!target.canMove) return false;
  if (!isInsideSvg(el)) {
    const table = el.closest && el.closest("table");
    if (table && el !== table) return false;
  }
  return true;
}

function hideTableAddZones() {
  if (!dom.addRowZone || !dom.addColZone) return;
  dom.addRowZone.dataset.visible = "false";
  dom.addColZone.dataset.visible = "false";
}

export function placeTableAddZones(table) {
  if (!dom.addRowZone || !dom.addColZone) return;
  if (!table || state.editing || state.dragging) {
    hideTableAddZones();
    return;
  }
  const r = rectOf(table);
  const gap = 5;
  const thickness = 22; // pill height/width — big enough to hit comfortably
  const corner = 18; // leave the SE corner alone for resize/move grip
  // Bottom "+" row zone.
  const rowLeft = r.left;
  const rowWidth = Math.max(0, r.width - corner);
  if (rowWidth > 24) {
    dom.addRowZone.style.left = rowLeft + "px";
    dom.addRowZone.style.top = (r.top + r.height + gap) + "px";
    dom.addRowZone.style.width = rowWidth + "px";
    dom.addRowZone.style.height = thickness + "px";
    dom.addRowZone.dataset.visible = "true";
  } else {
    dom.addRowZone.dataset.visible = "false";
  }
  // Right "+" column zone.
  const colTop = r.top;
  const colHeight = Math.max(0, r.height - corner);
  if (colHeight > 24) {
    dom.addColZone.style.left = (r.left + r.width + gap) + "px";
    dom.addColZone.style.top = colTop + "px";
    dom.addColZone.style.width = thickness + "px";
    dom.addColZone.style.height = colHeight + "px";
    dom.addColZone.dataset.visible = "true";
  } else {
    dom.addColZone.dataset.visible = "false";
  }
}

export function refreshTableAddZones() {
  placeTableAddZones(state.hoveredTable);
}

function placeTableHandles(el) {
  const cell = gridCellFrom(el);
  if (!cell || state.editing || state.dragging) {
    dom.rowHandle.style.display = "none";
    dom.colHandle.style.display = "none";
    return;
  }
  const rowRect = unionDocumentRect(tableRowSpanCells(cell));
  const colRect = unionDocumentRect(tableColSpanCells(cell));
  const rowActive = state.tableSelectionMode === "row" || state.tableSelectionMode === "table";
  const colActive = state.tableSelectionMode === "column" || state.tableSelectionMode === "table";
  if (rowRect) {
    const outsideLeft = rowRect.left - 12;
    const clampedLeft = outsideLeft < window.scrollX + 2
      ? rowRect.left + 2
      : outsideLeft;
    dom.rowHandle.style.display = "block";
    dom.rowHandle.style.top = rowRect.top + "px";
    dom.rowHandle.style.left = clampedLeft + "px";
    dom.rowHandle.style.width = "10px";
    dom.rowHandle.style.height = rowRect.height + "px";
    dom.rowHandle.dataset.active = rowActive ? "true" : "false";
  } else {
    dom.rowHandle.style.display = "none";
  }
  if (colRect) {
    const outsideTop = colRect.top - 12;
    const clampedTop = outsideTop < window.scrollY + 2
      ? colRect.top + 2
      : outsideTop;
    dom.colHandle.style.display = "block";
    dom.colHandle.style.top = clampedTop + "px";
    dom.colHandle.style.left = colRect.left + "px";
    dom.colHandle.style.width = colRect.width + "px";
    dom.colHandle.style.height = "10px";
    dom.colHandle.dataset.active = colActive ? "true" : "false";
  } else {
    dom.colHandle.style.display = "none";
  }
}

export function placeBox(box, el) {
  if (!el) { box.style.display = "none"; return; }
  const r = box === dom.selectBox ? selectionRectFor(el) : rectOf(el);
  box.style.display = "block";
  box.style.top = r.top + "px";
  box.style.left = r.left + "px";
  box.style.width = r.width + "px";
  box.style.height = r.height + "px";
  if (box === dom.selectBox) {
    const target = targetFor(el);
    const isTableRange = !!state.tableSelectionMode;
    box.dataset.resizable = !isTableRange && isHtmlResizable(el) ? "true" : "false";
    box.dataset.canMove = !isTableRange && target && target.canMove ? "true" : "false";
    box.dataset.editing = state.editing ? "true" : "false";
    box.dataset.tableSelection = state.tableSelectionMode || "cell";
    placeTableHandles(el);
    refreshCutBadge();
    if (state.hoveredTable) placeTableAddZones(state.hoveredTable);
  }
}

function refreshCutBadge() {
  const cut = state.tableCut;
  if (!cut) { delete dom.selectBox.dataset.cut; return; }
  const cell = gridCellFrom(state.selected);
  if (!cell || state.tableSelectionMode !== cut.kind) {
    delete dom.selectBox.dataset.cut;
    return;
  }
  const table = cell.closest("table");
  const grid = gridForCell(cell);
  if (!table || !grid || table.getAttribute("data-edit-id") !== cut.tableId) {
    delete dom.selectBox.dataset.cut;
    return;
  }
  const lineIndex = cut.kind === "row"
    ? (() => {
        const allRows = Array.from(table.querySelectorAll("tr"));
        return allRows.indexOf(cell.closest("tr"));
      })()
    : grid.position.col;
  if (lineIndex === cut.index) dom.selectBox.dataset.cut = "true";
  else delete dom.selectBox.dataset.cut;
}

export function placeToolbar(el) {
  if (!el) { dom.toolbar.hidden = true; return; }
  const r = selectionRectFor(el);
  dom.toolbar.hidden = false;
  const target = targetFor(el);
  const isEditing = !!state.editing;
  const tableMode = state.tableSelectionMode;
  const isTableRange = !!tableMode;
  dom.toolbar.dataset.mode = isEditing ? "editing" : (tableMode || "selected");
  dom.pathEl.innerHTML = breadcrumb(el)
    + (isEditing ? '<span class="editing">editing</span>' : "")
    + (tableMode ? `<span class="selection">${tableMode}</span>` : "");
  dom.editBtn.disabled = isEditing || isTableRange || !(target && target.canEditText);
  dom.editBtn.title = isEditing
    ? "Already editing — Cmd+Enter saves, Esc cancels"
    : (target && (target.kind === "svg-item" || target.kind === "svg-text")
      ? "Edit this diagram label (F2, Enter, or double-click)"
      : (dom.editBtn.disabled
          ? "Structural component selected. Select text inside it to edit."
          : "Edit text (F2, Enter, or double-click)"));
  dom.commentBtn.disabled = isEditing || isTableRange;
  dom.dragBtn.disabled = isEditing || isTableRange || !(target && target.canMove);
  dom.duplicateBtn.disabled = isEditing || isTableRange || !canDuplicateElement(el, target);
  dom.duplicateBtn.title = isEditing
    ? "Finish editing before duplicating"
    : (dom.duplicateBtn.disabled
      ? "This element can't be duplicated directly"
      : "Duplicate this element with fresh edit IDs");
  dom.tableBtn.disabled = isEditing || !gridCellFrom(el);
  dom.tableBtn.title = isEditing
    ? "Finish editing before changing table structure"
    : (dom.tableBtn.disabled
      ? "Select a table cell for row/column actions"
      : "Insert, delete, or reorder rows and columns");
  if (dom.tableBtn.disabled) dom.tableMenu.hidden = true;
  dom.dragBtn.title = isEditing
    ? "Finish editing before moving this component"
    : (target && target.moveMode === "spatial"
      ? "Drag to reposition this diagram item"
      : (dom.dragBtn.disabled
          ? "This selected item cannot be moved directly"
          : "Drag the toolbar handle or selection border to move"));
  dom.undoBtn.disabled = isEditing;
  dom.redoBtn.disabled = isEditing;
  dom.closeBtn.disabled = isEditing;
  dom.navParent.disabled = isEditing || isTableRange || !editableAncestor(el.parentElement);
  dom.navChild.disabled  = isEditing || isTableRange || !firstEditableChild(el);
  dom.navPrev.disabled   = isEditing || isTableRange || !prevEditableSibling(el);
  dom.navNext.disabled   = isEditing || isTableRange || !nextEditableSibling(el);

  const tb = dom.toolbar.getBoundingClientRect();
  let top = r.top - tb.height - 6;
  let left = r.left;
  if (tableMode || gridCellFrom(el)) {
    top = r.top + r.height + 8;
    if (top + tb.height > window.scrollY + window.innerHeight - 8) {
      top = r.top - tb.height - 18;
    }
  } else if (top < window.scrollY + 4) top = r.top + r.height + 6;
  if (top < window.scrollY + 4) top = window.scrollY + 4;
  const maxLeft = window.scrollX + window.innerWidth - tb.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  dom.toolbar.style.top = top + "px";
  dom.toolbar.style.left = left + "px";
}

// --- navigation -----------------------------------------------------------

export function ensureVisible(el) {
  const r = el.getBoundingClientRect();
  const pad = 64;
  if (r.top < pad || r.bottom > window.innerHeight - pad) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export function toggleHelp(force) {
  dom.helpOverlay.hidden = typeof force === "boolean" ? !force : !dom.helpOverlay.hidden;
}

// Re-exported by events.js; defined here because selectElement depends on a
// few targets-module helpers.
export function selectElementInternal(el, tableSelectionMode = null, options = {}) {
  // Reset any active range when selecting a brand-new element, unless the
  // caller is explicitly preserving it (e.g. during a Shift+Arrow extension
  // or a same-cell mode promotion). A plain click on another cell, even in
  // the same table, should drop the stale range so the next Shift+Space /
  // Ctrl+Space promotes the new cell rather than the old range.
  if (!options.preserveRange) state.tableRange = null;
  state.selected = el;
  state.tableSelectionMode = tableSelectionMode;
  state.hovered = null;
  dom.hoverBox.style.display = "none";
  placeBox(dom.selectBox, el);
  placeToolbar(el);
  dom.commentBox.hidden = true;
  dom.tableMenu.hidden = true;
  if (!state.svgEditing) dom.svgEditor.hidden = true;
  // "+" append zones are proximity-driven (see events.js), so don't pin them
  // to the selection here — let mousemove decide whether they belong on screen.
}

export function navigate(direction) {
  if (!state.selected) return;
  let target = null;
  if (direction === "left")  target = prevEditableSibling(state.selected);
  else if (direction === "right") target = nextEditableSibling(state.selected);
  else if (direction === "up")    target = editableAncestor(state.selected.parentElement);
  else if (direction === "down")  target = firstEditableChild(state.selected);
  if (!target) { flash("No editable element in that direction.", { kind: "warning" }); return; }
  selectElementInternal(target);
  ensureVisible(target);
}

export function navigateGrid(direction) {
  if (!state.selected) return false;
  const target = direction === "next"
    ? gridTabNeighbor(state.selected, true)
    : direction === "previous"
      ? gridTabNeighbor(state.selected, false)
      : direction.startsWith("edge-")
        ? gridEdgeNeighbor(state.selected, direction.slice(5))
        : gridNeighbor(state.selected, direction);
  if (!target) return false;
  selectElementInternal(target);
  ensureVisible(target);
  return true;
}
