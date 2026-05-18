// Keyboard command routing for the editor.
//
// events.js wires DOM listeners; this module owns shortcut interpretation and
// dispatch so clipboard, table, range, history, and edit-mode chords live in
// one focused place.

import { dom, flash, isOverlay } from "./dom.js";
import { startComment } from "./comments.js";
import {
  clearCut,
  clearLineCopy,
  commitLineCopyInsertBeforeSelection,
  commitLineCutInsertBeforeSelection,
  stageLineCut,
  stagedCut,
  stagedLineCopy,
} from "./transfer.js";
import {
  copySelectionToClipboard,
  deleteRangeContents,
  pasteFromClipboard,
  pasteStagedCut,
  stageRangeCutFromSelection,
  writeClipboardPayload,
} from "./clipboard.js";
import { state } from "./state.js";
import {
  ensureVisible,
  extendTableRange,
  gridCellFrom,
  gridForElement,
  navigate,
  navigateGrid,
  placeBox,
  placeToolbar,
  rangeAnchorElement,
  selectElementInternal,
  toggleHelp,
} from "./targets.js";

function isEditableField(target) {
  return !!(target && (
    target.tagName === "TEXTAREA"
    || target.tagName === "INPUT"
    || (target.getAttribute && target.getAttribute("contenteditable") === "true")
  ));
}

function isPrimaryModifier(event) {
  return event.metaKey || event.ctrlKey;
}

