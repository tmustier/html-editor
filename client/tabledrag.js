// Row/column drag-reorder and Excel-style cut+paste moves.
//
// These live in their own module so events.js can stay focused on routing.
// The drag flow is independent from drag.js because it operates on table
// rows/columns, not arbitrary DOM elements: the dragged thing is a logical
// row/column, not a single DOM node, and the drop result calls
// /table-operation rather than /move-element.

import { api } from "./api.js";
import { dom, flash } from "./dom.js";
import { reloadAfterMutation } from "./interaction.js";
import { state } from "./state.js";
import { applyTableSnapshot } from "./tableops.js";
import {
  dropSlotFor,
  ensureVisible,
  gridCellFrom,
  gridForElement,
  refreshTableAddZones,
  selectElementInternal,
  tableLineRects,
  tableRowIndexOf,
} from "./targets.js";

const NOOP_BG = "rgba(124, 58, 237, 0.18)";
const MOVE_BG = "#7c3aed";

function clearDropIndicator() {
  if (!dom.tableDrop) return;
  dom.tableDrop.hidden = true;
  dom.tableDrop.removeAttribute("data-axis");
}

function showDropIndicator(slot) {
  if (!dom.tableDrop || !slot) { clearDropIndicator(); return; }
  const r = slot.rect;
  const el = dom.tableDrop;
  el.hidden = false;
  el.dataset.axis = slot.axis;
  el.style.background = slot.noop ? NOOP_BG : MOVE_BG;
  if (slot.axis === "row") {
    const y = slot.mode === "before" ? r.top : r.top + r.height;
    el.style.left = r.left + "px";
    el.style.top = (y - 1) + "px";
    el.style.width = r.width + "px";
    el.style.height = "3px";
  } else {
    const x = slot.mode === "before" ? r.left : r.left + r.width;
    el.style.left = (x - 1) + "px";
    el.style.top = r.top + "px";
    el.style.height = r.height + "px";
    el.style.width = "3px";
  }
}

export function beginTableLineDrag(axis, event) {
  if (state.editing || state.dragging) return;
  const cell = gridCellFrom(state.selected);
  if (!cell || !["row", "column"].includes(axis)) return;
  event.preventDefault();
  event.stopPropagation();
  const grid = gridForElement(state.selected);
  const sourceIndex = axis === "row"
    ? tableRowIndexOf(cell)?.index
    : grid?.position.col;
  const lineInfo = tableLineRects(cell, axis);
  state.dragging = {
    mode: "table-line",
    axis,
    cell,
    cellId: cell.getAttribute("data-edit-id"),
    table: cell.closest("table"),
    lineInfo: lineInfo ? { ...lineInfo, sourceIndex } : null,
    slot: null,
  };
  document.documentElement.classList.add("__edit_dragging-line");
  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  document.addEventListener("mousemove", onLineDragMove, true);
  document.addEventListener("mouseup", onLineDragEnd, true);
  updateLineDrag(event);
}

function updateLineDrag(event) {
  if (!state.dragging || state.dragging.mode !== "table-line") return;
  event.preventDefault();
  const slot = dropSlotFor(state.dragging.cell, state.dragging.axis,
    event.clientX, event.clientY, state.dragging.lineInfo);
  state.dragging.slot = slot;
  showDropIndicator(slot);
}

function onLineDragMove(event) { updateLineDrag(event); }

async function onLineDragEnd(event) {
  if (!state.dragging || state.dragging.mode !== "table-line") return;
  event.preventDefault();
  event.stopPropagation();
  const { axis, cellId, slot } = state.dragging;
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging-line");
  document.removeEventListener("mousemove", onLineDragMove, true);
  document.removeEventListener("mouseup", onLineDragEnd, true);
  clearDropIndicator();

  if (!slot || slot.noop) {
    return; // silent no-op: cancelled or dropped on the same place
  }
  await runMoveTo(axis, cellId, slot.targetIndex, slot.mode);
}

