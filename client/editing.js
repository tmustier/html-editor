// Inline editing for both HTML text and SVG labels.
//
// HTML: makes the selected element contenteditable, captures original
// content for rollback, sends new text/html on commit (Cmd+Enter or blur).
//
// SVG: builds an invisible <input> on top of the <text>, mirrors typing back
// into the SVG text node live (so the diagram updates), positions a custom
// caret using SVG glyph metrics, and posts the new label on commit. The
// server preserves <tspan> formatting on single-segment edits; on success we
// reload to pick up the file's authoritative formatting.

import { api } from "./api.js";
import { dom, flash } from "./dom.js";
import { reloadAfterMutation } from "./interaction.js";
import { state } from "./state.js";
import {
  currentTarget,
  firstEditableChild,
  hasChildElements,
  isSvgGroup,
  isSvgText,
  placeBox,
  placeToolbar,
  selectElementInternal,
  svgTextFromHit,
} from "./targets.js";

// --- public entry ---------------------------------------------------------

export function startEdit(preferredSource, clickX, clickY) {
  if (!state.selected || state.editing) return;
  const target = currentTarget();
  if (target && (target.kind === "svg-item" || target.kind === "svg-text") && target.canEditText) {
    return startSvgLabelEdit(preferredSource, clickX, clickY);
  }
  const el = state.selected;
  if (!(target && target.canEditText)) {
    const child = firstEditableChild(el);
    flash(child
      ? "Structural component selected. Use Option+Down or click text inside it to edit."
      : "Structural component selected. Drag to move it; select text inside it to edit.",
      { kind: "info" });
    placeToolbar(el);
    return;
  }
  startHtmlTextEdit(el, clickX, clickY);
}

// --- HTML inline edit -----------------------------------------------------

function startHtmlTextEdit(el, clickX, clickY) {
  const id = el.getAttribute("data-edit-id");
  const originalText = el.innerText;
  const originalHTML = el.innerHTML;
  const hadChildren = hasChildElements(el);

  state.editing = true;
  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  dom.commentBox.hidden = true;
  dom.svgEditor.hidden = true;

  el.setAttribute("contenteditable", "true");
  el.classList.add("__edit_editing");
  el.focus();
  placeCaretFromClickOrEnd(el, clickX, clickY);

  let finished = false;
  const finish = async (commit) => {
    // Removing contenteditable can itself fire blur. Unhook listeners and guard
    // re-entry first so Escape/Cmd+Enter cannot recursively commit and create a
    // duplicate history snapshot.
    if (finished) return;
    finished = true;
    el.removeEventListener("blur", onBlur, true);
    el.removeEventListener("keydown", onKey, true);
    el.removeAttribute("contenteditable");
    el.classList.remove("__edit_editing");
    state.editing = false;
    if (!commit) {
      if (hadChildren) el.innerHTML = originalHTML;
      else el.innerText = originalText;
    } else {
      const text = el.innerText;
      const html = hadChildren ? el.innerHTML : undefined;
      try {
        await api.saveText(id, text, html);
        flash("Saved.", { kind: "success" });
        el.classList.add("__edit_pulse");
        setTimeout(() => el.classList.remove("__edit_pulse"), 700);
      } catch (err) {
        flash("Save failed: " + err.message, { kind: "error" });
      }
    }
    placeBox(dom.selectBox, el);
    placeToolbar(el);
  };

  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    }
  };
  el.addEventListener("blur",    onBlur, true);
  el.addEventListener("keydown", onKey,  true);
}

