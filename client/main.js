// Editor entrypoint. The server injects:
//   <link rel="stylesheet" href="/__editor/main.css?v=...">
//   <script type="module" src="/__editor/client/main.js?v=..."></script>
//
// This file orchestrates the boot sequence: build DOM, wire events, start
// runtime loops. Everything else is a pure module.

import { initDom } from "./dom.js";
import { initEvents } from "./events.js";
import { initRuntime } from "./init.js";
import { initSidebarButtons } from "./comments.js";

if (!window.__edit_loaded) {
  window.__edit_loaded = true;
  initDom();
  initEvents();
  initSidebarButtons();
  initRuntime();
}
