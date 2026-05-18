// Wire mouse, keyboard, and toolbar events. Lives at the top of the
// dependency tree because everything else exports the handlers it calls.

import { api } from "./api.js";
import { dom, flash, isOverlay } from "./dom.js";
import { interactionLock, reloadAfterMutation } from "./interaction.js";
import { sendComment, startComment } from "./comments.js";
import { beginDrag, beginResize, cancelDrag } from "./drag.js";
import {
  clearCut,
  commitLineCutInsertBeforeSelection,
  commitLineCutPaste,
  cutSourceIds,
  stageLineCut,
  stageRangeCut,
} from "./cut.js";
import { finishActiveEdit, finishSvgLabelEdit, startEdit } from "./editing.js";
import { state } from "./state.js";
import { runTableOperation, tableRestoreModeForAction } from "./tableops.js";
import {
  editableFrom,
  ensureVisible,
  extendTableRange,
  gridCellFrom,
  gridForElement,
  gridPasteTargets,
  isSvgLabelHit,
  navigate,
  navigateGrid,
  placeBox,
  placeTableAddZones,
  placeToolbar,
  rangeAnchorElement,
  rangeBounds,
  refreshTableAddZones,
  selectElementInternal,
  selectTableDimension,
  tableEdgeSelectionModeFromEvent,
  tableRangeMatrix,
  targetFor,
  toggleHelp,
} from "./targets.js";
import {
  beginTableLineDrag,
  cancelTableLineDrag,
} from "./tabledrag.js";

export function selectElement(el, tableSelectionMode = null) {
  selectElementInternal(el, tableSelectionMode);
}

// Excel-style row/column promotion that also handles escalating to whole-
// table selection. Called by the Shift+Space / Ctrl+Space shortcuts.
//   axis = "row"    → Shift+Space (select rows)
//   axis = "column" → Ctrl+Space  (select columns)
//
// Rules:
// - In edit mode the caller is expected to have already saved the cell.
// - In row mode + Shift+Space (same axis): no-op.
// - In column mode + Ctrl+Space (same axis): no-op.
// - In the *other* mode (row+Ctrl+Space or column+Shift+Space): escalate to
//   whole-table selection.
// - In cell/range mode: switch to row or column mode; tableRange is
//   preserved so the promotion covers the rows/columns the range spans.
export function promoteTableSelection(axis) {
  const cell = gridCellFrom(state.selected);
  if (!cell || !(axis === "row" || axis === "column")) {
    flash("Select a table cell first.", { kind: "warning" });
    return false;
  }
  const mode = state.tableSelectionMode;
  if (mode === axis) return false; // already in this mode
  let next;
  if (mode === "table") {
    next = axis; // step down from table to single axis
  } else if ((mode === "row" && axis === "column")
          || (mode === "column" && axis === "row")) {
    next = "table";
  } else {
    next = axis;
  }
  selectElementInternal(state.selected, next, { preserveRange: true });
  ensureVisible(cell);
  return true;
}

export function deselect() {
  if (state.svgEditing) finishSvgLabelEdit(false);
  state.selected = null;
  state.tableSelectionMode = null;
  state.tableRange = null;
  clearCut();
  dom.selectBox.style.display = "none";
  dom.rowHandle.style.display = "none";
  dom.colHandle.style.display = "none";
  dom.toolbar.hidden = true;
  dom.commentBox.hidden = true;
  dom.tableMenu.hidden = true;
  dom.svgEditor.hidden = true;
  if (dom.addRowZone) dom.addRowZone.dataset.visible = "false";
  if (dom.addColZone) dom.addColZone.dataset.visible = "false";
  if (dom.tableDrop) dom.tableDrop.hidden = true;
  state.hoveredTable = null;
}

// The "+" zones are proximity-gated: they show when the cursor is close to a
// table (over a cell or within a small margin of the table's bounds). That
// keeps them out of the way of nearby content like a paragraph right under
// the table while still giving the user a generous hit area.
const ADD_ZONE_PROXIMITY = 28; // px — generous so the cursor can travel onto the pill without it vanishing

function tableNearMouse() {
  if (state.mouseX < 0) return null;
  // Candidate tables to test against the cursor:
  //   1. table directly under the cursor (covers fresh hover)
  //   2. the previously hovered table (covers traveling out of cells into
  //      the "+" zones without the zone vanishing mid-flight)
  //   3. any currently-selected table (lets keyboard-driven selections keep
  //      the zones armed when the cursor is still nearby)
  const candidates = new Set();
  const directCell = document.elementFromPoint(state.mouseX, state.mouseY);
  const direct = directCell && directCell.closest && directCell.closest("table");
  if (direct) candidates.add(direct);
  if (state.hoveredTable && document.contains(state.hoveredTable)) {
    candidates.add(state.hoveredTable);
  }
  const selectedCell = gridCellFrom(state.selected);
  const selectedTable = selectedCell ? selectedCell.closest("table") : null;
  if (selectedTable) candidates.add(selectedTable);
  for (const table of candidates) {
    const r = table.getBoundingClientRect();
    const m = ADD_ZONE_PROXIMITY;
    // The "+" zones sit ~6–12px beyond the table edges; allow a generous
    // outer margin so the cursor traveling onto the zone keeps it armed.
    if (state.mouseX >= r.left - m && state.mouseX <= r.right + m + 24 /* col-zone tail */
        && state.mouseY >= r.top - m && state.mouseY <= r.bottom + m + 24 /* row-zone tail */) {
      return table;
    }
  }
  return null;
}

