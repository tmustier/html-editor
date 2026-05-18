// Shared table-structure operation helpers.
//
// Table insert/delete/add operations still save through the server so source
// HTML, history, and edit-id assignment remain canonical. When the server
// returns a compact table patch, we apply it to the live DOM instead of
// reloading the whole page.

import { api } from "./api.js";
import { flash } from "./dom.js";
import { reloadAfterMutation } from "./interaction.js";
import { state } from "./state.js";
import { gridCellFrom, ensureVisible, refreshTableAddZones, selectElementInternal } from "./targets.js";

function selectorForEditId(id) {
  return `[data-edit-id="${CSS.escape(id)}"]`;
}

function rememberSelectionForReload(selectionId, mode) {
  if (!selectionId) return;
  sessionStorage.setItem("__edit_restore_selection", selectionId);
  if (mode) sessionStorage.setItem("__edit_restore_table_mode", mode);
  else sessionStorage.removeItem("__edit_restore_table_mode");
}

function clearReloadSelection() {
  sessionStorage.removeItem("__edit_restore_selection");
  sessionStorage.removeItem("__edit_restore_table_mode");
}

export function tableRestoreModeForAction(action, fallbackMode = "") {
  if (action.startsWith("row-")) return "row";
  if (action.startsWith("col-")) return "column";
  return fallbackMode || "";
}

function tableForPatch(patch) {
  const tableId = patch?.table_id;
  if (!tableId) return null;
  const table = document.querySelector(selectorForEditId(tableId));
  return table?.tagName?.toLowerCase() === "table" ? table : null;
}

function elementByEditId(root, id) {
  if (!id) return null;
  if (root.getAttribute && root.getAttribute("data-edit-id") === id) return root;
  return root.querySelector(selectorForEditId(id));
}

function parseRow(html) {
  const template = document.createElement("template");
  template.innerHTML = `<table><tbody>${html}</tbody></table>`;
  return template.content.querySelector("tr");
}

function parseCell(html) {
  const template = document.createElement("template");
  template.innerHTML = `<table><tbody><tr>${html}</tr></tbody></table>`;
  return template.content.querySelector("td, th");
}

function directRows(table) {
  return Array.from(table.rows || table.querySelectorAll("tr"));
}

function rebaseHoveredTable(oldTable, nextTable = oldTable) {
  if (state.hoveredTable === oldTable) state.hoveredTable = nextTable;
  else if (state.hoveredTable && !document.contains(state.hoveredTable)) {
    state.hoveredTable = null;
  }
}

function finishTableApply(result, restoreMode = "") {
  const selected = result.selection_id
    ? document.querySelector(selectorForEditId(result.selection_id))
    : null;
  if (result.selection_id && !selected) return false;
  if (selected) {
    selectElementInternal(selected, restoreMode || null);
    ensureVisible(selected);
  }
  refreshTableAddZones();
  clearReloadSelection();
  return true;
}

