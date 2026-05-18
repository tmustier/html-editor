// Target model: every selectable element resolves to a semantic Target
// describing its capabilities (canEditText, canMove, kind). Other modules
// dispatch off this rather than re-deriving from the DOM each time.
//
// Also owns: predicates (isSvgGroup, isHtmlResizable, ...), DOM walks
// (editableFrom, nextEditableSibling, ...), navigation, breadcrumb
// rendering, and the toolbar-placement code.

import { INLINE_TEXT_TAGS } from "./config.js";
import { dom, flash, isOverlay, rectOf } from "./dom.js";
import { state } from "./state.js";
import {
  gridCellFrom,
  gridEdgeNeighbor,
  gridNeighbor,
  gridTabNeighbor,
  tableColSpanCells,
  tableRowSpanCells,
  tableSelectionCells,
} from "./tablegrid.js";
export {
  clearTableRange,
  dropSlotFor,
  extendTableRange,
  gridCellFrom,
  gridEdgeNeighbor,
  gridForElement,
  gridNeighbor,
  gridPasteTargets,
  gridTabNeighbor,
  rangeAnchorElement,
  rangeBounds,
  tableColSpanCells,
  tableEdgeSelectionModeFromEvent,
  tableLineRects,
  tableRangeMatrix,
  tableRectFor,
  tableRowIndexOf,
  tableRowSpanCells,
  tableSelectionCells,
} from "./tablegrid.js";

// --- predicates -----------------------------------------------------------

export const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
export const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
export const isSvgGroup = (el) => tagName(el) === "g" && isInsideSvg(el);
export const isSvgText  = (el) => tagName(el) === "text" && isInsideSvg(el);
export const hasChildElements = (el) => !!(el && el.querySelector && el.querySelector("*"));
const isInlineTextTag = (el) => INLINE_TEXT_TAGS.has(tagName(el));

export function isEditable(el) {
  if (!el || !el.getAttribute || !el.getAttribute("data-edit-id")) return false;
  return !isInsideSvg(el) || isSvgGroup(el) || isSvgText(el);
}

function hasOnlyInlineDescendants(el) {
  if (!el || !el.querySelectorAll) return true;
  return Array.from(el.querySelectorAll("*")).every((child) =>
    !isInsideSvg(child) && INLINE_TEXT_TAGS.has(tagName(child))
  );
}

function isTextEditableElement(el) {
  return isEditable(el) && !isInsideSvg(el)
    && (!hasChildElements(el) || hasOnlyInlineDescendants(el));
}

function isDraggableSvgGroup(el) {
  if (!isSvgGroup(el)) return false;
  return !Array.from(el.querySelectorAll("g[data-edit-id]")).some(isEditable);
}

export function isHtmlResizable(el) {
  if (!isEditable(el) || isInsideSvg(el)) return false;
  const tag = tagName(el);
  if (tag === "html" || tag === "body" || tag === "head") return false;
  if (INLINE_TEXT_TAGS.has(tag)) return false;
  const display = (window.getComputedStyle(el).display || "").toLowerCase();
  if (display === "inline" || display === "contents" || display === "none") return false;
  return true;
}

function svgTextNodes(el) {
  if (isSvgGroup(el)) return Array.from(el.querySelectorAll("text"));
  if (isSvgText(el)) return [el];
  return [];
}

export function svgTextFromHit(target) {
  if (!(target && target.closest)) return null;
  const text = target.closest("text");
  if (text) return text;
  const tspan = target.closest("tspan");
  return tspan && tspan.closest ? tspan.closest("text") : null;
}

export function isSvgLabelHit(target) {
  return !!svgTextFromHit(target);
}

// --- target model ---------------------------------------------------------