function updateAddZonesFromHover() {
  const table = tableNearMouse();
  if (table) {
    state.hoveredTable = table;
    placeTableAddZones(table);
  } else {
    state.hoveredTable = null;
    placeTableAddZones(null);
  }
}

function tableForAppend() {
  const hovered = state.hoveredTable && document.contains(state.hoveredTable)
    ? state.hoveredTable
    : null;
  if (!hovered && state.hoveredTable) state.hoveredTable = null;
  return hovered
    || (state.selected && (gridCellFrom(state.selected)?.closest("table")))
    || null;
}

function lastTableCell(table, axis) {
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return null;
  if (axis === "row") {
    // Anchor on any cell in the LAST row so row-insert-after appends.
    const last = rows[rows.length - 1];
    return last.querySelector("td, th");
  }
  // Anchor on the LAST cell of the FIRST row for col-insert-after.
  const cells = Array.from(rows[0].querySelectorAll("td, th"));
  return cells.length ? cells[cells.length - 1] : null;
}

async function appendTableLine(axis) {
  const table = tableForAppend();
  const cell = lastTableCell(table, axis);
  if (!cell) {
    flash("Hover over a table to add rows or columns.", { kind: "warning" });
    return;
  }
  const action = axis === "row" ? "row-insert-after" : "col-insert-after";
  if (state.cut) clearCut();
  await runTableOperation(cell, action, {
    restoreMode: axis,
    successMessage: axis === "row" ? "Row added." : "Column added.",
    errorPrefix: "Add failed",
    reloadDelay: 200,
  });
}

function insertOrDeleteLine(action) {
  const cell = gridCellFrom(state.selected);
  const axis = state.tableSelectionMode;
  if (!cell || !axis) {
    flash("Select a row or column first (Shift+Space / Ctrl+Space).", { kind: "warning" });
    return;
  }
  const op = axis === "row"
    ? (action === "insert" ? "row-insert-before" : "row-delete")
    : (action === "insert" ? "col-insert-before" : "col-delete");
  void performTableOperation(op);
}

function placeTableMenu() {
  const tb = dom.toolbar.getBoundingClientRect();
  const menu = dom.tableMenu;
  let top = tb.bottom + window.scrollY + 6;
  let left = tb.left + window.scrollX;
  const width = menu.offsetWidth || 280;
  const maxLeft = window.scrollX + window.innerWidth - width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  menu.style.top = top + "px";
  menu.style.left = left + "px";
}

function toggleTableMenu(force) {
  const show = typeof force === "boolean" ? force : dom.tableMenu.hidden;
  if (!show) {
    dom.tableMenu.hidden = true;
    return;
  }
  if (!state.selected || state.editing || !gridCellFrom(state.selected)) {
    flash("Select a table cell first.", { kind: "warning" });
    return;
  }
  dom.tableMenu.dataset.mode = state.tableSelectionMode || "cell";
  dom.tableMenu.hidden = false;
  placeTableMenu();
}

async function performTableOperation(action) {
  const cell = gridCellFrom(state.selected);
  if (!cell) {
    flash("Select a table cell first.", { kind: "warning" });
    return;
  }
  if (state.cut) clearCut();
  await runTableOperation(cell, action, {
    restoreMode: tableRestoreModeForAction(action, state.tableSelectionMode || ""),
    successMessage: `Table ${action.replace(/-/g, " ")} done.`,
    errorPrefix: "Table change failed",
    reloadDelay: 220,
  });
}

async function performDuplicate() {
  const target = targetFor(state.selected);
  if (!target) {
    flash("Select an element to duplicate.", { kind: "warning" });
    return;
  }
  try {
    const result = await api.duplicateElement(target.id);
    if (result.new_id) {
      sessionStorage.setItem("__edit_restore_selection", result.new_id);
      sessionStorage.removeItem("__edit_restore_table_mode");
    }
    flash("Duplicated element.", { kind: "success" });
    reloadAfterMutation({ delay: 220 });
  } catch (err) {
    flash("Duplicate failed: " + err.message, { kind: "error", timeout: 3600 });
  }
}

async function performHistory(action) {
  try {
    if (action === "undo") await api.undo();
    else await api.redo();
    flash(action === "undo" ? "Undone." : "Redone.", { kind: "success" });
    reloadAfterMutation({ delay: 120 });
  } catch (err) {
    flash(err.message
      || (action === "undo" ? "Nothing to undo." : "Nothing to redo."),
      { kind: "warning" });
  }
}

function isNativeClipboardTarget(el) {
  return !!(el && (
    el.tagName === "TEXTAREA"
    || el.tagName === "INPUT"
    || (el.getAttribute && el.getAttribute("contenteditable") === "true")
  ));
}

function selectedPlainText() {
  const el = state.selected;
  if (!el) return "";
  return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
}

function stripEditIds(root) {
  if (root.removeAttribute) root.removeAttribute("data-edit-id");
  if (root.querySelectorAll) {
    root.querySelectorAll("[data-edit-id]").forEach((el) =>
      el.removeAttribute("data-edit-id"));
  }
  return root;
}

