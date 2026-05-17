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

