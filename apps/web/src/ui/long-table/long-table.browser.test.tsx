// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ViteDevServer } from "vite";
import { expect as dom } from "@playwright/test";
import { t } from "@console/i18n";
import type { Browser, Page } from "../../lib/browser-test";
import { tableTest } from "../../../../../e2e/long-table-fixture";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => { ({ server, browser, page } = await tableTest()); }, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

for (const editable of [false, true]) {
  test(`cell typing keeps letters, spaces, Korean and input focus (editable=${editable})`, async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?typing${editable ? "-editable" : ""}`);
    const input = page.getByRole("textbox", { name: "Beta 메모" });
    await input.click();
    await page.keyboard.type("a ");
    await dom(input).toHaveValue("a ");
    await dom(input).toBeFocused();
    await page.keyboard.type("ㄱ");
    await dom(input).toHaveValue("a ㄱ");
    await dom(input).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("b");
    await dom(input).toHaveValue("a bㄱ");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await dom(input).toBeFocused();
  });

  test(`Korean composition stays in its cell (editable=${editable})`, async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?typing${editable ? "-editable" : ""}`);
    const input = page.getByRole("textbox", { name: "Beta 메모" });
    await input.click();
    await input.dispatchEvent("compositionstart", { data: "" });
    for (const [key, text] of [["ㄱ", "ㄱ"], ["가", "가"]]) {
      await input.dispatchEvent("keydown", { key, code: "KeyR", keyCode: 229, isComposing: true });
      await input.dispatchEvent("compositionupdate", { data: text });
      await page.keyboard.insertText(text!);
      await dom(input).toBeFocused();
      await input.press("Shift+ArrowLeft");
    }
    await input.dispatchEvent("compositionend", { data: "가" });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(" a ");
    await dom(input).toHaveValue("가 a ");
    await dom(input).toBeFocused();
  });

  test(`row and cell arrows and typeahead still navigate (editable=${editable})`, async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?typing${editable ? "-editable" : ""}`);
    const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await dom(rows.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await dom(rows.first()).toBeFocused();
    await page.keyboard.type("b");
    await dom(rows.nth(1)).toBeFocused();
    const name = rows.first().getByRole("rowheader");
    await name.focus();
    await page.keyboard.press("ArrowDown");
    await dom(rows.nth(1).getByRole("rowheader")).toBeFocused();
  });
}

test.each([1440].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))(
  "headers expose and change the controlled order at $width px in $theme", async ({ width, theme }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const name = page.getByRole("columnheader", { name: "이름", exact: true });
    await name.waitFor();
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    await name.focus();
    await name.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-sort="descending"]'));
    expect(await name.getAttribute("aria-sort")).toBe("descending");
    await name.click();
    await page.waitForFunction(() => document.querySelector('[aria-sort="ascending"]'));
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    const note = page.getByRole("columnheader", { name: "고정", exact: true });
    await note.click();
    expect(await note.getAttribute("aria-sort")).toBeNull();
    expect(await name.getAttribute("aria-sort")).toBe("ascending");
    expect(await page.getByRole("rowheader").allTextContents()).toEqual(["가상가", "가상나"]);
  },
);

test.each(["light", "dark"])("cards keep controlled sorting in %s, including keyboard and rotation", async theme => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test`);
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  await page.locator('[role="grid"][data-layout="cards"]').waitFor();
  const sort = page.getByRole("combobox", { name: "정렬", exact: true });
  await sort.waitFor();
  expect(await sort.inputValue()).toBe("name");
  expect(await sort.locator("option").allTextContents()).toEqual(["이름", "메모"]);
  await sort.selectOption("note");
  await page.getByText("note:ascending", { exact: true }).waitFor();
  await page.getByRole("button", { name: "내림차순", exact: true }).click();
  await page.getByText("note:descending", { exact: true }).waitFor();
  const ascending = page.getByRole("button", { name: "오름차순", exact: true });
  await ascending.focus();
  await ascending.press("Enter");
  await page.getByText("note:ascending", { exact: true }).waitFor();
  // The caller owns ordering; the table emits the descriptor without sorting a loaded page itself.
  expect(await page.getByRole("rowheader").allTextContents()).toEqual(["가상가메모첫째고정-", "가상나메모둘째고정-"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[role="grid"][data-layout="rows"]').waitFor();
  expect(await sort.count()).toBe(0);
  expect(await page.getByRole("columnheader", { name: "메모", exact: true }).getAttribute("aria-sort")).toBe("ascending");
});

test.each([1440, 390])("without a sort handler no column or card control can sort at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?readonly`);
  await page.getByText("name:ascending", { exact: true }).waitFor();
  expect(await page.locator("[data-allows-sorting]").count()).toBe(0);
  if (width === 1440) await page.getByRole("columnheader", { name: "이름", exact: true }).click();
  expect(await page.getByText("name:ascending", { exact: true }).isVisible()).toBe(true);
  expect(await page.getByRole("combobox", { name: "정렬", exact: true }).count()).toBe(0);
});