function sanitizedHtmlFragment(html) {
  if (!html || !html.trim()) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  stripEditIds(template.content);
  template.content.querySelectorAll("script, style, link, meta").forEach((el) => el.remove());
  return template.innerHTML.trim();
}

function selectedHtml() {
  const el = state.selected;
  if (!el) return "";
  const clone = stripEditIds(el.cloneNode(true));
  return (clone.innerHTML || selectedPlainText()).trim();
}

const STATUS_CLASSES = ["shipped", "partial", "next", "deferred"];
const STATUS_CLASS_BY_TEXT = new Map([
  ["SHIPPED", "shipped"],
  ["V1 SHIPPED", "shipped"],
  ["PARTIAL", "partial"],
  ["NEXT", "next"],
  ["DEFERRED", "deferred"],
]);

function updateStatusBadgeClass(el, text) {
  if (!(el && el.classList && el.classList.contains("status-badge"))) return;
  const mapped = STATUS_CLASS_BY_TEXT.get(String(text || "").trim().toUpperCase());
  if (!mapped) return;
  STATUS_CLASSES.forEach((cls) => el.classList.remove(cls));
  el.classList.add(mapped);
}

function singleInlineWrapper(el) {
  if (!el) return null;
  const elements = Array.from(el.children || []);
  if (elements.length !== 1) return null;
  const wrapper = elements[0];
  const hasOtherText = Array.from(el.childNodes).some((node) =>
    node !== wrapper && node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (hasOtherText) return null;
  const display = (window.getComputedStyle(wrapper).display || "").toLowerCase();
  if (!["inline", "inline-block", "inline-flex"].includes(display)) return null;
  return wrapper;
}

function htmlForPlainPastePreservingTarget(el, text) {
  const wrapper = singleInlineWrapper(el);
  if (!wrapper) return null;
  const clone = stripEditIds(el.cloneNode(true));
  const cloneWrapper = clone.children && clone.children[0];
  if (!cloneWrapper) return null;
  cloneWrapper.textContent = text;
  updateStatusBadgeClass(cloneWrapper, text);
  return clone.innerHTML;
}

function parseClipboardTableText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!raw.includes("\t") && !raw.includes("\n")) return null;

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "\t" && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  if (raw.endsWith("\n") && rows.length && rows.at(-1).length === 1
      && rows.at(-1)[0] === "") {
    rows.pop();
  }
  const cellCount = rows.reduce((sum, r) => sum + r.length, 0);
  return cellCount > 1 ? rows : null;
}

function parseClipboardTableHtml(html) {
  if (!html || !html.trim()) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const table = template.content.querySelector("table");
  if (!table) return null;
  const rows = Array.from(table.rows || table.querySelectorAll("tr"))
    .map((row) => Array.from(row.cells || row.querySelectorAll("th, td"))
      .map((cell) => (cell.innerText || cell.textContent || "").replace(/\u00a0/g, " ")))
    .filter((row) => row.length);
  const cellCount = rows.reduce((sum, row) => sum + row.length, 0);
  return cellCount > 1 ? rows : null;
}

function applyPlainTextToElement(el, text) {
  const nextHtml = htmlForPlainPastePreservingTarget(el, text);
  if (nextHtml) el.innerHTML = nextHtml;
  else el.innerText = text;
  return {
    id: el.getAttribute("data-edit-id"),
    text: el.innerText || String(text || ""),
    html: nextHtml || undefined,
  };
}

