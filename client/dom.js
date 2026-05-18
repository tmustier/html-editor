// Builds the overlay DOM (inserted into the host page <body>) and exposes
// the named element references the other modules use.
//
// Also owns the two cross-cutting UI helpers: icon() and flash().

import { ICONS } from "./config.js";

export function icon(name) {
  return `<span class="i i-${name}" aria-hidden="true">${ICONS[name]}</span>`;
}

// dom.* refs are populated by initDom(). Other modules import { dom } and
// access dom.toolbar, dom.selectBox, etc.
export const dom = {};

export function initDom() {
  const root = document.createElement("div");
  root.id = "__edit_root";
  root.innerHTML = `
    <div id="__edit_hover"></div>
    <div id="__edit_table_row_handle" title="Click to select row (Shift+Space) · Drag to reorder"></div>
    <div id="__edit_table_col_handle" title="Click to select column (Ctrl+Space or Option+Space) · Drag to reorder"></div>
    <div id="__edit_table_add_row" title="Click to add a new row at the bottom"></div>
    <div id="__edit_table_add_col" title="Click to add a new column on the right"></div>
    <div id="__edit_table_drop" hidden></div>
    <div id="__edit_select">
      <div class="__edit_border_drag bd-n" data-border-drag="n" title="Drag border to move"></div>
      <div class="__edit_border_drag bd-e" data-border-drag="e" title="Drag border to move"></div>
      <div class="__edit_border_drag bd-s" data-border-drag="s" title="Drag border to move"></div>
      <div class="__edit_border_drag bd-w" data-border-drag="w" title="Drag border to move"></div>
      <div class="__edit_handle h-e"  data-handle="e"  title="Drag to resize width"></div>
      <div class="__edit_handle h-s"  data-handle="s"  title="Drag to resize height"></div>
      <div class="__edit_handle h-se" data-handle="se" title="Drag to resize"></div>
    </div>
    <div id="__edit_drop" hidden></div>
    <div id="__edit_toolbar" hidden>
      <span class="path" data-role="path"></span>
      <span class="sep"></span>
      <button data-act="edit" aria-label="Edit text" title="Edit text (F2, Enter, or double-click)">${icon("edit")}</button>
      <button data-act="comment" aria-label="Comment" title="Comment (C)">${icon("comment")}</button>
      <button data-act="drag" class="drag-handle" aria-label="Drag component" title="Drag to move this component before/after another">${icon("drag")}</button>
      <button data-act="duplicate" aria-label="Duplicate element" title="Duplicate this element">${icon("copy")}</button>
      <button data-act="table" aria-label="Table actions" title="Table row/column actions">${icon("table")}</button>
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
    <div id="__edit_tablemenu" hidden>
      <div class="group" data-table-group="row">
        <div class="label">Rows</div>
        <button data-table-act="row-insert-before">Insert row above</button>
        <button data-table-act="row-insert-after">Insert row below</button>
        <button data-table-act="row-move-up">Move row up</button>
        <button data-table-act="row-move-down">Move row down</button>
        <button data-table-act="row-delete" class="danger">Delete row</button>
      </div>
      <div class="group" data-table-group="column">
        <div class="label">Columns</div>
        <button data-table-act="col-insert-before">Insert column left</button>
        <button data-table-act="col-insert-after">Insert column right</button>
        <button data-table-act="col-move-left">Move column left</button>
        <button data-table-act="col-move-right">Move column right</button>
        <button data-table-act="col-delete" class="danger">Delete column</button>
      </div>
      <div class="hint">Simple rectangular tables only for now — no rowspan/colspan.</div>
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
          <tr><td><kbd>Click</kbd></td><td>Select element; click again on text to edit</td></tr>
          <tr><td><kbd>Click</kbd> on text</td><td>Single-click drops straight into edit</td></tr>
          <tr><td><kbd>Drag edge</kbd></td><td>Resize HTML element (E / S / SE handles)</td></tr>
          <tr><td><kbd>F2</kbd> / <kbd>Enter</kbd> / <kbd>E</kbd></td><td>Edit selected text/label</td></tr>
          <tr><td><kbd>C</kbd></td><td>Add a comment</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>C</kbd> / <kbd>Cmd</kbd><kbd>V</kbd></td><td>Copy / paste the selected text box or table cell; Excel-style ranges fill existing table cells and clip at the edge</td></tr>
          <tr><td><kbd>Drag border</kbd> / <kbd>Drag handle</kbd></td><td>Reorder HTML or reposition diagram item</td></tr>
          <tr><td><kbd>Duplicate</kbd> button</td><td>Clone the selected element with fresh edit IDs</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Z</kbd></td><td>Undo last saved edit or move</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Y</kbd> / <kbd>Cmd</kbd><kbd>Shift</kbd><kbd>Z</kbd></td><td>Redo</td></tr>
          <tr><td><kbd>Arrow keys</kbd></td><td>Move between table/grid cells when a cell is selected</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>Arrow keys</kbd></td><td>Jump to the edge of the current table row/column</td></tr>
          <tr><td><kbd>Shift</kbd><kbd>Space</kbd> / <kbd>Ctrl</kbd><kbd>Space</kbd></td><td>Select the current table row / column (Option+Space also selects column if macOS owns Ctrl+Space)</td></tr>
          <tr><td><kbd>Row/column handles</kbd></td><td>Click to select a row or column; drag to reorder</td></tr>
          <tr><td><kbd>+</kbd> edge zones</td><td>Hover the table's right or bottom edge to append a column or row</td></tr>
          <tr><td><kbd>Cmd</kbd><kbd>X</kbd> → <kbd>Cmd</kbd><kbd>V</kbd></td><td>Cut a selected row/column and paste-as-move on another row/column (same table)</td></tr>
          <tr><td><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>=</kbd></td><td>Insert a row/column before the current selection</td></tr>
          <tr><td><kbd>Ctrl</kbd><kbd>-</kbd></td><td>Delete the selected row/column</td></tr>
          <tr><td><kbd>Table</kbd> button</td><td>Insert, delete, or reorder rows/columns for simple rectangular tables</td></tr>
          <tr><td><kbd>Tab</kbd> / <kbd>Shift</kbd><kbd>Tab</kbd></td><td>Next / previous table cell; saves the current cell first while editing</td></tr>
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

  const toolbar = root.querySelector("#__edit_toolbar");
  const commentBox = root.querySelector("#__edit_commentbox");
  const tableMenu = root.querySelector("#__edit_tablemenu");
  const sidebar = root.querySelector("#__edit_sidebar");
  const svgEditor = root.querySelector("#__edit_svgeditor");

  Object.assign(dom, {
    root,
    hoverBox:    root.querySelector("#__edit_hover"),
    rowHandle:   root.querySelector("#__edit_table_row_handle"),
    colHandle:   root.querySelector("#__edit_table_col_handle"),
    addRowZone:  root.querySelector("#__edit_table_add_row"),
    addColZone:  root.querySelector("#__edit_table_add_col"),
    tableDrop:   root.querySelector("#__edit_table_drop"),
    selectBox:   root.querySelector("#__edit_select"),
    dropLine:    root.querySelector("#__edit_drop"),
    toolbar,
    pathEl:      toolbar.querySelector("[data-role=path]"),
    editBtn:     toolbar.querySelector("[data-act=edit]"),
    commentBtn:  toolbar.querySelector("[data-act=comment]"),
    dragBtn:     toolbar.querySelector("[data-act=drag]"),
    duplicateBtn: toolbar.querySelector("[data-act=duplicate]"),
    tableBtn:    toolbar.querySelector("[data-act=table]"),
    undoBtn:     toolbar.querySelector("[data-act=undo]"),
    redoBtn:     toolbar.querySelector("[data-act=redo]"),
    closeBtn:    toolbar.querySelector("[data-act=close]"),
    navPrev:     toolbar.querySelector("[data-act=nav-prev]"),
    navNext:     toolbar.querySelector("[data-act=nav-next]"),
    navParent:   toolbar.querySelector("[data-act=nav-parent]"),
    navChild:    toolbar.querySelector("[data-act=nav-child]"),
    helpOverlay: root.querySelector("#__edit_help"),
    tableMenu,
    commentBox,
    commentTA:   commentBox.querySelector("textarea"),
    svgEditor,
    svgFields:   svgEditor,
    status:      root.querySelector("#__edit_status"),
    sidebar,
    clist:       sidebar.querySelector("#__edit_clist"),
    countEl:     sidebar.querySelector("[data-role=count]"),
    emptyEl:     sidebar.querySelector("[data-role=empty]"),
    hintEl:      sidebar.querySelector("[data-role=hint]"),
    toggleBtn:   sidebar.querySelector('[data-act="toggle"]'),
  });
}

const FLASH_KINDS = new Set(["info", "success", "warning", "error"]);
let flashTimer = 0;
export function flash(msg, { kind = "info", timeout = 2200 } = {}) {
  dom.status.textContent = msg;
  dom.status.dataset.kind = FLASH_KINDS.has(kind) ? kind : "info";
  dom.status.style.opacity = "1";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { dom.status.style.opacity = "0"; }, timeout);
}

export function isOverlay(el) {
  return !!(el && (el.id === "__edit_root"
    || (el.closest && el.closest("#__edit_root"))
    || (el.classList && el.classList.contains("__edit_dot"))));
}

// Bounding rect in document (scroll-relative) coordinates.
export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return {
    top: r.top + window.scrollY,
    left: r.left + window.scrollX,
    width: r.width,
    height: r.height,
  };
}
