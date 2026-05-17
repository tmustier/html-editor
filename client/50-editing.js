  // --- text / label editing ------------------------------------------------
  function startEdit(preferredSource, clickX, clickY) {
    if (!selected || editing) return;
    const target = currentTarget();
    if (target && (target.kind === "svg-item" || target.kind === "svg-text") && target.canEditText) {
      startSvgLabelEdit(preferredSource, clickX, clickY);
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
    placeCaretFromClickOrEnd(el, clickX, clickY);

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

  // Drop the caret where the user clicked. Tries the standard
  // caretRangeFromPoint (Chrome) then caretPositionFromPoint (Firefox/spec).
  // Falls back to end-of-content if the click was outside any text node or
  // the APIs aren't available.
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
      // Reject ranges that landed outside this editable (e.g. on an overlay).
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

  function positionSvgLabelInputs(state) {
    if (!state) return;
    state.inputs.forEach((input, i) => {
      const node = state.inputNodes[i];
      const r = node.getBoundingClientRect();
      input.style.top = (window.scrollY + r.top) + "px";
      input.style.left = (window.scrollX + r.left) + "px";
      input.style.width = Math.max(18, r.width) + "px";
      input.style.height = Math.max(16, r.height) + "px";
    });
    positionSvgCaret(state);
  }

  function svgPointFromClient(svgEl, clientX, clientY) {
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return pt;
    return pt.matrixTransform(ctm.inverse());
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
      // getCharNumAtPosition returns the char *under* the point. We want the
      // insertion point: snap to the nearer side of that glyph.
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
    // Clicked outside any glyph — pick start or end based on which side.
    const r = node.getBoundingClientRect();
    if (clientX <= r.left) return 0;
    return (node.textContent || "").length;
  }

  function measureSvgPrefixPx(node, prefixLen) {
    // Returns the rendered pixel width of the first `prefixLen` chars of node.
    // Uses getSubStringLength (SVG user units), scaled to screen pixels via
    // the ratio between the rendered bbox width and the full user-unit length.
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

  function positionSvgCaret(state) {
    if (!state || !state.caret) return;
    const input = state.inputs[0];
    const node = state.inputNodes[0];
    const r = node.getBoundingClientRect();
    const selStart = input.selectionStart == null ? input.value.length : input.selectionStart;
    const prefixWidth = measureSvgPrefixPx(node, selStart);
    const x = r.left + prefixWidth;
    state.caret.style.left = (window.scrollX + x) + "px";
    state.caret.style.top = (window.scrollY + r.top) + "px";
    state.caret.style.height = Math.max(12, r.height) + "px";
  }

  function startSvgLabelEdit(preferredSource, clickX, clickY) {
    if (!selected || svgEditing) return;
    const target = currentTarget();
    if (!(target && (target.kind === "svg-item" || target.kind === "svg-text") && target.canEditText)) {
      flash("Select a labelled diagram item or text to edit.");
      return;
    }
    const el = selected;
    // For a raw <text> target, the element itself is the only text node.
    const textNodes = target.kind === "svg-text" ? [el] : svgTextNodes(el);
    const originals = textNodes.map((node) => node.textContent || "");
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
    input.autocomplete = "off";
    input.spellcheck = false;
    const caret = document.createElement("span");
    caret.className = "__edit_svg_caret";
    svgFields.appendChild(input);
    svgFields.appendChild(caret);

    // Detect inline markup BEFORE the live preview strips it via textContent=.
    // We use this to decide whether to reload after save so the rendered SVG
    // matches the server-preserved tspan structure on disk.
    const hadInlineMarkup = textNodes.some((node) => node.querySelector && node.querySelector("tspan"));

    editing = true;
    svgEditing = {
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
      placeBox(selectBox, el);
      positionSvgLabelInputs(svgEditing);
    });
    input.addEventListener("mousedown", (e) => {
      // Bypass the input's native click-to-caret because its font/metrics
      // don't match the underlying SVG glyph layout. Use SVG glyph hit
      // testing instead, so the caret lands where the user pointed.
      const idx = charIndexAtClient(editNode, e.clientX, e.clientY);
      if (idx == null) return;
      e.preventDefault();
      requestAnimationFrame(() => {
        if (!svgEditing) return;
        input.focus();
        input.setSelectionRange(idx, idx);
        positionSvgCaret(svgEditing);
      });
    });
    ["keyup", "select"].forEach((eventName) => {
      input.addEventListener(eventName, () => positionSvgCaret(svgEditing));
    });
    toolbar.hidden = true;
    hoverBox.style.display = "none";
    commentBox.hidden = true;
    svgEditor.hidden = false;
    positionSvgLabelInputs(svgEditing);
    input.focus();
    // Caret placement: if startSvgLabelEdit was triggered by a click on a
    // glyph, derive char index from the click coords. Otherwise default to
    // end-of-text (preserves keyboard/Enter behaviour).
    let caretIdx = input.value.length;
    if (typeof clickX === "number" && typeof clickY === "number") {
      const idx = charIndexAtClient(editNode, clickX, clickY);
      if (idx != null && idx >= 0 && idx <= input.value.length) caretIdx = idx;
    }
    input.setSelectionRange(caretIdx, caretIdx);
    positionSvgCaret(svgEditing);
  }

  function finishSvgLabelEdit(commit) {
    if (!svgEditing) return;
    const state = svgEditing;
    const lines = state.originals.slice();
    lines[state.editIndex] = state.inputs[0] ? state.inputs[0].value : lines[state.editIndex];
    const restore = () => state.textNodes.forEach((node, i) => {
      node.textContent = state.originals[i] || "";
    });
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
    placeBox(selectBox, state.el);
    fetch(ENDPOINT_SAVE_SVG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.id, lines }),
    }).then((r) => r.json()).then((j) => {
      if (!j.ok) {
        restore();
        flash("Save failed: " + (j.error || "unknown error"));
        selectElement(state.el);
        return;
      }
      if (j.formatting_lost) {
        flash("Saved — but inline formatting was lost (edit crossed a styled span).");
      } else {
        flash("Saved diagram label.");
      }
      state.el.classList.add("__edit_pulse");
      setTimeout(() => state.el.classList.remove("__edit_pulse"), 700);
      // Live preview during typing collapses tspans (textContent=). After a
      // successful save the file may still hold tspan styling — reload so the
      // rendered SVG matches the file. Skip the reload when no inline markup
      // was at risk (pure text-only <text>) to keep the editor snappy.
      if (state.hadInlineMarkup) {
        // Give the warning toast time to be read when formatting was lost.
        setTimeout(() => window.location.reload(), j.formatting_lost ? 1600 : 220);
      } else {
        selectElement(state.el);
      }
    }).catch(() => {
      restore();
      flash("Save failed: network error");
      selectElement(state.el);
    });
  }

