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
  // Behavior: a single click on a text-editable element drops straight into
  // edit mode. Structural HTML containers and SVG group backgrounds just
  // select (their handles, comment, drag, etc. remain accessible).
  document.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (editing || dragging) return;
    if (isOverlay(e.target)) return;
    const el = editableFrom(e.target);
    if (!el) {
      if (selected) deselect();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const target = targetFor(el);
    // SVG: clicking a text glyph enters edit; clicking the rect/background
    // just selects the group (keeps comment/drag accessible without typing).
    if (target && target.kind === "svg-item") {
      if (selected !== el) selectElement(el);
      if (target.canEditText && isSvgLabelHit(e.target)) startEdit(e.target, e.clientX, e.clientY);
      return;
    }
    // Orphan SVG <text>: single click selects + drops into edit, caret-at-click.
    if (target && target.kind === "svg-text") {
      selectElement(el);
      startEdit(e.target, e.clientX, e.clientY);
      return;
    }
    // HTML text: single click selects + edits, caret lands at the click.
    if (target && target.canEditText && target.kind === "html-text") {
      selectElement(el);
      startEdit(e.target, e.clientX, e.clientY);
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
    startEdit(e.target, e.clientX, e.clientY);
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

  // Resize handles (children of selectBox). selectBox is pointer-events:none
  // so the handle's pointer-events:auto is what catches this.
  selectBox.addEventListener("mousedown", (e) => {
    const handle = e.target && e.target.closest && e.target.closest("[data-handle]");
    if (!handle) return;
    beginResize(handle.dataset.handle, e);
  });

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

