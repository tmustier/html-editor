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
  gridPasteTargets,
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
  dom.tableMenu.hidden = true;
  dom.svgEditor.hidden = true;
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
  dom.tableMenu.hidden = false;
  placeTableMenu();
}

async function performTableOperation(action) {
  const cell = gridCellFrom(state.selected);
  if (!cell) {
    flash("Select a table cell first.", { kind: "warning" });
    return;
  }
  try {
    const result = await api.tableOperation(cell.getAttribute("data-edit-id"), action);
    if (result.selection_id) {
      sessionStorage.setItem("__edit_restore_selection", result.selection_id);
    }
    const label = action.replace(/-/g, " ");
    flash(`Table ${label} done.`, { kind: "success" });
    reloadAfterMutation({ delay: 220 });
  } catch (err) {
    flash("Table change failed: " + err.message, { kind: "error", timeout: 3600 });
  }
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

function isNativeClipboardTarget(el) {
  return !!(el && (
    el.tagName === "TEXTAREA"
    || el.tagName === "INPUT"
    || (el.getAttribute && el.getAttribute("contenteditable") === "true")
  ));
}

function selectedPlainText() {
  const el = state.selected;
  if (!el) return "";
  return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
}

function stripEditIds(root) {
  if (root.removeAttribute) root.removeAttribute("data-edit-id");
  if (root.querySelectorAll) {
    root.querySelectorAll("[data-edit-id]").forEach((el) =>
      el.removeAttribute("data-edit-id"));
  }
  return root;
}

function sanitizedHtmlFragment(html) {
  if (!html || !html.trim()) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  stripEditIds(template.content);
  template.content.querySelectorAll("script, style, link, meta").forEach((el) => el.remove());
  return template.innerHTML.trim();
}

function selectedHtml() {
  const el = state.selected;
  if (!el) return "";
  const clone = stripEditIds(el.cloneNode(true));
  return (clone.innerHTML || selectedPlainText()).trim();
}

const STATUS_CLASSES = ["shipped", "partial", "next", "deferred"];
const STATUS_CLASS_BY_TEXT = new Map([
  ["SHIPPED", "shipped"],
  ["V1 SHIPPED", "shipped"],
  ["PARTIAL", "partial"],
  ["NEXT", "next"],
  ["DEFERRED", "deferred"],
]);

function updateStatusBadgeClass(el, text) {
  if (!(el && el.classList && el.classList.contains("status-badge"))) return;
  const mapped = STATUS_CLASS_BY_TEXT.get(String(text || "").trim().toUpperCase());
  if (!mapped) return;
  STATUS_CLASSES.forEach((cls) => el.classList.remove(cls));
  el.classList.add(mapped);
}

function singleInlineWrapper(el) {
  if (!el) return null;
  const elements = Array.from(el.children || []);
  if (elements.length !== 1) return null;
  const wrapper = elements[0];
  const hasOtherText = Array.from(el.childNodes).some((node) =>
    node !== wrapper && node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (hasOtherText) return null;
  const display = (window.getComputedStyle(wrapper).display || "").toLowerCase();
  if (!["inline", "inline-block", "inline-flex"].includes(display)) return null;
  return wrapper;
}

function htmlForPlainPastePreservingTarget(el, text) {
  const wrapper = singleInlineWrapper(el);
  if (!wrapper) return null;
  const clone = stripEditIds(el.cloneNode(true));
  const cloneWrapper = clone.children && clone.children[0];
  if (!cloneWrapper) return null;
  cloneWrapper.textContent = text;
  updateStatusBadgeClass(cloneWrapper, text);
  return clone.innerHTML;
}

function parseClipboardTableText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!raw.includes("\t") && !raw.includes("\n")) return null;

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "\t" && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  if (raw.endsWith("\n") && rows.length && rows.at(-1).length === 1
      && rows.at(-1)[0] === "") {
    rows.pop();
  }
  const cellCount = rows.reduce((sum, r) => sum + r.length, 0);
  return cellCount > 1 ? rows : null;
}

function parseClipboardTableHtml(html) {
  if (!html || !html.trim()) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const table = template.content.querySelector("table");
  if (!table) return null;
  const rows = Array.from(table.rows || table.querySelectorAll("tr"))
    .map((row) => Array.from(row.cells || row.querySelectorAll("th, td"))
      .map((cell) => (cell.innerText || cell.textContent || "").replace(/\u00a0/g, " ")))
    .filter((row) => row.length);
  const cellCount = rows.reduce((sum, row) => sum + row.length, 0);
  return cellCount > 1 ? rows : null;
}

function applyPlainTextToElement(el, text) {
  const nextHtml = htmlForPlainPastePreservingTarget(el, text);
  if (nextHtml) el.innerHTML = nextHtml;
  else el.innerText = text;
  return {
    id: el.getAttribute("data-edit-id"),
    text: el.innerText || String(text || ""),
    html: nextHtml || undefined,
  };
}

