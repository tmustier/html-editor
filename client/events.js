// Wire mouse, keyboard, and toolbar events. Lives at the top of the
// dependency tree because everything else exports the handlers it calls.

import { api } from "./api.js";
import { dom, flash, isOverlay } from "./dom.js";
import { interactionLock, reloadAfterMutation } from "./interaction.js";
import { sendComment, startComment } from "./comments.js";
import { beginDrag, beginResize, cancelDrag } from "./drag.js";
import {
  clearCut,
  clearLineCopy,
  stagedCut,
  stagedLineCopy,
} from "./transfer.js";
import {
  copySelectionToEventClipboard,
  isNativeClipboardTarget,
  pasteIntoSelection,
  pastePayloadAtSelection,
  pasteStagedCut,
} from "./clipboard.js";
import { finishActiveEdit, finishSvgLabelEdit, startEdit } from "./editing.js";
import { state } from "./state.js";
import { runTableOperation, tableRestoreModeForAction } from "./tableops.js";
import {
  editableFrom,
  gridCellFrom,
  isSvgLabelHit,
  navigate,
  placeBox,
  placeTableAddZones,
  refreshTableAddZones,
  selectElementInternal,
  selectTableDimension,
  tableEdgeSelectionModeFromEvent,
  targetFor,
  toggleHelp,
} from "./targets.js";
import {
  beginTableLineDrag,
  cancelTableLineDrag,
} from "./tabledrag.js";
import { handleEditorKeydown } from "./keyboard.js";

export function selectElement(el, tableSelectionMode = null) {
  selectElementInternal(el, tableSelectionMode);
}

export function deselect() {
  if (state.svgEditing) finishSvgLabelEdit(false);
  state.selected = null;
  state.tableSelectionMode = null;
  state.tableRange = null;
  clearCut();
  clearLineCopy();
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
  if (stagedCut()) clearCut();
  if (stagedLineCopy()) clearLineCopy();
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
  if (stagedCut()) clearCut();
  if (stagedLineCopy()) clearLineCopy();
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

function startEditClearingTransfers(...args) {
  // Editing cancels staged copy/cut state without mutating the source.
  if (stagedCut()) clearCut();
  if (stagedLineCopy()) clearLineCopy();
  startEdit(...args);
}

export function initEvents() {
  // --- clipboard ----------------------------------------------------------
  document.addEventListener("copy", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    if (!copySelectionToEventClipboard(e.clipboardData)) return;
    e.preventDefault();
  }, true);

  document.addEventListener("paste", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    if (stagedCut()) {
      e.preventDefault();
      void pasteStagedCut();
      return;
    }
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (typeof text !== "string" && typeof html !== "string") return;
    e.preventDefault();
    const lineCopy = stagedLineCopy();
    const payload = lineCopy?.payload && gridCellFrom(state.selected)
      ? lineCopy.payload
      : { text: text || "", html: html || "" };
    if (state.tableSelectionMode === "range"
        || state.tableSelectionMode === "row"
        || state.tableSelectionMode === "column") {
      void pastePayloadAtSelection(payload);
      return;
    }
    void pasteIntoSelection(payload);
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
        startEditClearingTransfers(e.target, e.clientX, e.clientY);
      }
      return;
    }
    if (target && target.kind === "svg-text") {
      selectElement(el);
      startEditClearingTransfers(e.target, e.clientX, e.clientY);
      return;
    }
    if (target && target.canEditText && target.kind === "html-text") {
      selectElement(el);
      startEditClearingTransfers(e.target, e.clientX, e.clientY);
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
    startEditClearingTransfers(e.target, e.clientX, e.clientY);
  }, true);

  // --- keyboard shortcuts -------------------------------------------------
  document.addEventListener("keydown", (e) => {
    handleEditorKeydown(e, {
      cancelTableLineDrag,
      cancelDrag,
      deselect,
      finishActiveEdit,
      finishSvgLabelEdit,
      insertOrDeleteLine,
      performHistory,
      startEditClearingTransfers,
    });
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
    if      (act === "edit")       startEditClearingTransfers();
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
