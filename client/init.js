// Reflow loop (re-position overlay on scroll/resize), comment polling, and
// the window.__edit debug API.

import { dom } from "./dom.js";
import { loadComments, startComment } from "./comments.js";
import { performHistory, selectElement, deselect } from "./events.js";
import { state } from "./state.js";
import {
  currentTarget,
  ensureVisible,
  navigate,
  navigateGrid,
  placeBox,
  placeToolbar,
  tableRangeMatrix,
  toggleHelp,
} from "./targets.js";
import { beginDrag } from "./drag.js";
import { positionSvgLabelInputs, startEdit } from "./editing.js";

const COMMENT_POLL_MS = 8000;
const DOT_RELOAD_DEBOUNCE_MS = 120;

export function initRuntime() {
  let raf = 0;
  function reflow() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (state.selected) {
        placeBox(dom.selectBox, state.selected);
        if (!state.editing) placeToolbar(state.selected);
      }
      if (state.svgEditing) positionSvgLabelInputs(state.svgEditing);
      if (state.hovered) placeBox(dom.hoverBox, state.hovered);
    });
  }

  let dotTimer = 0;
  function loadDotsThrottled() {
    clearTimeout(dotTimer);
    dotTimer = setTimeout(loadComments, DOT_RELOAD_DEBOUNCE_MS);
  }

  window.addEventListener("scroll", () => { reflow(); loadDotsThrottled(); }, true);
  window.addEventListener("resize", () => { reflow(); loadDotsThrottled(); });

  // Poll for comments so external CLI edits show up.
  setInterval(loadComments, COMMENT_POLL_MS);
  loadComments();

  const restoreId = sessionStorage.getItem("__edit_restore_selection");
  const restoreTableMode = sessionStorage.getItem("__edit_restore_table_mode");
  if (restoreId) {
    sessionStorage.removeItem("__edit_restore_selection");
    sessionStorage.removeItem("__edit_restore_table_mode");
    const restoreEl = Array.from(document.querySelectorAll("[data-edit-id]")).find((el) =>
      el.getAttribute("data-edit-id") === restoreId);
    if (restoreEl) {
      selectElement(restoreEl, ["row", "column"].includes(restoreTableMode) ? restoreTableMode : null);
      ensureVisible(restoreEl);
    }
  }

  // tiny API for debugging / tests
  window.__edit = {
    select: selectElement,
    deselect,
    reload: loadComments,
    startEdit,
    startComment,
    navigate,
    navigateGrid,
    toggleHelp,
    beginDrag,
    target: currentTarget,
    selectionMode: () => state.tableSelectionMode,
    tableRange: () => {
      if (!state.tableRange) return null;
      const { anchor, focus } = state.tableRange;
      return { anchor: { ...anchor }, focus: { ...focus } };
    },
    rangeCells: () => tableRangeMatrix().map((row) =>
      row.map((el) => (el ? (el.innerText || el.textContent || "").trim() : null))),
    undo: () => performHistory("undo"),
    redo: () => performHistory("redo"),
  };
}
