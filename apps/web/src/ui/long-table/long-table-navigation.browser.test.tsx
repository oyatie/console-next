// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ViteDevServer } from "vite";
import { expect as dom } from "@playwright/test";
import type { Browser, Page } from "../../lib/browser-test";
import { tableTest } from "../../../../../e2e/long-table-fixture";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ server, browser, page } = await tableTest());
  // Exercise Ctrl grid shortcuts on macOS runners too.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "Win32" });
    Object.defineProperty(navigator, "userAgentData", { value: undefined });
  });
}, 60_000);
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

// Select-all (Ctrl+A; the page reports Windows) reaches the grid from a focused control exactly as from its cell.
test.each([1440, 390].flatMap(width => (["cell", "button"] as const).map(origin => ({ width, origin }))))(
  "Control+A from $origin at $width px selects every row", async ({ width, origin }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?targets-wrapped-arrows`);
    const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
    await dom(rows).toHaveCount(2);
    const button = rows.first().getByRole("button", { name: "지정", exact: true });
    const cell = button.locator('xpath=ancestor::*[@role="gridcell" or @role="rowheader"][1]');
    await rows.first().focus();
    await (origin === "cell" ? cell : button).focus();
    await page.keyboard.press("Control+a");
    await dom(page.getByRole("row", { selected: true })).toHaveCount(2);
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

// Row/column destinations of cell navigation, including the header and the mobile row boundary.
const navigationKeys = [
  { key: "ArrowLeft", rows: [3, 2], cards: [3, 1] },
  { key: "ArrowRight", rows: [3, 4], cards: [3, null] },
  { key: "ArrowUp", rows: [2, 3], cards: [2, 2] },
  { key: "ArrowDown", rows: [4, 3], cards: [4, 2] },
  { key: "Home", rows: [3, 1], cards: [3, 1] },
  { key: "End", rows: [3, 4], cards: [3, 2] },
  { key: "Control+Home", rows: [2, 1], cards: [2, 1] },
  { key: "Control+End", rows: [4, 4], cards: [4, 2] },
  { key: "PageUp", rows: [1, 3], cards: [1, 2] },
  { key: "PageDown", rows: [4, 3], cards: [4, 2] },
];
const navigationMatrix = [1440, 390].flatMap(width => navigationKeys.flatMap(({ key, rows, cards }) =>
  (["cell", "button", "input"] as const).map(origin => ({ width, key, origin, expected: width === 390 ? cards : rows })),
));

test.each(navigationMatrix)("grid navigation $key from $origin at $width px matches cell navigation", async ({ width, key, origin, expected }) => {
  await page.setViewportSize({ width, height: 900 });
  const address = () => page.evaluate(() => {
    const active = document.activeElement;
    const cell = active?.closest('[role="gridcell"], [role="rowheader"], [role="columnheader"]');
    return [Number(active?.closest('[role="row"]')?.getAttribute("aria-rowindex")) || null, Number(cell?.getAttribute("aria-colindex")) || null];
  });
  const open = async (mode: string) => {
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?navigation-${mode}`);
    await dom(page.getByRole("grid")).toHaveAttribute("data-layout", width === 390 ? "cards" : "rows");
    const row = page.getByRole("row").filter({ hasText: "Beta" });
    return width === 390 ? row.getByRole("rowheader") : row.getByRole("gridcell").nth(1);
  };
  for (const wrapped of [false, true]) {
    const cell = await open(`${origin}${wrapped ? "-wrapped" : ""}`);
    const target = origin === "cell" ? cell : cell.getByRole(origin === "button" ? "button" : "textbox", { name: "Beta", exact: true });
    await target.focus();
    await dom(target).toBeFocused();
    if (origin === "input") await target.evaluate(el => new Promise<void>(resolve => requestAnimationFrame(() => {
      (el as HTMLInputElement).setSelectionRange(3, 3);
      resolve();
    })));
    await page.keyboard.press(key);
    if (origin === "input") {
      await dom(target).toBeFocused();
      await dom(target).toHaveValue("abcdef");
      await dom(page.locator("body")).toHaveAttribute("data-input-prevented", "false");
      if (key === "ArrowLeft" || key === "ArrowRight") {
        expect(await target.evaluate(el => (el as HTMLInputElement).selectionStart)).toBe(key === "ArrowLeft" ? 2 : 4);
      }
    } else await expect.poll(address).toEqual(expected);
    if (origin === "button") {
      for (const activation of ["Enter", "Space"]) {
        await target.focus();
        await page.locator("body").evaluate(el => { delete el.dataset.pressed; });
        await page.keyboard.press(activation);
        await dom(page.locator("body")).toHaveAttribute("data-pressed", "b");
      }
    }
  }
});
