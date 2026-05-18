import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";

test.describe("keyboard navigation + adversarial flows", () => {
  async function selectCell(page, text) {
    const id = await page.locator(`td:has-text("${text}")`).first()
      .getAttribute("data-edit-id");
    await page.evaluate((id) => {
      window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
    }, id);
  }

  async function selectedText(page) {
    return await page.evaluate(() =>
      (window.__edit.target()?.el?.textContent || "").trim());
  }

  async function cmdArrow(page, key) {
    await page.keyboard.down("Meta");
    await page.keyboard.press(key);
    await page.keyboard.up("Meta");
  }

  test("Option+Arrow walks siblings + into children", async ({ page }) => {
    const editor = await startEditor("deep-nesting.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Select an article.
      const firstArticleId = await page.locator('article[data-edit-id]').first()
        .getAttribute("data-edit-id");
      await page.evaluate((id) => {
        window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
      }, firstArticleId);

      // Option+Down → first editable child of the article.
      await page.keyboard.press("Alt+ArrowDown");
      const child = await page.evaluate(() => window.__edit.target().id);
      expect(child).not.toBe(firstArticleId);
      // Should be the h2 or the first p.
      const childTag = await page.locator(`[data-edit-id="${child}"]`)
        .evaluate((el) => el.tagName.toLowerCase());
      expect(["h2", "p"]).toContain(childTag);

      // Option+Up returns to a parent.
      await page.keyboard.press("Alt+ArrowUp");
      const parent = await page.evaluate(() => window.__edit.target().id);
      expect(parent).toBe(firstArticleId);

      // Option+Right moves to the next article.
      await page.keyboard.press("Alt+ArrowRight");
      const next = await page.evaluate(() => window.__edit.target().id);
      expect(next).not.toBe(firstArticleId);
    } finally {
      await editor.cleanup();
    }
  });

  test("plain arrows navigate table grids while Option+Arrow keeps structural nav", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.keyboard.press("ArrowUp");
      expect(await selectedText(page)).toBe("Beta");
      await page.keyboard.press("ArrowDown");
      expect(await selectedText(page)).toBe("Epsilon");
      await page.keyboard.press("ArrowLeft");
      expect(await selectedText(page)).toBe("Delta");
      await page.keyboard.press("ArrowRight");
      expect(await selectedText(page)).toBe("Epsilon");

      await page.keyboard.press("Alt+ArrowUp");
      const structuralTag = await page.evaluate(() =>
        window.__edit.target()?.el?.tagName.toLowerCase());
      expect(structuralTag).toBe("tr");
    } finally {
      await editor.cleanup();
    }
  });

  test("grid arrow misses stay quiet and Cmd+Arrow jumps to row or column edge", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await cmdArrow(page, "ArrowRight");
      expect(await selectedText(page)).toBe("Zeta");
      await cmdArrow(page, "ArrowLeft");
      expect(await selectedText(page)).toBe("Delta");
      await cmdArrow(page, "ArrowDown");
      expect(await selectedText(page)).toBe("Eta");
      await cmdArrow(page, "ArrowUp");
      expect(await selectedText(page)).toBe("Alpha");

      await page.keyboard.press("ArrowLeft");
      expect(await selectedText(page)).toBe("Alpha");
      await expect(page.locator("#__edit_status")).not.toHaveText(/No grid cell/i);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+C and Cmd+V copy/paste selected table cells and persist", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Alpha");
      await page.keyboard.press("Meta+C");
      await expect(page.locator("#__edit_commentbox")).toBeHidden();
      await selectCell(page, "Epsilon");
      await page.keyboard.press("Meta+V");

      await page.waitForFunction(() =>
        (window.__edit.target()?.el?.textContent || "").trim() === "Alpha");
      await expect.poll(() => editor.readFile()).toContain(">Alpha</td><td data-edit-id=\"e11\">Zeta");
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+V preserves copied status badge markup", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "SHIPPED");
      await page.keyboard.press("Meta+C");
      await selectCell(page, "PARTIAL");
      await page.keyboard.press("Meta+V");

      await page.waitForFunction(() =>
        (window.__edit.target()?.el?.textContent || "").trim() === "SHIPPED");
      const html = await page.evaluate(() => window.__edit.target().el.innerHTML);
      expect(html).toContain('class="status-badge shipped"');
      expect(html).not.toContain("data-edit-id");
      await expect.poll(() => editor.readFile())
        .toContain('class="status-badge shipped">SHIPPED</span>');
    } finally {
      await editor.cleanup();
    }
  });

  test("plain-text paste into a badge cell preserves the badge wrapper", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.evaluate(() => navigator.clipboard.writeText("SHIPPED"));
      await selectCell(page, "PARTIAL");
      await page.keyboard.press("Meta+V");

      await page.waitForFunction(() =>
        (window.__edit.target()?.el?.textContent || "").trim() === "SHIPPED");
      const html = await page.evaluate(() => window.__edit.target().el.innerHTML);
      expect(html).toContain('class="status-badge shipped"');
      await expect.poll(() => editor.readFile())
        .toContain('class="status-badge shipped">SHIPPED</span>');
    } finally {
      await editor.cleanup();
    }
  });

  test("Excel-style range paste fills table cells and clips at existing bounds", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.evaluate(() => navigator.clipboard.writeText(
        "One\tTwo\tOverflow\nThree\tFour\tOverflow\nOverflow\tOverflow\tOverflow"));
      await selectCell(page, "Epsilon");
      await page.keyboard.press("Meta+V");

      await page.waitForFunction(() =>
        (window.__edit.target()?.el?.textContent || "").trim() === "One");
      const cells = await page.locator('table[data-edit-id="e2"] td').evaluateAll((tds) =>
        tds.map((td) => td.textContent.trim()));
      expect(cells).toEqual([
        "Alpha", "Beta", "Gamma",
        "Delta", "One", "Two",
        "Eta", "Three", "Four",
      ]);
      await expect(page.locator("#__edit_status")).toContainText("Pasted 4 table cells");
      const persisted = editor.readFile();
      expect(persisted).toContain('<td data-edit-id="e10">One</td>');
      expect(persisted).toContain('<td data-edit-id="e11">Two</td>');
      expect(persisted).toContain('<td data-edit-id="e14">Three</td>');
      expect(persisted).toContain('<td data-edit-id="e15">Four</td>');
      expect(persisted).not.toContain("Overflow</td>");
    } finally {
      await editor.cleanup();
    }
  });

  test("Shift+Space, Ctrl+Space, and handles select table rows/columns", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await expect(page.locator("#__edit_table_row_handle")).toBeVisible();
      await expect(page.locator("#__edit_table_col_handle")).toBeVisible();

      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await expect(page.locator('#__edit_tablemenu [data-table-act="row-delete"]')).toBeVisible();
      await expect(page.locator('#__edit_tablemenu [data-table-act="col-delete"]')).toBeHidden();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe(null);

      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe(null);

      await page.locator("#__edit_table_row_handle").click();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.locator("#__edit_table_col_handle").click();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");

      await selectCell(page, "Beta");
      await page.locator("#__edit_table_col_handle").click();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
    } finally {
      await editor.cleanup();
    }
  });

  test("toolbar table menu inserts rows and restores selection after reload", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await expect(page.locator("#__edit_tablemenu")).toBeVisible();
      await page.locator('#__edit_tablemenu [data-table-act="row-insert-after"]').click();

      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
        ["", "", ""],
        ["Eta", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      expect(editor.readFile()).toMatch(/<td data-edit-id="e\d+"><\/td>/);
    } finally {
      await editor.cleanup();
    }
  });

  test("toolbar table menu inserts columns at the selected cell", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="col-insert-before"]').click();

      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 4);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "", "Beta", "Gamma"],
        ["Delta", "", "Epsilon", "Zeta"],
        ["Eta", "", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
    } finally {
      await editor.cleanup();
    }
  });

  test("toolbar table menu deletes rows and columns", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="row-delete"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 2);
      let rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Eta", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("Theta");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");

      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="col-delete"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 2);
      rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Gamma"],
        ["Eta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("Iota");
    } finally {
      await editor.cleanup();
    }
  });

  test("toolbar table menu reorders rows and columns", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="row-move-up"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] td')?.textContent.trim() === "Delta");
      let rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Delta", "Epsilon", "Zeta"],
        ["Alpha", "Beta", "Gamma"],
        ["Eta", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("Epsilon");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");

      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="col-move-right"]').click();
      await page.waitForFunction(() =>
        window.__edit && Array.from(document.querySelector('table[data-edit-id="e2"] tr').cells)
          .map((td) => td.textContent.trim()).join("|") === "Delta|Zeta|Epsilon");
      rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Delta", "Zeta", "Epsilon"],
        ["Alpha", "Gamma", "Beta"],
        ["Eta", "Iota", "Theta"],
      ]);
      expect(await selectedText(page)).toBe("Epsilon");
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+Z undoes inserted columns even from a pristine blank cell edit", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await page.locator('#__edit_tablemenu [data-table-act="col-insert-before"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 4);

      const blankCell = page.locator('table[data-edit-id="e2"] tr').nth(1).locator("td").nth(1);
      await blankCell.click();
      await expect(blankCell).toHaveAttribute("contenteditable", "true");
      await page.keyboard.press("Meta+Z");

      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 3);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Iota"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("toolbar duplicate clones an element with fresh edit ids", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.evaluate(() => {
        window.__edit.select(document.querySelector('[data-edit-id="e1"]'));
      });
      await page.locator('#__edit_toolbar [data-act="duplicate"]').click();

      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll("p").length === 3);
      const texts = await page.locator("body > p").evaluateAll((ps) =>
        ps.map((p) => p.textContent.trim()));
      expect(texts).toEqual(["hello world", "hello world", "second paragraph"]);
      const ids = await page.locator("body > p").evaluateAll((ps) =>
        ps.map((p) => p.getAttribute("data-edit-id")));
      expect(new Set(ids).size).toBe(3);
      expect(ids[1]).not.toBe("e1");
      expect(await selectedText(page)).toBe("hello world");
    } finally {
      await editor.cleanup();
    }
  });

  test("Tab and Shift+Tab walk table cells, including from edit mode", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Gamma");
      await page.keyboard.press("Tab");
      expect(await selectedText(page)).toBe("Delta");
      await page.keyboard.press("Shift+Tab");
      expect(await selectedText(page)).toBe("Gamma");

      await selectCell(page, "Alpha");
      await page.keyboard.press("F2");
      await page.keyboard.type(" changed");
      await page.keyboard.press("Tab");
      await page.waitForFunction(() =>
        (window.__edit.target()?.el?.textContent || "").trim() === "Beta");
      expect(await page.evaluate(() =>
        !!document.querySelector('[contenteditable="true"]'))).toBe(false);
      await expect.poll(() => editor.readFile()).toContain("Alpha changed");
    } finally {
      await editor.cleanup();
    }
  });

  test("Escape cascades: comment → help → deselect", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      await page.evaluate((id) => {
        window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
      }, id);

      // Open help; Esc should close help.
      await page.keyboard.press("?");
      await expect(page.locator("#__edit_help")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#__edit_help")).toBeHidden();

      // Open comment box; Esc should close it (not deselect).
      await page.evaluate(() => window.__edit.startComment());
      await expect(page.locator("#__edit_commentbox")).toBeVisible();
      await page.locator("#__edit_commentbox textarea").focus();
      await page.keyboard.press("Escape");
      await expect(page.locator("#__edit_commentbox")).toBeHidden();
      const stillSelected = await page.evaluate(() =>
        !!window.__edit.target());
      expect(stillSelected).toBe(true);

      // Esc again deselects.
      await page.keyboard.press("Escape");
      const cleared = await page.evaluate(() =>
        window.__edit.target() === null);
      expect(cleared).toBe(true);
    } finally {
      await editor.cleanup();
    }
  });

  test("clicking outside any editable deselects", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const id = await page.locator('p:has-text("hello world")')
        .getAttribute("data-edit-id");
      await page.evaluate((id) => {
        window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
      }, id);
      expect(await page.evaluate(() => !!window.__edit.target())).toBe(true);

      // Click far from any p — on the document/body itself.
      await page.mouse.click(5, 5);
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => window.__edit.target() === null)).toBe(true);
    } finally {
      await editor.cleanup();
    }
  });

  test("rapid double-click doesn't double-enter edit (no error)", async ({ page }) => {
    const editor = await startEditor("rich-text.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));

      const id = await page.locator('p:has-text("Plain paragraph one.")').first()
        .getAttribute("data-edit-id");
      const el = page.locator(`[data-edit-id="${id}"]`);
      await el.dblclick();
      await el.dblclick();
      await page.waitForTimeout(150);

      // Editor still functional.
      const editing = await page.evaluate(() => {
        const el = document.activeElement;
        return el && el.getAttribute("contenteditable") === "true";
      });
      expect(editing).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await editor.cleanup();
    }
  });

  test("the help table mentions all the visible keyboard shortcuts", async ({ page }) => {
    const editor = await startEditor("minimal.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await page.keyboard.press("?");
      const help = page.locator("#__edit_help");
      await expect(help).toBeVisible();
      await expect(help).toContainText("Cmd");
      await expect(help).toContainText("Esc");
      await expect(help).toContainText("Option");
      await expect(help).toContainText("Enter");
    } finally {
      await editor.cleanup();
    }
  });
});