async function writeClipboardPayload(text, html) {
  if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html || text], { type: "text/html" }),
    })]);
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function escapeTsvCell(value) {
  const text = String(value == null ? "" : value);
  if (/[\t\n\r"]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function escapeHtmlText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rangeCellText(targetEl) {
  if (!targetEl) return "";
  return (targetEl.innerText || targetEl.textContent || "")
    .replace(/\u00a0/g, " ")
    .trim();
}

// Build TSV + minimal HTML table for the active range. Returns null if no
// usable matrix is available.
function rangeClipboardPayload() {
  const matrix = tableRangeMatrix();
  if (!matrix.length) return null;
  const values = matrix.map((row) => row.map((el) => rangeCellText(el)));
  const sourceIds = matrix.flat()
    .filter(Boolean)
    .map((el) => el.getAttribute("data-edit-id"))
    .filter(Boolean);
  const text = values
    .map((row) => row.map((value) => escapeTsvCell(value)).join("\t"))
    .join("\n");
  const htmlRows = values
    .map((row) => "<tr>" + row.map((value) =>
      `<td>${escapeHtmlText(value)}</td>`).join("") + "</tr>")
    .join("");
  const html = `<table>${htmlRows}</table>`;
  return { text, html, matrix, values, sourceIds };
}

async function copySelectionToClipboard() {
  // A fresh copy replaces/cancels any staged cut, matching spreadsheet UX.
  if (state.cut) clearCut();
  if (state.tableSelectionMode === "range") {
    const payload = rangeClipboardPayload();
    if (payload) {
      await writeClipboardPayload(payload.text, payload.html);
      const count = payload.matrix.reduce((sum, r) =>
        sum + r.filter(Boolean).length, 0);
      flash(`Copied ${count} cell${count === 1 ? "" : "s"}.`,
        { kind: "success", timeout: 900 });
      return;
    }
  }
  await writeClipboardPayload(selectedPlainText(), selectedHtml());
  flash("Copied.", { kind: "success", timeout: 900 });
}

// Clear every editable cell in the current range with a single batch save.
// Returns the number of cleared cells (0 means nothing to do).
//
// Reuses `applyPlainTextToElement` so cells with a single inline wrapper
// (status badges, runner pills, etc.) keep the wrapper and only have their
// text content cleared.
async function clearRangeCells() {
  const matrix = tableRangeMatrix();
  if (!matrix.length) return 0;
  const updates = [];
  matrix.forEach((row) => row.forEach((el) => {
    if (!el) return;
    updates.push(applyPlainTextToElement(el, ""));
  }));
  if (!updates.length) return 0;
  // Refresh selection visuals so the toolbar/box stay aligned.
  if (state.selected) {
    placeBox(dom.selectBox, state.selected);
    placeToolbar(state.selected);
  }
  await api.saveTextMany(updates);
  return updates.length;
}

async function pasteIntoSelection({ text = "", html = "" } = {}) {
  const target = state.selected && targetFor(state.selected);
  if (!(target && target.kind === "html-text" && target.canEditText)) {
    flash("Select an editable text box or table cell to paste.", { kind: "warning" });
    return;
  }
  const el = target.el;
  const tableValues = parseClipboardTableText(text) || parseClipboardTableHtml(html);
  if (tableValues && gridCellFrom(el)) {
    const pasteTargets = gridPasteTargets(el, tableValues);
    if (!pasteTargets.length) {
      flash("No table cells available to paste into.", { kind: "warning" });
      return;
    }
    const updates = pasteTargets.map(({ el: cellEl, text: cellText }) =>
      applyPlainTextToElement(cellEl, cellText));
    placeBox(dom.selectBox, el);
    placeToolbar(el);
    try {
      await api.saveTextMany(updates);
      const requested = tableValues.reduce((sum, row) => sum + row.length, 0);
      const clipped = updates.length < requested ? " (clipped to table)." : ".";
      flash(`Pasted ${updates.length} table cell${updates.length === 1 ? "" : "s"}${clipped}`,
        { kind: "success" });
    } catch (err) {
      flash("Table paste failed: " + err.message, { kind: "error" });
      reloadAfterMutation({ delay: 800 });
    }
    return;
  }

  const cleanHtml = sanitizedHtmlFragment(html);
  const nextHtml = cleanHtml || htmlForPlainPastePreservingTarget(el, text);
  if (nextHtml) el.innerHTML = nextHtml;
  else el.innerText = text;
  placeBox(dom.selectBox, el);
  placeToolbar(el);
  try {
    await api.saveText(target.id, el.innerText || text, nextHtml || undefined);
    flash("Pasted.", { kind: "success" });
  } catch (err) {
    flash("Paste failed: " + err.message, { kind: "error" });
    reloadAfterMutation({ delay: 800 });
  }
}

async function readClipboardPayload() {
  if (navigator.clipboard && navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const html = item.types.includes("text/html")
        ? await (await item.getType("text/html")).text()
        : "";
      const text = item.types.includes("text/plain")
        ? await (await item.getType("text/plain")).text()
        : "";
      if (html || text) return { html, text };
    }
  }
  if (navigator.clipboard && navigator.clipboard.readText) {
    return { text: await navigator.clipboard.readText(), html: "" };
  }
  throw new Error("Clipboard paste is not available here.");
}

async function pasteFromClipboard() {
  if (state.cut) {
    await pasteStagedCut();
    return;
  }
  try {
    const payload = await readClipboardPayload();
    if (state.tableSelectionMode === "range") {
      // Anchor the paste on the range's top-left cell so range-paste fans out.
      const anchor = rangeAnchorElement();
      if (anchor) {
        state.tableRange = null;
        state.tableSelectionMode = null;
        selectElementInternal(anchor);
      }
    }
    await pasteIntoSelection(payload);
  } catch (err) {
    flash(err.message || "Clipboard paste is not available here.", { kind: "warning" });
  }
}

async function stageRangeCutFromSelection() {
  const payload = rangeClipboardPayload();
  if (!payload) {
    flash("Nothing to cut.", { kind: "warning" });
    return;
  }
  await stageRangeCut(payload, writeClipboardPayload);
}

function rangesOverlap(sourceIds, targets) {
  const source = new Set(sourceIds);
  return targets.some(({ el }) => source.has(el.getAttribute("data-edit-id")));
}

async function pasteStagedRangeCut() {
  const cut = state.cut;
  if (!cut || cut.kind !== "range") return false;
  const anchor = state.tableSelectionMode === "range" ? rangeAnchorElement() : state.selected;
  const targetCell = gridCellFrom(anchor);
  if (!targetCell) {
    flash("Select a destination table cell for the cut range.", { kind: "warning" });
    return false;
  }
  const matrix = cut.payload?.matrix;
  if (!Array.isArray(matrix) || !matrix.length) {
    clearCut();
    flash("Cut range is no longer available.", { kind: "warning" });
    return false;
  }
  const pasteTargets = gridPasteTargets(targetCell, matrix);
  if (!pasteTargets.length) {
    flash("No table cells available to paste into.", { kind: "warning" });
    return false;
  }
  const requested = matrix.reduce((sum, row) => sum + row.length, 0);
  if (pasteTargets.length < requested) {
    flash("Cut range doesn't fit at that destination — choose a larger area.",
      { kind: "warning" });
    return false;
  }
  const sourceIds = cutSourceIds(cut);
  if (rangesOverlap(sourceIds, pasteTargets)) {
    flash("Overlapping cut range moves aren't supported yet.", { kind: "warning" });
    return false;
  }
  const updates = pasteTargets.map(({ el, text }) => applyPlainTextToElement(el, text));
  for (const id of sourceIds) {
    const sourceEl = document.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
    if (sourceEl) updates.push(applyPlainTextToElement(sourceEl, ""));
  }
  if (!updates.length) return false;
  const selectedBeforeSave = state.selected;
  try {
    await api.saveTextMany(updates);
    clearCut();
    if (selectedBeforeSave) {
      placeBox(dom.selectBox, selectedBeforeSave);
      placeToolbar(selectedBeforeSave);
    }
    flash(`Moved ${pasteTargets.length} cell${pasteTargets.length === 1 ? "" : "s"}.`,
      { kind: "success" });
    return true;
  } catch (err) {
    flash("Range move failed: " + err.message, { kind: "error" });
    reloadAfterMutation({ delay: 800 });
    return false;
  }
}

async function pasteStagedCut() {
  if (!state.cut) return false;
  if (state.cut.kind === "range") return pasteStagedRangeCut();
  return commitLineCutPaste();
}

async function deleteRangeContents() {
  try {
    const cleared = await clearRangeCells();
    if (!cleared) {
      flash("Nothing to clear.", { kind: "warning" });
      return;
    }
    flash(`Cleared ${cleared} cell${cleared === 1 ? "" : "s"}.`,
      { kind: "success", timeout: 900 });
  } catch (err) {
    flash("Clear failed: " + err.message, { kind: "error" });
    reloadAfterMutation({ delay: 600 });
  }
}

// Drop the active range and re-anchor selection on a single cell. Used to
// route follow-up actions (edit, comment) through the normal single-cell
// code paths.
function collapseRangeToAnchor() {
  if (state.tableSelectionMode !== "range") return false;
  const anchor = rangeAnchorElement();
  if (!anchor) return false;
  state.tableRange = null;
  state.tableSelectionMode = null;
  selectElementInternal(anchor);
  return true;
}

export function initEvents() {
  // --- clipboard ----------------------------------------------------------
  document.addEventListener("copy", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    if (state.cut) clearCut();
    if (state.tableSelectionMode === "range") {
      // Excel-style multi-cell copy: TSV plus a minimal <table> HTML.
      if (!e.clipboardData) return;
      const payload = rangeClipboardPayload();
      if (!payload) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", payload.text);
      e.clipboardData.setData("text/html", payload.html);
      const count = payload.matrix.reduce((sum, r) =>
        sum + r.filter(Boolean).length, 0);
      flash(`Copied ${count} cell${count === 1 ? "" : "s"}.`,
        { kind: "success", timeout: 900 });
      return;
    }
    if (state.tableSelectionMode) return; // row/column selection keeps clipboard scoped to cut
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", selectedPlainText());
    e.clipboardData.setData("text/html", selectedHtml());
    flash("Copied.", { kind: "success", timeout: 900 });
  }, true);

  document.addEventListener("paste", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    if (state.cut) {
      e.preventDefault();
      void pasteStagedCut();
      return;
    }
    if (state.tableSelectionMode === "range") {
      // Range mode owns Cmd+V: route through the Excel-style range-paste
      // path anchored on the range's top-left cell.
      const anchor = rangeAnchorElement();
      if (!anchor) return;
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      const html = e.clipboardData && e.clipboardData.getData("text/html");
      if (typeof text !== "string" && typeof html !== "string") return;
      e.preventDefault();
      // Drop the range so the paste lands on the anchor cell (range-paste
      // logic already clips to the table). The visual will be reanchored
      // by reloadAfterMutation if the paste fans out.
      const stash = state.tableRange;
      state.tableRange = null;
      state.tableSelectionMode = null;
      selectElementInternal(anchor);
      void pasteIntoSelection({ text: text || "", html: html || "" }).catch(() => {
        // If something went wrong, restore the prior range so the user can retry.
        state.tableRange = stash;
        state.tableSelectionMode = stash ? "range" : null;
      });
      return;
    }
    if (state.tableSelectionMode) {
      // Row/column selection owns Cmd+V (cut-paste move). Never let the
      // generic value-paste path race with it.
      e.preventDefault();
      return;
    }
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (typeof text !== "string" && typeof html !== "string") return;
    e.preventDefault();
    void pasteIntoSelection({ text: text || "", html: html || "" });
  }, true);

  // --- mouse tracking -----------------------------------------------------
  document.addEventListener("mousemove", (e) => {
    // Always remember mouse pos so the "+" proximity check stays current.
    state.mouseX = e.clientX;
    state.mouseY = e.clientY;
    if (state.editing || state.dragging) return;
    const t = e.target;
    // Keep "+" zones reactive even when the cursor is over them.
    if (t === dom.addRowZone || t === dom.addColZone
        || t === dom.rowHandle || t === dom.colHandle) {
      updateAddZonesFromHover();
      return;
    }
    if (isOverlay(t)) {
      dom.hoverBox.style.display = "none";
      state.hovered = null;
      updateAddZonesFromHover();
      return;
    }
    const el = editableFrom(t);
    if (!el) {
      dom.hoverBox.style.display = "none";
      state.hovered = null;
      updateAddZonesFromHover();
      return;
    }
    state.hovered = el;
    placeBox(dom.hoverBox, el);
    updateAddZonesFromHover();
  }, true);

  document.addEventListener("mouseleave", () => {
    dom.hoverBox.style.display = "none";
    state.mouseX = -1;
    state.mouseY = -1;
    updateAddZonesFromHover();
  });

  // Capture-phase click selects (and edits text-editables in one go).
  // Structural HTML containers and SVG group backgrounds just select.
  document.addEventListener("click", (e) => {
    if (interactionLock.clicksLocked()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (state.editing || state.dragging) return;
    if (isOverlay(e.target)) return;
    const el = editableFrom(e.target);
    if (!el) {
      if (state.selected) deselect();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const edgeSelectionMode = tableEdgeSelectionModeFromEvent(e, el);
    if (edgeSelectionMode) {
      selectElement(el, edgeSelectionMode);
      return;
    }
    const target = targetFor(el);
    if (target && target.kind === "svg-item") {
      if (state.selected !== el) selectElement(el);
      if (target.canEditText && isSvgLabelHit(e.target)) {
        startEdit(e.target, e.clientX, e.clientY);
      }
      return;
    }
    if (target && target.kind === "svg-text") {
      selectElement(el);
      startEdit(e.target, e.clientX, e.clientY);
      return;
    }
    if (target && target.canEditText && target.kind === "html-text") {
      selectElement(el);
      startEdit(e.target, e.clientX, e.clientY);
      return;
    }
    selectElement(el);
  }, true);

  // Double-click bypasses the toolbar and drops straight into edit mode.
  document.addEventListener("dblclick", (e) => {
    if (state.editing || state.dragging) return;
    if (isOverlay(e.target)) return;
    const el = editableFrom(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    selectElement(el);
    startEdit(e.target, e.clientX, e.clientY);
  }, true);

  // --- keyboard shortcuts -------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const inEditableField =
      t && ((t.tagName === "TEXTAREA" || t.tagName === "INPUT")
            || (t.getAttribute && t.getAttribute("contenteditable") === "true"));

    if (e.key === "Escape") {
      if (state.dragging && state.dragging.mode === "table-line") {
        e.preventDefault(); cancelTableLineDrag(); return;
      }
      if (state.dragging)  { e.preventDefault(); cancelDrag(); return; }
      if (state.svgEditing){ e.preventDefault(); finishSvgLabelEdit(false); return; }
      if (state.editing)   return; // edit handler owns its own cancel
      if (state.cut) { e.preventDefault(); clearCut(); flash("Cut cleared.", { kind: "info", timeout: 800 }); return; }
      if (!dom.commentBox.hidden) { e.preventDefault(); dom.commentBox.hidden = true; return; }
      if (!dom.tableMenu.hidden)  { e.preventDefault(); dom.tableMenu.hidden = true; return; }
      if (!dom.helpOverlay.hidden){ e.preventDefault(); toggleHelp(false); return; }
      // Step down through table selection modes:
      //   table → range or cell (we don't track the prior axis, so collapse
      //              straight to the range that drove the promotion if it
      //              existed, otherwise to the single anchor cell)
      //   row|column → range or cell
      //   range  → cell
      //   cell   → deselect
      if (state.tableSelectionMode === "table" && state.selected) {
        e.preventDefault();
        selectElementInternal(state.selected,
          state.tableRange ? "range" : null,
          { preserveRange: true });
        return;
      }
      if ((state.tableSelectionMode === "row" || state.tableSelectionMode === "column")
          && state.selected) {
        e.preventDefault();
        // Collapse to range if a range is active, otherwise to single cell.
        const next = state.tableRange ? "range" : null;
        selectElementInternal(state.selected, next, { preserveRange: true });
        return;
      }
      if (state.tableSelectionMode === "range" && state.selected) {
        e.preventDefault();
        state.tableRange = null;
        selectElementInternal(state.selected, null);
        return;
      }
      if (state.tableSelectionMode && state.selected) {
        e.preventDefault();
        selectElement(state.selected);
        return;
      }
      if (state.selected)  { e.preventDefault(); deselect(); return; }
      return;
    }

    const key = e.key.toLowerCase();
    if (e.key === "Tab" && state.selected && gridCellFrom(state.selected)
        && (state.editing || !isOverlay(t))) {
      e.preventDefault();
      e.stopPropagation();
      const direction = e.shiftKey ? "previous" : "next";
      void (async () => {
        if (state.editing) await finishActiveEdit(true);
        if (!navigateGrid(direction)) {
          flash(e.shiftKey ? "No previous grid cell." : "No next grid cell.", { kind: "warning" });
        }
      })();
      return;
    }

    if ((e.key === "Backspace" || e.key === "Delete") && state.cut
        && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      flash("Press Esc to cancel the staged cut before clearing cells.", { kind: "warning" });
      return;
    }

    // Range-aware delete / backspace: clear every cell in one batch.
    if ((e.key === "Backspace" || e.key === "Delete")
        && state.tableSelectionMode === "range" && state.selected
        && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      void deleteRangeContents();
      return;
    }

    // Range-aware Cmd+X: stage an Excel-style cut, don't clear yet.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "x"
        && state.tableSelectionMode === "range" && state.selected
        && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      void stageRangeCutFromSelection();
      return;
    }

    // Excel-style row/column cut on Cmd/Ctrl+X.
    const cutKey = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "x";
    const singleLineSelection = state.tableSelectionMode === "row"
      || state.tableSelectionMode === "column";
    const lineSpan = singleLineSelection && state.tableRange
      ? (state.tableSelectionMode === "row"
          ? Math.abs(state.tableRange.focus.row - state.tableRange.anchor.row) + 1
          : Math.abs(state.tableRange.focus.col - state.tableRange.anchor.col) + 1)
      : 1;
    if (cutKey && singleLineSelection && state.selected
        && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      if (lineSpan > 1) {
        flash(
          `Single-${state.tableSelectionMode} cut/paste only — multi-${state.tableSelectionMode} move coming soon.`,
          { kind: "warning" });
        return;
      }
      void stageLineCut(state.tableSelectionMode, writeClipboardPayload);
      return;
    }

    // Excel-style paste-as-move if a staged cut is pending.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "v"
        && state.cut && state.selected
        && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      if (singleLineSelection && lineSpan > 1) {
        flash(
          `Single-${state.tableSelectionMode} cut/paste only.`,
          { kind: "warning" });
        return;
      }
      void pasteStagedCut();
      return;
    }

    const isClipboardKey = (e.metaKey || e.ctrlKey) && !e.altKey
      && (key === "c" || key === "v");
    if (isClipboardKey && state.selected && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      void (key === "c" ? copySelectionToClipboard() : pasteFromClipboard());
      return;
    }

    const isHistoryKey = (e.metaKey || e.ctrlKey) && !e.altKey
      && (key === "z" || key === "y");
    if (isHistoryKey && !inEditableField && !state.editing) {
      e.preventDefault();
      if (state.cut) clearCut();
      performHistory(key === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }

    // Excel-style row/column structure shortcuts:
    //   Ctrl+Shift+= (the "+" key) inserts before the selection.
    //   Ctrl+- deletes the selected row/column.
    //   Cmd+Shift+= / Cmd+- as Mac Excel fallbacks.
    const isPlusInsert = (e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey
      && (e.key === "+" || e.key === "=" || e.code === "Equal");
    const isMinusDelete = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      && (e.key === "-" || e.key === "_" || e.code === "Minus");
    if ((isPlusInsert || isMinusDelete) && !inEditableField && !state.editing) {
      if (isPlusInsert && state.cut && ["row", "column"].includes(state.cut.kind)
          && state.selected && gridCellFrom(state.selected)) {
        e.preventDefault();
        e.stopPropagation();
        void commitLineCutInsertBeforeSelection();
        return;
      }
      if (isPlusInsert && state.cut && state.cut.kind === "range") {
        e.preventDefault();
        e.stopPropagation();
        flash("Insert cut only supports full rows/columns; use Cmd+V to move a range.",
          { kind: "warning" });
        return;
      }
      if (singleLineSelection && state.selected) {
        e.preventDefault();
        e.stopPropagation();
        if (lineSpan > 1) {
          flash(
            `Applied to first ${state.tableSelectionMode} only — multi-${state.tableSelectionMode} insert/delete coming soon.`,
            { kind: "info", timeout: 1400 });
        }
        insertOrDeleteLine(isPlusInsert ? "insert" : "delete");
        return;
      }
      // Otherwise let the browser handle Cmd+/- zoom etc.
    }

    if (inEditableField || state.editing) return;

    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      toggleHelp();
      return;
    }

    if (!state.selected) return;

    if (e.key === " " && state.selected && gridCellFrom(state.selected)) {
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        promoteTableSelection("row");
        return;
      }
      if ((e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
          || (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey)) {
        e.preventDefault();
        promoteTableSelection("column");
        return;
      }
    }

    // Shift+Arrow extends an Excel-style rectangular cell range across the
    // current table. Honors row/column promotion when those modes are already
    // active (Shift+Down in row mode adds another row, etc.).
    const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
    if (isArrow && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
        && gridCellFrom(state.selected) && !isOverlay(t)) {
      const direction = e.key.replace("Arrow", "").toLowerCase();
      const mode = state.tableSelectionMode;
      // In row mode, only Shift+Up/Down is meaningful (rows already cover
      // every column); in column mode, only Shift+Left/Right.
      if (mode === "row" && (direction === "left" || direction === "right")) {
        e.preventDefault();
        return;
      }
      if (mode === "column" && (direction === "up" || direction === "down")) {
        e.preventDefault();
        return;
      }
      if (mode === "table") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const changed = extendTableRange(direction);
      if (changed) {
        placeBox(dom.selectBox, state.selected);
        placeToolbar(state.selected);
        const grid = gridForElement(state.selected);
        if (grid && state.tableRange) {
          const f = state.tableRange.focus;
          const focusCell = grid.matrix[f.row] && grid.matrix[f.row][f.col];
          if (focusCell) ensureVisible(focusCell);
        }
      }
      return;
    }

    const gridArrow = !e.altKey && !e.ctrlKey && !e.shiftKey
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      && gridCellFrom(state.selected)
      && !isOverlay(t);
    if (gridArrow) {
      e.preventDefault();
      // Bare arrow keys collapse any range / multi-line selection back to a
      // single cell before moving (Excel behavior).
      if (state.tableRange || state.tableSelectionMode) {
        state.tableRange = null;
        state.tableSelectionMode = null;
      }
      const direction = e.key.replace("Arrow", "").toLowerCase();
      navigateGrid(e.metaKey ? `edge-${direction}` : direction);
      return;
    }

    const unmodified = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.key === "F2" || (unmodified && (e.key === "Enter" || key === "e"))) {
      e.preventDefault();
      // Editing cancels a staged cut without mutating the source.
      if (state.cut) clearCut();
      // In range mode, collapse to anchor cell before entering edit.
      if (state.tableSelectionMode === "range") collapseRangeToAnchor();
      startEdit();
      return;
    }
    if (unmodified && key === "c") {
      e.preventDefault();
      // In range mode, collapse to anchor cell before starting the comment.
      if (state.tableSelectionMode === "range") collapseRangeToAnchor();
      startComment();
      return;
    }
    if (e.altKey) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); navigate("left");  return; }
      if (e.key === "ArrowRight") { e.preventDefault(); navigate("right"); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); navigate("up");    return; }
      if (e.key === "ArrowDown")  { e.preventDefault(); navigate("down");  return; }
    }
  });

  // --- toolbar / popovers / drag handle / resize handles ------------------
  dom.dragBtn.addEventListener("mousedown", beginDrag);

  // Row/column handles: mousedown begins a drag, mouseup with no drag is a
  // plain click that selects. We track distance from mousedown to decide.
  function installHandleDrag(handleEl, axis) {
    handleEl.addEventListener("mousedown", (e) => {
      if (state.editing || state.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      if (!gridCellFrom(state.selected)) {
        // Best-effort: try to seed the selection from the handle's anchor cell
        // if the user clicked the handle while nothing was selected.
        return;
      }
      const startX = e.clientX;
      const startY = e.clientY;
      let dragged = false;
      const onMove = (ev) => {
        if (dragged) return;
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (dx + dy > 4) {
          dragged = true;
          document.removeEventListener("mousemove", onMove, true);
          document.removeEventListener("mouseup", onUp, true);
          beginTableLineDrag(axis, ev);
        }
      };
      const onUp = (ev) => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        if (dragged) return;
        // Plain click: toggle selection of that dimension.
        ev.preventDefault();
        ev.stopPropagation();
        selectTableDimension(axis);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }
  installHandleDrag(dom.rowHandle, "row");
  installHandleDrag(dom.colHandle, "column");

  // "+" append zones at the table's right/bottom edges.
  if (dom.addRowZone) {
    dom.addRowZone.addEventListener("mouseenter", () => refreshTableAddZones());
    dom.addRowZone.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void appendTableLine("row");
    });
  }
  if (dom.addColZone) {
    dom.addColZone.addEventListener("mouseenter", () => refreshTableAddZones());
    dom.addColZone.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void appendTableLine("column");
    });
  }

  dom.selectBox.addEventListener("mousedown", (e) => {
    const handle = e.target && e.target.closest && e.target.closest("[data-handle]");
    if (handle) {
      beginResize(handle.dataset.handle, e);
      return;
    }
    const border = e.target && e.target.closest && e.target.closest("[data-border-drag]");
    if (border) beginDrag(e);
  });

  dom.toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-act]");
    const act = btn && btn.dataset.act;
    if (!act || btn.disabled) return;
    if      (act === "edit")       startEdit();
    else if (act === "comment")    startComment();
    else if (act === "undo")       performHistory("undo");
    else if (act === "redo")       performHistory("redo");
    else if (act === "duplicate")  performDuplicate();
    else if (act === "table")      toggleTableMenu();
    else if (act === "close")      deselect();
    else if (act === "nav-prev")   navigate("left");
    else if (act === "nav-parent") navigate("up");
    else if (act === "nav-child")  navigate("down");
    else if (act === "nav-next")   navigate("right");
    else if (act === "help")       toggleHelp();
  });

  dom.tableMenu.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-table-act]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    dom.tableMenu.hidden = true;
    void performTableOperation(btn.dataset.tableAct);
  });

  dom.helpOverlay.addEventListener("click", (e) => {
    if (e.target === dom.helpOverlay) { toggleHelp(false); return; }
    const btn = e.target.closest && e.target.closest("[data-act]");
    if (btn && btn.dataset.act === "help-close") toggleHelp(false);
  });

  dom.commentBox.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-act]");
    const act = btn && btn.dataset.act;
    if (act === "send") sendComment();
    else if (act === "cancel") { dom.commentBox.hidden = true; }
  });
  dom.commentTA.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      sendComment();
      return;
    }
    if (e.key === "Escape") {
      if (dom.commentBox.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      dom.commentBox.hidden = true;
      dom.commentTA.blur();
    }
  });

  dom.svgEditor.addEventListener("focusout", () => {
    setTimeout(() => {
      if (state.svgEditing && !dom.svgEditor.contains(document.activeElement)) {
        finishSvgLabelEdit(true);
      }
    }, 0);
  });
  dom.svgEditor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finishSvgLabelEdit(false);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      finishSvgLabelEdit(true);
    }
  });
}

// Re-exported for the debug API.
export { performHistory };
