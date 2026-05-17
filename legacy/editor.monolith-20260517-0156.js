/* Collaborative HTML editor overlay.
   Server endpoints:
     POST /save-text   { id, text }
     POST /comment     { id, comment, excerpt }
     GET  /comments    -> [ { id, comment, excerpt, timestamp } ]
   Every editable element in the served HTML carries a data-edit-id.
*/
(function () {
  if (window.__edit_loaded) return;
  window.__edit_loaded = true;

  const ENDPOINT_SAVE = "/save-text";
  const ENDPOINT_SAVE_SVG = "/save-svg-labels";
  const ENDPOINT_MOVE = "/move-element";
  const ENDPOINT_MOVE_SVG = "/move-svg";
  const ENDPOINT_UNDO = "/undo";
  const ENDPOINT_REDO = "/redo";
  const ENDPOINT_COMMENT = "/comment";
  const ENDPOINT_LIST = "/comments";

  // Inline Iconoir icons (https://iconoir.com) so the overlay remains
  // dependency-free and works on local/offline HTML files.
  const ICONS = {
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0 0-3L17.5 5.5a2.1 2.1 0 0 0-3 0L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>',
    comment: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H10l-5 5v-4.5A2.5 2.5 0 0 1 4 13V5.5Z"/><path d="M8 8h8M8 11h5"/></svg>',
    drag: '<svg viewBox="0 0 24 24"><path d="M12 3v18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 7l-5 5 5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6v1"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M8 8h10v12H8z"/><path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 4v6h-6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    help: '<svg viewBox="0 0 24 24"><path d="M9.2 9a3 3 0 1 1 4.95 2.3c-1 .78-2.15 1.3-2.15 2.7"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  };
  const icon = (name) => '<span class="i i-' + name + '" aria-hidden="true">' + ICONS[name] + '</span>';

  // --- build UI ------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "__edit_root";
  root.innerHTML = `
    <div id="__edit_hover"></div>
    <div id="__edit_select"></div>
    <div id="__edit_drop" hidden></div>
    <div id="__edit_toolbar" hidden>
      <span class="path" data-role="path"></span>
      <span class="sep"></span>
      <button data-act="edit" aria-label="Edit text" title="Edit text (Enter or double-click)">${icon("edit")}</button>
      <button data-act="comment" aria-label="Comment" title="Comment (C)">${icon("comment")}</button>
      <button data-act="drag" class="drag-handle" aria-label="Drag component" title="Drag to move this component before/after another">${icon("drag")}</button>
      <span class="sep"></span>
      <button data-act="nav-prev" aria-label="Previous sibling" title="Previous sibling (Option+Left)">${icon("left")}</button>
      <button data-act="nav-parent" aria-label="Parent" title="Parent (Option+Up)">${icon("up")}</button>
      <button data-act="nav-child" aria-label="First editable child" title="First editable child (Option+Down)">${icon("down")}</button>
      <button data-act="nav-next" aria-label="Next sibling" title="Next sibling (Option+Right)">${icon("right")}</button>
      <span class="sep"></span>
      <button data-act="undo" aria-label="Undo" title="Undo last edit/move (Command+Z)">${icon("undo")}</button>
      <button data-act="redo" aria-label="Redo" title="Redo last undone edit/move (Command+Y or Command+Shift+Z)">${icon("redo")}</button>
      <button data-act="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon("help")}</button>
      <button data-act="close" aria-label="Deselect" title="Deselect (Esc)">${icon("close")}</button>
    </div>
    <div id="__edit_commentbox" hidden>
      <textarea placeholder="Comment for the agent...  (Cmd+Enter to send, Esc to cancel)"></textarea>
      <div class="row">
        <button data-act="cancel">Cancel</button>
        <button data-act="send">Send</button>
      </div>
    </div>
    <div id="__edit_svgeditor" hidden></div>
    <div id="__edit_help" hidden>
      <div class="card">
        <h3>Editor shortcuts <button data-act="help-close" aria-label="Close shortcuts" title="Close">${icon("close")}</button></h3>
        <table>
          <tr><td><kbd>Click</kbd></td><td>Select element</td></tr>
          <tr><td><kbd>Double-click</kbd></td><td>Edit text or diagram label</td></tr>
          <tr><td><kbd>Enter</kbd> / <kbd>E</kbd></td><td>Edit selected text/label</td></tr>
          <tr><td><kbd>C</kbd></td><td>Add a comment</td></tr>
          <tr><td><kbd>Drag handle</kbd></td><td>Reorder HTML or reposition diagram item</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Z</kbd></td><td>Undo last saved edit or move</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Y</kbd> / <kbd>Cmd</kbd><kbd>Shift</kbd><kbd>Z</kbd></td><td>Redo</td></tr>
          <tr><td><kbd>Option</kbd><kbd>Left</kbd> / <kbd>Right</kbd></td><td>Previous / next sibling</td></tr>
          <tr><td><kbd>Option</kbd><kbd>Up</kbd></td><td>Parent</td></tr>
          <tr><td><kbd>Option</kbd><kbd>Down</kbd></td><td>First editable child</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Enter</kbd></td><td>Save edit / send comment</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Cancel / dismiss / deselect</td></tr>
          <tr><td><kbd>?</kbd></td><td>Toggle this help</td></tr>
        </table>
      </div>
    </div>
    <div id="__edit_status"></div>
    <div id="__edit_sidebar">
      <div class="head">
        <span class="title">Comments for agent</span>
        <span class="count" data-role="count">0</span>
        <button data-act="copy" aria-label="Copy comments" title="Copy comment summary">${icon("copy")}</button>
        <button data-act="refresh" aria-label="Refresh comments" title="Refresh comments">${icon("refresh")}</button>
        <button data-act="toggle" aria-label="Collapse comments" title="Collapse comments">${icon("collapse")}</button>
      </div>
      <div class="hint" data-role="hint" hidden>Comments are delivered to the agent automatically as user messages.</div>
      <div class="list" id="__edit_clist"></div>
      <div class="empty" data-role="empty">No comments yet. Select an element and click Comment.</div>
    </div>
  `;
  document.body.appendChild(root);
  document.documentElement.classList.add("__edit_active");

  const hoverBox  = root.querySelector("#__edit_hover");
  const selectBox = root.querySelector("#__edit_select");
  const dropLine  = root.querySelector("#__edit_drop");
  const toolbar   = root.querySelector("#__edit_toolbar");
  const pathEl    = toolbar.querySelector("[data-role=path]");
  const editBtn   = toolbar.querySelector("[data-act=edit]");
  const dragBtn   = toolbar.querySelector("[data-act=drag]");
  const navPrev   = toolbar.querySelector("[data-act=nav-prev]");
  const navNext   = toolbar.querySelector("[data-act=nav-next]");
  const navParent = toolbar.querySelector("[data-act=nav-parent]");
  const navChild  = toolbar.querySelector("[data-act=nav-child]");
  const helpOverlay = root.querySelector("#__edit_help");
  const commentBox = root.querySelector("#__edit_commentbox");
  const commentTA  = commentBox.querySelector("textarea");
  const svgEditor = root.querySelector("#__edit_svgeditor");
  const svgFields = svgEditor;
  const status    = root.querySelector("#__edit_status");
  const sidebar   = root.querySelector("#__edit_sidebar");
  const clist     = sidebar.querySelector("#__edit_clist");
  const countEl   = sidebar.querySelector("[data-role=count]");
  const emptyEl   = sidebar.querySelector("[data-role=empty]");
  const hintEl    = sidebar.querySelector("[data-role=hint]");
  const toggleBtn = sidebar.querySelector('[data-act="toggle"]');

  // --- helpers -------------------------------------------------------------
  let hovered = null;
  let selected = null;
  let editing = false;
  let svgEditing = null;
  let dragging = null;

  const isOverlay = (el) =>
    el && (el.id === "__edit_root" || (el.closest && el.closest("#__edit_root")) || (el.classList && el.classList.contains("__edit_dot")));
  const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
  const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
  const isSvgGroup = (el) => !!(el && tagName(el) === "g" && isInsideSvg(el));
  const isEditable = (el) =>
    !!(el && el.getAttribute && el.getAttribute("data-edit-id") && (!isInsideSvg(el) || isSvgGroup(el)));
  const hasChildElements = (el) => !!(el && el.querySelector && el.querySelector("*"));
  const INLINE_TEXT_TAGS = new Set([
    "a", "abbr", "b", "br", "code", "em", "i", "kbd", "mark", "s", "small",
    "span", "strong", "sub", "sup", "time", "u", "var"
  ]);
  function hasOnlyInlineDescendants(el) {
    if (!el || !el.querySelectorAll) return true;
    return Array.from(el.querySelectorAll("*")).every((child) =>
      !isInsideSvg(child) && INLINE_TEXT_TAGS.has(tagName(child))
    );
  }
  function isTextEditableElement(el) {
    return !!(isEditable(el) && !isInsideSvg(el) && (!hasChildElements(el) || hasOnlyInlineDescendants(el)));
  }
  function isDraggableSvgGroup(el) {
    return !!(isSvgGroup(el) && !Array.from(el.querySelectorAll('g[data-edit-id]')).some(isEditable));
  }
  function svgTextNodes(el) {
    return isSvgGroup(el) ? Array.from(el.querySelectorAll("text")) : [];
  }
  function svgTextFromHit(target) {
    if (!(target && target.closest)) return null;
    const text = target.closest("text");
    if (text) return text;
    const tspan = target.closest("tspan");
    return tspan && tspan.closest ? tspan.closest("text") : null;
  }
  function isSvgLabelHit(target) {
    return !!svgTextFromHit(target);
  }
  function targetFor(el) {
    if (!isEditable(el)) return null;
    const svgLeaf = isDraggableSvgGroup(el);
    if (svgLeaf) {
      return {
        el,
        id: el.getAttribute("data-edit-id"),
        kind: "svg-item",
        canEditText: svgTextNodes(el).length > 0,
        canComment: true,
        canMove: true,
        moveMode: "spatial",
      };
    }
    if (isInsideSvg(el)) {
      return {
        el,
        id: el.getAttribute("data-edit-id"),
        kind: "svg-container",
        canEditText: false,
        canComment: true,
        canMove: false,
        moveMode: null,
      };
    }
    const canEditText = isTextEditableElement(el);
    return {
      el,
      id: el.getAttribute("data-edit-id"),
      kind: canEditText ? "html-text" : "html-structural",
      canEditText,
      canComment: true,
      canMove: true,
      moveMode: "reorder",
    };
  }
  function currentTarget() { return targetFor(selected); }

  function editableFrom(target) {
    if (isInsideSvg(target)) {
      // In SVG diagrams, select logical component groups, not raw rect/text/path
      // primitives. If no group is available, fall back to the containing diagram.
      const group = target.closest && target.closest('g[data-edit-id]');
      if (group && isEditable(group)) return group;
      const diagram = target.closest && target.closest('[data-edit-id].diagram');
      if (diagram && isEditable(diagram)) return diagram;
    }
    let el = target;
    while (el && !isEditable(el)) el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return el;
  }
  function editableAncestor(el) {
    while (el && !isEditable(el)) el = el.parentElement;
    return el && el !== document.body && el !== document.documentElement ? el : null;
  }
  function prevEditableSibling(el) {
    let s = el && el.previousElementSibling;
    while (s) { if (isEditable(s)) return s; s = s.previousElementSibling; }
    return null;
  }
  function nextEditableSibling(el) {
    let s = el && el.nextElementSibling;
    while (s) { if (isEditable(s)) return s; s = s.nextElementSibling; }
    return null;
  }
  function firstEditableChild(el) {
    if (!el || !el.querySelectorAll) return null;
    if (el.querySelector("svg") || isSvgGroup(el)) {
      const groups = Array.from(el.querySelectorAll('g[data-edit-id]')).filter(isEditable);
      return groups.find((g) => !Array.from(g.querySelectorAll('g[data-edit-id]')).some(isEditable)) || groups[0] || null;
    }
    return Array.from(el.querySelectorAll("[data-edit-id]")).find(isEditable) || null;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }
  function labelFor(el) {
    if (isSvgGroup(el)) {
      const label = svgTextNodes(el).map((node) => (node.textContent || "").trim()).filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, 48);
      return label || "svg group";
    }
    let label = tagName(el);
    const cls = typeof el.className === "string"
      ? el.className.split(/\s+/).filter((c) => c && !c.startsWith("__edit_"))[0]
      : "";
    if (el.id) label += "#" + el.id;
    else if (cls) label += "." + cls;
    return label;
  }
  function breadcrumb(el) {
    if (isSvgGroup(el)) {
      return '<span class="cur">' + escapeHtml(labelFor(el)) + '</span>';
    }
    const parts = [];
    let cur = el;
    while (cur && isEditable(cur) && parts.length < 4) {
      parts.unshift(labelFor(cur));
      cur = cur.parentElement;
    }
    return parts.map((p, i) =>
      i === parts.length - 1
        ? '<span class="cur">' + escapeHtml(p) + '</span>'
        : '<span>' + escapeHtml(p) + '</span>'
    ).join('<span class="arrow">›</span>');
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      top: r.top + window.scrollY,
      left: r.left + window.scrollX,
      width: r.width,
      height: r.height,
    };
  }
  function placeBox(box, el) {
    if (!el) { box.style.display = "none"; return; }
    const r = rectOf(el);
    box.style.display = "block";
    box.style.top = r.top + "px";
    box.style.left = r.left + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }
  function placeToolbar(el) {
    if (!el) { toolbar.hidden = true; return; }
    const r = rectOf(el);
    toolbar.hidden = false;
    const target = targetFor(el);
    pathEl.innerHTML = breadcrumb(el);
    editBtn.disabled = !(target && target.canEditText);
    editBtn.title = target && target.kind === "svg-item"
      ? "Edit this diagram label (Enter or double-click)"
      : (editBtn.disabled ? "Structural component selected. Select text inside it to edit." : "Edit text (Enter or double-click)");
    dragBtn.disabled = !(target && target.canMove);
    dragBtn.title = target && target.moveMode === "spatial"
      ? "Drag to reposition this diagram item"
      : (dragBtn.disabled ? "This selected item cannot be moved directly" : "Drag to move this component before/after another");
    navParent.disabled = !editableAncestor(el.parentElement);
    navChild.disabled = !firstEditableChild(el);
    navPrev.disabled = !prevEditableSibling(el);
    navNext.disabled = !nextEditableSibling(el);

    // Measure after un-hiding and after path text is set.
    const tb = toolbar.getBoundingClientRect();
    let top = r.top - tb.height - 6;
    let left = r.left;
    if (top < window.scrollY + 4) top = r.top + r.height + 6;
    const maxLeft = window.scrollX + window.innerWidth - tb.width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < window.scrollX + 4) left = window.scrollX + 4;
    toolbar.style.top = top + "px";
    toolbar.style.left = left + "px";
  }
  function ensureVisible(el) {
    const r = el.getBoundingClientRect();
    const pad = 64;
    if (r.top < pad || r.bottom > window.innerHeight - pad) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  function toggleHelp(force) {
    helpOverlay.hidden = typeof force === "boolean" ? !force : !helpOverlay.hidden;
  }
  function navigate(direction) {
    if (!selected) return;
    let target = null;
    if (direction === "left") target = prevEditableSibling(selected);
    else if (direction === "right") target = nextEditableSibling(selected);
    else if (direction === "up") target = editableAncestor(selected.parentElement);
    else if (direction === "down") target = firstEditableChild(selected);
    if (!target) { flash("No editable element in that direction."); return; }
    selectElement(target);
    ensureVisible(target);
  }
  function performHistory(action) {
    const endpoint = action === "undo" ? ENDPOINT_UNDO : ENDPOINT_REDO;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) {
        flash(j.error || (action === "undo" ? "Nothing to undo." : "Nothing to redo."));
        return;
      }
      flash(action === "undo" ? "Undone." : "Redone.");
      setTimeout(() => window.location.reload(), 120);
    }).catch(() => flash((action === "undo" ? "Undo" : "Redo") + " failed: network error"));
  }

  // --- drag / reorder / SVG spatial move ----------------------------------
  function isIllegalDragTarget(target) {
    return !selected || !target || target === selected || selected.contains(target) || isInsideSvg(target);
  }
  function parseTranslate(transform) {
    const m = String(transform || "").match(/translate\s*\(\s*([-+]?\d*\.?\d+)(?:[ ,]+([-+]?\d*\.?\d+))?\s*\)/);
    return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2] || "0") : 0 };
  }
  function withTranslate(transform, x, y) {
    const next = "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")";
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
    // Avoid the floating ghost/drop overlays becoming the hit-test target.
    if (dragging && dragging.ghost) dragging.ghost.style.display = "none";
    dropLine.hidden = true;
    const raw = document.elementFromPoint(x, y);
    if (dragging && dragging.ghost) dragging.ghost.style.display = "block";
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
    if (!drop || !drop.el) { dropLine.hidden = true; return; }
    const r = rectOf(drop.el);
    dropLine.hidden = false;
    dropLine.style.left = r.left + "px";
    dropLine.style.top = (drop.position === "before" ? r.top : r.top + r.height) + "px";
    dropLine.style.width = Math.max(24, r.width) + "px";
  }
  function moveGhost(x, y) {
    if (!dragging || !dragging.ghost) return;
    dragging.ghost.style.left = (x + 12) + "px";
    dragging.ghost.style.top = (y + 12) + "px";
  }
  function beginDrag(e) {
    if (!selected || editing || dragging) return;
    const target = currentTarget();
    if (!target || !target.canMove) { flash("This selected item cannot be moved directly."); return; }
    if (target.moveMode === "spatial") return beginSvgDrag(e);
    return beginReorderDrag(e);
  }
  function beginReorderDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    const ghost = document.createElement("div");
    ghost.className = "__edit_ghost";
    const text = ((selected.innerText || selected.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90));
    ghost.textContent = labelFor(selected) + (text ? " — " + text : "");
    document.body.appendChild(ghost);
    dragging = { mode: "reorder", el: selected, id: selected.getAttribute("data-edit-id"), ghost, drop: null };
    document.documentElement.classList.add("__edit_dragging");
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    moveGhost(e.clientX, e.clientY);
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragEnd, true);
    updateDrag(e);
  }
  function beginSvgDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    const svg = selected.ownerSVGElement;
    const start = svgPoint(svg, e.clientX, e.clientY);
    const originalTransform = selected.getAttribute("transform") || "";
    dragging = {
      mode: "svg",
      el: selected,
      id: selected.getAttribute("data-edit-id"),
      svg,
      start,
      base: parseTranslate(originalTransform),
      originalTransform,
      current: parseTranslate(originalTransform),
    };
    document.documentElement.classList.add("__edit_dragging");
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    document.addEventListener("mousemove", onSvgDragMove, true);
    document.addEventListener("mouseup", onSvgDragEnd, true);
    updateSvgDrag(e);
  }
  function updateDrag(e) {
    if (!dragging || dragging.mode !== "reorder") return;
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    dragging.drop = dragTargetFromPoint(e.clientX, e.clientY);
    showDropLine(dragging.drop);
  }
  function updateSvgDrag(e) {
    if (!dragging || dragging.mode !== "svg") return;
    e.preventDefault();
    const p = svgPoint(dragging.svg, e.clientX, e.clientY);
    const tx = dragging.base.x + (p.x - dragging.start.x);
    const ty = dragging.base.y + (p.y - dragging.start.y);
    dragging.current = { x: tx, y: ty };
    dragging.el.setAttribute("transform", withTranslate(dragging.originalTransform, tx, ty));
    placeBox(selectBox, dragging.el);
  }
  function onDragMove(e) { updateDrag(e); }
  function onSvgDragMove(e) { updateSvgDrag(e); }
  function cleanupDragListeners() {
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
    document.removeEventListener("mousemove", onSvgDragMove, true);
    document.removeEventListener("mouseup", onSvgDragEnd, true);
  }
  function cancelDrag() {
    if (!dragging) return;
    const original = dragging.el;
    if (dragging.mode === "svg") {
      original.setAttribute("transform", dragging.originalTransform || "");
    }
    if (dragging.ghost) dragging.ghost.remove();
    dragging = null;
    document.documentElement.classList.remove("__edit_dragging");
    dropLine.hidden = true;
    cleanupDragListeners();
    if (original && document.contains(original)) selectElement(original);
  }
  function onSvgDragEnd(e) {
    if (!dragging || dragging.mode !== "svg") return;
    e.preventDefault();
    e.stopPropagation();
    const { el, id, current, originalTransform } = dragging;
    dragging = null;
    document.documentElement.classList.remove("__edit_dragging");
    cleanupDragListeners();

    fetch(ENDPOINT_MOVE_SVG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, translate_x: current.x, translate_y: current.y }),
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) {
        el.setAttribute("transform", originalTransform || "");
        flash("Move failed: " + (j.error || "unknown error"));
        selectElement(el);
        return;
      }
      selectElement(el);
      flash("Repositioned.");
    }).catch(() => {
      el.setAttribute("transform", originalTransform || "");
      flash("Move failed: network error");
      selectElement(el);
    });
  }
  function onDragEnd(e) {
    if (!dragging || dragging.mode !== "reorder") return;
    e.preventDefault();
    e.stopPropagation();
    const { el, id, drop, ghost } = dragging;
    if (ghost) ghost.remove();
    dragging = null;
    document.documentElement.classList.remove("__edit_dragging");
    dropLine.hidden = true;
    cleanupDragListeners();

    if (!drop || !drop.el) {
      flash("Move cancelled: drop on another component.");
      if (el && document.contains(el)) selectElement(el);
      return;
    }

    fetch(ENDPOINT_MOVE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, target_id: drop.id, position: drop.position }),
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) {
        flash("Move failed: " + (j.error || "unknown error"));
        if (el && document.contains(el)) selectElement(el);
        return;
      }
      if (drop.position === "before") drop.el.parentNode.insertBefore(el, drop.el);
      else drop.el.parentNode.insertBefore(el, drop.el.nextSibling);
      selectElement(el);
      loadComments();
      flash("Moved.");
    }).catch(() => {
      flash("Move failed: network error");
      if (el && document.contains(el)) selectElement(el);
    });
  }

  // --- mouse tracking ------------------------------------------------------
  document.addEventListener("mousemove", (e) => {
    if (editing || dragging) return;
    const t = e.target;
    if (isOverlay(t)) { hoverBox.style.display = "none"; hovered = null; return; }
    const el = editableFrom(t);
    if (!el) { hoverBox.style.display = "none"; hovered = null; return; }
    hovered = el;
    placeBox(hoverBox, el);
  }, true);

  document.addEventListener("mouseleave", () => {
    hoverBox.style.display = "none";
  });

  // Capture-phase click selects instead of following links etc.
  document.addEventListener("click", (e) => {
    if (editing || dragging) return;
    if (isOverlay(e.target)) return;
    const el = editableFrom(e.target);
    if (!el) {
      if (selected) deselect();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (selected === el && targetFor(el)?.kind === "svg-item" && isSvgLabelHit(e.target)) {
      startEdit(e.target);
      return;
    }
    selectElement(el);
  }, true);

  // Double-click bypasses the toolbar and drops straight into edit mode.
  document.addEventListener("dblclick", (e) => {
    if (editing || dragging) return;
    if (isOverlay(e.target)) return;
    const el = editableFrom(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    selectElement(el);
    startEdit(e.target);
  }, true);

  // global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const inEditableField =
      t && ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") ||
            (t.getAttribute && t.getAttribute("contenteditable") === "true"));

    if (e.key === "Escape") {
      if (dragging) { e.preventDefault(); cancelDrag(); return; }
      if (svgEditing) { e.preventDefault(); finishSvgLabelEdit(false); return; }
      if (editing) return; // edit handler owns edit cancellation
      if (!commentBox.hidden) { e.preventDefault(); commentBox.hidden = true; return; }
      if (!helpOverlay.hidden) { e.preventDefault(); toggleHelp(false); return; }
      if (selected) { e.preventDefault(); deselect(); return; }
      return;
    }

    const key = e.key.toLowerCase();
    const isHistoryKey = (e.metaKey || e.ctrlKey) && !e.altKey && (key === "z" || key === "y");
    if (isHistoryKey && !inEditableField && !editing) {
      e.preventDefault();
      performHistory(key === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }

    if (inEditableField || editing) return;

    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      toggleHelp();
      return;
    }

    if (!selected) return;

    if (e.key === "Enter" || e.key.toLowerCase() === "e") {
      e.preventDefault(); startEdit(); return;
    }
    if (e.key.toLowerCase() === "c") {
      e.preventDefault(); startComment(); return;
    }
    if (e.altKey) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); navigate("left");  return; }
      if (e.key === "ArrowRight") { e.preventDefault(); navigate("right"); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); navigate("up");    return; }
      if (e.key === "ArrowDown")  { e.preventDefault(); navigate("down");  return; }
    }
  });

  function selectElement(el) {
    selected = el;
    hovered = null;
    hoverBox.style.display = "none";
    placeBox(selectBox, el);
    placeToolbar(el);
    commentBox.hidden = true;
    if (!svgEditing) svgEditor.hidden = true;
  }
  function deselect() {
    if (svgEditing) finishSvgLabelEdit(false);
    selected = null;
    selectBox.style.display = "none";
    toolbar.hidden = true;
    commentBox.hidden = true;
    svgEditor.hidden = true;
  }

  dragBtn.addEventListener("mousedown", beginDrag);

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-act]");
    const act = btn && btn.dataset.act;
    if (!act || btn.disabled) return;
    if (act === "edit") startEdit();
    else if (act === "comment") startComment();
    else if (act === "undo") performHistory("undo");
    else if (act === "redo") performHistory("redo");
    else if (act === "close") deselect();
    else if (act === "nav-prev")   navigate("left");
    else if (act === "nav-parent") navigate("up");
    else if (act === "nav-child")  navigate("down");
    else if (act === "nav-next")   navigate("right");
    else if (act === "help") toggleHelp();
  });

  helpOverlay.addEventListener("click", (e) => {
    if (e.target === helpOverlay) { toggleHelp(false); return; }
    const btn = e.target.closest && e.target.closest("[data-act]");
    if (btn && btn.dataset.act === "help-close") toggleHelp(false);
  });

  commentBox.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-act]");
    const act = btn && btn.dataset.act;
    if (act === "send") sendComment();
    else if (act === "cancel") { commentBox.hidden = true; }
  });
  commentTA.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      sendComment();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commentBox.hidden = true;
    }
  });

  svgEditor.addEventListener("focusout", () => {
    setTimeout(() => {
      if (svgEditing && !svgEditor.contains(document.activeElement)) finishSvgLabelEdit(true);
    }, 0);
  });
  svgEditor.addEventListener("keydown", (e) => {
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

  // --- text / label editing ------------------------------------------------
  function startEdit(preferredSource) {
    if (!selected || editing) return;
    const target = currentTarget();
    if (target && target.kind === "svg-item" && target.canEditText) {
      startSvgLabelEdit(preferredSource);
      return;
    }
    const el = selected;
    const id = el.getAttribute("data-edit-id");
    const originalText = el.innerText;
    const originalHTML = el.innerHTML;
    const hadChildren = hasChildElements(el);
    if (!(target && target.canEditText)) {
      const child = firstEditableChild(el);
      flash(child ? "Structural component selected. Use Option+Down or click text inside it to edit." : "Structural component selected. Drag to move it; select text inside it to edit.");
      placeToolbar(el);
      return;
    }

    editing = true;
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    commentBox.hidden = true;
    svgEditor.hidden = true;

    el.setAttribute("contenteditable", "true");
    el.classList.add("__edit_editing");
    el.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);

    const finish = (commit) => {
      el.removeAttribute("contenteditable");
      el.classList.remove("__edit_editing");
      el.removeEventListener("blur", onBlur, true);
      el.removeEventListener("keydown", onKey, true);
      editing = false;
      if (!commit) {
        if (hadChildren) el.innerHTML = originalHTML;
        else el.innerText = originalText;
      } else {
        const text = el.innerText;
        const html = hadChildren ? el.innerHTML : undefined;
        fetch(ENDPOINT_SAVE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, text, html }),
        }).then((r) => r.json()).then((j) => {
          if (j.ok) {
            flash("Saved.");
            el.classList.add("__edit_pulse");
            setTimeout(() => el.classList.remove("__edit_pulse"), 700);
          } else {
            flash("Save failed: " + (j.error || "unknown error"));
          }
        }).catch(() => flash("Save failed: network error"));
      }
      placeBox(selectBox, el);
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
    el.addEventListener("blur", onBlur, true);
    el.addEventListener("keydown", onKey, true);
  }

  function positionSvgLabelInputs(state) {
    if (!state) return;
    state.inputs.forEach((input, i) => {
      const node = state.inputNodes[i];
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      const anchor = node.getAttribute("text-anchor") || cs.textAnchor || "start";
      const width = Math.max(18, r.width);
      const height = Math.max(16, r.height);
      input.style.top = (window.scrollY + r.top) + "px";
      input.style.left = (window.scrollX + r.left) + "px";
      input.style.width = width + "px";
      input.style.height = height + "px";
      input.style.lineHeight = height + "px";
      input.style.fontFamily = cs.fontFamily;
      input.style.fontSize = cs.fontSize;
      input.style.fontWeight = cs.fontWeight;
      input.style.fontStyle = cs.fontStyle;
      input.style.letterSpacing = cs.letterSpacing;
      input.style.color = cs.fill && cs.fill !== "none" ? cs.fill : cs.color;
      input.style.textAlign = anchor === "middle" ? "center" : (anchor === "end" ? "right" : "left");
    });
  }

  function startSvgLabelEdit(preferredSource) {
    if (!selected || svgEditing) return;
    const target = currentTarget();
    if (!(target && target.kind === "svg-item" && target.canEditText)) {
      flash("Select a labelled diagram item to edit its text.");
      return;
    }
    const el = selected;
    const textNodes = svgTextNodes(el);
    const originals = textNodes.map((node) => node.textContent || "");
    const originalVisibility = textNodes.map((node) => node.style.visibility || "");
    const preferredText = svgTextFromHit(preferredSource);
    let editIndex = textNodes.indexOf(preferredText);
    if (editIndex < 0) editIndex = 0;
    const editNode = textNodes[editIndex];

    svgFields.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "__edit_svg_input";
    input.value = editNode.textContent || "";
    input.dataset.index = String(editIndex);
    input.setAttribute("aria-label", "Edit diagram label");
    svgFields.appendChild(input);
    editNode.style.visibility = "hidden";

    editing = true;
    svgEditing = {
      el,
      id: target.id,
      textNodes,
      originals,
      originalVisibility,
      editIndex,
      inputNodes: [editNode],
      inputs: [input],
    };
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    commentBox.hidden = true;
    svgEditor.hidden = false;
    positionSvgLabelInputs(svgEditing);
    input.focus();
    input.select();
    requestAnimationFrame(() => { input.scrollLeft = 0; });
  }

  function finishSvgLabelEdit(commit) {
    if (!svgEditing) return;
    const state = svgEditing;
    const lines = state.originals.slice();
    lines[state.editIndex] = state.inputs[0] ? state.inputs[0].value : lines[state.editIndex];
    const restore = () => state.textNodes.forEach((node, i) => {
      node.textContent = state.originals[i] || "";
      node.style.visibility = state.originalVisibility[i] || "";
    });
    const reveal = () => state.textNodes.forEach((node, i) => { node.style.visibility = state.originalVisibility[i] || ""; });
    svgEditing = null;
    editing = false;
    svgEditor.hidden = true;
    svgFields.innerHTML = "";

    if (!commit) {
      restore();
      selectElement(state.el);
      return;
    }

    state.textNodes.forEach((node, i) => { node.textContent = lines[i] || ""; });
    reveal();
    placeBox(selectBox, state.el);
    fetch(ENDPOINT_SAVE_SVG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.id, lines }),
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) {
        restore();
        flash("Save failed: " + (j.error || "unknown error"));
      } else {
        flash("Saved diagram label.");
        state.el.classList.add("__edit_pulse");
        setTimeout(() => state.el.classList.remove("__edit_pulse"), 700);
      }
      selectElement(state.el);
    }).catch(() => {
      restore();
      flash("Save failed: network error");
      selectElement(state.el);
    });
  }

  // --- comments ------------------------------------------------------------
  function startComment() {
    if (!selected) return;
    svgEditor.hidden = true;
    commentBox.hidden = false;
    const r = rectOf(selected);
    commentBox.style.top  = (r.top + r.height + 6) + "px";
    let left = r.left;
    const maxLeft = window.scrollX + window.innerWidth - 340;
    if (left > maxLeft) left = maxLeft;
    if (left < window.scrollX + 4) left = window.scrollX + 4;
    commentBox.style.left = left + "px";
    commentTA.value = "";
    commentTA.focus();
  }
  function sendComment() {
    if (!selected) return;
    const text = commentTA.value.trim();
    if (!text) { flash("Type a comment first."); return; }
    const id = selected.getAttribute("data-edit-id");
    const raw = (selected.innerText && selected.innerText.trim()) || (selected.textContent || "");
    const excerpt = raw.trim().slice(0, 160).replace(/\s+/g, " ");
    const tag = selected.tagName.toLowerCase();
    fetch(ENDPOINT_COMMENT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, comment: text, excerpt, tag }),
    }).then((r) => r.json()).then((j) => {
      if (j.ok) {
        flash("Sent to agent.");
        commentTA.value = "";
        commentBox.hidden = true;
        loadComments();
      } else {
        flash("Comment failed: " + (j.error || "unknown error"));
      }
    }).catch(() => flash("Comment failed: network error"));
  }

  function flash(msg) {
    status.textContent = msg;
    status.style.opacity = "1";
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { status.style.opacity = "0"; }, 2200);
  }

  // --- comment list & dots -------------------------------------------------
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
      const el = document.querySelector('[data-edit-id="' + CSS.escape(id) + '"]');
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
        selectElement(el);
      });
      document.body.appendChild(dot);
      dots.push(dot);
    });
  }
  function loadComments() {
    fetch(ENDPOINT_LIST).then((r) => r.json()).then((items) => {
      countEl.textContent = items.length;
      clist.innerHTML = "";
      if (!items.length) {
        emptyEl.style.display = "";
        if (hintEl) hintEl.hidden = true;
      } else {
        emptyEl.style.display = "none";
        if (hintEl) hintEl.hidden = false;
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
            const el = document.querySelector('[data-edit-id="' + CSS.escape(c.id) + '"]');
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              setTimeout(() => selectElement(el), 350);
            } else {
              flash("That element no longer exists in the DOM.");
            }
          });
          clist.appendChild(d);
        });
      }
      renderDots(items);
    }).catch(() => {});
  }

  // sidebar buttons
  sidebar.querySelector('[data-act="refresh"]').addEventListener("click", loadComments);
  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    const collapsed = sidebar.classList.contains("collapsed");
    toggleBtn.innerHTML = icon(collapsed ? "expand" : "collapse");
    toggleBtn.setAttribute("aria-label", collapsed ? "Expand comments" : "Collapse comments");
    toggleBtn.title = collapsed ? "Expand comments" : "Collapse comments";
  });
  sidebar.querySelector('[data-act="copy"]').addEventListener("click", () => {
    fetch(ENDPOINT_LIST).then((r) => r.json()).then((items) => {
      if (!items.length) { flash("No comments to copy."); return; }
      const lines = items.map((c) => `- [${c.id} <${c.tag || "?"}>] ${c.comment}  (on: "${c.excerpt || ""}")`);
      const text = `check comments (${items.length}):\n` + lines.join("\n");
      navigator.clipboard.writeText(text).then(
        () => flash("Copied."),
        () => flash("Copy failed; read the comments JSON instead.")
      );
    });
  });

  // --- reposition on scroll/resize ----------------------------------------
  let raf = 0;
  function reflow() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (selected) {
        placeBox(selectBox, selected);
        if (!editing) placeToolbar(selected);
      }
      if (svgEditing) positionSvgLabelInputs(svgEditing);
      if (hovered)  placeBox(hoverBox, hovered);
    });
  }
  window.addEventListener("scroll", () => { reflow(); loadDotsThrottled(); }, true);
  window.addEventListener("resize", () => { reflow(); loadDotsThrottled(); });

  let dotTimer = 0;
  function loadDotsThrottled() {
    clearTimeout(dotTimer);
    dotTimer = setTimeout(loadComments, 120);
  }

  // Poll for comments every 8s so external CLI edits show up.
  setInterval(loadComments, 8000);
  loadComments();

  // expose tiny API for debugging/tests
  window.__edit = {
    select: selectElement,
    deselect,
    reload: loadComments,
    startEdit,
    startComment,
    navigate,
    toggleHelp,
    beginDrag,
    target: currentTarget,
    undo: () => performHistory("undo"),
    redo: () => performHistory("redo"),
  };
})();
