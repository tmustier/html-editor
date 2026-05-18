import { test, expect } from "@playwright/test";
import { startEditor, waitForEditor } from "./helpers.js";
import {
  cmdArrow,
  expectNoReload,
  persistedFirstTableRows,
  rangeBounds,
  rangeCellTexts,
  readCellText,
  selectCell,
  selectedText,
  setReloadMarker,
} from "./table-helpers.js";

test.describe("table structure operations", () => {
  test("toolbar table menu inserts rows and restores selection without reload", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Epsilon");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      await expect(page.locator("#__edit_tablemenu")).toBeVisible();
      const marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="row-insert-after"]').click();

      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      await expectNoReload(page, marker);
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
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
      expect(editor.readFile()).toMatch(/<td data-edit-id="e\d+"><\/td>/);
    } finally {
      await editor.cleanup();
    }
  });

  test("row insert patch handles direct <tr> children without reloading", async ({ page }) => {
    const editor = await startEditor("table-direct-rows.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "B");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      const marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="row-insert-after"]').click();
      await page.waitForFunction(() => document.querySelectorAll('table[data-edit-id="d2"] tr').length === 3);
      await expectNoReload(page, marker);
      const rows = await page.locator('table[data-edit-id="d2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["A", "B"],
        ["", ""],
        ["C", "D"],
      ]);
      expect(await selectedText(page)).toBe("");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
      expect(editor.readFile()).toMatch(/data-edit-id="e\d+"/);
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
      const marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="col-insert-before"]').click();

      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 4);
      await expectNoReload(page, marker);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "", "Beta", "Gamma"],
        ["Delta", "", "Epsilon", "Zeta"],
        ["Eta", "", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
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
      let marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="row-delete"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 2);
      await expectNoReload(page, marker);
      let rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Eta", "Theta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("Theta");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);

      // v0.1.6: row + Ctrl+Space promotes to whole-table mode. To switch to
      // column mode we step back to the cell first, then Ctrl+Space.
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe(null);
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="col-delete"]').click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 2);
      await expectNoReload(page, marker);
      rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Gamma"],
        ["Eta", "Iota"],
      ]);
      expect(await selectedText(page)).toBe("Iota");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
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

      // v0.1.6: step out of row mode before promoting to column.
      await page.keyboard.press("Escape");
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

  test("+ zone on table's right edge appends a column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Epsilon");
      // Hover over a cell so the "+" zones arm via proximity.
      await page.locator('td:text-is("Epsilon")').hover();
      await expect(page.locator("#__edit_table_add_col")).toHaveAttribute("data-visible", "true");
      const marker = await setReloadMarker(page);
      await page.locator("#__edit_table_add_col").click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 4);
      await expectNoReload(page, marker);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma", ""],
        ["Delta", "Epsilon", "Zeta", ""],
        ["Eta", "Theta", "Iota", ""],
      ]);
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("hovering an unselected table arms the + zones and click adds a column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      // Nothing selected. Hover into the second table's cell; zones should arm.
      await page.locator('td:text-is("Status A")').hover();
      await expect(page.locator("#__edit_table_add_col")).toHaveAttribute("data-visible", "true");
      // Travel out of the cell and onto the column zone without first
      // re-entering the table; the zone should stay armed.
      await page.locator("#__edit_table_add_col").click();
      await page.waitForFunction(() =>
        document.querySelector('table[data-edit-id="e18"] tr')?.cells.length === 3);
      const rows = await page.locator('table[data-edit-id="e18"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows[0][2]).toBe("");
      expect(rows[1][2]).toBe("");
    } finally {
      await editor.cleanup();
    }
  });

  test("+ zone on table's bottom edge appends a row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Epsilon");
      await page.locator('td:text-is("Epsilon")').hover();
      await expect(page.locator("#__edit_table_add_row")).toHaveAttribute("data-visible", "true");
      const marker = await setReloadMarker(page);
      await page.locator("#__edit_table_add_row").click();
      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      await expectNoReload(page, marker);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Iota"],
        ["", "", ""],
      ]);
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("structural table ops cancel a staged cut before replacing the table", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Meta+X");
      await page.waitForFunction(() => window.__edit.cut()?.kind === "row");
      await selectCell(page, "Alpha");
      await page.locator('#__edit_toolbar [data-act="table"]').click();
      const marker = await setReloadMarker(page);
      await page.locator('#__edit_tablemenu [data-table-act="row-insert-after"]').click();
      await page.waitForFunction(() => document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      await expectNoReload(page, marker);
      expect(await page.evaluate(() => window.__edit.cut())).toBeNull();
      await expect(page.locator("#__edit_cut")).toBeHidden();
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+Shift+= inserts a row before the selected row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Epsilon");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Control+Shift+Equal");
      await page.waitForFunction(() =>
        window.__edit && document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["", "", ""],
        ["Delta", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Iota"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+- deletes the selected column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Control+Minus");
      await page.waitForFunction(() =>
        window.__edit && document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 2);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Gamma"],
        ["Delta", "Zeta"],
        ["Eta", "Iota"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("dragging the column handle reorders the column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      // Pick the middle column (Beta) and drag its top handle onto the
      // Gamma column so it should land on the right.
      await selectCell(page, "Beta");
      const handle = page.locator("#__edit_table_col_handle");
      const gammaCell = page.locator('td:text-is("Gamma")');
      const start = await handle.boundingBox();
      const target = await gammaCell.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      // Move slightly off-handle to trigger the drag threshold.
      await page.mouse.move(start.x + start.width / 2 + 6, start.y + start.height / 2 + 6);
      await page.mouse.move(target.x + target.width - 6, target.y + target.height / 2);
      await page.mouse.up();

      await page.waitForFunction(() =>
        document.querySelector('table[data-edit-id="e2"] tr')?.cells[2]?.textContent.trim() === "Beta");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Gamma", "Beta"],
        ["Delta", "Zeta", "Epsilon"],
        ["Eta", "Iota", "Theta"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("dragging the row handle reorders the row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);

      await selectCell(page, "Alpha");
      const handle = page.locator("#__edit_table_row_handle");
      const etaCell = page.locator('td:text-is("Eta")');
      const start = await handle.boundingBox();
      const target = await etaCell.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 6, start.y + start.height / 2 + 6);
      await page.mouse.move(target.x + target.width / 2, target.y + target.height - 4);
      await page.mouse.up();

      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('table[data-edit-id="e2"] tr'))
          .map((tr) => tr.cells[0].textContent.trim())
          .join(",") === "Delta,Eta,Alpha");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Delta", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Iota"],
        ["Alpha", "Beta", "Gamma"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("row-move-to via API reorders rows and restores selection", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      const id = await page.locator('td:text-is("Delta")').getAttribute("data-edit-id");
      await page.evaluate(() => { window.__moveReloadMarker = crypto.randomUUID(); });
      const marker = await page.evaluate(() => window.__moveReloadMarker);
      // Drive the move-to action directly via the public client API.
      await page.evaluate(async ({ id }) => {
        const mod = await import("/__editor/client/tabledrag.js");
        await mod.runMoveTo("row", id, 2, "after");
      }, { id });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('table[data-edit-id="e2"] tr'))
          .map((tr) => tr.cells[0].textContent.trim())
          .join(",") === "Alpha,Eta,Delta");
      await waitForEditor(page);
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => window.__moveReloadMarker)).toBe(marker);
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      expect(persistedFirstTableRows(editor.readFile())).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Eta", "Theta", "Iota"],
        ["Delta", "Epsilon", "Zeta"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("col-move-to via API reorders columns and restores column selection", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      const id = await page.locator('td:text-is("Gamma")').getAttribute("data-edit-id");
      await page.evaluate(() => { window.__moveReloadMarker = crypto.randomUUID(); });
      const marker = await page.evaluate(() => window.__moveReloadMarker);
      await page.evaluate(async ({ id }) => {
        const mod = await import("/__editor/client/tabledrag.js");
        await mod.runMoveTo("column", id, 0, "before");
      }, { id });
      await page.waitForFunction(() =>
        document.querySelector('table[data-edit-id="e2"] tr')?.cells[0]?.textContent.trim() === "Gamma");
      await waitForEditor(page);
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => window.__moveReloadMarker)).toBe(marker);
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      expect(persistedFirstTableRows(editor.readFile())).toEqual([
        ["Gamma", "Alpha", "Beta"],
        ["Zeta", "Delta", "Epsilon"],
        ["Iota", "Eta", "Theta"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  // -----------------------------------------------------------------------
  // v0.1.6: Excel-style cell range selection + row/column promotion
  // -----------------------------------------------------------------------

  async function rangeBounds(page) {
    return await page.evaluate(() => window.__edit.tableRange());
  }
});
