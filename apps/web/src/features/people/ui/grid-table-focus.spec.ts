// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, mount, expectWindowAt } from "./grid-table-fixture.playwright";
import { expectAxe } from "../../../../../../e2e/a11y";

const imeText = "\u3131";

test("Shift+Tab restores the active cell after its row scrolls out of the window", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-7-1").click();
  await page.keyboard.press("Tab");
  await expect(page.locator("#after")).toBeFocused();
  await page.locator("#scroller").evaluate((el) => {
    el.scrollTop = 1000 * parseFloat(getComputedStyle(el).getPropertyValue("--row-h"));
  });
  await expectWindowAt(page, 1000);
  await expect(page.locator("#grid-7-1")).toHaveCount(0);
  await page.locator("#after").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#grid-7-1 input")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#grid-8-1 input")).toBeFocused();
});

test("Korean IME composition events preserve the first character", async ({ page }) => {
  await mount(page, true);
  const cell = page.locator("#grid-0-2");
  await cell.click();
  const input = cell.locator("input");
  await input.dispatchEvent("compositionstart", { data: "" });
  await expect(cell).toHaveAttribute("data-editing", "true");
  await input.dispatchEvent("compositionupdate", { data: imeText });
  await page.keyboard.insertText(imeText);
  await input.dispatchEvent("compositionend", { data: imeText });
  await expect(input).toHaveValue(imeText);
  await input.press("Enter");
  await expect(cell).toHaveText(imeText);
  await expect(page.locator("#grid-1-2 input")).toBeFocused();
  await expectAxe(page, "Korean grid composition", { include: "#gallery-grid-table" });
});

test("a plain click collapses a rectangular selection", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.locator("#grid-2-2").click();
  expect(await page.locator('[role="gridcell"][aria-selected="true"]').evaluateAll((cells) => cells.map((cell) => cell.id))).toEqual(["grid-2-2"]);
  await page.locator("#grid-1-1").click({ modifiers: ["Shift"] });
  await page.locator("#grid-1-1").click();
  expect(await page.locator('[role="gridcell"][aria-selected="true"]').evaluateAll((cells) => cells.map((cell) => cell.id))).toEqual(["grid-1-1"]);
  await expectAxe(page, "collapsed grid selection", { include: "#gallery-grid-table" });
});

test("Shift+click extends the anchor into a rectangle", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-1-0").click();
  await page.locator("#grid-2-1").click({ modifiers: ["Shift"] });
  expect(await page.locator('[role="gridcell"][aria-selected="true"]').evaluateAll((cells) => cells.map((cell) => cell.id))).toEqual([
    "grid-1-0", "grid-1-1", "grid-2-0", "grid-2-1",
  ]);
  await expectAxe(page, "pointer grid selection", { include: "#gallery-grid-table" });
});

test("Ctrl+D fills and Delete clears every column in the selection", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").evaluate((cell) => {
    const data = new DataTransfer();
    data.setData("text/plain", "F\tHQ\nM\tRemote\nM\tBranch");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    cell.dispatchEvent(event);
  });
  await page.locator("#grid-0-0").click();
  await page.locator("#grid-2-1").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+d");
  for (const row of [0, 1, 2]) {
    await expect(page.locator(`#grid-${row}-0`)).toHaveText("F");
    await expect(page.locator(`#grid-${row}-1`)).toHaveText("HQ");
  }
  await page.keyboard.press("Delete");
  for (const row of [0, 1, 2]) for (const col of [0, 1]) await expect(page.locator(`#grid-${row}-${col}`)).toHaveText("");
  await expectAxe(page, "filled and cleared grid selection", { include: "#gallery-grid-table" });
});

test("Backspace clears only the active cell and enters edit", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").evaluate((cell) => {
    const data = new DataTransfer();
    data.setData("text/plain", "F\tHQ\nM\tRemote");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    cell.dispatchEvent(event);
  });
  await page.locator("#grid-0-0").click();
  await page.locator("#grid-1-1").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Backspace");
  await expect(page.locator("#grid-1-1")).toHaveAttribute("data-editing", "true");
  await expect(page.locator("#grid-1-1 input")).toHaveValue("");
  await expect(page.locator("#grid-0-0")).toHaveText("F");
  await expect(page.locator("#grid-0-1")).toHaveText("HQ");
  await expect(page.locator("#grid-1-0")).toHaveText("M");
  await page.keyboard.press("Escape");
  await expect(page.locator("#grid-1-1")).toHaveText("");
  await expectAxe(page, "Backspace cell edit", { include: "#gallery-grid-table" });
});

test("Ctrl+D and Delete leave read-only cells unchanged inside a rectangle", async ({ page }) => {
  await mount(page, true, "table", true);
  const locked = [0, 1, 2].map((row) => page.locator(`#grid-${row}-1`));
  const before = await Promise.all(locked.map((cell) => cell.innerText()));
  await page.locator("#grid-0-0").click();
  await page.locator("#grid-2-2").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+d");
  expect(await Promise.all(locked.map((cell) => cell.innerText()))).toEqual(before);
  await page.keyboard.press("Delete");
  expect(await Promise.all(locked.map((cell) => cell.innerText()))).toEqual(before);
  for (const row of [0, 1, 2]) for (const col of [0, 2]) await expect(page.locator(`#grid-${row}-${col}`)).toHaveText("");
  await expectAxe(page, "read-only range commands", { include: "#gallery-grid-table" });
});

