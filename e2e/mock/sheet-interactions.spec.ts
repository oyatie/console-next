// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { expectAxe } from "../a11y";
import { routeReady } from "../flows";
import { mockLifecycleSheets } from "./lifecycle-sheets";
import { mockScreen } from "./screen";
import { attendanceBoardScreens } from "../states/attendance";
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
  await sheet.getByRole("textbox", { name: tg("sheet.reason") }).focus();
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

test("a search input does not make a Sheet dirty", async ({ page }) => {
  const sheet = await openFormSheet(page);
  const search = await sheet.evaluateHandle(element => {
    const input = document.createElement("input");
    input.type = "search";
    input.setAttribute("aria-label", "목록 검색");
    element.querySelector("textarea")!.parentElement!.append(input);
    return input;
  });
  await search.asElement()!.fill("검색어");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("Escape outside a dock leaves it open and reaches the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/_gallery");
  const dock = page.getByRole("complementary", { name: tg("dockSheet.title"), exact: true });
  await expect(dock).toBeVisible();
  await page.getByRole("button", { name: tg("dockSheet.open"), exact: true }).focus();
  await page.evaluate(() => document.addEventListener("keydown", event => {
    if (event.key === "Escape") document.body.dataset.pageEscape = "received";
  }, { once: true }));
  await page.keyboard.press("Escape");
  await expect(dock).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-page-escape", "received");
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

test("Escape dismissal cannot reach a dirty lower Sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_gallery");
  const lower = page.getByRole("dialog", { name: tg("dockSheet.title"), exact: true });
  await expect(lower).toBeVisible();
  const lowerDraft = await lower.getByText(tg("dockSheet.body"), { exact: true }).evaluateHandle(element => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "아래 초안");
    element.parentElement!.append(input);
    return input;
  });
  await lowerDraft.asElement()!.fill("남아야 하는 아래 내용");
  await page.getByRole("button", { name: tg("sheet.open"), exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.click());
  const upper = page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
  await expect(upper).toBeVisible();
  await upper.getByRole("textbox", { name: tg("sheet.reason") }).fill("위 내용");
  await lower.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await expect(lower.getByRole("status")).toHaveCount(0);
  await expect(lower).toBeVisible();
  await expect(upper).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(upper.getByRole("status")).toHaveText(t("composer.unsaved"));
  await expect(lower.getByRole("status")).toHaveCount(0);
});

test("Back closes a clean top Sheet and keeps a dirty lower draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_gallery");
  await page.locator('[data-panel-trigger="populated"]').evaluate((button: HTMLElement) => button.click());
  const href = page.url();
  const lower = page.getByRole("dialog", { name: tg("dockSheet.title"), exact: true });
  const lowerDraft = await lower.getByText(tg("dockSheet.body"), { exact: true }).evaluateHandle(element => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "아래 초안");
    element.parentElement!.append(input);
    return input;
  });
  await lowerDraft.asElement()!.fill("뒤로 가도 남는 아래 내용");
  await page.getByRole("button", { name: tg("sheet.open"), exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.click());
  const upper = page.getByRole("dialog", { name: tg("sheet.title"), exact: true });
  await expect(upper).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(href);
  await expect(upper).toHaveCount(0);
  await expect(lower.getByRole("textbox", { name: "아래 초안" })).toHaveValue("뒤로 가도 남는 아래 내용");
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(href);
  await expect(lower.getByRole("status")).toHaveText(t("composer.unsaved"));
});

test("Back restores the shell scroller on a non-table screen", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await page.goto("/org");
  await routeReady(page, "/org");
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
  await routeReady(page, "/");
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/org$/);
  await routeReady(page, "/org");
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(top);
  expect(fixture.unexpected).toEqual([]);
});