function lineSelectionSpan() {
  const singleLineSelection = state.tableSelectionMode === "row"
    || state.tableSelectionMode === "column";
  if (!singleLineSelection || !state.tableRange) return 1;
  return state.tableSelectionMode === "row"
    ? Math.abs(state.tableRange.focus.row - state.tableRange.anchor.row) + 1
    : Math.abs(state.tableRange.focus.col - state.tableRange.anchor.col) + 1;
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

function handleEscape(event, actions) {
  if (state.dragging && state.dragging.mode === "table-line") {
    event.preventDefault(); actions.cancelTableLineDrag(); return true;
  }
  if (state.dragging)  { event.preventDefault(); actions.cancelDrag(); return true; }
  if (state.svgEditing){ event.preventDefault(); actions.finishSvgLabelEdit(false); return true; }
  if (state.editing)   return true; // edit handler owns its own cancel
  if (stagedCut()) {
    event.preventDefault();
    clearCut();
    flash("Cut cleared.", { kind: "info", timeout: 800 });
    return true;
  }
  if (stagedLineCopy()) {
    event.preventDefault();
    clearLineCopy();
    flash("Copy cleared.", { kind: "info", timeout: 800 });
    return true;
  }
  if (!dom.commentBox.hidden) { event.preventDefault(); dom.commentBox.hidden = true; return true; }
  if (!dom.tableMenu.hidden)  { event.preventDefault(); dom.tableMenu.hidden = true; return true; }
  if (!dom.helpOverlay.hidden){ event.preventDefault(); toggleHelp(false); return true; }
  // Step down through table selection modes:
  //   table → range or cell (we don't track the prior axis, so collapse
  //              straight to the range that drove the promotion if it
  //              existed, otherwise to the single anchor cell)
  //   row|column → range or cell
  //   range  → cell
  //   cell   → deselect
  if (state.tableSelectionMode === "table" && state.selected) {
    event.preventDefault();
    selectElementInternal(state.selected,
      state.tableRange ? "range" : null,
      { preserveRange: true });
    return true;
  }
  if ((state.tableSelectionMode === "row" || state.tableSelectionMode === "column")
      && state.selected) {
    event.preventDefault();
    // Collapse to range if a range is active, otherwise to single cell.
    const next = state.tableRange ? "range" : null;
    selectElementInternal(state.selected, next, { preserveRange: true });
    return true;
  }
  if (state.tableSelectionMode === "range" && state.selected) {
    event.preventDefault();
    state.tableRange = null;
    selectElementInternal(state.selected, null);
    return true;
  }
  if (state.tableSelectionMode && state.selected) {
    event.preventDefault();
    selectElementInternal(state.selected);
    return true;
  }
  if (state.selected)  { event.preventDefault(); actions.deselect(); return true; }
  return true;
}

function handleTab(event, actions) {
  if (event.key !== "Tab" || !state.selected || !gridCellFrom(state.selected)
      || !(state.editing || !isOverlay(event.target))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  const direction = event.shiftKey ? "previous" : "next";
  void (async () => {
    if (state.editing) await actions.finishActiveEdit(true);
    if (!navigateGrid(direction)) {
      flash(event.shiftKey ? "No previous grid cell." : "No next grid cell.", { kind: "warning" });
    }
  })();
  return true;
}

function handleRangeAndTransferKeys(event, key, inEditableField) {
  if ((event.key === "Backspace" || event.key === "Delete") && stagedCut()
      && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    flash("Press Esc to cancel the staged cut before clearing cells.", { kind: "warning" });
    return true;
  }

  // Range-aware delete / backspace: clear every cell in one batch.
  if ((event.key === "Backspace" || event.key === "Delete")
      && state.tableSelectionMode === "range" && state.selected
      && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    void deleteRangeContents();
    return true;
  }

  // Range-aware Cmd+X: stage an Excel-style cut, don't clear yet.
  if (isPrimaryModifier(event) && !event.altKey && !event.shiftKey && key === "x"
      && state.tableSelectionMode === "range" && state.selected
      && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    void stageRangeCutFromSelection();
    return true;
  }

  // Excel-style row/column cut on Cmd/Ctrl+X.
  const cutKey = isPrimaryModifier(event) && !event.altKey && !event.shiftKey && key === "x";
  const singleLineSelection = state.tableSelectionMode === "row"
    || state.tableSelectionMode === "column";
  const lineSpan = lineSelectionSpan();
  if (cutKey && singleLineSelection && state.selected
      && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    if (lineSpan > 1) {
      flash(
        `Single-${state.tableSelectionMode} cut/paste only — multi-${state.tableSelectionMode} move coming soon.`,
        { kind: "warning" });
      return true;
    }
    void stageLineCut(state.tableSelectionMode, writeClipboardPayload);
    return true;
  }

  // Excel-style paste-as-move if a staged cut is pending.
  if (isPrimaryModifier(event) && !event.altKey && !event.shiftKey && key === "v"
      && stagedCut() && state.selected
      && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    if (singleLineSelection && lineSpan > 1) {
      flash(
        `Single-${state.tableSelectionMode} cut/paste only.`,
        { kind: "warning" });
      return true;
    }
    void pasteStagedCut();
    return true;
  }

  const isClipboardKey = isPrimaryModifier(event) && !event.altKey
    && (key === "c" || key === "v");
  if (isClipboardKey && state.selected && !inEditableField && !state.editing) {
    event.preventDefault();
    event.stopPropagation();
    void (key === "c" ? copySelectionToClipboard() : pasteFromClipboard());
    return true;
  }

  return false;
}

function handleHistoryKey(event, key, inEditableField, actions) {
  const isHistoryKey = isPrimaryModifier(event) && !event.altKey
    && (key === "z" || key === "y");
  if (!isHistoryKey || inEditableField || state.editing) return false;
  event.preventDefault();
  if (stagedCut()) clearCut();
  if (stagedLineCopy()) clearLineCopy();
  actions.performHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  return true;
}

function handleStructureKeys(event, inEditableField, actions) {
  // Excel-style row/column structure shortcuts:
  //   Ctrl+Shift+= (the "+" key) inserts before the selection.
  //   Ctrl+- deletes the selected row/column.
  //   Cmd+Shift+= / Cmd+- as Mac Excel fallbacks.
  const isPlusInsert = isPrimaryModifier(event) && !event.altKey && event.shiftKey
    && (event.key === "+" || event.key === "=" || event.code === "Equal");
  const isMinusDelete = isPrimaryModifier(event) && !event.altKey && !event.shiftKey
    && (event.key === "-" || event.key === "_" || event.code === "Minus");
  if (!(isPlusInsert || isMinusDelete) || inEditableField || state.editing) return false;

  const plusCut = stagedCut();
  if (isPlusInsert && plusCut && ["row", "column"].includes(plusCut.kind)
      && state.selected && gridCellFrom(state.selected)) {
    event.preventDefault();
    event.stopPropagation();
    void commitLineCutInsertBeforeSelection();
    return true;
  }
  const plusCopy = stagedLineCopy();
  if (isPlusInsert && plusCopy && ["row", "column"].includes(plusCopy.kind)
      && state.selected && gridCellFrom(state.selected)) {
    event.preventDefault();
    event.stopPropagation();
    void commitLineCopyInsertBeforeSelection();
    return true;
  }
  if (isPlusInsert && stagedCut("range")) {
    event.preventDefault();
    event.stopPropagation();
    flash("Insert cut only supports full rows/columns; use Cmd+V to move a range.",
      { kind: "warning" });
    return true;
  }

  const singleLineSelection = state.tableSelectionMode === "row"
    || state.tableSelectionMode === "column";
  if (singleLineSelection && state.selected) {
    event.preventDefault();
    event.stopPropagation();
    const span = lineSelectionSpan();
    if (span > 1) {
      flash(
        `Applied to first ${state.tableSelectionMode} only — multi-${state.tableSelectionMode} insert/delete coming soon.`,
        { kind: "info", timeout: 1400 });
    }
    actions.insertOrDeleteLine(isPlusInsert ? "insert" : "delete");
    return true;
  }
  // Otherwise let the browser handle Cmd+/- zoom etc.
  return false;
}

function handleSelectionAndNavigationKeys(event, key, actions) {
  if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
    event.preventDefault();
    toggleHelp();
    return true;
  }

  if (!state.selected) return true;

  if (event.key === " " && state.selected && gridCellFrom(state.selected)) {
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      promoteTableSelection("row");
      return true;
    }
    if ((event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey)
        || (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey)) {
      event.preventDefault();
      promoteTableSelection("column");
      return true;
    }
  }

  // Shift+Arrow extends an Excel-style rectangular cell range across the
  // current table. Honors row/column promotion when those modes are already
  // active (Shift+Down in row mode adds another row, etc.).
  const isArrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
  if (isArrow && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
      && gridCellFrom(state.selected) && !isOverlay(event.target)) {
    const direction = event.key.replace("Arrow", "").toLowerCase();
    const mode = state.tableSelectionMode;
    // In row mode, only Shift+Up/Down is meaningful (rows already cover
    // every column); in column mode, only Shift+Left/Right.
    if (mode === "row" && (direction === "left" || direction === "right")) {
      event.preventDefault();
      return true;
    }
    if (mode === "column" && (direction === "up" || direction === "down")) {
      event.preventDefault();
      return true;
    }
    if (mode === "table") {
      event.preventDefault();
      return true;
    }
    event.preventDefault();
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
    return true;
  }

  const gridArrow = !event.altKey && !event.ctrlKey && !event.shiftKey
    && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    && gridCellFrom(state.selected)
    && !isOverlay(event.target);
  if (gridArrow) {
    event.preventDefault();
    // Bare arrow keys collapse any range / multi-line selection back to a
    // single cell before moving (Excel behavior).
    if (state.tableRange || state.tableSelectionMode) {
      state.tableRange = null;
      state.tableSelectionMode = null;
    }
    const direction = event.key.replace("Arrow", "").toLowerCase();
    navigateGrid(event.metaKey ? `edge-${direction}` : direction);
    return true;
  }

  const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (event.key === "F2" || (unmodified && (event.key === "Enter" || key === "e"))) {
    event.preventDefault();
    // In range mode, collapse to anchor cell before entering edit.
    if (state.tableSelectionMode === "range") collapseRangeToAnchor();
    actions.startEditClearingTransfers();
    return true;
  }
  if (unmodified && key === "c") {
    event.preventDefault();
    // In range mode, collapse to anchor cell before starting the comment.
    if (state.tableSelectionMode === "range") collapseRangeToAnchor();
    startComment();
    return true;
  }
  if (event.altKey) {
    if (event.key === "ArrowLeft")  { event.preventDefault(); navigate("left");  return true; }
    if (event.key === "ArrowRight") { event.preventDefault(); navigate("right"); return true; }
    if (event.key === "ArrowUp")    { event.preventDefault(); navigate("up");    return true; }
    if (event.key === "ArrowDown")  { event.preventDefault(); navigate("down");  return true; }
  }
  return false;
}

export function handleEditorKeydown(event, actions) {
  if (event.key === "Escape") return handleEscape(event, actions);

  const inEditableField = isEditableField(event.target);
  const key = event.key.toLowerCase();

  if (handleTab(event, actions)) return true;
  if (handleRangeAndTransferKeys(event, key, inEditableField)) return true;
  if (handleHistoryKey(event, key, inEditableField, actions)) return true;
  if (handleStructureKeys(event, inEditableField, actions)) return true;

  if (inEditableField || state.editing) return false;
  return handleSelectionAndNavigationKeys(event, key, actions);
}
