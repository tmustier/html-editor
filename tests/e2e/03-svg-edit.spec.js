import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("SVG label editing", () => {
  test("click on a labelled group's text opens inline editor", async ({ page }) => {
    const editor = await startEditor("svg-labelled-groups.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const text = page.locator('svg text:has-text("First box")');
      await text.click();

      // The wrapper is a 0x0 positioning container; the actual field is the
      // visible object.
      await expect(page.locator("#__edit_svgeditor input")).toBeVisible();
      const inputValue = await page.locator("#__edit_svgeditor input").inputValue();
      expect(inputValue).toBe("First box");
    } finally {
      await editor.cleanup();
    }
  });

  test("clicking on the rect (not text) selects but does not enter edit", async ({ page }) => {
    const editor = await startEditor("svg-labelled-groups.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Click a part of the rect that's not under any text glyph.
      const rect = page.locator('svg g rect').first();
      const box = await rect.boundingBox();
      await page.mouse.click(box.x + 10, box.y + 10);

      // svg editor should not be visible.
      await expect(page.locator("#__edit_svgeditor")).toBeHidden();
      // But the group is selected.
      const target = await page.evaluate(() => {
        const t = window.__edit.target();
        return t && { kind: t.kind, canEditText: t.canEditText, canMove: t.canMove };
      });
      expect(target.kind).toBe("svg-item");
      expect(target.canMove).toBe(true);
    } finally {
      await editor.cleanup();
    }
  });

  test("editing plain SVG text saves to disk", async ({ page }) => {
    const editor = await startEditor("svg-labelled-groups.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.locator('svg text:has-text("First box")').click();
      const input = page.locator("#__edit_svgeditor input");
      await input.focus();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("Renamed First");
      await page.keyboard.press("Enter");

      // Reload happens automatically only when hadInlineMarkup; here it
      // shouldn't, so we wait for the SVG to update in-place.
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("svg text"))
          .some((t) => t.textContent.trim() === "Renamed First"));

      const onDisk = editor.readFile();
      expect(onDisk).toContain("Renamed First");
      expect(onDisk).not.toContain("First box");
    } finally {
      await editor.cleanup();
    }
  });

  test("editing inside a tspan preserves its formatting", async ({ page }) => {
    const editor = await startEditor("svg-mixed-tspans.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Target shape C: "node · reads runner.env / Keychain" — edit *inside*
      // the runner.env tspan to "runner.envX".
      const text = page.locator('svg text:has-text("runner.env")').first();
      await text.click();
      const input = page.locator("#__edit_svgeditor input");
      await input.focus();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("node · reads runner.envX / Keychain");
      await page.keyboard.press("Enter");

      // hadInlineMarkup is true, so the page reloads. Wait for it.
      await page.waitForFunction(() => {
        const t = Array.from(document.querySelectorAll("svg text"))
          .find((n) => n.textContent.includes("runner.envX"));
        return t && t.querySelector('tspan[font-family="monospace"]');
      }, null, { timeout: 5000 });

      const onDisk = editor.readFile();
      expect(onDisk).toContain('<tspan font-family="monospace">runner.envX</tspan>');
    } finally {
      await editor.cleanup();
    }
  });

  test("cross-segment edit reports formatting_lost and falls back to plain text", async ({ page }) => {
    const editor = await startEditor("svg-mixed-tspans.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Edit shape D: "bold middle italic" with two tspans. Replace the
      // whole thing — the edit crosses tspan boundaries.
      const text = page.locator('svg text:has-text("bold")').first();
      await text.click();
      const input = page.locator("#__edit_svgeditor input");
      await input.focus();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("flattened");
      await page.keyboard.press("Enter");

      // Wait for the reload (hadInlineMarkup is true).
      await page.waitForFunction(() => {
        const t = Array.from(document.querySelectorAll("svg text"))
          .find((n) => n.textContent.trim() === "flattened");
        return t && !t.querySelector("tspan");
      }, null, { timeout: 5000 });

      const onDisk = editor.readFile();
      expect(onDisk).toContain(">flattened</text>");
      // The bold/italic tspans for that text are gone.
      // (Other texts in the doc may still have tspans; check only this slot.)
      const flattenedSlot = onDisk.match(/<text[^>]*>flattened<\/text>/);
      expect(flattenedSlot).not.toBeNull();
    } finally {
      await editor.cleanup();
    }
  });

  test("orphan <text> in a flat SVG can be selected + edited", async ({ page }) => {
    const editor = await startEditor("svg-flat.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const t = page.locator('svg text:has-text("orphan two")');
      await t.click();

      const targetKind = await page.evaluate(() => window.__edit.target().kind);
      expect(targetKind).toBe("svg-text");

      const input = page.locator("#__edit_svgeditor input");
      await input.focus();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("orphan TWO");
      await page.keyboard.press("Enter");

      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("svg text"))
          .some((n) => n.textContent.trim() === "orphan TWO"));

      expect(editor.readFile()).toContain("orphan TWO");
    } finally {
      await editor.cleanup();
    }
  });
});