async function writeClipboardPayload(text, html) {
  if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html || text], { type: "text/html" }),
    })]);
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

async function copySelectionToClipboard() {
  await writeClipboardPayload(selectedPlainText(), selectedHtml());
  flash("Copied.", { kind: "success", timeout: 900 });
}

async function pasteIntoSelection({ text = "", html = "" } = {}) {
  const target = state.selected && targetFor(state.selected);
  if (!(target && target.kind === "html-text" && target.canEditText)) {
    flash("Select an editable text box or table cell to paste.", { kind: "warning" });
    return;
  }
  const el = target.el;
  const tableValues = parseClipboardTableText(text) || parseClipboardTableHtml(html);
  if (tableValues && gridCellFrom(el)) {
    const pasteTargets = gridPasteTargets(el, tableValues);
    if (!pasteTargets.length) {
      flash("No table cells available to paste into.", { kind: "warning" });
      return;
    }
    const updates = pasteTargets.map(({ el: cellEl, text: cellText }) =>
      applyPlainTextToElement(cellEl, cellText));
    placeBox(dom.selectBox, el);
    placeToolbar(el);
    try {
      await api.saveTextMany(updates);
      const requested = tableValues.reduce((sum, row) => sum + row.length, 0);
      const clipped = updates.length < requested ? " (clipped to table)." : ".";
      flash(`Pasted ${updates.length} table cell${updates.length === 1 ? "" : "s"}${clipped}`,
        { kind: "success" });
    } catch (err) {
      flash("Table paste failed: " + err.message, { kind: "error" });
      reloadAfterMutation({ delay: 800 });
    }
    return;
  }

  const cleanHtml = sanitizedHtmlFragment(html);
  const nextHtml = cleanHtml || htmlForPlainPastePreservingTarget(el, text);
  if (nextHtml) el.innerHTML = nextHtml;
  else el.innerText = text;
  placeBox(dom.selectBox, el);
  placeToolbar(el);
  try {
    await api.saveText(target.id, el.innerText || text, nextHtml || undefined);
    flash("Pasted.", { kind: "success" });
  } catch (err) {
    flash("Paste failed: " + err.message, { kind: "error" });
    reloadAfterMutation({ delay: 800 });
  }
}

async function readClipboardPayload() {
  if (navigator.clipboard && navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const html = item.types.includes("text/html")
        ? await (await item.getType("text/html")).text()
        : "";
      const text = item.types.includes("text/plain")
        ? await (await item.getType("text/plain")).text()
        : "";
      if (html || text) return { html, text };
    }
  }
  if (navigator.clipboard && navigator.clipboard.readText) {
    return { text: await navigator.clipboard.readText(), html: "" };
  }
  throw new Error("Clipboard paste is not available here.");
}

async function pasteFromClipboard() {
  try {
    await pasteIntoSelection(await readClipboardPayload());
  } catch (err) {
    flash(err.message || "Clipboard paste is not available here.", { kind: "warning" });
  }
}

export function initEvents() {
  // --- clipboard ----------------------------------------------------------
  document.addEventListener("copy", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", selectedPlainText());
    e.clipboardData.setData("text/html", selectedHtml());
    flash("Copied.", { kind: "success", timeout: 900 });
  }, true);

  document.addEventListener("paste", (e) => {
    if (!state.selected || state.editing || isNativeClipboardTarget(e.target)) return;
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (typeof text !== "string" && typeof html !== "string") return;
    e.preventDefault();
    void pasteIntoSelection({ text: text || "", html: html || "" });
  }, true);

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
      if (!dom.tableMenu.hidden)  { e.preventDefault(); dom.tableMenu.hidden = true; return; }
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

    const isClipboardKey = (e.metaKey || e.ctrlKey) && !e.altKey
      && (key === "c" || key === "v");
    if (isClipboardKey && state.selected && !inEditableField && !state.editing) {
      e.preventDefault();
      e.stopPropagation();
      void (key === "c" ? copySelectionToClipboard() : pasteFromClipboard());
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

    const gridArrow = !e.altKey && !e.ctrlKey && !e.shiftKey
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      && gridCellFrom(state.selected)
      && !isOverlay(t);
    if (gridArrow) {
      e.preventDefault();
      const direction = e.key.replace("Arrow", "").toLowerCase();
      navigateGrid(e.metaKey ? `edge-${direction}` : direction);
      return;
    }

    const unmodified = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (e.key === "F2" || (unmodified && (e.key === "Enter" || key === "e"))) {
      e.preventDefault(); startEdit(); return;
    }
    if (unmodified && key === "c") {
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
