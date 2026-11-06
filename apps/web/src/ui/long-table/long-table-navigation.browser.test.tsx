// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ViteDevServer } from "vite";
import { expect as dom } from "@playwright/test";
import type { Browser, Page } from "../../lib/browser-test";
import { tableTest } from "../../../../../e2e/long-table-fixture";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => { ({ server, browser, page } = await tableTest()); }, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// Exercise the focused controls as well as the cells around them, in both synthesized cards and rows.
test.each([1440, 390].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))(
  "arrows leave name and action buttons in every direction at $width px in $theme", async ({ width, theme }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?targets-wrapped-arrows`);
    const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
    await dom(rows).toHaveCount(2);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    for (const label of ["가상가", "지정"]) {
      const button = rows.first().getByRole("button", { name: label, exact: true });
      const cell = button.locator('xpath=ancestor::*[@role="gridcell" or @role="rowheader"][1]');
      await rows.first().focus();
      await cell.focus();
      await dom(cell.getByRole("button").first()).toBeFocused();
      await button.focus();
      await page.keyboard.press("ArrowDown");
      expect(await rows.nth(1).evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("ArrowUp");
      expect(await cell.evaluate(el => el.contains(document.activeElement))).toBe(true);
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        await button.focus();
        await page.keyboard.press(key);
        await dom(button).not.toBeFocused();
      }
      await button.focus();
      await page.keyboard.press("Tab");
      await dom(button).not.toBeFocused();
    }
    for (let step = 0; step < 12 && await page.getByRole("grid").evaluate(el => el.contains(document.activeElement)); step++) await page.keyboard.press("Tab");
    expect(await page.getByRole("grid").evaluate(el => el.contains(document.activeElement))).toBe(false);
    await page.keyboard.press("Shift+Tab");
    expect(await page.getByRole("grid").evaluate(el => el.contains(document.activeElement))).toBe(true);
    // Walk every column, forward and backward, without substituting Tab for arrows.
    await rows.first().focus();
    const visited = new Set<string>();
    for (let step = 0; step < 18; step++) {
      await page.keyboard.press("ArrowRight");
      visited.add(await page.evaluate(() => document.activeElement?.closest("[data-cell-key]")?.getAttribute("data-cell-key") ?? ""));
    }
    const keys = await rows.first().locator("[data-cell-key]").evaluateAll(cells => cells.map(cell => cell.getAttribute("data-cell-key")));
    for (const key of keys) expect(visited.has(key!)).toBe(true);
    visited.clear();
    for (let step = 0; step < 18; step++) {
      await page.keyboard.press("ArrowLeft");
      visited.add(await page.evaluate(() => document.activeElement?.closest("[data-cell-key]")?.getAttribute("data-cell-key") ?? ""));
    }
    for (const key of keys) expect(visited.has(key!)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  },
);

test.each([1440, 390])("shared table controls keep their own minimum target at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?targets-tiny`);
  const button = page.getByRole("button", { name: "지정", exact: true }).first();
  await dom(button).toBeVisible();
  for (const control of [button, page.getByRole("checkbox").nth(1).locator("xpath=ancestor::label[1]")]) {
    const target = await control.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(24);
    expect(target!.height).toBeGreaterThanOrEqual(24);
  }
});
