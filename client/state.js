// Shared mutable state across the editor modules.
//
// Importing this module and reading/writing fields on `state` is the only
// allowed way to share state. Adding a new field means adding it here so the
// full set is visible in one place.
export const state = {
  hovered: null,             // currently hovered editable element (or null)
  selected: null,            // currently selected editable element (or null)
  editing: false,            // true while an inline HTML or SVG edit is active
  svgEditing: null,          // SVG edit session object, or null
  dragging: null,            // drag session object (reorder / svg / resize) or null
  suppressClickUntil: 0,     // Date.now() until which clicks should be ignored
                             // (used to guard against synthetic click after drag/resize)
};
