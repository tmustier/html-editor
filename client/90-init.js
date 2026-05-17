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
