// Wire mouse, keyboard, and toolbar events. Lives at the top of the
// dependency tree because everything else exports the handlers it calls.

import { api } from "./api.js";
import { dom, flash, isOverlay } from "./dom.js";
import { interactionLock, reloadAfterMutation } from "./interaction.js";
import { sendComment, startComment } from "./comments.js";
import { beginDrag, beginResize, cancelDrag } from "./drag.js";
import { finishActiveEdit, finishSvgLabelEdit, startEdit } from "./editing.js";
import { state } from "./state.js";
import {
  editableFrom,
  gridCellFrom,
  isSvgLabelHit,
  navigate,
  navigateGrid,
  placeBox,
  placeToolbar,
  selectElementInternal,
  targetFor,
  toggleHelp,
} from "./targets.js";

export function selectElement(el) {
  selectElementInternal(el);
}

export function deselect() {
  if (state.svgEditing) finishSvgLabelEdit(false);
  state.selected = null;
  dom.selectBox.style.display = "none";
  dom.toolbar.hidden = true;
  dom.commentBox.hidden = true;
  dom.svgEditor.hidden = true;
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

export function initEvents() {
  // --- mouse tracking -----------------------------------------------------
  document.addEventListener("mousemove", (e) => {
    if (state.editing || state.dragging) return;
    const t = e.target;
    if (isOverlay(t)) {
      dom.hoverBox.style.display = "none";
      state.hovered = null;
      return;
    }
    const el = editableFrom(t);
    if (!el) {
      dom.hoverBox.style.display = "none";
      state.hovered = null;
      return;
    }
    state.hovered = el;
    placeBox(dom.hoverBox, el);
  }, true);

  document.addEventListener("mouseleave", () => {
    dom.hoverBox.style.display = "none";
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
      if (state.dragging)  { e.preventDefault(); cancelDrag(); return; }
      if (state.svgEditing){ e.preventDefault(); finishSvgLabelEdit(false); return; }
      if (state.editing)   return; // edit handler owns its own cancel
      if (!dom.commentBox.hidden) { e.preventDefault(); dom.commentBox.hidden = true; return; }
      if (!dom.helpOverlay.hidden){ e.preventDefault(); toggleHelp(false); return; }
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

    const isHistoryKey = (e.metaKey || e.ctrlKey) && !e.altKey
      && (key === "z" || key === "y");
    if (isHistoryKey && !inEditableField && !state.editing) {
      e.preventDefault();
      performHistory(key === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }

    if (inEditableField || state.editing) return;

    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      toggleHelp();
      return;
    }

    if (!state.selected) return;

    const plainGridArrow = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      && gridCellFrom(state.selected)
      && !isOverlay(t);
    if (plainGridArrow) {
      e.preventDefault();
      const direction = e.key.replace("Arrow", "").toLowerCase();
      if (!navigateGrid(direction)) {
        flash("No grid cell in that direction.", { kind: "warning" });
      }
      return;
    }

    if (e.key === "F2" || e.key === "Enter" || key === "e") {
      e.preventDefault(); startEdit(); return;
    }
    if (key === "c") {
      e.preventDefault(); startComment(); return;
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
    else if (act === "close")      deselect();
    else if (act === "nav-prev")   navigate("left");
    else if (act === "nav-parent") navigate("up");
    else if (act === "nav-child")  navigate("down");
    else if (act === "nav-next")   navigate("right");
    else if (act === "help")       toggleHelp();
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
      e.preventDefault();
      e.stopPropagation();
      dom.commentBox.hidden = true;
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
