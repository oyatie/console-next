// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, mount, expectWindowAt } from "./grid-table-fixture.playwright";

test("Shift+Tab restores the active cell after its row scrolls out of the window", async ({ page }) => {
  await mount(page, true);
  await page.locator("#grid-0-0").click();
  await page.keyboard.press("Tab");
  await expect(page.locator("#after")).toBeFocused();
  await page.locator("#scroller").evaluate((el) => { el.scrollTop = 40000; });
  await expectWindowAt(page, 1000);
  await expect(page.locator("#grid-0-0")).toHaveCount(0);
  await page.locator("#after").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#grid-0-0 input")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#grid-1-0 input")).toBeFocused();
});

for (const width of [1440, 390]) {
  test(`F8 keeps the focused error cell clear of its explanation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, true);
    await page.getByRole("grid").focus();
    await page.keyboard.press("F8");
    await expect(page.locator("#grid-999-2 input")).toBeFocused();
    await expect.poll(() => page.locator("#grid-999-2 input").evaluate((el) => {
      const cell = el.getBoundingClientRect();
      const tip = el.closest('[role="grid"]')!.querySelector('[role="status"]')!.getBoundingClientRect();
      return cell.right > tip.left && cell.left < tip.right && cell.bottom > tip.top && cell.top < tip.bottom;
    })).toBe(false);
  });
}
