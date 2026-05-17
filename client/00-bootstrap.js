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
  const ENDPOINT_RESIZE = "/resize-element";
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