test("a narrow table without card metadata keeps sorting in the card control", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?rows`);
  await page.locator('[role="grid"][data-layout="cards"]').waitFor();
  const sort = page.getByRole("combobox", { name: "정렬", exact: true });
  await sort.waitFor();
  expect(await sort.inputValue()).toBe("name");
  await page.getByRole("button", { name: "내림차순", exact: true }).click();
  await page.getByText("name:descending", { exact: true }).waitFor();
});

test.each([1440, 390])("row ids can match column ids while callbacks and selection keep raw ids at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?collision`);
  const rows = page.getByRole("row").filter({ has: page.getByRole("rowheader") });
  await rows.nth(3).waitFor();
  expect(await rows.count()).toBe(4);
  const toggleAll = page.getByRole("checkbox").first();
  const toggleText = t("uiLongTable.selection.toggleAll", { count: 4, unit: "item" });
  await dom(toggleAll).toHaveAttribute("aria-label", toggleText);
  if (width === 390) {
    const toggleControl = toggleAll.locator("xpath=ancestor::label[1]");
    const selectHeader = await page.getByRole("columnheader").first().boundingBox();
    expect(selectHeader!.width).toBeGreaterThan(200);
    expect(selectHeader!.height).toBeGreaterThanOrEqual(36);
    await dom(toggleControl).toContainText(toggleText);
    const box = await toggleControl.boundingBox();
    expect(box!.width).toBeGreaterThan(box!.height * 2);
  }
  for (const [i, id] of ["name", "__select", "__card", "row:name"].entries()) {
    const row = rows.nth(i);
    await row.hover();
    expect(await page.locator("body").getAttribute("data-hover")).toBe(id);
    await row.focus();
    expect(await page.locator("body").getAttribute("data-focus")).toBe(id);
    await row.press("o");
    expect(await page.locator("body").getAttribute("data-action")).toBe(id);
    await row.press("Space");
    await page.waitForFunction(() => document.querySelector('[aria-selected="true"]'));
    expect(await row.getAttribute("aria-selected")).toBe("true");
    expect(JSON.parse((await page.locator("body").getAttribute("data-selection"))!)).toContain(id);
  }
  await rows.first().focus();
  await rows.first().press("o");
  await expect.poll(() => page.locator("body").getAttribute("data-action")).toBe("name");
  await rows.first().press("Space");
  await expect.poll(async () => JSON.parse((await page.locator("body").getAttribute("data-selection"))!)).toEqual(["__select", "__card", "row:name"]);
});

test("native row actions receive the caller's id", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?collision-action`);
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "가상0", exact: true }) });
  await row.click();
  await expect.poll(() => page.locator("body").getAttribute("data-action")).toBe("name");
});

test("O opens through rowKeys when the table has no row action", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?keyboard-open`);
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "가상0", exact: true }) });
  await row.focus();
  await row.press("o");
  await expect.poll(() => page.locator("body").getAttribute("data-keyboard-open")).toBe("name");
});

test("card mode preserves child focusMode on the synthesized card column at 390 px", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/long-table-test?typing-child`);
  await page.locator('[role="grid"][data-layout="cards"]').waitFor();
  const row = page.getByRole("row").filter({ hasText: "Alpha" });
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await dom(page.getByRole("textbox", { name: "Alpha 메모", exact: true })).toBeFocused();
});

test.each([1440, 390].flatMap(width => ["direct", "wrapped"].map(shape => ({ width, shape }))))(
  "action controls own focus and their targets at $width px ($shape)", async ({ width, shape }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?targets${shape === "wrapped" ? "-wrapped" : ""}`);
    const button = page.getByRole("button", { name: "지정", exact: true }).first();
    await dom(button).toBeVisible();
    const cell = button.locator('xpath=ancestor::*[@role="gridcell" or @role="rowheader"][1]');
    const row = button.locator('xpath=ancestor::*[@role="row"][1]');
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await row.focus();
      await cell.focus();
      await dom(button).toBeFocused();
      await dom(cell).toHaveAttribute("tabindex", "-1");
      const { violations } = await new AxeBuilder({ page }).withRules(["target-size"]).analyze();
      expect(violations).toEqual([]);
      const target = await button.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(24);
      expect(target!.height).toBeGreaterThanOrEqual(24);
      for (const key of ["Enter", "Space"]) {
        await page.locator("body").evaluate(el => { delete el.dataset.pressed; });
        await button.press(key);
        await dom(page.locator("body")).toHaveAttribute("data-pressed", "true");
        await dom(button).toBeFocused();
        await dom(row).not.toHaveAttribute("aria-selected", "true");
        expect(await page.locator("body").getAttribute("data-action")).toBeNull();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  },
);

test.each([1440, 390])("keyboard focus entering a nested action never returns to a previous row at %s px", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}long-table-test?targets-wrapped`);
  const buttons = page.getByRole("button", { name: "지정", exact: true });
  const rows = page.getByRole("row").filter({ has: buttons });
  await rows.first().focus();
  await page.locator("body").evaluate(el => { el.tabIndex = -1; el.focus(); });
  await page.keyboard.press("ArrowRight");
  await buttons.nth(1).focus();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await dom(buttons.nth(1)).toBeFocused();
  await buttons.nth(1).press("Enter");
  await dom(page.locator("body")).toHaveAttribute("data-pressed", "true");
  await dom(rows.first()).not.toHaveAttribute("aria-selected", "true");
  await dom(rows.nth(1)).not.toHaveAttribute("aria-selected", "true");
  expect(await page.locator("body").getAttribute("data-action")).toBeNull();
});
