import { expect } from "@playwright/test";
import { waitForEditor } from "./helpers.js";

export async function selectCell(page, text) {
  // Prefer the exact-match locator so cells like "Eta" don't collide with
  // substrings ("Beta"). Fall back to has-text when the visible text lives
  // in a nested span (badge cells).
  let locator = page.locator(`td:text-is("${text}")`).first();
  if (await locator.count() === 0) {
    locator = page.locator(`td:has-text("${text}")`).first();
  }
  const id = await locator.getAttribute("data-edit-id");
  await page.evaluate((id) => {
    window.__edit.select(document.querySelector(`[data-edit-id="${id}"]`));
  }, id);
}

export async function selectedText(page) {
  return await page.evaluate(() =>
    (window.__edit.target()?.el?.textContent || "").trim());
}

export async function rangeBounds(page) {
  return await page.evaluate(() => window.__edit.tableRange());
}

export async function rangeCellTexts(page) {
  return await page.evaluate(() => window.__edit.rangeCells());
}

export async function readCellText(page, editId) {
  return await page.evaluate((id) => {
    const el = document.querySelector(`[data-edit-id="${id}"]`);
    return el ? (el.innerText || el.textContent || "").trim() : null;
  }, editId);
}

export function persistedFirstTableRows(html) {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] || "";
  return Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (rowMatch) =>
    Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi), (cellMatch) =>
      cellMatch[1].replace(/<[^>]*>/g, "").trim()));
}

export async function setReloadMarker(page) {
  await page.evaluate(() => { window.__tableReloadMarker = crypto.randomUUID(); });
  return await page.evaluate(() => window.__tableReloadMarker);
}

export async function expectNoReload(page, marker) {
  await waitForEditor(page);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__tableReloadMarker)).toBe(marker);
}

export async function cmdArrow(page, key) {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
}
