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

// --- predicates -----------------------------------------------------------

export const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
export const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
export const isSvgGroup = (el) => tagName(el) === "g" && isInsideSvg(el);
export const isSvgText  = (el) => tagName(el) === "text" && isInsideSvg(el);
export const hasChildElements = (el) => !!(el && el.querySelector && el.querySelector("*"));

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
  return Array.from(el.querySelectorAll("[data-edit-id]")).find(isEditable) || null;
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

export function placeBox(box, el) {
  if (!el) { box.style.display = "none"; return; }
  const r = rectOf(el);
  box.style.display = "block";
  box.style.top = r.top + "px";
  box.style.left = r.left + "px";
  box.style.width = r.width + "px";
  box.style.height = r.height + "px";
  if (box === dom.selectBox) {
    box.dataset.resizable = isHtmlResizable(el) ? "true" : "false";
  }
}

export function placeToolbar(el) {
  if (!el) { dom.toolbar.hidden = true; return; }
  const r = rectOf(el);
  dom.toolbar.hidden = false;
  const target = targetFor(el);
  dom.pathEl.innerHTML = breadcrumb(el);
  dom.editBtn.disabled = !(target && target.canEditText);
  dom.editBtn.title = target && (target.kind === "svg-item" || target.kind === "svg-text")
    ? "Edit this diagram label (Enter or double-click)"
    : (dom.editBtn.disabled
        ? "Structural component selected. Select text inside it to edit."
        : "Edit text (Enter or double-click)");
  dom.dragBtn.disabled = !(target && target.canMove);
  dom.dragBtn.title = target && target.moveMode === "spatial"
    ? "Drag to reposition this diagram item"
    : (dom.dragBtn.disabled
        ? "This selected item cannot be moved directly"
        : "Drag to move this component before/after another");
  dom.navParent.disabled = !editableAncestor(el.parentElement);
  dom.navChild.disabled  = !firstEditableChild(el);
  dom.navPrev.disabled   = !prevEditableSibling(el);
  dom.navNext.disabled   = !nextEditableSibling(el);

  const tb = dom.toolbar.getBoundingClientRect();
  let top = r.top - tb.height - 6;
  let left = r.left;
  if (top < window.scrollY + 4) top = r.top + r.height + 6;
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
export function selectElementInternal(el) {
  state.selected = el;
  state.hovered = null;
  dom.hoverBox.style.display = "none";
  placeBox(dom.selectBox, el);
  placeToolbar(el);
  dom.commentBox.hidden = true;
  if (!state.svgEditing) dom.svgEditor.hidden = true;
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
