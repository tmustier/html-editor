// Shared helpers for the e2e suite.
//
// startEditor(fixtureName): copies the fixture to a fresh tempdir, boots a
// python serve.py against it on a free port, returns { url, file, cleanup }.
// Each test gets its own isolated file + server so they're parallel-safe.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(HERE, "fixtures");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
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
          return reject(new Error("server didn't come up at " + url));
        }
        setTimeout(tick, 80);
      }
    };
    tick();
  });
}

export async function startEditor(fixtureName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hce-e2e-"));
  const file = path.join(tmpDir, fixtureName);
  fs.copyFileSync(path.join(FIXTURES, fixtureName), file);
  const port = await freePort();
  const proc = spawn(
    "python3",
    [path.join(PROJECT_ROOT, "serve.py"), file,
     "--port", String(port), "--no-open",
     // Keep comments out of the shared pi-extension bridge so test runs
     // never wake up other live pi sessions.
     "--comments-bridge", "none"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: PROJECT_ROOT,
      env: { ...process.env, HTML_EDITOR_COMMENTS_BRIDGE: "none" },
    },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitForServer(url);
  } catch (e) {
    proc.kill();
    throw new Error("server failed to start: " + stderr, { cause: e });
  }

  return {
    url,
    file,
    tmpDir,
    readFile: () => fs.readFileSync(file, "utf-8"),
    cleanup: async () => {
      proc.kill();
      await new Promise((r) => setTimeout(r, 100));
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {
        // Temp cleanup is best-effort; tests should report the editor failure,
        // not fail because macOS kept a file handle open for a moment.
      }
    },
  };
}

// Wait until window.__edit is ready — the module entrypoint is async.
export async function waitForEditor(page) {
  await page.waitForFunction(() => !!window.__edit && !!window.__edit_loaded);
}

// Synthesise a click on a DOM element from the page side. We use page.evaluate
// to keep clientX/clientY consistent with the element's actual position so
// caret-at-click can resolve correctly.
export async function clickElement(page, selector) {
  // page.click also dispatches a real mouse event; either works. We use
  // page.click for the realism (it also moves the synthetic cursor).
  await page.click(selector);
}

// Read the comments JSON sidecar (.html.comments.json).
export function readCommentsFile(file) {
  const sidecar = file + ".comments.json";
  if (!fs.existsSync(sidecar)) return [];
  return JSON.parse(fs.readFileSync(sidecar, "utf-8"));
}
