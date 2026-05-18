#!/usr/bin/env node
// Browser-side performance benchmark for table operations.
//
// Measures the user-visible pieces that the Python-only benchmark cannot see:
// API roundtrip time plus reload-free browser DOM application latency for
// table insert and move operations.

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const ROWS = Number(arg("rows", "120"));
const COLS = Number(arg("cols", "30"));
const RUNS = Number(arg("runs", "5"));
const HEADED = process.argv.includes("--headed");

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p95(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url + "healthz", (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      function retry() {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("server didn't come up at " + url));
        } else {
          setTimeout(tick, 50);
        }
      }
    };
    tick();
  });
}

function fixtureHtml(rows, cols) {
  const body = [];
  body.push("<!doctype html><html><head><meta charset=\"utf-8\"><title>bench</title>");
  body.push("<style>body{font-family:system-ui;margin:24px}td{padding:2px 6px;border:1px solid #ddd}</style>");
  body.push("</head><body><h1 data-edit-id=\"title\">Bench fixture</h1><table data-edit-id=\"bench-table\"><tbody>");
  for (let r = 0; r < rows; r += 1) {
    body.push("<tr>");
    for (let c = 0; c < cols; c += 1) {
      body.push(`<td data-edit-id=\"cell-${r}-${c}\">R${r}C${c}</td>`);
    }
    body.push("</tr>");
  }
  body.push("</tbody></table></body></html>");
  return body.join("");
}

async function startEditor() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hce-browser-bench-"));
  const file = path.join(tmpDir, "bench.html");
  fs.writeFileSync(file, fixtureHtml(ROWS, COLS));
  const port = await freePort();
  const proc = spawn("python3", [
    path.join(PROJECT_ROOT, "serve.py"), file,
    "--port", String(port), "--no-open", "--comments-bridge", "none",
  ], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HTML_EDITOR_COMMENTS_BRIDGE: "none" },
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitForServer(url);
  } catch (err) {
    proc.kill();
    throw new Error(`${err.message}\n${stderr}`);
  }
  return {
    url,
    cleanup: async () => {
      proc.kill();
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function waitForEditor(page) {
  await page.waitForFunction(() => !!window.__edit && !!window.__edit_loaded);
}

async function freshPage(browser) {
  const editor = await startEditor();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(editor.url);
  await waitForEditor(page);
  return { page, editor };
}

async function timeSample(browser, fn) {
  const { page, editor } = await freshPage(browser);
  try {
    return await fn(page);
  } finally {
    await page.close();
    await editor.cleanup();
  }
}

async function insertWithSnapshot(page, action, axis) {
  const marker = crypto.randomUUID();
  const id = `cell-${Math.floor(ROWS / 2)}-${Math.floor(COLS / 2)}`;
  await page.evaluate((marker) => { window.__benchReloadMarker = marker; }, marker);
  const sample = await page.evaluate(async ({ id, action, axis }) => {
    const { api } = await import("/__editor/client/api.js");
    const { applyTableSnapshot } = await import("/__editor/client/tableops.js");
    const t0 = performance.now();
    const result = await api.tableOperation(id, action, { include_table_html: true });
    const apiMs = performance.now() - t0;
    const t1 = performance.now();
    const applied = applyTableSnapshot(result, axis);
    const applyMs = performance.now() - t1;
    if (!applied) throw new Error(`${action} table snapshot apply failed`);
    return { apiMs, applyMs, totalMs: apiMs + applyMs };
  }, { id, action, axis });
  await page.waitForTimeout(350);
  const persistedMarker = await page.evaluate(() => window.__benchReloadMarker);
  if (persistedMarker !== marker) throw new Error(`${action} unexpectedly reloaded the page`);
  return { ...sample, reloadMs: 0 };
}

async function moveWithoutReload(page, axis) {
  const marker = crypto.randomUUID();
  const sourceId = axis === "row" ? "cell-0-0" : "cell-0-0";
  const targetIndex = axis === "row" ? ROWS - 1 : COLS - 1;
  await page.evaluate((marker) => { window.__benchReloadMarker = marker; }, marker);
  const t0 = performance.now();
  const ok = await page.evaluate(async ({ axis, sourceId, targetIndex }) => {
    const { runMoveTo } = await import("/__editor/client/tabledrag.js");
    return await runMoveTo(axis, sourceId, targetIndex, "after");
  }, { axis, sourceId, targetIndex });
  const totalMs = performance.now() - t0;
  // runMoveTo's historical fallback reload used a 200ms delay. Wait past that
  // before declaring the path reload-free.
  await page.waitForTimeout(350);
  const persistedMarker = await page.evaluate(() => window.__benchReloadMarker);
  if (!ok) throw new Error(`${axis} move failed`);
  if (persistedMarker !== marker) throw new Error(`${axis} move unexpectedly reloaded the page`);
  return { totalMs, apiMs: totalMs, reloadMs: 0 };
}

const ops = [
  ["row-insert-after snapshot", (page) => insertWithSnapshot(page, "row-insert-after", "row")],
  ["col-insert-after snapshot", (page) => insertWithSnapshot(page, "col-insert-after", "column")],
  ["row-move-to client-dom", (page) => moveWithoutReload(page, "row")],
  ["col-move-to client-dom", (page) => moveWithoutReload(page, "column")],
];

const browser = await chromium.launch({ headless: !HEADED });
try {
  console.log(`Browser table benchmark: ${ROWS}x${COLS}, ${RUNS} run(s)`);
  console.log("operation                         median total   p95 total   median api   median reload");
  for (const [name, fn] of ops) {
    const samples = [];
    for (let i = 0; i < RUNS; i += 1) {
      samples.push(await timeSample(browser, fn));
    }
    const totals = samples.map((s) => s.totalMs);
    const apis = samples.map((s) => s.apiMs);
    const reloads = samples.map((s) => s.reloadMs);
    console.log(
      name.padEnd(34)
      + `${median(totals).toFixed(1).padStart(8)} ms`
      + `${p95(totals).toFixed(1).padStart(10)} ms`
      + `${median(apis).toFixed(1).padStart(11)} ms`
      + `${median(reloads).toFixed(1).padStart(14)} ms`,
    );
  }
} finally {
  await browser.close();
}