function cellSelector(id) {
  return `[data-edit-id="${CSS.escape(id)}"]`;
}

function rememberSelectionForReload(selectionId, axis) {
  if (!selectionId) return;
  sessionStorage.setItem("__edit_restore_selection", selectionId);
  sessionStorage.setItem("__edit_restore_table_mode", axis);
}

function moveRowInDom(sourceCell, targetIndex, mode) {
  const grid = gridForElement(sourceCell);
  const sourceRow = sourceCell?.closest("tr");
  const targetRow = grid?.matrix?.[targetIndex]?.[0]?.closest("tr");
  if (!sourceRow || !targetRow || !sourceRow.parentNode || !targetRow.parentNode) {
    return false;
  }
  if (sourceRow.parentNode !== targetRow.parentNode) return false;
  if (mode === "before") targetRow.parentNode.insertBefore(sourceRow, targetRow);
  else targetRow.parentNode.insertBefore(sourceRow, targetRow.nextSibling);
  return true;
}

function moveColumnInDom(sourceCell, targetIndex, mode) {
  const grid = gridForElement(sourceCell);
  const sourceIndex = grid?.position?.col;
  if (sourceIndex == null) return false;
  const moves = [];
  for (const row of grid.matrix || []) {
    const source = row?.[sourceIndex];
    const target = row?.[targetIndex];
    if (!source || !target || !source.parentNode || source.parentNode !== target.parentNode) {
      return false;
    }
    moves.push({ source, target });
  }
  for (const { source, target } of moves) {
    if (mode === "before") target.parentNode.insertBefore(source, target);
    else target.parentNode.insertBefore(source, target.nextSibling);
  }
  return true;
}

function applyMoveToDom(axis, cellId, targetIndex, mode, selectionId) {
  const sourceCell = document.querySelector(cellSelector(cellId));
  if (!sourceCell) return false;
  const moved = axis === "row"
    ? moveRowInDom(sourceCell, targetIndex, mode)
    : moveColumnInDom(sourceCell, targetIndex, mode);
  if (!moved) return false;
  const selected = selectionId
    ? document.querySelector(cellSelector(selectionId))
    : sourceCell;
  if (!selected) return false;
  selectElementInternal(selected, axis);
  ensureVisible(selected);
  refreshTableAddZones();
  return true;
}

export async function runMoveTo(axis, cellId, targetIndex, mode) {
  const action = axis === "row" ? "row-move-to" : "col-move-to";
  let result;
  try {
    result = await api.tableOperation(cellId, action,
      { target_index: targetIndex, mode });
  } catch (err) {
    flash("Move failed: " + err.message, { kind: "error", timeout: 3000 });
    return false;
  }

  let localOk = false;
  try {
    localOk = applyMoveToDom(axis, cellId, targetIndex, mode, result.selection_id);
  } catch (err) {
    console.warn("html-editor: local table move apply failed; trying table snapshot", err);
  }
  if (!localOk) {
    try {
      localOk = applyTableSnapshot(result, axis);
    } catch (err) {
      console.warn("html-editor: table snapshot apply failed; reloading", err);
    }
  }
  flash(axis === "row" ? "Row moved." : "Column moved.",
    { kind: "success", timeout: 1200 });
  if (!localOk) {
    rememberSelectionForReload(result.selection_id, axis);
    reloadAfterMutation({ delay: 200 });
  } else {
    sessionStorage.removeItem("__edit_restore_selection");
    sessionStorage.removeItem("__edit_restore_table_mode");
  }
  return true;
}

export function cancelTableLineDrag() {
  if (!state.dragging || state.dragging.mode !== "table-line") return;
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging-line");
  document.removeEventListener("mousemove", onLineDragMove, true);
  document.removeEventListener("mouseup", onLineDragEnd, true);
  clearDropIndicator();
}
