// Three drag flavours, all driven from the same beginDrag entry point:
//   1. HTML reorder       (moveMode: "reorder")
//   2. SVG spatial move   (moveMode: "spatial", group transform translate)
//   3. HTML resize        (handle on selectBox; written as inline style)
//
// Suppress synthetic clicks for 350 ms after a drag/resize ends so the next
// click doesn't double-trigger an edit.

import { api } from "./api.js";
import { dom, flash, isOverlay, rectOf } from "./dom.js";
import { interactionLock } from "./interaction.js";
import { state } from "./state.js";
import {
  currentTarget,
  editableFrom,
  isHtmlResizable,
  isInsideSvg,
  placeBox,
  selectElementInternal,
} from "./targets.js";
import { loadComments } from "./comments.js";

const RESIZE_END_CLICK_SUPPRESS_MS = 350;

// --- resize ---------------------------------------------------------------

export function beginResize(direction, e) {
  if (!state.selected || state.dragging) return;
  if (!isHtmlResizable(state.selected)) return;
  e.preventDefault();
  e.stopPropagation();
  // End any active edit gracefully before resizing.
  if (state.editing && state.selected.hasAttribute("contenteditable")) {
    state.selected.blur();
  }
  const r = state.selected.getBoundingClientRect();
  state.dragging = {
    mode: "resize",
    el: state.selected,
    direction,
    startX: e.clientX,
    startY: e.clientY,
    originalW: r.width,
    originalH: r.height,
    originalInlineWidth:  state.selected.style.width,
    originalInlineHeight: state.selected.style.height,
    originalInlineMaxWidth:  state.selected.style.maxWidth,
    originalInlineMaxHeight: state.selected.style.maxHeight,
  };
  document.documentElement.classList.add("__edit_resizing");
  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  document.addEventListener("mousemove", onResizeMove, true);
  document.addEventListener("mouseup",   onResizeEnd, true);
}

function onResizeMove(e) {
  if (!state.dragging || state.dragging.mode !== "resize") return;
  e.preventDefault();
  const d = state.dragging;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  let newW = d.originalW, newH = d.originalH;
  if (d.direction.indexOf("e") >= 0) newW = Math.max(20, d.originalW + dx);
  if (d.direction.indexOf("s") >= 0) newH = Math.max(20, d.originalH + dy);
  // Direct-manipulation override: strip stylesheet max-* caps so the element
  // really takes the dragged size. Undo restores everything.
  if (d.direction.indexOf("e") >= 0) {
    d.el.style.width = Math.round(newW) + "px";
    d.el.style.maxWidth = "none";
  }
  if (d.direction.indexOf("s") >= 0) {
    d.el.style.height = Math.round(newH) + "px";
    d.el.style.maxHeight = "none";
  }
  placeBox(dom.selectBox, d.el);
}

async function onResizeEnd(e) {
  if (!state.dragging || state.dragging.mode !== "resize") return;
  e.preventDefault();
  e.stopPropagation();
  interactionLock.lockClicksFor(RESIZE_END_CLICK_SUPPRESS_MS);
  const {
    el, direction,
    originalInlineWidth, originalInlineHeight,
    originalInlineMaxWidth, originalInlineMaxHeight,
  } = state.dragging;
  const usedW = direction.indexOf("e") >= 0;
  const usedH = direction.indexOf("s") >= 0;
  const finalW = usedW ? el.style.width  : null;
  const finalH = usedH ? el.style.height : null;
  state.dragging = null;
  document.documentElement.classList.remove("__edit_resizing");
  document.removeEventListener("mousemove", onResizeMove, true);
  document.removeEventListener("mouseup",   onResizeEnd, true);

  const noChange =
    (!usedW || finalW === originalInlineWidth) &&
    (!usedH || finalH === originalInlineHeight);
  if (noChange) {
    el.style.maxWidth  = originalInlineMaxWidth  || "";
    el.style.maxHeight = originalInlineMaxHeight || "";
    selectElementInternal(el);
    return;
  }

  const restore = () => {
    if (usedW) el.style.width  = originalInlineWidth;
    if (usedH) el.style.height = originalInlineHeight;
    el.style.maxWidth  = originalInlineMaxWidth  || "";
    el.style.maxHeight = originalInlineMaxHeight || "";
  };
  const body = {};
  if (usedW) { body.width  = finalW; body.max_width  = "none"; }
  if (usedH) { body.height = finalH; body.max_height = "none"; }
  try {
    await api.resizeElement(el.getAttribute("data-edit-id"), body);
    flash("Resized.", { kind: "success" });
  } catch (err) {
    restore();
    flash("Resize failed: " + err.message, { kind: "error" });
  }
  selectElementInternal(el);
}

