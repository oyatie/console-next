import { expect, type Page } from "@playwright/test";
import { go } from "../flows";
import { HERO } from "./universe";

// Steps the employee-record specs share: opening a person, the record's own sheets, the grade list.

export const cardHeading = (page: Page, name = HERO.name) => page.getByRole("heading", { name, level: 1 });

/** Opens a person's 인사카드 from the roster by an exact 사번 (Enter on an exact number opens that person). */
export async function openByNumber(page: Page, no: string, name: string, status?: "EXITED") {
  await go(page, status ? `/people?status=${status}` : "/people");
  const find = page.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill(no);
  await find.press("Enter");
  await expect(cardHeading(page, name)).toBeVisible();
}

/** The open side sheet (one at a time). */
export const sheet = (page: Page) => page.getByRole("dialog");

/** A pick from a chip group (React Aria radios: the label takes the press). */
export const pick = (scope: Page | ReturnType<Page["getByRole"]>, group: RegExp | string, name: string) =>
  scope.getByRole("radiogroup", { name: group }).getByText(name, { exact: true });

/** Waits for a 바로 수정 receipt (saved, with its undo). */
export const savedToast = (page: Page) => expect(page.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();

/** A stale-write race the live stream cannot refresh away; settle the injected outage before measuring the edit. */
export async function cutRecordUpdates(page: Page) {
  await page.route("**/api/v1/events", (r) => r.abort());
  await page.reload();
  await expect(page.getByText("실시간 연결 끊김 · 재연결 중")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400))))));
  await page.evaluate(() => void window.__shifts?.splice(0));
}

export async function restoreRecordUpdates(page: Page) {
  await page.unroute("**/api/v1/events");
  await expect(page.getByText("실시간 연결 끊김 · 재연결 중")).toHaveCount(0, { timeout: 60_000 });
}
