// SPDX-License-Identifier: LicenseRef-Proprietary
// The month view's sideways cases of the grid's browser test: the active cell stays in view between the sticky columns.
import { beforeAll, expect, test } from "vitest";
import { expect as element, type Locator, type Page } from "@playwright/test";
import type { MonthView } from "./person-day-grid.browser-editing";
import { activeShows, cutDay } from "./person-day-grid.browser-probes";

/** Registers the cases, each in a box of every width in `widths` (a query); `view` is read once the page is up. */
export function sidewaysCases(view: () => MonthView, widths: readonly string[]) {
  let page: Page, month: MonthView["month"], dayCell: MonthView["dayCell"], active: MonthView["active"], editor: Locator;
  beforeAll(() => {
    ({ page, month, dayCell, active } = view());
    editor = page.getByRole("textbox");
  });
  const scrollLeft = (grid: Locator) => grid.locator("..").evaluate(el => el.scrollLeft);

  test.each(widths)("moving the active cell sideways keeps it in view between the sticky columns (%s)", async width => {
    const grid = await month(width);
    await grid.focus();
    expect(await activeShows(grid)).toBe("in view");
    for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(active).toBe("0,14");
    await expect.poll(() => activeShows(grid)).toBe("in view");
    // The editor is wider than a day, and shows whole too.
    await page.keyboard.type("9");
    await element(editor).toBeFocused();
    await expect.poll(() => activeShows(grid)).toBe("in view");
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await expect.poll(active).toBe("0,30");
    await expect.poll(() => activeShows(grid)).toBe("in view");
    // Back the other way the sticky lead columns cover the left of the box.
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowLeft");
    await expect.poll(active).toBe("0,10");
    await expect.poll(() => activeShows(grid)).toBe("in view");
    await page.keyboard.press("Home");
    await expect.poll(active).toBe("0,0");
    await expect.poll(() => activeShows(grid)).toBe("in view");
    // A press on a person's number selects the row, to its last day, and the box stays where it is.
    const kept = await scrollLeft(grid);
    await grid.getByText("1002", { exact: true }).click();
    await element(grid.locator('td[aria-selected="true"]')).toHaveCount(31);
    expect(await active()).toBe("1,30");
    expect(await scrollLeft(grid)).toBe(kept);
    // A press on the part of a cell that shows brings the rest of it into view, and selects that cell alone. The box is
    // first moved so that a day shows its left half beside the sticky total, whatever width the look draws a day at.
    await dayCell(2, 1).locator("..").evaluate(tr => {
      const box = tr.closest("table")!.parentElement!, cells = [...tr.querySelectorAll("td")];
      const sticky = cells.filter(cell => getComputedStyle(cell).position === "sticky").map(cell => cell.getBoundingClientRect().left);
      const edge = Math.min(box.getBoundingClientRect().left + box.clientWidth, ...sticky);
      const day = cells.map(cell => cell.getBoundingClientRect()).find(b => b.right > edge)!;
      box.scrollLeft += day.left + day.width / 2 - edge;
    });
    const cut = await cutDay(dayCell(2, 1).locator(".."));
    expect(cut).toBeGreaterThan(0);
    await dayCell(2, cut + 1).click({ position: { x: 6, y: 10 } });
    await expect.poll(active).toBe(`1,${cut}`);
    await expect.poll(() => activeShows(grid)).toBe("in view");
    await element(grid.locator('td[aria-selected="true"]')).toHaveCount(1);
  });

  test("a key that keeps the active cell's column brings it back into view after the box was moved without it", async () => {
    const grid = await month(widths[0]);
    const box = grid.locator(".."), scrollTo = (left: number) => box.evaluate((el, to) => { el.scrollLeft = to; }, left);
    await grid.focus();
    // On day 1 with the box scrolled away by hand: a move down, then two keys with nowhere further to go.
    for (const [key, cell] of [["ArrowDown", "1,0"], ["ArrowLeft", "1,0"], ["Home", "1,0"]] as const) {
      await scrollTo(500);
      await page.keyboard.press(key);
      await expect.poll(active).toBe(cell);
      await expect.poll(() => activeShows(grid), { message: key }).toBe("in view");
    }
    // On day 31 with the box scrolled back to the start.
    await page.keyboard.press("End");
    for (const [key, cell] of [["ArrowDown", "2,30"], ["Shift+ArrowDown", "3,30"]] as const) {
      await scrollTo(0);
      await page.keyboard.press(key);
      await expect.poll(active).toBe(cell);
      await expect.poll(() => activeShows(grid), { message: key }).toBe("in view");
    }
    // A press on a person's number leaves the box where it is; the next key is followed.
    await scrollTo(0);
    await grid.getByText("1002", { exact: true }).click();
    expect(await active()).toBe("1,30");
    expect(await scrollLeft(grid)).toBe(0);
    await page.keyboard.press("ArrowDown");
    await expect.poll(active).toBe("2,30");
    await expect.poll(() => activeShows(grid)).toBe("in view");
    // So is the key after a press on a number that the browser cancelled (a touch that became a pan).
    await scrollTo(0);
    const number = grid.getByText("1004", { exact: true });
    await number.dispatchEvent("pointerdown");
    await number.dispatchEvent("pointercancel");
    await expect.poll(active).toBe("3,30");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(active).toBe("3,29");
    await expect.poll(() => activeShows(grid)).toBe("in view");
  });

  test("a cell selected from outside the grid, as the save panel's go-to does, is brought into view", async () => {
    const grid = await month(widths[0]);
    expect(await scrollLeft(grid)).toBe(0);
    await page.getByRole("button", { name: "Go to", exact: true }).click();
    await expect.poll(active).toBe("2,27");
    await expect.poll(() => activeShows(grid)).toBe("in view");
  });
}