function applyPatchToClone(clone, patch) {
  const rows = directRows(clone);

  if (patch.kind === "row-insert") {
    const row = parseRow(patch.row_html);
    if (!row || !patch.parent_id) return false;
    const before = rows[patch.index] || null;
    let parent = elementByEditId(clone, patch.parent_id);
    // Browser DOM may materialize an implicit <tbody> for source tables that
    // contain direct <tr> children. In that case the server-side parent is the
    // table, but the live row siblings sit under the implicit tbody; insert
    // beside those siblings so the visual DOM mirrors the browser's structure.
    if (parent === clone && before?.parentNode && before.parentNode !== clone) {
      parent = before.parentNode;
    } else if (parent === clone && !before && rows.at(-1)?.parentNode
        && rows.at(-1).parentNode !== clone) {
      parent = rows.at(-1).parentNode;
    }
    if (!parent || parent.closest("table") !== clone) return false;
    parent.insertBefore(row, before && before.parentNode === parent ? before : null);
  } else if (patch.kind === "row-delete") {
    const row = rows[patch.index];
    if (!row) return false;
    row.remove();
  } else if (patch.kind === "row-move") {
    const source = rows[patch.source_index];
    const target = rows[patch.target_index];
    if (!source || !target || source.parentNode !== target.parentNode) return false;
    if (patch.mode === "before") target.parentNode.insertBefore(source, target);
    else target.parentNode.insertBefore(source, target.nextSibling);
  } else if (patch.kind === "col-insert") {
    if (!Array.isArray(patch.cells_html) || patch.cells_html.length !== rows.length) return false;
    const parsed = patch.cells_html.map(parseCell);
    if (parsed.some((cell) => !cell)) return false;
    rows.forEach((row, index) => row.insertBefore(parsed[index], row.cells[patch.index] || null));
  } else if (patch.kind === "col-delete") {
    if (rows.some((row) => !row.cells[patch.index])) return false;
    rows.forEach((row) => row.cells[patch.index].remove());
  } else if (patch.kind === "col-move") {
    if (rows.some((row) => !row.cells[patch.source_index] || !row.cells[patch.target_index])) {
      return false;
    }
    rows.forEach((row) => {
      const source = row.cells[patch.source_index];
      const target = row.cells[patch.target_index];
      if (patch.mode === "before") target.parentNode.insertBefore(source, target);
      else target.parentNode.insertBefore(source, target.nextSibling);
    });
  } else {
    return false;
  }
  return true;
}

export function applyTablePatch(result, restoreMode = "") {
  const patch = result?.table_patch;
  const table = tableForPatch(patch);
  if (!patch || !table) return false;
  const clone = table.cloneNode(true);
  if (!applyPatchToClone(clone, patch)) return false;
  if (result.selection_id && !elementByEditId(clone, result.selection_id)) return false;
  table.replaceWith(clone);
  rebaseHoveredTable(table, clone);
  return finishTableApply(result, restoreMode);
}

export function applyTableSnapshot(result, restoreMode = "") {
  const tableId = result?.table_id;
  const html = result?.table_html;
  if (!tableId || !html) return false;
  const current = document.querySelector(selectorForEditId(tableId));
  if (!current || current.tagName.toLowerCase() !== "table") return false;

  const template = document.createElement("template");
  template.innerHTML = String(html).trim();
  const next = template.content.firstElementChild;
  if (!next || next.tagName.toLowerCase() !== "table") return false;
  current.replaceWith(next);
  rebaseHoveredTable(current, next);
  return finishTableApply(result, restoreMode);
}

export async function runTableOperation(cell, action, {
  restoreMode = tableRestoreModeForAction(action),
  successMessage = `Table ${action.replace(/-/g, " ")} done.`,
  errorPrefix = "Table change failed",
  reloadDelay = 220,
  extra = {},
} = {}) {
  const tableCell = gridCellFrom(cell);
  if (!tableCell) {
    flash("Select a table cell first.", { kind: "warning" });
    return { ok: false, applied: false, result: null };
  }
  let result;
  try {
    result = await api.tableOperation(tableCell.getAttribute("data-edit-id"), action,
      { ...extra, include_table_patch: true });
  } catch (err) {
    flash(`${errorPrefix}: ${err.message}`, { kind: "error", timeout: 3600 });
    return { ok: false, applied: false, result: null };
  }

  let applied = false;
  try {
    applied = applyTablePatch(result, restoreMode) || applyTableSnapshot(result, restoreMode);
  } catch (err) {
    console.warn("html-editor: local table patch apply failed; reloading", err);
  }
  if (!applied) {
    rememberSelectionForReload(result.selection_id, restoreMode);
    reloadAfterMutation({ delay: reloadDelay });
  }
  flash(successMessage, { kind: "success", timeout: 1200 });
  return { ok: true, applied, result };
}
