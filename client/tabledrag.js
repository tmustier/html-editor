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
import {
  dropSlotFor,
  gridCellFrom,
  gridForElement,
  tableLineRects,
  tableRowIndexOf,
} from "./targets.js";

const NOOP_BG = "rgba(124, 58, 237, 0.18)";
const MOVE_BG = "#7c3aed";

function tableIdFor(cell) {
  const table = cell && cell.closest && cell.closest("table");
  return table ? table.getAttribute("data-edit-id") : null;
}

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

export async function runMoveTo(axis, cellId, targetIndex, mode) {
  const action = axis === "row" ? "row-move-to" : "col-move-to";
  try {
    const result = await api.tableOperation(cellId, action,
      { target_index: targetIndex, mode });
    if (result.selection_id) {
      sessionStorage.setItem("__edit_restore_selection", result.selection_id);
      sessionStorage.setItem("__edit_restore_table_mode", axis);
    }
    flash(axis === "row" ? "Row moved." : "Column moved.",
      { kind: "success", timeout: 1200 });
    reloadAfterMutation({ delay: 200 });
  } catch (err) {
    flash("Move failed: " + err.message, { kind: "error", timeout: 3000 });
  }
}

export function cancelTableLineDrag() {
  if (!state.dragging || state.dragging.mode !== "table-line") return;
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging-line");
  document.removeEventListener("mousemove", onLineDragMove, true);
  document.removeEventListener("mouseup", onLineDragEnd, true);
  clearDropIndicator();
}

// --- Excel cut + paste ----------------------------------------------------

export function markTableCut(axis) {
  const cell = gridCellFrom(state.selected);
  if (!cell || !["row", "column"].includes(axis)) return false;
  const grid = gridForElement(state.selected);
  if (!grid) return false;
  const tableId = tableIdFor(cell);
  const index = axis === "row"
    ? tableRowIndexOf(cell)?.index
    : grid.position.col;
  if (index == null) return false;
  state.tableCut = { kind: axis, tableId, index, cellId: cell.getAttribute("data-edit-id") };
  refreshCutMarker();
  flash(axis === "row" ? "Row cut — paste over another row to move it."
                       : "Column cut — paste over another column to move it.",
    { kind: "info", timeout: 1800 });
  return true;
}

export function clearTableCut() {
  if (!state.tableCut) return;
  state.tableCut = null;
  refreshCutMarker();
}

export function refreshCutMarker() {
  const cut = state.tableCut;
  if (!dom.selectBox) return;
  if (!cut) { delete dom.selectBox.dataset.cut; return; }
  const cell = gridCellFrom(state.selected);
  const sameAxis = state.tableSelectionMode === cut.kind;
  const sameTable = cell && tableIdFor(cell) === cut.tableId;
  const grid = cell && gridForElement(state.selected);
  const sameLine = sameTable && grid && (
    cut.kind === "row"
      ? tableRowIndexOf(cell)?.index === cut.index
      : grid.position.col === cut.index
  );
  if (sameAxis && sameLine) dom.selectBox.dataset.cut = "true";
  else delete dom.selectBox.dataset.cut;
}

// Cmd+V on another row/column in the same table → moves the cut line.
// Excel "insert cut" semantics: the cut line lands AT the target's old
// position, shoving everything else around. So we pick mode based on the
// direction of travel.
export async function pasteTableCut() {
  const cut = state.tableCut;
  if (!cut) return false;
  const cell = gridCellFrom(state.selected);
  if (!cell) return false;
  if (state.tableSelectionMode !== cut.kind) {
    flash(`Select a ${cut.kind} first (Shift+Space / Ctrl+Space).`, { kind: "warning" });
    return false;
  }
  const tableId = tableIdFor(cell);
  if (tableId !== cut.tableId) {
    flash("Can't move rows or columns across tables yet.", { kind: "warning" });
    return false;
  }
  const grid = gridForElement(state.selected);
  if (!grid) return false;
  const targetIndex = cut.kind === "row"
    ? tableRowIndexOf(cell)?.index
    : grid.position.col;
  if (targetIndex == null) return false;
  if (targetIndex === cut.index) {
    clearTableCut();
    return false;
  }
  const mode = targetIndex > cut.index ? "after" : "before";
  state.tableCut = null;
  await runMoveTo(cut.kind, cut.cellId, targetIndex, mode);
  return true;
}
