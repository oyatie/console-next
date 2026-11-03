// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { expectAxe } from "../a11y";
import { mockLifecycleSheets } from "./lifecycle-sheets";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function openFormSheet(page: Page) {
  await page.goto("/_gallery?entry=sheet");
  return showFormSheet(page);
}

async function showFormSheet(page: Page) {
  await page.getByRole("button", { name: tg("sheet.open"), exact: true }).click();
  return page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
}

test("a dirty Sheet asks before Escape and keeps its draft", async ({ page }) => {
  const sheet = await openFormSheet(page);
  const draft = sheet.getByRole("textbox", { name: tg("sheet.reason") });
  await draft.fill("검토 중인 내용");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
  await expect(draft).toHaveValue("검토 중인 내용");
  await expectAxe(page, "dirty Sheet close prompt", { include: "[role=dialog]" });

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: tg("sheet.open"), exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: tg("sheet.reason") })).toHaveValue("검토 중인 내용");
});

test("a clean Sheet closes immediately, while a form ignores its backdrop", async ({ page }) => {
  let sheet = await openFormSheet(page);
  await page.mouse.click(4, 400);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  sheet = await openFormSheet(page);
  const draft = sheet.getByRole("textbox", { name: tg("sheet.reason") });
  await draft.fill("배경을 눌러도 남는 내용");
  await page.mouse.click(4, 400);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
  await expect(draft).toHaveValue("배경을 눌러도 남는 내용");
});

test("Back asks before leaving a dirty Sheet", async ({ page }) => {
  await page.goto("/_gallery");
  await page.locator('[data-panel-trigger="populated"]').evaluate((button: HTMLElement) => button.click());
  await expect(page).toHaveURL(/sel=populated/);
  const href = page.url();
  await page.getByRole("button", { name: tg("sheet.open"), exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.click());
  const sheet = page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
  const draft = sheet.getByRole("textbox", { name: tg("sheet.reason") });
  await draft.fill("뒤로 가도 남는 내용");
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(href);
  await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
  await expect(draft).toHaveValue("뒤로 가도 남는 내용");
});

test("Escape closes only the top Sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_gallery");
  const lower = page.getByRole("dialog", { name: tg("dockSheet.title"), exact: true });
  await expect(lower).toBeVisible();
  await page.getByRole("button", { name: tg("sheet.open"), exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.click());
  const upper = page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
  await expect(upper).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(upper).toHaveCount(0);
  await expect(lower).toBeVisible();
});

test("Back restores the shell scroller on a non-table screen", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await page.goto("/org");
  await page.addStyleTag({ content: "#main::after { content: ''; display: block; height: 1800px; }" });
  const main = page.locator("#main");
  await main.focus();
  await main.evaluate(element => { element.scrollTop = 700; });
  await main.dispatchEvent("scroll");
  await page.waitForTimeout(200);
  const top = await main.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.locator('a[href="/"]').first().evaluate((element: HTMLElement) => element.click());
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/org$/);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(top);
  expect(fixture.unexpected).toEqual([]);
});

test("Back restores the shell scroller without replacing roster restoration", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "large");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await page.goto("/people");
  await page.addStyleTag({ content: "#main::after { content: ''; display: block; height: 1800px; }" });
  const main = page.locator("#main");
  const roster = page.getByRole("grid", { name: t("people.table"), exact: true });
  await expect(roster).toHaveAttribute("aria-rowcount", "2001");
  await roster.evaluate(element => { element.scrollTop = 640; });
  await roster.dispatchEvent("scroll");
  const rosterTop = await roster.evaluate(element => element.scrollTop);
  expect(rosterTop).toBeGreaterThan(0);
  const row = roster.locator('[role="row"][data-row-id]').first();
  await row.getByRole("rowheader").last().evaluate((element: HTMLElement) => element.click());
  const panel = page.getByRole("complementary", { name: t("people.panel"), exact: true });
  await expect(panel).toBeVisible();
  const listHref = page.url();
  await main.focus();
  await main.evaluate(element => { element.scrollTop = 1000; });
  await main.dispatchEvent("scroll");
  await page.waitForTimeout(200);
  const mainTop = await main.evaluate(element => element.scrollTop);
  expect(mainTop).toBeGreaterThan(0);
  await panel.getByRole("link", { name: t("people.panel.open"), exact: false }).evaluate((element: HTMLElement) => element.click());
  await expect(page).toHaveURL(/\/people\/[^/]+$/);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(listHref);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(mainTop);
  await expect.poll(() => page.getByRole("grid", { name: t("people.table"), exact: true }).evaluate(element => element.scrollTop)).toBe(rosterTop);
  expect(fixture.unexpected).toEqual([]);
});
