  // --- drag / reorder / SVG spatial move / HTML resize --------------------
  function beginResize(direction, e) {
    if (!selected || dragging) return;
    if (!isHtmlResizable(selected)) return;
    e.preventDefault();
    e.stopPropagation();
    // If we were mid-edit, gracefully end edit before resizing.
    if (editing && selected.hasAttribute("contenteditable")) {
      selected.blur();
    }
    const r = selected.getBoundingClientRect();
    dragging = {
      mode: "resize",
      el: selected,
      direction,
      startX: e.clientX,
      startY: e.clientY,
      originalW: r.width,
      originalH: r.height,
      originalInlineWidth: selected.style.width,
      originalInlineHeight: selected.style.height,
      originalInlineMaxWidth: selected.style.maxWidth,
      originalInlineMaxHeight: selected.style.maxHeight,
    };
    document.documentElement.classList.add("__edit_resizing");
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    document.addEventListener("mousemove", onResizeMove, true);
    document.addEventListener("mouseup", onResizeEnd, true);
  }
  function onResizeMove(e) {
    if (!dragging || dragging.mode !== "resize") return;
    e.preventDefault();
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const dir = dragging.direction;
    let newW = dragging.originalW;
    let newH = dragging.originalH;
    if (dir.indexOf("e") >= 0) newW = Math.max(20, dragging.originalW + dx);
    if (dir.indexOf("s") >= 0) newH = Math.max(20, dragging.originalH + dy);
    // Direct-manipulation override: also strip stylesheet max-* caps so the
    // element really takes the dragged size. Undo restores everything.
    if (dir.indexOf("e") >= 0) {
      dragging.el.style.width = Math.round(newW) + "px";
      dragging.el.style.maxWidth = "none";
    }
    if (dir.indexOf("s") >= 0) {
      dragging.el.style.height = Math.round(newH) + "px";
      dragging.el.style.maxHeight = "none";
    }
    placeBox(selectBox, dragging.el);
  }
  function onResizeEnd(e) {
    if (!dragging || dragging.mode !== "resize") return;
    e.preventDefault();
    e.stopPropagation();
    suppressClickUntil = Date.now() + 350;
    const {
      el, direction,
      originalInlineWidth, originalInlineHeight,
      originalInlineMaxWidth, originalInlineMaxHeight,
    } = dragging;
    const usedW = direction.indexOf("e") >= 0;
    const usedH = direction.indexOf("s") >= 0;
    const finalW = usedW ? el.style.width  : null;
    const finalH = usedH ? el.style.height : null;
    dragging = null;
    document.documentElement.classList.remove("__edit_resizing");
    document.removeEventListener("mousemove", onResizeMove, true);
    document.removeEventListener("mouseup", onResizeEnd, true);
    const noChange =
      (!usedW || (finalW === originalInlineWidth)) &&
      (!usedH || (finalH === originalInlineHeight));
    if (noChange) {
      // Restore max-* in case the live-drag set them but nothing else changed.
      el.style.maxWidth  = originalInlineMaxWidth  || "";
      el.style.maxHeight = originalInlineMaxHeight || "";
      selectElement(el);
      return;
    }
    const restore = () => {
      if (usedW) el.style.width  = originalInlineWidth;
      if (usedH) el.style.height = originalInlineHeight;
      el.style.maxWidth  = originalInlineMaxWidth  || "";
      el.style.maxHeight = originalInlineMaxHeight || "";
    };
    const id = el.getAttribute("data-edit-id");
    const body = { id };
    if (usedW) { body.width  = finalW; body.max_width  = "none"; }
    if (usedH) { body.height = finalH; body.max_height = "none"; }
    fetch(ENDPOINT_RESIZE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) { restore(); flash("Resize failed: " + (j.error || "unknown error")); }
      else {
        flash("Resized.");
        el.classList.add("__edit_pulse");
        setTimeout(() => el.classList.remove("__edit_pulse"), 700);
      }
      selectElement(el);
    }).catch(() => { restore(); flash("Resize failed: network error"); selectElement(el); });
  }

  // --- reorder / SVG spatial move -----------------------------------------
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

