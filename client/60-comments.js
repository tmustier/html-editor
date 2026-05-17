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