export function targetFor(el) {
  if (!isEditable(el)) return null;
  if (isSvgText(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-text",
      canEditText: true, canComment: true, canMove: false, moveMode: null,
    };
  }
  if (isDraggableSvgGroup(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-item",
      canEditText: svgTextNodes(el).length > 0,
      canComment: true, canMove: true, moveMode: "spatial",
    };
  }
  if (isInsideSvg(el)) {
    return {
      el, id: el.getAttribute("data-edit-id"),
      kind: "svg-container",
      canEditText: false, canComment: true, canMove: false, moveMode: null,
    };
  }
  const canEditText = isTextEditableElement(el);
  return {
    el, id: el.getAttribute("data-edit-id"),
    kind: canEditText ? "html-text" : "html-structural",
    canEditText, canComment: true, canMove: true, moveMode: "reorder",
  };
}

export function currentTarget() {
  return targetFor(state.selected);
}

// --- DOM walks ------------------------------------------------------------

function textEditableRootFromHit(target) {
  if (!target || isInsideSvg(target)) return null;
  let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  let cur = el && el.closest ? el.closest("[data-edit-id]") : null;
  let best = null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (isTextEditableElement(cur) && !isInlineTextTag(cur)) best = cur;
    cur = cur.parentElement && cur.parentElement.closest
      ? cur.parentElement.closest("[data-edit-id]")
      : null;
  }
  return best;
}

export function editableFrom(target) {
  if (isInsideSvg(target)) {
    // Prefer a labelled <g> wrapping the hit; otherwise allow direct editing
    // of an orphan <text>. Anything else falls through to the generic
    // ancestor walk (which lands on the enclosing SVG container itself).
    const group = target.closest && target.closest("g[data-edit-id]");
    if (group && isEditable(group)) return group;
    const text = target.closest && target.closest("text[data-edit-id]");
    if (text && isEditable(text)) return text;
  }

  // Inline formatting/code runs are not independent text boxes. If a click
  // lands on <code>, <b>, <span>, etc. inside a larger editable text block,
  // edit/select the containing text box so arrow keys can move across the
  // style boundary like PowerPoint/Keynote text.
  const textRoot = textEditableRootFromHit(target);
  if (textRoot) return textRoot;

  let el = target;
  while (el && !isEditable(el)) el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return el;
}

export function editableAncestor(el) {
  while (el && !isEditable(el)) el = el.parentElement;
  return el && el !== document.body && el !== document.documentElement ? el : null;
}

export function prevEditableSibling(el) {
  let s = el && el.previousElementSibling;
  while (s) { if (isEditable(s)) return s; s = s.previousElementSibling; }
  return null;
}

export function nextEditableSibling(el) {
  let s = el && el.nextElementSibling;
  while (s) { if (isEditable(s)) return s; s = s.nextElementSibling; }
  return null;
}

export function firstEditableChild(el) {
  if (!el || !el.querySelectorAll) return null;
  if (el.querySelector("svg") || isSvgGroup(el)) {
    const groups = Array.from(el.querySelectorAll("g[data-edit-id]")).filter(isEditable);
    if (groups.length) {
      return groups.find((g) => !Array.from(g.querySelectorAll("g[data-edit-id]")).some(isEditable)) || groups[0];
    }
    const texts = Array.from(el.querySelectorAll("text[data-edit-id]")).filter(isEditable);
    if (texts.length) return texts[0];
    return null;
  }
  return Array.from(el.querySelectorAll("[data-edit-id]")).find((child) =>
    isEditable(child) && !(isInlineTextTag(child) && textEditableRootFromHit(child) === el)
  ) || null;
}

// --- grid/table actions -----------------------------------------------------

export function selectTableDimension(mode) {
  const cell = gridCellFrom(state.selected);
  if (!cell || !["row", "column"].includes(mode)) {
    flash("Select a table cell first.", { kind: "warning" });
    return false;
  }
  selectElementInternal(cell, mode);
  ensureVisible(cell);
  return true;
}

// --- breadcrumbs / labels -------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function labelFor(el) {
  if (isSvgGroup(el)) {
    const label = Array.from(el.querySelectorAll("text"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 48);
    return label || "svg group";
  }
  if (isSvgText(el)) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return text ? `text "${text}"` : "svg text";
  }
  let label = tagName(el);
  const cls = typeof el.className === "string"
    ? el.className.split(/\s+/).filter((c) => c && !c.startsWith("__edit_"))[0]
    : "";
  if (el.id) label += "#" + el.id;
  else if (cls) label += "." + cls;
  return label;
}

