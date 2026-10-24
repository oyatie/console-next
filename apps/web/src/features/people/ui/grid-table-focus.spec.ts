// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, mount, expectWindowAt } from "./grid-table-fixture.playwright";

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

for (const width of [1440, 390]) {
  test(`F8 keeps the focused error cell clear of its explanation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, true);
    await page.getByRole("grid").focus();
    await page.keyboard.press("F8");
    await expect(page.locator("#grid-999-2 input")).toBeFocused();
    await expect.poll(() => page.locator('#gallery-grid-table [role="status"]').evaluate((el) => {
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
