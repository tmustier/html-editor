import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor, readCommentsFile } from "./helpers.js";

test.describe("comments", () => {
  test("send a comment from the box; sidecar JSON gets it; sidebar shows it", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("hello world")')
        .getAttribute("data-edit-id");
      await page.evaluate((id) => {
        const el = document.querySelector(`[data-edit-id="${id}"]`);
        window.__edit.select(el);
        window.__edit.startComment();
      }, id);

      await page.locator("#__edit_commentbox textarea").fill("please tighten this");
      await page.locator('#__edit_commentbox [data-act="send"]').click();

      // Sidebar count updates.
      await expect(page.locator('#__edit_sidebar [data-role="count"]'))
        .toHaveText("1");

      // Sidecar JSON has the entry.
      await page.waitForTimeout(120);
      const stored = readCommentsFile(editor.file);
      expect(stored).toHaveLength(1);
      expect(stored[0].comment).toBe("please tighten this");
      expect(stored[0].id).toBe(id);
      expect(stored[0].tag).toBe("p");
    } finally {
      await editor.cleanup();
    }
  });
});