test("read-only cells refuse edit keys, typing and synthetic input", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount(page, true, "table", true);
  await page.locator("html").evaluate((element) => { element.dataset.theme = "dark"; });
  const cell = page.locator("#grid-0-1"), input = cell.locator("input");
  const value = await cell.innerText();
  await cell.click();
  await expect(cell).toHaveAttribute("data-readonly", "true");
  await expect(cell).toHaveCSS("cursor", "not-allowed");
  expect(await cell.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(await page.locator("#grid-0-0").evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(input).toHaveAttribute("readonly", "");
  for (const key of ["F2", "Enter", "Backspace"]) {
    await input.press(key);
    await expect(cell).not.toHaveAttribute("data-editing", "true");
    await expect(cell).toHaveText(value);
  }
  await cell.dblclick();
  await expect(cell).not.toHaveAttribute("data-editing", "true");
  await expect(cell).toHaveText(value);
  await page.keyboard.insertText("changed");
  await expect(input).toHaveValue("");
  await input.evaluate((element) => {
    const control = element as HTMLInputElement;
    control.value = "changed";
    control.dispatchEvent(new InputEvent("input", { bubbles: true, data: "changed", inputType: "insertText" }));
  });
  await expect(cell).not.toHaveAttribute("data-editing", "true");
  await input.evaluate((element) => { (element as HTMLInputElement).value = ""; });
  await input.dispatchEvent("compositionstart", { data: imeText });
  await expect(cell).not.toHaveAttribute("data-editing", "true");
  const suggested = page.locator("#grid-1-1");
  const suggestedValue = await suggested.innerText();
  await suggested.click();
  await suggested.locator("input").press("Enter");
  await expect(suggested).not.toHaveAttribute("data-editing", "true");
  await expect(suggested).toHaveText(suggestedValue);
  await expectAxe(page, "read-only grid cell", { include: "#gallery-grid-table" });
});

test("copy while editing is left to the input's selected text", async ({ page }) => {
  await mount(page, true);
  const cell = page.locator("#grid-0-2");
  await cell.click();
  await page.keyboard.press("F2");
  const result = await cell.locator("input").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.setSelectionRange(0, Math.min(3, input.value.length));
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    const allowed = input.dispatchEvent(event);
    return { allowed, selected: input.value.slice(input.selectionStart!, input.selectionEnd!), gridCopy: data.getData("text/plain") };
  });
  expect(result.selected.length).toBeGreaterThan(0);
  expect(result).toMatchObject({ allowed: true, gridCopy: "" });
  await expectAxe(page, "native editor copy", { include: "#gallery-grid-table" });
});

test("row and employee numbers stay frozen at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount(page, true);
  await page.locator("html").evaluate((element) => { element.dataset.theme = "dark"; });
  const headers = page.getByRole("columnheader");
  const firstRow = page.getByRole("row").nth(1);
  const frozen = [headers.nth(0), headers.nth(1), firstRow.getByRole("rowheader"), firstRow.getByRole("gridcell").first()];
  const before = await Promise.all(frozen.map((cell) => cell.evaluate((element) => element.getBoundingClientRect().left)));
  const scrollLeft = await page.locator("#scroller").evaluate((element) => (element.scrollLeft = element.scrollWidth));
  expect(scrollLeft).toBeGreaterThan(0);
  for (const cell of frozen) await expect(cell).toHaveCSS("position", "sticky");
  const after = await Promise.all(frozen.map((cell) => cell.evaluate((element) => element.getBoundingClientRect().left)));
  expect(after.every((left, index) => Math.abs(left - before[index]!) <= 1)).toBe(true);
  await expect(headers.nth(0)).toBeVisible();
  await expect(headers.nth(1)).toBeVisible();
  await expectAxe(page, "frozen grid identity columns", { include: "#gallery-grid-table" });
});

for (const width of [1440, 390]) {
  test(`F8 keeps the focused error cell clear of its explanation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, true);
    await page.getByRole("grid").focus();
    await page.keyboard.press("F8");
    await expect(page.locator("#grid-999-2 input")).toBeFocused();
    await expect.poll(() => page.getByRole("grid").getByRole("status").evaluate((el) => {
      const tip = el.getBoundingClientRect();
      const scroller = document.getElementById("scroller")!.getBoundingClientRect();
      return tip.left >= Math.max(0, scroller.left) && tip.right <= Math.min(innerWidth, scroller.right)
        && tip.top >= Math.max(0, scroller.top) && tip.bottom <= Math.min(innerHeight, scroller.bottom);
    })).toBe(true);
    await expect.poll(() => page.locator("#grid-999-2 input").evaluate((el) => {
      const cell = el.getBoundingClientRect();
      const tip = el.closest('[role="grid"]')!.querySelector('[role="status"]')!.getBoundingClientRect();
      return cell.right > tip.left && cell.left < tip.right && cell.bottom > tip.top && cell.top < tip.bottom;
    })).toBe(false);
  });
}

for (const density of ["regular", "compact"]) {
  test(`four-digit row numbers fit without clipping at ${density} density`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await mount(page, true);
    await page.locator("#scroller").evaluate((el, value) => el.setAttribute("data-density", value), density);
    await page.getByRole("grid").focus();
    await page.keyboard.press("Control+End");
    await expect(page.locator("#grid-1999-2 input")).toBeFocused();
    await page.locator("#scroller").evaluate((el) => { el.scrollLeft = 0; });
    const number = page.getByRole("rowheader", { name: "2000", exact: true });
    await expect(number).toBeVisible();
    expect(await number.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const cell = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return text.left >= cell.left + parseFloat(style.paddingLeft) && text.right <= cell.right - parseFloat(style.paddingRight);
    })).toBe(true);
  });
}
