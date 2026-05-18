// Shared table-structure operation helpers.
//
// Table insert/delete/add operations still save through the server so source
// HTML, history, and edit-id assignment remain canonical. When the server
// returns a fresh table snapshot, we replace only that table in the live DOM
// instead of reloading the whole page.

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
  const wasHovered = state.hoveredTable === current;
  current.replaceWith(next);
  if (wasHovered) state.hoveredTable = next;
  else if (state.hoveredTable && !document.contains(state.hoveredTable)) {
    state.hoveredTable = null;
  }

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

export async function runTableOperation(cell, action, {
  restoreMode = tableRestoreModeForAction(action),
  successMessage = `Table ${action.replace(/-/g, " ")} done.`,
  errorPrefix = "Table change failed",
  reloadDelay = 220,
} = {}) {
  const tableCell = gridCellFrom(cell);
  if (!tableCell) {
    flash("Select a table cell first.", { kind: "warning" });
    return { ok: false, applied: false, result: null };
  }
  let result;
  try {
    result = await api.tableOperation(tableCell.getAttribute("data-edit-id"), action,
      { include_table_html: true });
  } catch (err) {
    flash(`${errorPrefix}: ${err.message}`, { kind: "error", timeout: 3600 });
    return { ok: false, applied: false, result: null };
  }

  let applied = false;
  try {
    applied = applyTableSnapshot(result, restoreMode);
  } catch (err) {
    console.warn("html-editor: local table snapshot apply failed; reloading", err);
  }
  if (!applied) {
    rememberSelectionForReload(result.selection_id, restoreMode);
    reloadAfterMutation({ delay: reloadDelay });
  }
  flash(successMessage, { kind: "success", timeout: 1200 });
  return { ok: true, applied, result };
}
