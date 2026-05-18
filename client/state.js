// Shared mutable state across the editor modules.
//
// Importing this module and reading/writing fields on `state` is the only
// allowed way to share state. Adding a new field means adding it here so the
// full set is visible in one place.
export const state = {
  hovered: null,             // currently hovered editable element (or null)
  selected: null,            // currently selected editable element (or null)
  // Active table selection mode:
  //   null      → single cell (or non-table) selection
  //   "range"   → rectangular multi-cell selection in one table
  //   "row"     → entire row(s) selected (uses tableRange row span if set)
  //   "column"  → entire column(s) selected (uses tableRange col span if set)
  //   "table"   → entire table selected
  tableSelectionMode: null,
  // Active table range. Anchor is the original cell of the selection;
  // focus is the far corner. Range is only meaningful while the selected
  // element is a cell in the same table.
  tableRange: null,          // { table, anchor: {row,col}, focus: {row,col} } | null
  editing: false,            // true while an inline HTML or SVG edit is active
  svgEditing: null,          // SVG edit session object, or null
  dragging: null,            // drag session object (reorder / svg / resize / table-line) or null
  // Pending Excel-style cut: staged source + payload, committed by paste/insert.
  // { kind: "range"|"row"|"column", tableId, source, payload, createdAt } | null
  cut: null,
  hoveredTable: null,        // table currently under cursor for "+" append zones
  mouseX: -1,                // last known viewport mouse position ("+" zone proximity)
  mouseY: -1,
};