// Caret placement: prefer caretRangeFromPoint (Chrome) then
// caretPositionFromPoint (Firefox/spec). Reject ranges that landed outside
// the editable. Fall back to end-of-content.
function placeCaretFromClickOrEnd(el, clickX, clickY) {
  const sel = window.getSelection();
  let range = null;
  if (typeof clickX === "number" && typeof clickY === "number") {
    if (typeof document.caretRangeFromPoint === "function") {
      range = document.caretRangeFromPoint(clickX, clickY);
    } else if (typeof document.caretPositionFromPoint === "function") {
      const pos = document.caretPositionFromPoint(clickX, clickY);
      if (pos && pos.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (range && !el.contains(range.startContainer)) range = null;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// --- SVG label edit -------------------------------------------------------

function svgPointFromClient(svgEl, clientX, clientY) {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svgEl.getScreenCTM();
  return ctm ? pt.matrixTransform(ctm.inverse()) : pt;
}

function charIndexAtClient(node, clientX, clientY) {
  const svg = node.ownerSVGElement;
  if (!svg) return null;
  let idx = -1;
  try {
    const pt = svgPointFromClient(svg, clientX, clientY);
    idx = node.getCharNumAtPosition(pt);
  } catch (_) { idx = -1; }
  if (idx >= 0) {
    // getCharNumAtPosition returns the char *under* the point. Snap to the
    // nearer side of that glyph for a sensible insertion point.
    try {
      const e = node.getExtentOfChar(idx);
      const ctm = svg.getScreenCTM();
      if (ctm && e) {
        const left = e.x * ctm.a + ctm.e;
        const right = (e.x + e.width) * ctm.a + ctm.e;
        if (clientX > (left + right) / 2) return idx + 1;
        return idx;
      }
    } catch (_) {}
    return idx;
  }
  const r = node.getBoundingClientRect();
  if (clientX <= r.left) return 0;
  return (node.textContent || "").length;
}

function measureSvgPrefixPx(node, prefixLen) {
  if (prefixLen <= 0) return 0;
  const full = node.textContent || "";
  if (!full) return 0;
  const clamped = Math.min(prefixLen, full.length);
  let fullUserLen = 0;
  try { fullUserLen = node.getComputedTextLength(); } catch (_) { fullUserLen = 0; }
  const rWidth = node.getBoundingClientRect().width;
  if (!fullUserLen || !rWidth) return rWidth * (clamped / full.length);
  let prefixUserLen = 0;
  try { prefixUserLen = node.getSubStringLength(0, clamped); }
  catch (_) { prefixUserLen = fullUserLen * (clamped / full.length); }
  return (prefixUserLen / fullUserLen) * rWidth;
}

function positionSvgCaret(s) {
  if (!s || !s.caret) return;
  const input = s.inputs[0];
  const node  = s.inputNodes[0];
  const r = node.getBoundingClientRect();
  const selStart = input.selectionStart == null ? input.value.length : input.selectionStart;
  const prefixWidth = measureSvgPrefixPx(node, selStart);
  const x = r.left + prefixWidth;
  s.caret.style.left = (window.scrollX + x) + "px";
  s.caret.style.top  = (window.scrollY + r.top) + "px";
  s.caret.style.height = Math.max(12, r.height) + "px";
}

export function positionSvgLabelInputs(s) {
  if (!s) return;
  s.inputs.forEach((input, i) => {
    const node = s.inputNodes[i];
    const r = node.getBoundingClientRect();
    input.style.top    = (window.scrollY + r.top) + "px";
    input.style.left   = (window.scrollX + r.left) + "px";
    input.style.width  = Math.max(18, r.width)  + "px";
    input.style.height = Math.max(16, r.height) + "px";
  });
  positionSvgCaret(s);
}

function svgTextNodes(el) {
  if (isSvgGroup(el)) return Array.from(el.querySelectorAll("text"));
  if (isSvgText(el))  return [el];
  return [];
}

function startSvgLabelEdit(preferredSource, clickX, clickY) {
  if (!state.selected || state.svgEditing) return;
  const target = currentTarget();
  if (!(target && (target.kind === "svg-item" || target.kind === "svg-text") && target.canEditText)) {
    flash("Select a labelled diagram item or text to edit.", { kind: "warning" });
    return;
  }
  const el = state.selected;
  const textNodes = target.kind === "svg-text" ? [el] : svgTextNodes(el);
  const originals = textNodes.map((node) => node.textContent || "");
  const preferredText = svgTextFromHit(preferredSource);
  let editIndex = textNodes.indexOf(preferredText);
  if (editIndex < 0) editIndex = 0;
  const editNode = textNodes[editIndex];

  dom.svgFields.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "__edit_svg_input";
  input.value = editNode.textContent || "";
  input.dataset.index = String(editIndex);
  input.setAttribute("aria-label", "Edit diagram label");
  input.autocomplete = "off";
  input.spellcheck = false;
  const caret = document.createElement("span");
  caret.className = "__edit_svg_caret";
  dom.svgFields.appendChild(input);
  dom.svgFields.appendChild(caret);

  // Capture inline-markup snapshot BEFORE the live preview strips it via
  // textContent=. Determines whether we reload after save.
  const hadInlineMarkup = textNodes.some(
    (node) => node.querySelector && node.querySelector("tspan"));

  state.editing = true;
  state.svgEditing = {
    el,
    id: target.id,
    textNodes,
    originals,
    editIndex,
    inputNodes: [editNode],
    inputs: [input],
    caret,
    hadInlineMarkup,
  };

  input.addEventListener("input", () => {
    editNode.textContent = input.value;
    placeBox(dom.selectBox, el);
    positionSvgLabelInputs(state.svgEditing);
  });
  input.addEventListener("mousedown", (e) => {
    // Hijack the input's native click-to-caret: its font metrics don't match
    // the SVG glyph layout, so we hit-test the SVG instead.
    const idx = charIndexAtClient(editNode, e.clientX, e.clientY);
    if (idx == null) return;
    e.preventDefault();
    requestAnimationFrame(() => {
      if (!state.svgEditing) return;
      input.focus();
      input.setSelectionRange(idx, idx);
      positionSvgCaret(state.svgEditing);
    });
  });
  ["keyup", "select"].forEach((eventName) =>
    input.addEventListener(eventName, () => positionSvgCaret(state.svgEditing)));

  dom.toolbar.hidden = true;
  dom.hoverBox.style.display = "none";
  dom.commentBox.hidden = true;
  dom.svgEditor.hidden = false;
  positionSvgLabelInputs(state.svgEditing);
  input.focus();

  let caretIdx = input.value.length;
  if (typeof clickX === "number" && typeof clickY === "number") {
    const idx = charIndexAtClient(editNode, clickX, clickY);
    if (idx != null && idx >= 0 && idx <= input.value.length) caretIdx = idx;
  }
  input.setSelectionRange(caretIdx, caretIdx);
  positionSvgCaret(state.svgEditing);
}

export async function finishSvgLabelEdit(commit) {
  if (!state.svgEditing) return;
  const s = state.svgEditing;
  const lines = s.originals.slice();
  lines[s.editIndex] = s.inputs[0] ? s.inputs[0].value : lines[s.editIndex];
  const restore = () => s.textNodes.forEach((node, i) => {
    node.textContent = s.originals[i] || "";
  });
  state.svgEditing = null;
  state.editing = false;
  dom.svgEditor.hidden = true;
  dom.svgFields.innerHTML = "";

  if (!commit) {
    restore();
    selectElementInternal(s.el);
    return;
  }

  s.textNodes.forEach((node, i) => { node.textContent = lines[i] || ""; });
  placeBox(dom.selectBox, s.el);
  try {
    const j = await api.saveSvgLabels(s.id, lines);
    if (j.formatting_lost) {
      flash("Saved — but inline formatting was lost (edit crossed a styled span).", { kind: "warning" });
    } else {
      flash("Saved diagram label.", { kind: "success" });
    }
    s.el.classList.add("__edit_pulse");
    setTimeout(() => s.el.classList.remove("__edit_pulse"), 700);
    // Live preview during typing collapses tspans. If the file still holds
    // tspan styling, reload so the rendered SVG matches the file. Skip when
    // no inline markup was at risk (pure-text <text>) to keep editing snappy.
    if (s.hadInlineMarkup) {
      reloadAfterMutation({ delay: j.formatting_lost ? 1600 : 220 });
    } else {
      selectElementInternal(s.el);
    }
  } catch (err) {
    restore();
    flash("Save failed: " + err.message, { kind: "error" });
    selectElementInternal(s.el);
  }
}