export function breadcrumb(el) {
  if (isSvgGroup(el) || isSvgText(el)) {
    return `<span class="cur">${escapeHtml(labelFor(el))}</span>`;
  }
  const parts = [];
  let cur = el;
  while (cur && isEditable(cur) && parts.length < 4) {
    parts.unshift(labelFor(cur));
    cur = cur.parentElement;
  }
  return parts.map((p, i) =>
    i === parts.length - 1
      ? `<span class="cur">${escapeHtml(p)}</span>`
      : `<span>${escapeHtml(p)}</span>`
  ).join('<span class="arrow">›</span>');
}

// --- layout / placement ---------------------------------------------------

function canDuplicateElement(el, target) {
  if (!el || !target) return false;
  if (target.kind === "svg-text") return true;
  if (!target.canMove) return false;
  if (!isInsideSvg(el)) {
    const table = el.closest && el.closest("table");
    if (table && el !== table) return false;
  }
  return true;
}

function hideTableAddZones() {
  if (!dom.addRowZone || !dom.addColZone) return;
  dom.addRowZone.dataset.visible = "false";
  dom.addColZone.dataset.visible = "false";
}

export function placeTableAddZones(table) {
  if (!dom.addRowZone || !dom.addColZone) return;
  if (!table || state.editing || state.dragging) {
    hideTableAddZones();
    return;
  }
  const r = rectOf(table);
  const gap = 5;
  const thickness = 22; // pill height/width — big enough to hit comfortably
  const corner = 18; // leave the SE corner alone for resize/move grip
  // Bottom "+" row zone.
  const rowLeft = r.left;
  const rowWidth = Math.max(0, r.width - corner);
  if (rowWidth > 24) {
    dom.addRowZone.style.left = rowLeft + "px";
    dom.addRowZone.style.top = (r.top + r.height + gap) + "px";
    dom.addRowZone.style.width = rowWidth + "px";
    dom.addRowZone.style.height = thickness + "px";
    dom.addRowZone.dataset.visible = "true";
  } else {
    dom.addRowZone.dataset.visible = "false";
  }
  // Right "+" column zone.
  const colTop = r.top;
  const colHeight = Math.max(0, r.height - corner);
  if (colHeight > 24) {
    dom.addColZone.style.left = (r.left + r.width + gap) + "px";
    dom.addColZone.style.top = colTop + "px";
    dom.addColZone.style.width = thickness + "px";
    dom.addColZone.style.height = colHeight + "px";
    dom.addColZone.dataset.visible = "true";
  } else {
    dom.addColZone.dataset.visible = "false";
  }
}

export function refreshTableAddZones() {
  placeTableAddZones(state.hoveredTable);
}

