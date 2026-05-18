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

test.describe("table row/column transfer operations", () => {
  test("Excel-style Cmd+X / Cmd+V on rows moves the row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.keyboard.press("Meta+X");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      expect(await page.evaluate(() => window.__edit.cut()?.kind)).toBe("row");
      // Move to the third (Eta) row and paste-as-move; cut outline stays on source.
      await selectCell(page, "Eta");
      await page.keyboard.press("Shift+Space");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      expect(await page.evaluate(() => window.__edit.cut()?.kind)).toBe("row");
      await page.keyboard.press("Meta+V");
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('table[data-edit-id="e2"] tr'))
          .map((tr) => tr.cells[0].textContent.trim())
          .join(",") === "Alpha,Eta,Delta");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Eta", "Theta", "Iota"],
        ["Delta", "Epsilon", "Zeta"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+X then Cmd+Shift++ inserts a staged row before the selected row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Eta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Meta+X");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      // Select the first row and insert the staged third row before it.
      await selectCell(page, "Alpha");
      await page.keyboard.press("Meta+Shift+Equal");
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('table[data-edit-id="e2"] tr'))
          .map((tr) => tr.cells[0].textContent.trim())
          .join(",") === "Eta,Alpha,Delta");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Eta", "Theta", "Iota"],
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+C cancels a staged cut so the next paste is normal clipboard paste", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Meta+X");
      await page.waitForFunction(() => window.__edit.cut()?.kind === "row");
      await selectCell(page, "Alpha");
      await page.keyboard.press("Meta+C");
      await page.waitForFunction(() => window.__edit.cut() === null);
      await expect(page.locator("#__edit_cut")).toBeHidden();
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+C on a column then Ctrl+V into another column pastes every copied cell", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Control+C");
      await page.waitForFunction(() => window.__edit.lineCopy()?.kind === "column");
      // Select the destination column from its middle cell: paste should anchor
      // at the top of the selected column, not clip from the focused cell.
      await selectCell(page, "Zeta");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Control+V");
      await page.waitForFunction(() =>
        document.querySelector('td[data-edit-id="e11"]')?.textContent.trim() === "Epsilon");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Beta"],
        ["Delta", "Epsilon", "Epsilon"],
        ["Eta", "Theta", "Theta"],
      ]);
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+C on a row then Ctrl+V into another row pastes every copied cell", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Control+C");
      await page.waitForFunction(() => window.__edit.lineCopy()?.kind === "row");
      // Select the destination row from its middle cell: paste should anchor
      // at the first column of the row, not clip from the focused cell.
      await selectCell(page, "Theta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Control+V");
      await page.waitForFunction(() =>
        document.querySelector('td[data-edit-id="e13"]')?.textContent.trim() === "Delta");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
        ["Delta", "Epsilon", "Zeta"],
      ]);
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+C then Ctrl+Shift+= duplicates a copied column structurally", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      const marker = await setReloadMarker(page);
      await page.keyboard.press("Control+C");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      await page.keyboard.press("Control+Shift+Equal");
      await page.waitForFunction(() =>
        document.querySelector('table[data-edit-id="e2"] tr')?.cells.length === 4);
      await expectNoReload(page, marker);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Theta", "Iota"],
      ]);
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+C then Ctrl+Shift+= duplicates a copied row structurally", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Control+C");
      await page.waitForFunction(() => window.__edit.lineCopy()?.kind === "row");
      await page.keyboard.press("Control+Shift+Equal");
      await page.waitForFunction(() =>
        document.querySelectorAll('table[data-edit-id="e2"] tr').length === 4);
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Alpha", "Beta", "Gamma"],
        ["Delta", "Epsilon", "Zeta"],
        ["Delta", "Epsilon", "Zeta"],
        ["Eta", "Theta", "Iota"],
      ]);
      expect(persistedFirstTableRows(editor.readFile())).toEqual(rows);
    } finally {
      await editor.cleanup();
    }
  });

  test("starting edit mode clears a staged row/column copy", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Control+C");
      await page.waitForFunction(() => window.__edit.lineCopy()?.kind === "column");
      await page.keyboard.press("F2");
      await page.waitForFunction(() => window.__edit.lineCopy() === null);
      await expect(page.locator("#__edit_cut")).toBeHidden();
    } finally {
      await editor.cleanup();
    }
  });

  test("Excel-style Cmd+X / Cmd+V on columns moves the column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.keyboard.press("Meta+X");
      await selectCell(page, "Alpha");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Meta+V");
      await page.waitForFunction(() =>
        document.querySelector('table[data-edit-id="e2"] tr')?.cells[0]?.textContent.trim() === "Beta");
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows).toEqual([
        ["Beta", "Alpha", "Gamma"],
        ["Epsilon", "Delta", "Zeta"],
        ["Theta", "Eta", "Iota"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+V across tables surfaces a warning instead of moving", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Delta");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Meta+X");
      await selectCell(page, "Status B");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Meta+V");
      await expect(page.locator("#__edit_status")).toContainText(/across tables/i);
      // Source table should still have Delta in its second row.
      const rows = await page.locator('table[data-edit-id="e2"] tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
      expect(rows[1]).toEqual(["Delta", "Epsilon", "Zeta"]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+X on a multi-row selection is rejected with a friendly toast", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowDown"); // two rows in range
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.keyboard.press("Meta+x");
      // Toast surfaced and no cut was registered.
      await expect(page.locator("#__edit_status")).toContainText("Single-row");
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+C on a multi-row selection warns instead of silently copying one row", async ({ page, context }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(editor.url).origin,
      });
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Beta");
      await page.keyboard.press("Control+Space");
      await page.keyboard.press("Control+C");
      await page.waitForFunction(() => window.__edit.lineCopy()?.kind === "column");
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowDown"); // two rows in range
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.keyboard.press("Control+C");
      await expect(page.locator("#__edit_status")).toContainText("Multi-row copy");
      expect(await page.evaluate(() => window.__edit.lineCopy())).toBeNull();
    } finally {
      await editor.cleanup();
    }
  });
});
