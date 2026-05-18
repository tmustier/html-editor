// All fetch() calls live here. One module = one place to add retries,
// cancellation, or request timing.
//
// Every wrapper returns the parsed JSON on success. On HTTP error or network
// error, it throws an Error whose `.message` is suitable for surfacing to the
// user via flash().

import { ENDPOINTS } from "./config.js";

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("network error");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function getJson(path) {
  let res;
  try {
    res = await fetch(path);
  } catch (e) {
    throw new Error("network error");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  saveText: (id, text, html) =>
    postJson(ENDPOINTS.saveText, { id, text, html }),
  saveTextMany: (updates) =>
    postJson(ENDPOINTS.saveTextMany, { updates }),
  saveSvgLabels: (id, lines) =>
    postJson(ENDPOINTS.saveSvgLabels, { id, lines }),
  moveElement: (id, target_id, position) =>
    postJson(ENDPOINTS.moveElement, { id, target_id, position }),
  moveSvg: (id, translate_x, translate_y) =>
    postJson(ENDPOINTS.moveSvg, { id, translate_x, translate_y }),
  resizeElement: (id, body) =>
    postJson(ENDPOINTS.resizeElement, { id, ...body }),
  tableOperation: (cell_id, action, extra = {}) =>
    postJson(ENDPOINTS.tableOperation, { cell_id, action, ...extra }),
  duplicateElement: (id) =>
    postJson(ENDPOINTS.duplicateElement, { id }),
  undo: () => postJson(ENDPOINTS.undo, {}),
  redo: () => postJson(ENDPOINTS.redo, {}),
  comment: (id, comment, excerpt, tag) =>
    postJson(ENDPOINTS.comment, { id, comment, excerpt, tag }),
  listComments: () => getJson(ENDPOINTS.listComments),
};
