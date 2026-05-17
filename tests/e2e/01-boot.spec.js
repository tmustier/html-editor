import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("editor boots", () => {
  test("loads the overlay, css link, and module script tag", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Editor surface objects exist (root is a 0x0 container; just check attached).
      await expect(page.locator("#__edit_root")).toBeAttached();
      await expect(page.locator("#__edit_toolbar")).toBeAttached();
      await expect(page.locator("#__edit_sidebar")).toBeVisible();

      // Asset routes returned 200.
      const css = await page.locator('link#__edit_css').getAttribute("href");
      expect(css).toMatch(/^\/__editor\/main\.css/);
      const js = await page.locator('script#__edit_js').getAttribute("src");
      expect(js).toMatch(/^\/__editor\/client\/main\.js/);

      // ensure_edit_ids has stamped the doc.
      const ids = await page.locator("[data-edit-id]").count();
      expect(ids).toBeGreaterThan(0);

      // Debug API is exposed.
      const apiMethods = await page.evaluate(() =>
        window.__edit ? Object.keys(window.__edit).sort() : null);
      expect(apiMethods).toContain("select");
      expect(apiMethods).toContain("deselect");
      expect(apiMethods).toContain("undo");
    } finally {
      await editor.cleanup();
    }
  });

  test("static-file route rejects path traversal", async ({ request }) => {
    const editor = await startEditor("minimal.html");
    try {
      const safe = await request.get(
        editor.url + "__editor/client/main.js");
      expect(safe.status()).toBe(200);

      const traversal = await request.get(
        editor.url + "__editor/client/../../etc/passwd");
      expect(traversal.status()).toBe(404);

      const nonJs = await request.get(
        editor.url + "__editor/client/main.css");
      expect(nonJs.status()).toBe(404);
    } finally {
      await editor.cleanup();
    }
  });
});
