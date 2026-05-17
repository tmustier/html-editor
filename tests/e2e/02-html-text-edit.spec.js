import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("HTML inline text editing", () => {
  test("single click on a <p> drops straight into edit mode", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const before = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      expect(before).toBeTruthy();

      await page.locator(`[data-edit-id="${before}"]`).click();
      await expect(page.locator(`[data-edit-id="${before}"]`))
        .toHaveAttribute("contenteditable", "true");
      await expect(page.locator("#__edit_toolbar")).toBeVisible();
      await expect(page.locator("#__edit_toolbar .editing")).toHaveText("editing");
    } finally {
      await editor.cleanup();
    }
  });

  test("clicking inline code edits the containing text box", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const parentId = await page.locator('p:has-text("mixed paragraph")')
        .getAttribute("data-edit-id");
      const codeId = await page.locator('code:has-text("code()")')
        .getAttribute("data-edit-id");
      expect(parentId).toBeTruthy();
      expect(codeId).toBeTruthy();
      expect(parentId).not.toBe(codeId);

      await page.locator('code:has-text("code()")').click();

      const active = await page.evaluate(() => ({
        selectedId: window.__edit.target().id,
        activeId: document.activeElement.getAttribute("data-edit-id"),
        activeTag: document.activeElement.tagName.toLowerCase(),
      }));
      expect(active.selectedId).toBe(parentId);
      expect(active.activeId).toBe(parentId);
      expect(active.activeTag).toBe("p");
      await expect(page.locator(`[data-edit-id="${parentId}"]`))
        .toHaveAttribute("contenteditable", "true");
    } finally {
      await editor.cleanup();
    }
  });

  test("F2 edits the selected text box", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      await page.evaluate((id) => {
        window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
      }, id);
      await page.keyboard.press("F2");

      await expect(page.locator(`[data-edit-id="${id}"]`))
        .toHaveAttribute("contenteditable", "true");
      await expect(page.locator("#__edit_toolbar")).toBeVisible();
      await expect(page.locator("#__edit_toolbar .editing")).toHaveText("editing");
    } finally {
      await editor.cleanup();
    }
  });

  test("edit, commit with Cmd+Enter, and the file on disk is updated", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      const el = page.locator(`[data-edit-id="${id}"]`);
      await el.click();
      await expect(el).toHaveAttribute("contenteditable", "true");

      // Select all and replace.
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("REPLACED VIA EDITOR");
      await page.keyboard.press("Meta+Enter");

      // Wait for save.
      await page.waitForFunction(() =>
        !document.activeElement || !document.activeElement.hasAttribute("contenteditable"));
      await page.waitForTimeout(150);

      const onDisk = editor.readFile();
      expect(onDisk).toContain("REPLACED VIA EDITOR");
      expect(onDisk).not.toContain("Plain paragraph one.");
      expect(onDisk).not.toContain("__edit_pulse");
      await expect(el).not.toHaveClass(/__edit_pulse/);
    } finally {
      await editor.cleanup();
    }
  });

  test("Escape cancels and restores original content", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      const el = page.locator(`[data-edit-id="${id}"]`);
      await el.click();
      await page.keyboard.press("Meta+A");
      await page.keyboard.type("THIS SHOULD BE DROPPED");

      // Headless Chromium fires window blur on page.keyboard.press("Escape")
      // which beats our capture-phase keydown handler. Dispatch the keydown
      // directly to the editable element to test the editor's actual logic,
      // not the headless quirk.
      await el.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent("keydown",
          { key: "Escape", bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(100);

      // File is untouched.
      expect(editor.readFile()).toContain("Plain paragraph one.");
      expect(editor.readFile()).not.toContain("THIS SHOULD BE DROPPED");
      // DOM is restored too.
      await expect(el).toHaveText("Plain paragraph one.");
    } finally {
      await editor.cleanup();
    }
  });

  test("editing a mixed-inline <p> preserves the inline <b>/<code>/<a>", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const mixed = page.locator('p:has-text("mixed paragraph")');
      const id = await mixed.getAttribute("data-edit-id");
      await mixed.click();
      // Append text to the end (don't blow away the inline structure).
      await page.keyboard.press("End");
      await page.keyboard.type(" extra");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(200);

      const onDisk = editor.readFile();
      // ensure_edit_ids stamps every non-skip element including inline tags,
      // so the on-disk markup is <b data-edit-id="...">bold</b> etc. The
      // structural preservation is what matters: tags survive, ordering
      // survives, link href survives, and our "extra" suffix landed.
      expect(onDisk).toMatch(/<b[^>]*>bold<\/b>/);
      expect(onDisk).toMatch(/<code[^>]*>code\(\)<\/code>/);
      expect(onDisk).toMatch(/<a[^>]*href="#"[^>]*>a link<\/a>/);
      expect(onDisk).toMatch(/extra/);
    } finally {
      await editor.cleanup();
    }
  });

  test("structural element (section with multiple <p>) cannot be text-edited", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Find a section with descendants.
      const id = await page.locator("section[data-edit-id]").first()
        .getAttribute("data-edit-id");
      // Programmatically select (clicking would land on a child).
      await page.evaluate((id) => {
        const el = document.querySelector(`[data-edit-id="${id}"]`);
        window.__edit.select(el);
      }, id);

      const target = await page.evaluate(() => {
        const t = window.__edit.target();
        return t && { kind: t.kind, canEditText: t.canEditText };
      });
      expect(target.kind).toBe("html-structural");
      expect(target.canEditText).toBe(false);
    } finally {
      await editor.cleanup();
    }
  });
});
