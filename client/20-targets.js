  // --- helpers -------------------------------------------------------------
  let hovered = null;
  let selected = null;
  let editing = false;
  let svgEditing = null;
  let dragging = null;
  let suppressClickUntil = 0;

  const isOverlay = (el) =>
    el && (el.id === "__edit_root" || (el.closest && el.closest("#__edit_root")) || (el.classList && el.classList.contains("__edit_dot")));
  const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : "");
  const isInsideSvg = (el) => !!(el && el.closest && el.closest("svg"));
  const isSvgGroup = (el) => !!(el && tagName(el) === "g" && isInsideSvg(el));
  const isSvgText = (el) => !!(el && tagName(el) === "text" && isInsideSvg(el));
  const isEditable = (el) =>
    !!(el && el.getAttribute && el.getAttribute("data-edit-id") && (!isInsideSvg(el) || isSvgGroup(el) || isSvgText(el)));
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
  function isHtmlResizable(el) {
    if (!isEditable(el) || isInsideSvg(el)) return false;
    const tag = tagName(el);
    if (tag === "html" || tag === "body" || tag === "head") return false;
    if (INLINE_TEXT_TAGS.has(tag)) return false;
    // Inline elements (e.g. CSS-styled) can't take width/height meaningfully.
    const display = (window.getComputedStyle(el).display || "").toLowerCase();
    if (display === "inline" || display === "contents" || display === "none") return false;
    return true;
  }
  function svgTextNodes(el) {
    if (isSvgGroup(el)) return Array.from(el.querySelectorAll("text"));
    if (isSvgText(el)) return [el];
    return [];
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
    if (isSvgText(el)) {
      // Orphan SVG <text> (not enclosed in a labelled group). Text-editable
      // only; we do not move it independently of its background rect.
      return {
        el,
        id: el.getAttribute("data-edit-id"),
        kind: "svg-text",
        canEditText: true,
        canComment: true,
        canMove: false,
        moveMode: null,
      };
    }
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
      // Prefer a labelled <g> when one wraps the hit; otherwise, allow direct
      // editing of orphan <text> elements (so flat SVG diagrams are usable).
      // Fall back to the containing diagram for clicks on bare rects/paths.
      const group = target.closest && target.closest('g[data-edit-id]');
      if (group && isEditable(group)) return group;
      const text = target.closest && target.closest('text[data-edit-id]');
      if (text && isEditable(text)) return text;
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
      if (groups.length) {
        return groups.find((g) => !Array.from(g.querySelectorAll('g[data-edit-id]')).some(isEditable)) || groups[0];
      }
      const texts = Array.from(el.querySelectorAll('text[data-edit-id]')).filter(isEditable);
      if (texts.length) return texts[0];
      return null;
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
  function breadcrumb(el) {
    if (isSvgGroup(el) || isSvgText(el)) {
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
    if (box === selectBox) {
      box.dataset.resizable = isHtmlResizable(el) ? "true" : "false";
    }
  }
  function placeToolbar(el) {
    if (!el) { toolbar.hidden = true; return; }
    const r = rectOf(el);
    toolbar.hidden = false;
    const target = targetFor(el);
    pathEl.innerHTML = breadcrumb(el);
    editBtn.disabled = !(target && target.canEditText);
    editBtn.title = target && (target.kind === "svg-item" || target.kind === "svg-text")
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

