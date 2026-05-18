// Excel-style staged cuts/copies for table rows, columns, and cell ranges.
//
// A cut is a mode, not an immediate mutation: Cmd+X records the source,
// populates the system clipboard when possible, and paints a persistent
// source outline. Cmd+V or Cmd+Shift++ commits the move/insert.
//
// A row/column copy keeps the same source/payload shape so Cmd+Shift++ can
// insert copied cells structurally instead of creating blank lines.

import { dom, flash } from "./dom.js";
import { state } from "./state.js";
import { runMoveTo } from "./tabledrag.js";
import { runTableOperation } from "./tableops.js";
import {
  gridCellFrom,
  gridForElement,
  rangeAnchorElement,
  rangeBounds,
  tableRowIndexOf,
} from "./targets.js";

function tableIdFor(cell) {
  const table = cell && cell.closest && cell.closest("table");
  return table ? table.getAttribute("data-edit-id") : null;
}

function escapeTsvCell(value) {
  const text = String(value == null ? "" : value);
  if (/[\t\n\r"]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function escapeHtmlText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cellText(el) {
  return (el?.innerText || el?.textContent || "").replace(/\u00a0/g, " ").trim();
}

function uniqueCells(cells) {
  const seen = new Set();
  return cells.filter((cell) => {
    if (!cell || seen.has(cell)) return false;
    seen.add(cell);
    return true;
  });
}

function lineCells(axis, sourceCell) {
  const grid = sourceCell && gridForElement(sourceCell);
  if (!grid) return [];
  if (axis === "row") {
    const rowIndex = tableRowIndexOf(sourceCell)?.index;
    return rowIndex == null ? [] : uniqueCells(grid.matrix[rowIndex] || []);
  }
  if (axis === "column") {
    const colIndex = grid.position.col;
    return uniqueCells(grid.matrix.map((row) => row && row[colIndex]).filter(Boolean));
  }
  return [];
}

function linePayload(axis, cells) {
  const values = axis === "row"
    ? [cells.map(cellText)]
    : cells.map((cell) => [cellText(cell)]);
  const text = values.map((row) => row.map(escapeTsvCell).join("\t")).join("\n");
  const html = "<table>" + values.map((row) =>
    "<tr>" + row.map((value) => `<td>${escapeHtmlText(value)}</td>`).join("") + "</tr>")
    .join("") + "</table>";
  return { text, html, matrix: values };
}

async function tryWriteClipboard(payload, writeClipboardPayload) {
  if (!writeClipboardPayload) return true;
  try {
    await writeClipboardPayload(payload.text, payload.html);
    return true;
  } catch (_err) {
    return false;
  }
}

function setCut(cut) {
  state.lineCopy = null;
  state.cut = cut;
  placeCutOverlay();
}

function setLineCopy(copy) {
  state.cut = null;
  state.lineCopy = copy;
  placeCutOverlay();
}

export function clearCut() {
  state.cut = null;
  placeCutOverlay();
}

export function clearLineCopy() {
  state.lineCopy = null;
  placeCutOverlay();
}

export function hasStagedCut(kind = null) {
  return !!state.cut && (!kind || state.cut.kind === kind);
}

function lineTransfer(axis) {
  if (!["row", "column"].includes(axis)) return null;
  const sourceCell = gridCellFrom(state.selected);
  const grid = sourceCell && gridForElement(sourceCell);
  if (!sourceCell || !grid) return null;
  const tableId = tableIdFor(sourceCell);
  const index = axis === "row"
    ? tableRowIndexOf(sourceCell)?.index
    : grid.position.col;
  if (index == null) return null;
  const cells = lineCells(axis, sourceCell);
  const payload = linePayload(axis, cells);
  return {
    kind: axis,
    tableId,
    source: {
      cellId: sourceCell.getAttribute("data-edit-id"),
      r1: axis === "row" ? index : 0,
      r2: axis === "row" ? index : Math.max(0, grid.matrix.length - 1),
      c1: axis === "column" ? index : 0,
      c2: axis === "column" ? index : Math.max(0, (grid.matrix[0] || []).length - 1),
    },
    payload,
    createdAt: Date.now(),
  };
}

export async function stageLineCut(axis, writeClipboardPayload) {
  const transfer = lineTransfer(axis);
  if (!transfer) return false;
  const clipboardOk = await tryWriteClipboard(transfer.payload, writeClipboardPayload);
  setCut(transfer);
  flash(
    (axis === "row" ? "Row" : "Column")
      + (clipboardOk
        ? " cut — select a destination and paste or insert."
        : " cut staged; system clipboard unavailable."),
    { kind: clipboardOk ? "info" : "warning", timeout: 1800 },
  );
  return true;
}

export async function stageLineCopy(axis, writeClipboardPayload) {
  const transfer = lineTransfer(axis);
  if (!transfer) return false;
  const clipboardOk = await tryWriteClipboard(transfer.payload, writeClipboardPayload);
  setLineCopy(transfer);
  flash(
    (axis === "row" ? "Row" : "Column")
      + (clipboardOk
        ? " copied — paste values or press Cmd+Shift+= to duplicate."
        : " copied inside the editor; system clipboard unavailable."),
    { kind: clipboardOk ? "success" : "warning", timeout: 1800 },
  );
  return true;
}

export async function stageRangeCut(rangePayload, writeClipboardPayload) {
  const bounds = rangeBounds();
  const anchor = rangeAnchorElement();
  const sourceCell = gridCellFrom(anchor);
  if (!bounds || !sourceCell || !rangePayload) return false;
  const tableId = tableIdFor(sourceCell);
  const values = rangePayload.values || rangePayload.matrix?.map((row) =>
    row.map((el) => cellText(el))) || [];
  const ids = rangePayload.sourceIds || [];
  const payload = { text: rangePayload.text, html: rangePayload.html, matrix: values };
  const clipboardOk = await tryWriteClipboard(payload, writeClipboardPayload);
  setCut({
    kind: "range",
    tableId,
    source: {
      cellId: sourceCell.getAttribute("data-edit-id"),
      r1: bounds.r1,
      r2: bounds.r2,
      c1: bounds.c1,
      c2: bounds.c2,
      ids,
    },
    payload,
    createdAt: Date.now(),
  });
  const count = values.reduce((sum, row) => sum + row.length, 0);
  flash(
    `Range cut (${count} cell${count === 1 ? "" : "s"}) — select a destination and paste.`
      + (clipboardOk ? "" : " System clipboard unavailable."),
    { kind: clipboardOk ? "info" : "warning", timeout: 1800 },
  );
  return true;
}

function currentLineIndex(axis) {
  const cell = gridCellFrom(state.selected);
  const grid = cell && gridForElement(state.selected);
  if (!cell || !grid) return null;
  return axis === "row" ? tableRowIndexOf(cell)?.index : grid.position.col;
}

function currentTableId() {
  return tableIdFor(gridCellFrom(state.selected));
}

function effectiveMoveNoop(sourceIndex, targetIndex, mode) {
  if (targetIndex === sourceIndex) return true;
  let newIndex;
  if (targetIndex < sourceIndex) {
    newIndex = mode === "before" ? targetIndex : targetIndex + 1;
  } else {
    newIndex = mode === "before" ? targetIndex - 1 : targetIndex;
  }
  return newIndex === sourceIndex;
}

export async function commitLineCutPaste() {
  const cut = state.cut;
  if (!cut || !["row", "column"].includes(cut.kind)) return false;
  if (state.tableSelectionMode !== cut.kind) {
    flash(`Select a ${cut.kind} first (Shift+Space / Ctrl+Space).`, { kind: "warning" });
    return false;
  }
  if (currentTableId() !== cut.tableId) {
    flash("Can't move rows or columns across tables yet.", { kind: "warning" });
    return false;
  }
  const targetIndex = currentLineIndex(cut.kind);
  if (targetIndex == null) return false;
  const sourceIndex = cut.kind === "row" ? cut.source.r1 : cut.source.c1;
  if (targetIndex === sourceIndex) {
    clearCut();
    flash("Cut cleared.", { kind: "info", timeout: 900 });
    return false;
  }
  const mode = targetIndex > sourceIndex ? "after" : "before";
  const sourceCellId = cut.source.cellId;
  const ok = await runMoveTo(cut.kind, sourceCellId, targetIndex, mode);
  if (ok) clearCut();
  return ok;
}

export async function commitLineCutInsertBeforeSelection() {
  const cut = state.cut;
  if (!cut || !["row", "column"].includes(cut.kind)) return false;
  if (currentTableId() !== cut.tableId) {
    flash("Can't insert cut rows or columns across tables yet.", { kind: "warning" });
    return false;
  }
  const targetIndex = currentLineIndex(cut.kind);
  if (targetIndex == null) return false;
  const sourceIndex = cut.kind === "row" ? cut.source.r1 : cut.source.c1;
  if (effectiveMoveNoop(sourceIndex, targetIndex, "before")) {
    clearCut();
    flash("Cut cleared.", { kind: "info", timeout: 900 });
    return false;
  }
  const sourceCellId = cut.source.cellId;
  const ok = await runMoveTo(cut.kind, sourceCellId, targetIndex, "before");
  if (ok) clearCut();
  return ok;
}

export async function commitLineCopyInsertBeforeSelection() {
  const copy = state.lineCopy;
  if (!copy || !["row", "column"].includes(copy.kind)) return false;
  if (state.tableSelectionMode !== copy.kind) {
    flash(`Select a ${copy.kind} destination first (Shift+Space / Ctrl+Space).`,
      { kind: "warning" });
    return false;
  }
  if (currentTableId() !== copy.tableId) {
    flash("Can't insert copied rows or columns across tables yet.", { kind: "warning" });
    return false;
  }
  const targetCell = gridCellFrom(state.selected);
  if (!targetCell) return false;
  const action = copy.kind === "row" ? "row-copy-before" : "col-copy-before";
  return runTableOperation(targetCell, action, {
    restoreMode: copy.kind,
    successMessage: copy.kind === "row" ? "Row duplicated." : "Column duplicated.",
    errorPrefix: "Duplicate failed",
    reloadDelay: 200,
    extra: { source_cell_id: copy.source.cellId },
  });
}

function sourceCellForCut(cut) {
  const id = cut?.source?.cellId;
  return id ? document.querySelector(`[data-edit-id="${CSS.escape(id)}"]`) : null;
}

function cellsForCut(cut) {
  const sourceCell = sourceCellForCut(cut);
  const grid = sourceCell && gridForElement(sourceCell);
  if (!sourceCell || !grid) return [];
  if (cut.kind === "row" || cut.kind === "column") {
    return lineCells(cut.kind, sourceCell);
  }
  if (cut.kind === "range") {
    const cells = [];
    for (let r = cut.source.r1; r <= cut.source.r2; r += 1) {
      for (let c = cut.source.c1; c <= cut.source.c2; c += 1) {
        const cell = grid.matrix[r] && grid.matrix[r][c];
        if (cell) cells.push(cell);
      }
    }
    return uniqueCells(cells);
  }
  return [];
}

function unionDocumentRect(elements) {
  const rects = elements.filter(Boolean).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  });
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

export function placeCutOverlay() {
  if (!dom.cutBox) return;
  const transfer = state.cut || state.lineCopy;
  if (!transfer) { dom.cutBox.hidden = true; return; }
  const cells = cellsForCut(transfer);
  const rect = unionDocumentRect(cells);
  if (!rect) { dom.cutBox.hidden = true; return; }
  const box = dom.cutBox;
  box.hidden = false;
  box.dataset.kind = transfer.kind;
  box.dataset.transfer = state.cut ? "cut" : "copy";
  box.style.display = "block";
  box.style.left = (rect.left - 2) + "px";
  box.style.top = (rect.top - 2) + "px";
  box.style.width = (rect.width + 4) + "px";
  box.style.height = (rect.height + 4) + "px";
}

export function cutSourceIds(cut = state.cut) {
  return Array.isArray(cut?.source?.ids) ? cut.source.ids.slice() : [];
}
