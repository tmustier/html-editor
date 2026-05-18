// Clipboard and range-cell actions.
//
// This module owns copy/paste payload parsing, table-range paste/clear, and
// staged range cut commits. events.js should only route keys/events here.

import { api } from "./api.js";
import {
  clearCut,
  clearLineCopy,
  commitLineCutPaste,
  cutSourceIds,
  stageLineCopy,
  stageRangeCut,
} from "./cut.js";
import { dom, flash } from "./dom.js";
import { reloadAfterMutation } from "./interaction.js";
import { state } from "./state.js";
import {
  gridCellFrom,
  gridForElement,
  gridPasteTargets,
  placeBox,
  placeToolbar,
  rangeAnchorElement,
  rangeBounds,
  selectElementInternal,
  tableRangeMatrix,
  targetFor,
} from "./targets.js";

export function isNativeClipboardTarget(el) {
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

export async function writeClipboardPayload(text, html) {
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

export function copySelectionToEventClipboard(clipboardData) {
  // A fresh copy replaces/cancels any staged cut/copy, matching spreadsheet UX.
  if (state.cut) clearCut();
  if (state.lineCopy) clearLineCopy();
  if (state.tableSelectionMode === "range") {
    if (!clipboardData) return false;
    const payload = rangeClipboardPayload();
    if (!payload) return false;
    clipboardData.setData("text/plain", payload.text);
    clipboardData.setData("text/html", payload.html);
    const count = payload.matrix.reduce((sum, r) =>
      sum + r.filter(Boolean).length, 0);
    flash(`Copied ${count} cell${count === 1 ? "" : "s"}.`,
      { kind: "success", timeout: 900 });
    return true;
  }
  // Row/column selections are handled by the explicit Cmd/Ctrl+C key path,
  // which can write the async system clipboard and keep an editor-local copy
  // source for Insert Copied Cells.
  if (state.tableSelectionMode) return false;
  if (!clipboardData) return false;
  clipboardData.setData("text/plain", selectedPlainText());
  clipboardData.setData("text/html", selectedHtml());
  flash("Copied.", { kind: "success", timeout: 900 });
  return true;
}

function lineSelectionSpan(axis) {
  if (!state.tableRange) return 1;
  return axis === "row"
    ? Math.abs(state.tableRange.focus.row - state.tableRange.anchor.row) + 1
    : Math.abs(state.tableRange.focus.col - state.tableRange.anchor.col) + 1;
}

export async function copySelectionToClipboard() {
  // A fresh copy replaces/cancels any staged cut/copy, matching spreadsheet UX.
  if (state.cut) clearCut();
  if (state.tableSelectionMode === "row" || state.tableSelectionMode === "column") {
    const span = lineSelectionSpan(state.tableSelectionMode);
    if (span > 1) {
      if (state.lineCopy) clearLineCopy();
      flash(`Multi-${state.tableSelectionMode} copy/insert is coming soon; copy a range for values instead.`,
        { kind: "warning", timeout: 1800 });
      return;
    }
    await stageLineCopy(state.tableSelectionMode, writeClipboardPayload);
    return;
  }
  if (state.lineCopy) clearLineCopy();
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

function tableSelectionPasteAnchor() {
  const mode = state.tableSelectionMode;
  if (mode === "range") return rangeAnchorElement();
  if (mode !== "row" && mode !== "column") return state.selected || null;
  const cell = gridCellFrom(state.selected);
  const grid = cell && gridForElement(cell);
  if (!grid) return state.selected || null;
  const bounds = state.tableRange && state.tableRange.table === grid.table
    ? rangeBounds(state.tableRange)
    : null;
  const row = mode === "row" ? (bounds?.r1 ?? grid.position.row) : 0;
  const col = mode === "column" ? (bounds?.c1 ?? grid.position.col) : 0;
  return (grid.matrix[row] && grid.matrix[row][col]) || state.selected || null;
}

export async function pastePayloadAtSelection(payload) {
  const mode = state.tableSelectionMode;
  if (["range", "row", "column"].includes(mode)) {
    const anchor = tableSelectionPasteAnchor();
    if (anchor) {
      if (mode === "range") {
        state.tableRange = null;
        state.tableSelectionMode = null;
        selectElementInternal(anchor);
      } else {
        selectElementInternal(anchor, mode, { preserveRange: true });
      }
    }
  }
  await pasteIntoSelection(payload);
}

export async function pasteIntoSelection({ text = "", html = "" } = {}) {
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

export async function pasteFromClipboard() {
  if (state.cut) {
    await pasteStagedCut();
    return;
  }
  if (state.lineCopy?.payload && gridCellFrom(state.selected)) {
    await pastePayloadAtSelection(state.lineCopy.payload);
    return;
  }
  try {
    const payload = await readClipboardPayload();
    await pastePayloadAtSelection(payload);
  } catch (err) {
    if (state.lineCopy?.payload) {
      await pastePayloadAtSelection(state.lineCopy.payload);
      return;
    }
    flash(err.message || "Clipboard paste is not available here.", { kind: "warning" });
  }
}

export async function stageRangeCutFromSelection() {
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

export async function pasteStagedCut() {
  if (!state.cut) return false;
  if (state.cut.kind === "range") return pasteStagedRangeCut();
  return commitLineCutPaste();
}

export async function deleteRangeContents() {
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