test("Back restores the shell scroller without replacing roster restoration", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "large");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await page.goto("/people");
  await routeReady(page, "/people");
  await page.addStyleTag({ content: "#main::after { content: ''; display: block; height: 1800px; }" });
  const main = page.locator("#main");
  const roster = page.getByRole("grid", { name: t("people.table"), exact: true });
  await expect(roster).toHaveAttribute("aria-rowcount", "2001");
  await main.evaluate(element => { element.scrollTop = 500; });
  await main.dispatchEvent("scroll");
  const selectionTop = await main.evaluate(element => element.scrollTop);
  expect(selectionTop).toBeGreaterThan(0);
  await roster.evaluate(element => { element.scrollTop = 640; });
  await roster.dispatchEvent("scroll");
  const rosterTop = await roster.evaluate(element => element.scrollTop);
  expect(rosterTop).toBeGreaterThan(0);
  const row = roster.locator('[role="row"][data-row-id]').first();
  await row.getByRole("rowheader").last().evaluate((element: HTMLElement) => element.click());
  const panel = page.getByRole("complementary", { name: t("people.panel"), exact: true });
  await expect(panel).toBeVisible();
  await routeReady(page);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(selectionTop);
  const listHref = page.url();
  await main.focus();
  await main.evaluate(element => { element.scrollTop = 1000; });
  await main.dispatchEvent("scroll");
  await page.waitForTimeout(200);
  const mainTop = await main.evaluate(element => element.scrollTop);
  expect(mainTop).toBeGreaterThan(0);
  await panel.getByRole("link", { name: t("people.panel.open"), exact: false }).evaluate((element: HTMLElement) => element.click());
  await expect(page).toHaveURL(/\/people\/[^/]+$/);
  await routeReady(page);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(listHref);
  await routeReady(page);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(mainTop);
  await expect.poll(() => page.getByRole("grid", { name: t("people.table"), exact: true }).evaluate(element => element.scrollTop)).toBe(rosterTop);
  expect(fixture.unexpected).toEqual([]);
});

test("Back reapplies the shell position after slow content grows", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await page.goto("/org");
  await routeReady(page, "/org");
  await page.addStyleTag({ content: "#main::after { content: ''; display: block; height: var(--restore-height, 1800px); }" });
  const main = page.locator("#main");
  await expect.poll(() => main.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1000);
  await main.evaluate(element => { element.scrollTop = 1000; });
  await main.dispatchEvent("scroll");
  const top = await main.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(500);
  await page.locator('a[href="/"]').first().evaluate((element: HTMLElement) => element.click());
  await expect(page).toHaveURL(/\/$/);
  await routeReady(page, "/");
  await main.evaluate((element: HTMLElement) => element.style.setProperty("--restore-height", "0px"));
  await page.goBack();
  await expect(page).toHaveURL(/\/org$/);
  await routeReady(page, "/org");
  await expect.poll(() => main.evaluate(element => element.scrollTop)).not.toBe(top);
  await main.evaluate((element: HTMLElement) => element.style.setProperty("--restore-height", "1800px"));
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(top);
  expect(fixture.unexpected).toEqual([]);
});

test("a real Sheet draft survives confirmed close and reopen", async ({ page }) => {
  const fixture = await mockScreen(page, attendanceBoardScreens[3], "populated");
  try {
    await page.goto("/attendance?tab=schedule&view=crews&month=2026-10");
    await page.getByRole("button", { name: t("attendanceCrews.crews.add"), exact: true }).first().click();
    let sheet = page.getByRole("dialog", { name: t("attendanceCrews.crews.add"), exact: true });
    await sheet.getByLabel(t("attendanceCrews.crews.workplace"), { exact: false }).selectOption({ index: 1 });
    await sheet.getByLabel(t("attendanceCrews.crews.name"), { exact: false }).fill("초안 교대조");
    await page.keyboard.press("Escape");
    await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await page.getByRole("button", { name: t("attendanceCrews.crews.add"), exact: true }).first().click();
    sheet = page.getByRole("dialog", { name: t("attendanceCrews.crews.add"), exact: true });
    await expect(sheet.getByLabel(t("attendanceCrews.crews.name"), { exact: false })).toHaveValue("초안 교대조");
    await expect(sheet.getByLabel(t("attendanceCrews.crews.workplace"), { exact: false })).not.toHaveValue("");
    await expect(sheet.getByRole("status")).toContainText(t("draft.restored"));
    await expectAxe(page, "restored Sheet draft", { include: "[role=dialog]" });
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
