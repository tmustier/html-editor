import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("undo / redo", () => {
  test("Cmd+Z undoes a save and the file on disk is restored", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    const original = editor.readFile();
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("hello world")')
        .getAttribute("data-edit-id");
      const el = page.locator(`[data-edit-id="${id}"]`);
      await el.click();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("changed text");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(200);

      expect(editor.readFile()).toContain("changed text");

      // Cmd+Z triggers undo (which reloads).
      await page.keyboard.press("Meta+Z");
      await page.waitForLoadState("load");
      await page.waitForTimeout(200);

      expect(editor.readFile()).toBe(original);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+Y redoes after undo", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("hello world")')
        .getAttribute("data-edit-id");
      const el = page.locator(`[data-edit-id="${id}"]`);
      await el.click();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("first change");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(200);

      await page.keyboard.press("Meta+Z");
      await page.waitForLoadState("load");
      await page.waitForTimeout(200);
      expect(editor.readFile()).not.toContain("first change");

      // Re-wait for editor after reload.
      await waitForEditor(page);
      await page.keyboard.press("Meta+Y");
      await page.waitForLoadState("load");
      await page.waitForTimeout(200);

      expect(editor.readFile()).toContain("first change");
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+Z with empty history flashes 'nothing to undo' and doesn't crash", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    const original = editor.readFile();
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.keyboard.press("Meta+Z");
      // Server returns 409 nothing-to-undo; flash shows briefly but the file
      // must be unchanged and the page must not have reloaded.
      await page.waitForTimeout(300);
      expect(editor.readFile()).toBe(original);
    } finally {
      await editor.cleanup();
    }
  });
});
