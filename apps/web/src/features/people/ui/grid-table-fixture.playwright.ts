// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test as base, type Page } from "@playwright/test";

export { expect };

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
    await use(page);
    expect(errors).toEqual([]);
  },
});

export async function mount(page: Page, bounded = false, variant = "table") {
  // Mount just this entry through the real dev route; unrelated galleries can open body portals.
  await page.route("**/src/gallery/gallery.tsx", (route) => route.fulfill({
    contentType: "text/javascript",
    body: 'export { default as Gallery } from "/src/features/people/ui/grid-table.gallery.tsx";',
  }));
  await page.goto(`/_gallery?grid=${variant}&bounded=${bounded}`);
  await page.locator("#gallery-grid-table").getByRole("grid").waitFor();
}

export async function expectWindowAt(page: Page, row: number) {
  await expect.poll(() => page.getByRole("rowheader").allTextContents()).toContain(String(row));
  expect(await page.getByRole("rowheader").count()).toBeLessThanOrEqual(25 + 10);
  // Check geometry, not just DOM presence: the rendered rows must cover the viewport.
  const coverage = await page.evaluate(() => {
    const wrapper = document.getElementById("scroller")!;
    const bounds = wrapper.getBoundingClientRect();
    const top = Math.max(0, bounds.top + wrapper.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + wrapper.clientTop + wrapper.clientHeight);
    const cells = [...wrapper.querySelectorAll('[role="rowheader"]')];
    const first = cells[0]!.getBoundingClientRect();
    const last = cells.at(-1)!.getBoundingClientRect();
    return { coversTop: first.top <= top, coversBottom: last.bottom >= bottom, visible: cells.some((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    }) };
  });
  expect(coverage).toEqual({ coversTop: true, coversBottom: true, visible: true });
}
