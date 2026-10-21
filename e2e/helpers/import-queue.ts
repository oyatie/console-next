import { expect, type Locator, type Page } from "@playwright/test";

// The dry run's questions (IMPORT-2, spec E7-values): the 값 연결 tables (a text → a place or a code, one per kind) and the
// 「확인 필요」 queue of the rest (virtualised), and the row table; an item or a row opens below its grid.

/** Every grid holding a question: the 값 연결 tables and the queue. */
export const queue = (page: Page) => page.getByRole("grid", { name: /^(확인 필요|값 연결)/ });
export const rowsGrid = (page: Page) => page.getByRole("grid", { name: "행별 결과" });
/** The opened 확인 필요 item (its heading is the reason). */
export const panel = (page: Page) => page.locator("section:has(> .toolbar #import-resolve)");
/** The opened row's detail. */
export const detail = (page: Page) => page.getByRole("region", { name: /시트 \d+행/ });

/** Waits until no answer is still being run through a dry run. */
export const settled = (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

/**
 * A grid's row holding `text`. The grids are virtualised against the window too: only rows on screen are in the page,
 * so the grid is brought into view first.
 */
export async function gridRow(grid: Locator, text: string | RegExp) {
  // Several grids: a 값 연결 table that holds the text (all its rows are drawn), else the queue (virtualised: its row
  // is only drawn once the grid is in view).
  const page = grid.page();
  const values = page.getByRole("grid", { name: /^값 연결/ }).filter({ has: page.getByRole("row").filter({ hasText: text }) });
  const one = (await grid.count()) <= 1 ? grid : (await values.count()) > 0 ? values.first() : page.getByRole("grid", { name: /^확인 필요/ });
  await one.scrollIntoViewIfNeeded();
  return one.getByRole("row").filter({ hasText: text }).first();
}

/** Opens the queue item whose row holds `text`. */
export async function openItem(page: Page, text: string | RegExp) {
  await settled(page);
  await (await gridRow(queue(page), text)).click();
  await expect(panel(page)).toContainText(text);
}

/** Opens a planned row's detail by a text in its row (a 사번 or a name). */
export async function openRow(page: Page, text: string) {
  await (await gridRow(rowsGrid(page), text)).click();
  await expect(detail(page)).toBeVisible();
  return detail(page);
}