function unionDocumentRect(elements) {
  const rects = elements.filter(Boolean).map(rectOf);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

function selectionRectFor(el) {
  const mode = state.tableSelectionMode;
  if (mode && gridCellFrom(el)) {
    const selectionRect = unionDocumentRect(tableSelectionCells(el, mode));
    if (selectionRect) return selectionRect;
  }
  return rectOf(el);
}

function placeTableHandles(el) {
  const cell = gridCellFrom(el);
  if (!cell || state.editing || state.dragging) {
    dom.rowHandle.style.display = "none";
    dom.colHandle.style.display = "none";
    return;
  }
  const rowRect = unionDocumentRect(tableRowSpanCells(cell));
  const colRect = unionDocumentRect(tableColSpanCells(cell));
  const rowActive = state.tableSelectionMode === "row" || state.tableSelectionMode === "table";
  const colActive = state.tableSelectionMode === "column" || state.tableSelectionMode === "table";
  if (rowRect) {
    const outsideLeft = rowRect.left - 12;
    const clampedLeft = outsideLeft < window.scrollX + 2
      ? rowRect.left + 2
      : outsideLeft;
    dom.rowHandle.style.display = "block";
    dom.rowHandle.style.top = rowRect.top + "px";
    dom.rowHandle.style.left = clampedLeft + "px";
    dom.rowHandle.style.width = "10px";
    dom.rowHandle.style.height = rowRect.height + "px";
    dom.rowHandle.dataset.active = rowActive ? "true" : "false";
  } else {
    dom.rowHandle.style.display = "none";
  }
  if (colRect) {
    const outsideTop = colRect.top - 12;
    const clampedTop = outsideTop < window.scrollY + 2
      ? colRect.top + 2
      : outsideTop;
    dom.colHandle.style.display = "block";
    dom.colHandle.style.top = clampedTop + "px";
    dom.colHandle.style.left = colRect.left + "px";
    dom.colHandle.style.width = colRect.width + "px";
    dom.colHandle.style.height = "10px";
    dom.colHandle.dataset.active = colActive ? "true" : "false";
  } else {
    dom.colHandle.style.display = "none";
  }
}

export function placeBox(box, el) {
  if (!el) { box.style.display = "none"; return; }
  const r = box === dom.selectBox ? selectionRectFor(el) : rectOf(el);
  box.style.display = "block";
  box.style.top = r.top + "px";
  box.style.left = r.left + "px";
  box.style.width = r.width + "px";
  box.style.height = r.height + "px";
  if (box === dom.selectBox) {
    const target = targetFor(el);
    const isTableRange = !!state.tableSelectionMode;
    box.dataset.resizable = !isTableRange && isHtmlResizable(el) ? "true" : "false";
    box.dataset.canMove = !isTableRange && target && target.canMove ? "true" : "false";
    box.dataset.editing = state.editing ? "true" : "false";
    box.dataset.tableSelection = state.tableSelectionMode || "cell";
    placeTableHandles(el);
    if (state.hoveredTable) placeTableAddZones(state.hoveredTable);
  }
}

export function placeToolbar(el) {
  if (!el) { dom.toolbar.hidden = true; return; }
  const r = selectionRectFor(el);
  dom.toolbar.hidden = false;
  const target = targetFor(el);
  const isEditing = !!state.editing;
  const tableMode = state.tableSelectionMode;
  const isTableRange = !!tableMode;
  dom.toolbar.dataset.mode = isEditing ? "editing" : (tableMode || "selected");
  dom.pathEl.innerHTML = breadcrumb(el)
    + (isEditing ? '<span class="editing">editing</span>' : "")
    + (tableMode ? `<span class="selection">${tableMode}</span>` : "");
  dom.editBtn.disabled = isEditing || isTableRange || !(target && target.canEditText);
  dom.editBtn.title = isEditing
    ? "Already editing — Cmd+Enter saves, Esc cancels"
    : (target && (target.kind === "svg-item" || target.kind === "svg-text")
      ? "Edit this diagram label (F2, Enter, or double-click)"
      : (dom.editBtn.disabled
          ? "Structural component selected. Select text inside it to edit."
          : "Edit text (F2, Enter, or double-click)"));
  dom.commentBtn.disabled = isEditing || isTableRange;
  dom.dragBtn.disabled = isEditing || isTableRange || !(target && target.canMove);
  dom.duplicateBtn.disabled = isEditing || isTableRange || !canDuplicateElement(el, target);
  dom.duplicateBtn.title = isEditing
    ? "Finish editing before duplicating"
    : (dom.duplicateBtn.disabled
      ? "This element can't be duplicated directly"
      : "Duplicate this element with fresh edit IDs");
  dom.tableBtn.disabled = isEditing || !gridCellFrom(el);
  dom.tableBtn.title = isEditing
    ? "Finish editing before changing table structure"
    : (dom.tableBtn.disabled
      ? "Select a table cell for row/column actions"
      : "Insert, delete, or reorder rows and columns");
  if (dom.tableBtn.disabled) dom.tableMenu.hidden = true;
  dom.dragBtn.title = isEditing
    ? "Finish editing before moving this component"
    : (target && target.moveMode === "spatial"
      ? "Drag to reposition this diagram item"
      : (dom.dragBtn.disabled
          ? "This selected item cannot be moved directly"
          : "Drag the toolbar handle or selection border to move"));
  dom.undoBtn.disabled = isEditing;
  dom.redoBtn.disabled = isEditing;
  dom.closeBtn.disabled = isEditing;
  dom.navParent.disabled = isEditing || isTableRange || !editableAncestor(el.parentElement);
  dom.navChild.disabled  = isEditing || isTableRange || !firstEditableChild(el);
  dom.navPrev.disabled   = isEditing || isTableRange || !prevEditableSibling(el);
  dom.navNext.disabled   = isEditing || isTableRange || !nextEditableSibling(el);

  const tb = dom.toolbar.getBoundingClientRect();
  let top = r.top - tb.height - 6;
  let left = r.left;
  if (tableMode || gridCellFrom(el)) {
    top = r.top + r.height + 8;
    if (top + tb.height > window.scrollY + window.innerHeight - 8) {
      top = r.top - tb.height - 18;
    }
  } else if (top < window.scrollY + 4) top = r.top + r.height + 6;
  if (top < window.scrollY + 4) top = window.scrollY + 4;
  const maxLeft = window.scrollX + window.innerWidth - tb.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  dom.toolbar.style.top = top + "px";
  dom.toolbar.style.left = left + "px";
}

// --- navigation -----------------------------------------------------------

export function ensureVisible(el) {
  const r = el.getBoundingClientRect();
  const pad = 64;
  if (r.top < pad || r.bottom > window.innerHeight - pad) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export function toggleHelp(force) {
  dom.helpOverlay.hidden = typeof force === "boolean" ? !force : !dom.helpOverlay.hidden;
}

// Re-exported by events.js; defined here because selectElement depends on a
// few targets-module helpers.
export function selectElementInternal(el, tableSelectionMode = null, options = {}) {
  // Reset any active range when selecting a brand-new element, unless the
  // caller is explicitly preserving it (e.g. during a Shift+Arrow extension
  // or a same-cell mode promotion). A plain click on another cell, even in
  // the same table, should drop the stale range so the next Shift+Space /
  // Ctrl+Space promotes the new cell rather than the old range.
  if (!options.preserveRange) state.tableRange = null;
  state.selected = el;
  state.tableSelectionMode = tableSelectionMode;
  state.hovered = null;
  dom.hoverBox.style.display = "none";
  placeBox(dom.selectBox, el);
  placeToolbar(el);
  dom.commentBox.hidden = true;
  dom.tableMenu.hidden = true;
  if (!state.svgEditing) dom.svgEditor.hidden = true;
  // "+" append zones are proximity-driven (see events.js), so don't pin them
  // to the selection here — let mousemove decide whether they belong on screen.
}

export function navigate(direction) {
  if (!state.selected) return;
  let target = null;
  if (direction === "left")  target = prevEditableSibling(state.selected);
  else if (direction === "right") target = nextEditableSibling(state.selected);
  else if (direction === "up")    target = editableAncestor(state.selected.parentElement);
  else if (direction === "down")  target = firstEditableChild(state.selected);
  if (!target) { flash("No editable element in that direction.", { kind: "warning" }); return; }
  selectElementInternal(target);
  ensureVisible(target);
}

export function navigateGrid(direction) {
  if (!state.selected) return false;
  const target = direction === "next"
    ? gridTabNeighbor(state.selected, true)
    : direction === "previous"
      ? gridTabNeighbor(state.selected, false)
      : direction.startsWith("edge-")
        ? gridEdgeNeighbor(state.selected, direction.slice(5))
        : gridNeighbor(state.selected, direction);
  if (!target) return false;
  selectElementInternal(target);
  ensureVisible(target);
  return true;
}
