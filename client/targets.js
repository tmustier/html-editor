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

// --- grid/table navigation ------------------------------------------------

export function gridCellFrom(el) {
  if (!el || isInsideSvg(el)) return null;
  const node = el.nodeType === Node.ELEMENT_NODE ? el : el.parentElement;
  const cell = node && node.closest ? node.closest("td, th") : null;
  return cell && isEditable(cell) ? cell : null;
}

function positiveSpan(value, fallback) {
  const n = Number.parseInt(value || String(fallback || 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function selectableInCell(cell) {
  if (!cell) return null;
  if (isEditable(cell)) return cell;
  return firstEditableChild(cell);
}

function gridForCell(cell) {
  const table = cell && cell.closest ? cell.closest("table") : null;
  if (!table) return null;
  const rows = Array.from(table.rows || table.querySelectorAll("tr"));
  const matrix = [];
  const cells = [];
  let position = null;

  rows.forEach((row, rowIndex) => {
    matrix[rowIndex] = matrix[rowIndex] || [];
    let colIndex = 0;
    Array.from(row.cells || row.querySelectorAll("th, td")).forEach((cellEl) => {
      while (matrix[rowIndex][colIndex]) colIndex += 1;
      const rowSpan = positiveSpan(cellEl.getAttribute("rowspan"), cellEl.rowSpan);
      const colSpan = positiveSpan(cellEl.getAttribute("colspan"), cellEl.colSpan);
      const entry = { cell: cellEl, row: rowIndex, col: colIndex, rowSpan, colSpan };
      cells.push(entry);
      if (cellEl === cell) position = entry;
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        matrix[r] = matrix[r] || [];
        for (let c = colIndex; c < colIndex + colSpan; c += 1) {
          matrix[r][c] = cellEl;
        }
      }
      colIndex += colSpan;
    });
  });

  return position ? { table, rows, matrix, cells, position } : null;
}

function differentCellAt(matrix, row, col, current) {
  const cell = matrix[row] && matrix[row][col];
  if (!cell || cell === current) return null;
  return selectableInCell(cell);
}

export function gridNeighbor(el, direction) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const { matrix, position } = grid;
  const cols = Array.from(
    { length: position.colSpan },
    (_, i) => position.col + i,
  );

  if (direction === "up") {
    for (let r = position.row - 1; r >= 0; r -= 1) {
      for (const c of cols) {
        const target = differentCellAt(matrix, r, c, cell);
        if (target) return target;
      }
    }
  }
  if (direction === "down") {
    for (let r = position.row + position.rowSpan; r < matrix.length; r += 1) {
      for (const c of cols) {
        const target = differentCellAt(matrix, r, c, cell);
        if (target) return target;
      }
    }
  }
  if (direction === "left") {
    for (let c = position.col - 1; c >= 0; c -= 1) {
      const target = differentCellAt(matrix, position.row, c, cell);
      if (target) return target;
    }
  }
  if (direction === "right") {
    const row = matrix[position.row] || [];
    for (let c = position.col + position.colSpan; c < row.length; c += 1) {
      const target = differentCellAt(matrix, position.row, c, cell);
      if (target) return target;
    }
  }
  return null;
}

export function gridTabNeighbor(el, forward = true) {
  const cell = gridCellFrom(el);
  const grid = cell && gridForCell(cell);
  if (!grid) return null;
  const ordered = grid.cells
    .map((entry) => entry.cell)
    .filter((candidate) => selectableInCell(candidate));
  const index = ordered.indexOf(cell);
  if (index < 0) return null;
  return selectableInCell(ordered[index + (forward ? 1 : -1)]);
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
    const target = targetFor(el);
    box.dataset.resizable = isHtmlResizable(el) ? "true" : "false";
    box.dataset.canMove = target && target.canMove ? "true" : "false";
    box.dataset.editing = state.editing ? "true" : "false";
  }
}

export function placeToolbar(el) {
  if (!el) { dom.toolbar.hidden = true; return; }
  const r = rectOf(el);
  dom.toolbar.hidden = false;
  const target = targetFor(el);
  const isEditing = !!state.editing;
  dom.toolbar.dataset.mode = isEditing ? "editing" : "selected";
  dom.pathEl.innerHTML = breadcrumb(el) + (isEditing ? '<span class="editing">editing</span>' : "");
  dom.editBtn.disabled = isEditing || !(target && target.canEditText);
  dom.editBtn.title = isEditing
    ? "Already editing — Cmd+Enter saves, Esc cancels"
    : (target && (target.kind === "svg-item" || target.kind === "svg-text")
      ? "Edit this diagram label (F2, Enter, or double-click)"
      : (dom.editBtn.disabled
          ? "Structural component selected. Select text inside it to edit."
          : "Edit text (F2, Enter, or double-click)"));
  dom.commentBtn.disabled = isEditing;
  dom.dragBtn.disabled = isEditing || !(target && target.canMove);
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
  dom.navParent.disabled = isEditing || !editableAncestor(el.parentElement);
  dom.navChild.disabled  = isEditing || !firstEditableChild(el);
  dom.navPrev.disabled   = isEditing || !prevEditableSibling(el);
  dom.navNext.disabled   = isEditing || !nextEditableSibling(el);

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

export function navigateGrid(direction) {
  if (!state.selected) return false;
  const target = direction === "next"
    ? gridTabNeighbor(state.selected, true)
    : direction === "previous"
      ? gridTabNeighbor(state.selected, false)
      : gridNeighbor(state.selected, direction);
  if (!target) return false;
  selectElementInternal(target);
  ensureVisible(target);
  return true;
}
