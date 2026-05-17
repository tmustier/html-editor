// Comment box (per-element textarea), sidebar list, and dot markers on
// commented elements. All three render from the same source: GET /comments.

import { api } from "./api.js";
import { dom, flash, icon, rectOf } from "./dom.js";
import { state } from "./state.js";
import { selectElementInternal } from "./targets.js";

// --- comment box ---------------------------------------------------------

export function startComment() {
  if (!state.selected) return;
  dom.svgEditor.hidden = true;
  dom.commentBox.hidden = false;
  const r = rectOf(state.selected);
  dom.commentBox.style.top  = (r.top + r.height + 6) + "px";
  let left = r.left;
  const maxLeft = window.scrollX + window.innerWidth - 340;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  dom.commentBox.style.left = left + "px";
  dom.commentTA.value = "";
  dom.commentTA.focus();
}

export async function sendComment() {
  if (!state.selected) return;
  const text = dom.commentTA.value.trim();
  if (!text) { flash("Type a comment first.", { kind: "warning" }); return; }
  const id = state.selected.getAttribute("data-edit-id");
  const raw = (state.selected.innerText && state.selected.innerText.trim())
    || (state.selected.textContent || "");
  const excerpt = raw.trim().slice(0, 160).replace(/\s+/g, " ");
  const tag = state.selected.tagName.toLowerCase();
  try {
    await api.comment(id, text, excerpt, tag);
    flash("Sent to agent.", { kind: "success" });
    dom.commentTA.value = "";
    dom.commentBox.hidden = true;
    loadComments();
  } catch (err) {
    flash("Comment failed: " + err.message, { kind: "error" });
  }
}

// --- sidebar list + dot markers -------------------------------------------

let dots = [];
function clearDots() {
  dots.forEach((d) => d.remove());
  dots = [];
}

function renderDots(items) {
  clearDots();
  const groups = {};
  items.forEach((c) => { (groups[c.id] = groups[c.id] || []).push(c); });
  Object.keys(groups).forEach((id) => {
    const el = document.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = rectOf(el);
    const dot = document.createElement("div");
    dot.className = "__edit_dot";
    dot.dataset.editId = id;
    dot.textContent = groups[id].length;
    dot.style.top  = (r.top - 7) + "px";
    dot.style.left = (r.left + r.width - 7) + "px";
    dot.title = groups[id].map((c) => c.comment).join("\n---\n");
    dot.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectElementInternal(el);
    });
    document.body.appendChild(dot);
    dots.push(dot);
  });
}

export async function loadComments() {
  let items;
  try {
    items = await api.listComments();
  } catch (_) {
    return; // sidebar just stays as-is; not worth a toast.
  }
  dom.countEl.textContent = items.length;
  dom.clist.innerHTML = "";
  if (!items.length) {
    dom.emptyEl.style.display = "";
    if (dom.hintEl) dom.hintEl.hidden = true;
  } else {
    dom.emptyEl.style.display = "none";
    if (dom.hintEl) dom.hintEl.hidden = false;
    items.slice().reverse().forEach((c) => {
      const d = document.createElement("div");
      d.className = "c";
      d.innerHTML =
        '<div class="cm"></div>' +
        '<div class="ex">on: <i></i></div>' +
        '<div class="ts"></div>';
      d.querySelector(".cm").textContent = c.comment;
      d.querySelector(".ex i").textContent = c.excerpt || "(no excerpt)";
      d.querySelector(".ts").textContent = c.timestamp + "  ·  " + c.id;
      d.addEventListener("click", () => {
        const el = document.querySelector(`[data-edit-id="${CSS.escape(c.id)}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => selectElementInternal(el), 350);
        } else {
          flash("That element no longer exists in the DOM.", { kind: "warning" });
        }
      });
      dom.clist.appendChild(d);
    });
  }
  renderDots(items);
}

// --- sidebar buttons (wired during init) ----------------------------------

export function initSidebarButtons() {
  dom.sidebar.querySelector('[data-act="refresh"]').addEventListener("click", loadComments);

  dom.toggleBtn.addEventListener("click", () => {
    dom.sidebar.classList.toggle("collapsed");
    const collapsed = dom.sidebar.classList.contains("collapsed");
    dom.toggleBtn.innerHTML = icon(collapsed ? "expand" : "collapse");
    dom.toggleBtn.setAttribute("aria-label", collapsed ? "Expand comments" : "Collapse comments");
    dom.toggleBtn.title = collapsed ? "Expand comments" : "Collapse comments";
  });

  dom.sidebar.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    try {
      const items = await api.listComments();
      if (!items.length) { flash("No comments to copy.", { kind: "warning" }); return; }
      const lines = items.map((c) =>
        `- [${c.id} <${c.tag || "?"}>] ${c.comment}  (on: "${c.excerpt || ""}")`);
      const text = `check comments (${items.length}):\n` + lines.join("\n");
      try {
        await navigator.clipboard.writeText(text);
        flash("Copied.", { kind: "success" });
      } catch (_) {
        flash("Copy failed; read the comments JSON instead.", { kind: "error" });
      }
    } catch (_) {
      flash("Couldn't load comments.", { kind: "error" });
    }
  });
}
