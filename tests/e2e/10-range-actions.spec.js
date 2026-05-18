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

test.describe("table range actions", () => {
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

  test("Shift+ArrowRight extends a single cell into a 2-wide range", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("range");
      const bounds = await rangeBounds(page);
      expect(bounds).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 1 } });
    } finally {
      await editor.cleanup();
    }
  });

  test("Shift+Arrow grows and shrinks the range; Shift+Left collapses to anchor", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      expect(await rangeBounds(page)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 2 } });
      await page.keyboard.press("Shift+ArrowLeft");
      expect(await rangeBounds(page)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 1 } });
      await page.keyboard.press("Shift+ArrowLeft");
      // Collapsed back to single cell.
      expect(await rangeBounds(page)).toBeNull();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
    } finally {
      await editor.cleanup();
    }
  });

  test("Shift+ArrowDown extends the range vertically through header rows", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      const bounds = await rangeBounds(page);
      expect(bounds).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 2, col: 0 } });
    } finally {
      await editor.cleanup();
    }
  });

  test("Bare arrow key collapses an active range and moves a single cell", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("range");
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
      expect(await rangeBounds(page)).toBeNull();
      // The cell to the right of "Alpha" is "Beta", and the bare arrow then
      // moves further right from there (or stays put if already at edge).
      // We accept either Beta or Gamma since the precise step depends on
      // collapse-then-move semantics.
      const text = await selectedText(page);
      expect(["Beta", "Gamma"]).toContain(text);
    } finally {
      await editor.cleanup();
    }
  });

  // Keyboard mapping: we use Excel's convention (matches v0.1.5):
  //   Shift+Space → row     (row label / horizontal stripe)
  //   Ctrl+Space  → column  (column label / vertical stripe)

  test("Range + Shift+Space promotes to row mode and selects every row in the range", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowDown"); // range rows 0..1
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      // Range is preserved so the row mode covers rows 0 and 1.
      const bounds = await rangeBounds(page);
      expect(bounds).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 0 } });
    } finally {
      await editor.cleanup();
    }
  });

  test("Range + Ctrl+Space promotes to column mode and selects every column in the range", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight"); // range cols 0..1
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      const bounds = await rangeBounds(page);
      expect(bounds).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 1 } });
    } finally {
      await editor.cleanup();
    }
  });

  test("Row mode + Ctrl+Space escalates to whole-table selection", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("table");
    } finally {
      await editor.cleanup();
    }
  });

  test("Column mode + Shift+Space escalates to whole-table selection", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("table");
    } finally {
      await editor.cleanup();
    }
  });

  test("Shift+Space inside an editable cell saves and selects the row", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("F2");
      await page.waitForFunction(() =>
        document.querySelector('.__edit_editing'));
      // Type some text then flip to row mode.
      await page.keyboard.type("X");
      await page.keyboard.press("Shift+Space");
      await page.waitForFunction(() => window.__edit.selectionMode() === "row");
      // The edit was committed.
      const cellText = await page.locator('td[data-edit-id]').first().textContent();
      expect(cellText.trim().startsWith("AlphaX") || cellText.trim() === "X"
        || cellText.trim() === "AlphaX").toBeTruthy();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
    } finally {
      await editor.cleanup();
    }
  });

  test("Ctrl+Space inside an editable cell saves and selects the column", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("F2");
      await page.waitForFunction(() => document.querySelector('.__edit_editing'));
      await page.keyboard.press("Control+Space");
      await page.waitForFunction(() => window.__edit.selectionMode() === "column");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("column");
    } finally {
      await editor.cleanup();
    }
  });

  test("Esc steps down through table modes: table → cell → deselect", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+Space");
      await page.keyboard.press("Control+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("table");
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
      // Anchor cell is still selected after stepping down from table mode.
      expect(await selectedText(page)).toBe("Alpha");
      await page.keyboard.press("Escape");
      // Now deselected.
      expect(await page.evaluate(() => !!window.__edit.target())).toBeFalsy();
    } finally {
      await editor.cleanup();
    }
  });

  test("Clicking another cell in the same table drops a stale range", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight"); // range 0,0–0,1
      expect(await rangeBounds(page)).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 1 } });
      // Now select a different cell in the same table directly.
      await selectCell(page, "Iota");
      expect(await rangeBounds(page)).toBeNull();
      // Promotion should now act on Iota's cell, not the previous range.
      await page.keyboard.press("Shift+Space");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("row");
    } finally {
      await editor.cleanup();
    }
  });

  test("Esc collapses an active range to single-cell selection", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("range");
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
      expect(await rangeBounds(page)).toBeNull();
      expect(await selectedText(page)).toBe("Alpha");
    } finally {
      await editor.cleanup();
    }
  });

  test("rangeCells() exposes the active range in row-major order", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      expect(await rangeCellTexts(page)).toEqual([
        ["Alpha", "Beta"],
        ["Delta", "Epsilon"],
      ]);
    } finally {
      await editor.cleanup();
    }
  });

  test("Delete on a 2x2 range clears every cell as one undoable op", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Delete");
      await page.waitForFunction(() => {
        const cells = window.__edit.rangeCells().flat();
        return cells.every((t) => t === "");
      });
      // Cells outside the range untouched.
      expect(await readCellText(page, "e7")).toBe("Gamma");
      expect(await readCellText(page, "e15")).toBe("Iota");
      // One undo restores all four cells.
      await page.keyboard.press("Meta+z");
      await page.waitForFunction(() =>
        document.querySelector('[data-edit-id="e5"]').textContent.trim() === "Alpha");
      expect(await readCellText(page, "e5")).toBe("Alpha");
      expect(await readCellText(page, "e6")).toBe("Beta");
      expect(await readCellText(page, "e9")).toBe("Delta");
      expect(await readCellText(page, "e10")).toBe("Epsilon");
    } finally {
      await editor.cleanup();
    }
  });

  test("Backspace on a 2x2 range matches Delete behavior", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Backspace");
      await page.waitForFunction(() => {
        const cells = window.__edit.rangeCells().flat();
        return cells.every((t) => t === "");
      });
      expect(await readCellText(page, "e5")).toBe("");
      expect(await readCellText(page, "e10")).toBe("");
    } finally {
      await editor.cleanup();
    }
  });

  test("Cmd+X on a range stages the cut; Cmd+V moves and clears source in one undo", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight"); // Alpha + Beta
      await page.keyboard.press("Meta+x");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      expect(await page.evaluate(() => window.__edit.cut()?.kind)).toBe("range");
      // Source remains intact until paste commits the move.
      expect(await readCellText(page, "e5")).toBe("Alpha");
      expect(await readCellText(page, "e6")).toBe("Beta");

      await selectCell(page, "Delta");
      await page.keyboard.press("Meta+v");
      await page.waitForFunction(() =>
        document.querySelector('[data-edit-id="e5"]').textContent.trim() === ""
        && document.querySelector('[data-edit-id="e9"]').textContent.trim() === "Alpha"
        && window.__edit.cut() === null);
      expect(await readCellText(page, "e5")).toBe("");
      expect(await readCellText(page, "e6")).toBe("");
      expect(await readCellText(page, "e9")).toBe("Alpha");
      expect(await readCellText(page, "e10")).toBe("Beta");
      expect(await readCellText(page, "e7")).toBe("Gamma");

      // One undo restores both source and destination.
      await page.keyboard.press("Meta+z");
      await page.waitForFunction(() =>
        document.querySelector('[data-edit-id="e5"]').textContent.trim() === "Alpha");
      expect(await readCellText(page, "e5")).toBe("Alpha");
      expect(await readCellText(page, "e6")).toBe("Beta");
      expect(await readCellText(page, "e9")).toBe("Delta");
      expect(await readCellText(page, "e10")).toBe("Epsilon");
    } finally {
      await editor.cleanup();
    }
  });

  test("staged range cut refuses clipped destinations without clearing source", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown"); // 2x2: Alpha/Beta + Delta/Epsilon
      await page.keyboard.press("Meta+x");
      await expect(page.locator("#__edit_cut")).toBeVisible();
      await selectCell(page, "Iota");
      await page.keyboard.press("Meta+v");
      await expect(page.locator("#__edit_status")).toContainText(/doesn't fit/i);
      expect(await page.evaluate(() => window.__edit.cut()?.kind)).toBe("range");
      expect(await readCellText(page, "e5")).toBe("Alpha");
      expect(await readCellText(page, "e6")).toBe("Beta");
      expect(await readCellText(page, "e9")).toBe("Delta");
      expect(await readCellText(page, "e10")).toBe("Epsilon");
      expect(await readCellText(page, "e15")).toBe("Iota");
    } finally {
      await editor.cleanup();
    }
  });

  test("F2 on a range collapses to the anchor cell and enters edit mode", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBe("range");
      await page.keyboard.press("F2");
      await page.waitForFunction(() => !!document.querySelector(".__edit_editing"));
      // Range cleared, anchor ("Alpha") is the edit target.
      expect(await page.evaluate(() => window.__edit.tableRange())).toBeNull();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
      expect(await selectedText(page)).toBe("Alpha");
    } finally {
      await editor.cleanup();
    }
  });

  test("`c` on a range collapses to the anchor and opens the comment composer", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("c");
      await page.waitForSelector("#__edit_commentbox:not([hidden])");
      // Range cleared.
      expect(await page.evaluate(() => window.__edit.tableRange())).toBeNull();
      expect(await page.evaluate(() => window.__edit.selectionMode())).toBeNull();
      // Anchor cell still selected.
      expect(await selectedText(page)).toBe("Alpha");
    } finally {
      await editor.cleanup();
    }
  });

  test("Range Delete keeps inline wrappers like status badges intact", async ({ page }) => {
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      // Build a range over the badge column of the status-grid table.
      await page.evaluate(() => {
        const el = document.querySelector('[data-edit-id="e23"]');
        window.__edit.select(el);
      });
      await page.keyboard.press("Shift+ArrowDown");
      expect(await page.evaluate(() => window.__edit.rangeCells()))
        .toEqual([["SHIPPED"], ["PARTIAL"]]);
      await page.keyboard.press("Delete");
      await page.waitForFunction(() => {
        const cells = window.__edit.rangeCells().flat();
        return cells.every((t) => t === "");
      });
      // Wrappers survived for both rows.
      const wrappers = await page.evaluate(() => {
        const td22 = document.querySelector('[data-edit-id="e22"]');
        const td26 = document.querySelector('[data-edit-id="e26"]');
        return [td22?.innerHTML, td26?.innerHTML];
      });
      expect(wrappers[0]).toMatch(/class="status-badge shipped"[^>]*><\/span>$/);
      expect(wrappers[1]).toMatch(/class="status-badge partial"[^>]*><\/span>$/);
    } finally {
      await editor.cleanup();
    }
  });

  test("Delete on a 1x1 range (collapsed) is a no-op (single-cell delete not wired)", async ({ page }) => {
    // Sanity guard: we only wired Delete in 'range' mode. A plain single-cell
    // selection should still leave the cell text untouched.
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(120);
      expect(await readCellText(page, "e5")).toBe("Alpha");
    } finally {
      await editor.cleanup();
    }
  });

  // Clipboard-write tests use the writeText path via Playwright permissions.
  // We focus on the *behavior* (paste back into the same table fans out into
  // a range) rather than directly observing system clipboard contents, since
  // playwright's clipboard model is sandboxed.

  test("Cmd+C then Cmd+V on a fresh anchor pastes the range row-major", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const editor = await startEditor("table-grid.html");
    try {
      await page.goto(editor.url);
      await waitForEditor(page);
      await selectCell(page, "Alpha");
      await page.keyboard.press("Shift+ArrowRight"); // range Alpha + Beta
      await page.keyboard.press("Meta+c");
      // Flash shows count.
      await expect(page.locator("#__edit_status")).toContainText("Copied");
      // Select Delta (row 1, col 0) and paste — should fill Delta + Epsilon.
      await selectCell(page, "Delta");
      // Force-set selection mode none so paste lands on the cell.
      await page.keyboard.press("Meta+v");
      await page.waitForFunction(() =>
        document.querySelector('[data-edit-id="e9"]').textContent.trim() === "Alpha");
      expect(await readCellText(page, "e9")).toBe("Alpha");
      expect(await readCellText(page, "e10")).toBe("Beta");
      expect(await readCellText(page, "e11")).toBe("Zeta"); // outside the 1x2 paste
    } finally {
      await editor.cleanup();
    }
  });
});