// --- reorder + SVG spatial ------------------------------------------------

function isIllegalDragTarget(target) {
  return !state.selected || !target || target === state.selected
    || state.selected.contains(target) || isInsideSvg(target);
}

function parseTranslate(transform) {
  const m = String(transform || "").match(
    /translate\s*\(\s*([-+]?\d*\.?\d+)(?:[ ,]+([-+]?\d*\.?\d+))?\s*\)/);
  return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2] || "0") : 0 };
}

function withTranslate(transform, x, y) {
  const next = `translate(${x.toFixed(2)} ${y.toFixed(2)})`;
  const current = String(transform || "").trim();
  if (/translate\s*\([^)]*\)/.test(current)) {
    return current.replace(/translate\s*\([^)]*\)/, next).trim();
  }
  return (next + (current ? " " + current : "")).trim();
}

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const matrix = svg.getScreenCTM();
  return matrix ? pt.matrixTransform(matrix.inverse()) : { x: clientX, y: clientY };
}

function dragTargetFromPoint(x, y) {
  // Hide ghost so it's not the hit-test result.
  if (state.dragging && state.dragging.ghost) state.dragging.ghost.style.display = "none";
  dom.dropLine.hidden = true;
  const raw = document.elementFromPoint(x, y);
  if (state.dragging && state.dragging.ghost) state.dragging.ghost.style.display = "block";
  const target = raw && !isOverlay(raw) ? editableFrom(raw) : null;
  if (isIllegalDragTarget(target)) return null;
  const r = target.getBoundingClientRect();
  return {
    el: target,
    id: target.getAttribute("data-edit-id"),
    position: y < r.top + (r.height / 2) ? "before" : "after",
  };
}

function showDropLine(drop) {
  if (!drop || !drop.el) { dom.dropLine.hidden = true; return; }
  const r = rectOf(drop.el);
  dom.dropLine.hidden = false;
  dom.dropLine.style.left  = r.left + "px";
  dom.dropLine.style.top   = (drop.position === "before" ? r.top : r.top + r.height) + "px";
  dom.dropLine.style.width = Math.max(24, r.width) + "px";
}

function moveGhost(x, y) {
  if (!state.dragging || !state.dragging.ghost) return;
  state.dragging.ghost.style.left = (x + 12) + "px";
  state.dragging.ghost.style.top  = (y + 12) + "px";
}

export function beginDrag(e) {
  if (!state.selected || state.editing || state.dragging) return;
  const target = currentTarget();
  if (!target || !target.canMove) {
    flash("This selected item cannot be moved directly.", { kind: "warning" });
    return;
  }
  if (target.moveMode === "spatial") return beginSvgDrag(e);
  return beginReorderDrag(e);
}

function labelForGhost(el) {
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === "string"
    ? el.className.split(/\s+/).filter((c) => c && !c.startsWith("__edit_"))[0]
    : "";
  let label = tag;
  if (el.id) label += "#" + el.id;
  else if (cls) label += "." + cls;
  return label;
}

function beginReorderDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  const ghost = document.createElement("div");
  ghost.className = "__edit_ghost";
  const text = ((state.selected.innerText || state.selected.textContent || "")
    .trim().replace(/\s+/g, " ").slice(0, 90));
  ghost.textContent = labelForGhost(state.selected) + (text ? " — " + text : "");
  document.body.appendChild(ghost);
  state.dragging = {
    mode: "reorder",
    el: state.selected,
    id: state.selected.getAttribute("data-edit-id"),
    ghost,
    drop: null,
  };
  document.documentElement.classList.add("__edit_dragging");
  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  moveGhost(e.clientX, e.clientY);
  document.addEventListener("mousemove", onDragMove, true);
  document.addEventListener("mouseup",   onDragEnd, true);
  updateDrag(e);
}

function beginSvgDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  const el = state.selected;
  const svg = el.ownerSVGElement;
  const start = svgPoint(svg, e.clientX, e.clientY);
  const originalTransform = el.getAttribute("transform") || "";
  state.dragging = {
    mode: "svg",
    el,
    id: el.getAttribute("data-edit-id"),
    svg,
    start,
    base: parseTranslate(originalTransform),
    originalTransform,
    current: parseTranslate(originalTransform),
  };
  document.documentElement.classList.add("__edit_dragging");
  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  document.addEventListener("mousemove", onSvgDragMove, true);
  document.addEventListener("mouseup",   onSvgDragEnd, true);
  updateSvgDrag(e);
}

function updateDrag(e) {
  if (!state.dragging || state.dragging.mode !== "reorder") return;
  e.preventDefault();
  moveGhost(e.clientX, e.clientY);
  state.dragging.drop = dragTargetFromPoint(e.clientX, e.clientY);
  showDropLine(state.dragging.drop);
}

function updateSvgDrag(e) {
  if (!state.dragging || state.dragging.mode !== "svg") return;
  e.preventDefault();
  const d = state.dragging;
  const p = svgPoint(d.svg, e.clientX, e.clientY);
  const tx = d.base.x + (p.x - d.start.x);
  const ty = d.base.y + (p.y - d.start.y);
  d.current = { x: tx, y: ty };
  d.el.setAttribute("transform", withTranslate(d.originalTransform, tx, ty));
  placeBox(dom.selectBox, d.el);
}

function onDragMove(e)    { updateDrag(e); }
function onSvgDragMove(e) { updateSvgDrag(e); }

function cleanupDragListeners() {
  document.removeEventListener("mousemove", onDragMove,    true);
  document.removeEventListener("mouseup",   onDragEnd,     true);
  document.removeEventListener("mousemove", onSvgDragMove, true);
  document.removeEventListener("mouseup",   onSvgDragEnd,  true);
}

export function cancelDrag() {
  if (!state.dragging) return;
  const original = state.dragging.el;
  if (state.dragging.mode === "svg") {
    original.setAttribute("transform", state.dragging.originalTransform || "");
  }
  if (state.dragging.ghost) state.dragging.ghost.remove();
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging");
  dom.dropLine.hidden = true;
  cleanupDragListeners();
  if (original && document.contains(original)) selectElementInternal(original);
}

async function onSvgDragEnd(e) {
  if (!state.dragging || state.dragging.mode !== "svg") return;
  e.preventDefault();
  e.stopPropagation();
  const { el, id, current, originalTransform } = state.dragging;
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging");
  cleanupDragListeners();

  try {
    await api.moveSvg(id, current.x, current.y);
    flash("Repositioned.", { kind: "success" });
  } catch (err) {
    el.setAttribute("transform", originalTransform || "");
    flash("Move failed: " + err.message, { kind: "error" });
  }
  selectElementInternal(el);
}

async function onDragEnd(e) {
  if (!state.dragging || state.dragging.mode !== "reorder") return;
  e.preventDefault();
  e.stopPropagation();
  const { el, id, drop, ghost } = state.dragging;
  if (ghost) ghost.remove();
  state.dragging = null;
  document.documentElement.classList.remove("__edit_dragging");
  dom.dropLine.hidden = true;
  cleanupDragListeners();

  if (!drop || !drop.el) {
    flash("Move cancelled: drop on another component.", { kind: "warning" });
    if (el && document.contains(el)) selectElementInternal(el);
    return;
  }

  try {
    await api.moveElement(id, drop.id, drop.position);
    if (drop.position === "before") drop.el.parentNode.insertBefore(el, drop.el);
    else drop.el.parentNode.insertBefore(el, drop.el.nextSibling);
    selectElementInternal(el);
    loadComments();
    flash("Moved.", { kind: "success" });
  } catch (err) {
    flash("Move failed: " + err.message, { kind: "error" });
    if (el && document.contains(el)) selectElementInternal(el);
  }
}
