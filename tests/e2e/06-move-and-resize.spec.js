// HTML reorder, SVG spatial move, and HTML resize all hit the server via
// drag interactions. The drag math itself is tricky to simulate reliably
// across Playwright drivers, so these tests exercise the endpoints directly
// while also covering one end-to-end drag with a deliberate slow path.

import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("move + resize", () => {
  test("/move-element via direct fetch reorders the file", async ({ page, request }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Get the section's two child paragraph ids.
      const ids = await page.evaluate(() => {
        const section = document.querySelector("section[data-edit-id]");
        return Array.from(section.querySelectorAll("p[data-edit-id]"))
          .map((p) => p.getAttribute("data-edit-id"));
      });
      expect(ids).toHaveLength(2);
      const [first, second] = ids;

      // Move first paragraph after second.
      const res = await request.post(editor.url + "move-element", {
        data: { id: first, target_id: second, position: "after" },
      });
      expect(res.status()).toBe(200);

      const onDisk = editor.readFile();
      const firstIdx = onDisk.indexOf(`data-edit-id="${first}"`);
      const secondIdx = onDisk.indexOf(`data-edit-id="${second}"`);
      expect(firstIdx).toBeGreaterThan(secondIdx);
    } finally {
      await editor.cleanup();
    }
  });

  test("/move-svg adds a translate to a labelled group", async ({ page, request }) => {
    const editor = await startEditor("svg-labelled-groups.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator("svg g[data-edit-id]").first()
        .getAttribute("data-edit-id");
      const res = await request.post(editor.url + "move-svg", {
        data: { id, translate_x: 42.5, translate_y: -8 },
      });
      expect(res.status()).toBe(200);

      const onDisk = editor.readFile();
      expect(onDisk).toMatch(/transform="translate\(42\.50 -8\.00\)"/);
    } finally {
      await editor.cleanup();
    }
  });

  test("/resize-element writes inline width + max-width:none", async ({ page, request }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator("section[data-edit-id]").first()
        .getAttribute("data-edit-id");
      const res = await request.post(editor.url + "resize-element", {
        data: { id, width: "240px", height: "120px",
                max_width: "none", max_height: "none" },
      });
      expect(res.status()).toBe(200);

      const onDisk = editor.readFile();
      // Find the section with our id and verify its style.
      const m = onDisk.match(new RegExp(
        `<section[^>]*data-edit-id="${id}"[^>]*>`));
      expect(m).not.toBeNull();
      expect(m[0]).toContain("width: 240px");
      expect(m[0]).toContain("height: 120px");
      expect(m[0]).toContain("max-width: none");
    } finally {
      await editor.cleanup();
    }
  });

  test("HTML reorder drag persists the move to disk", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Get ids of the section's two paragraphs.
      const ids = await page.evaluate(() => {
        const section = document.querySelector("section[data-edit-id]");
        return Array.from(section.querySelectorAll("p[data-edit-id]"))
          .map((p) => p.getAttribute("data-edit-id"));
      });
      const [first, second] = ids;

      // Select the first without entering text-edit mode (single-click on a
      // text target intentionally starts editing now).
      await page.evaluate((id) => {
        window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
      }, first);

      const handle = page.locator('#__edit_toolbar [data-act="drag"]');
      await expect(handle).toBeVisible();
      const handleBox = await handle.boundingBox();
      const secondP = page.locator(`[data-edit-id="${second}"]`);
      const targetBox = await secondP.boundingBox();

      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height * 0.8,
        { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);

      const onDisk = editor.readFile();
      const firstIdx = onDisk.indexOf(`data-edit-id="${first}"`);
      const secondIdx = onDisk.indexOf(`data-edit-id="${second}"`);
      // The drop fell on the lower half of the second paragraph → "after".
      expect(firstIdx).toBeGreaterThan(secondIdx);
    } finally {
      await editor.cleanup();
    }
  });
});
