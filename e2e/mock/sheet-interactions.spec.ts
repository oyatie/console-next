// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { expectAxe } from "../a11y";
import { go, routeReady } from "../flows";
import { AT, id, user } from "./fixtures";
import { mockLifecycleSheets } from "./lifecycle-sheets";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
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

test("a search input and a reverted value leave a Sheet clean", async ({ page }) => {
  const sheet = await openFormSheet(page);
  await sheet.evaluate(element => {
    const input = document.createElement("input");
    input.type = "search";
    input.setAttribute("aria-label", "목록 검색");
    element.querySelector("textarea")!.parentElement!.append(input);
  });
  await sheet.getByRole("searchbox", { name: "목록 검색" }).fill("검색어");
  const draft = sheet.getByRole("textbox", { name: tg("sheet.reason") });
  await draft.fill("검토 중인 내용");
  await draft.fill("");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("uncommitted combobox filter text in 직원 등록 closes cleanly, while a committed pick asks", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  await page.goto("/people/new");
  const probe = page.getByRole("dialog", { name: t("register.title"), exact: true });
  const placement = probe.getByRole("combobox", { name: t("register.place.label"), exact: true });
  await placement.fill("부산");
  await expect(page.getByRole("option", { name: /부산사업장/ }).first()).toBeVisible();
  await placement.press("Escape");
  await probe.getByRole("button", { name: t("uiSheet.close"), exact: true }).last().click();
  await expect(probe).toBeHidden();

  await go(page, `/people/${id(4000)}?act=TRANSFER`);
  const transfer = page.getByRole("dialog");
  await transfer.getByRole("combobox").first().fill("인사");
  await page.getByRole("option", { name: /인사팀/ }).first().click();
  await page.keyboard.press("Escape");
  await expect(transfer.getByText(t("composer.unsaved"), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
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
  await page.evaluate(() => history.back());
  await expect(page).not.toHaveURL(href);
  await expect(page).not.toHaveURL(/sel=/);
  await expect(sheet).toHaveCount(0);
  await showFormSheet(page);
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
  await page.goto("/_gallery#prior");
  await go(page, "/_gallery");
  const href = page.url();
  await page.locator('[data-panel-trigger="populated"]').evaluate((button: HTMLElement) => button.click());
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

test("Back from a URL-opened Sheet (PUSH onClose) leaves no dead history entry", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  await go(page, "/");
  await go(page, "/people/new");
  await expect(page.getByRole("dialog", { name: t("register.title"), exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await routeReady(page, "/");
  await expect(page.getByRole("dialog", { name: t("register.title"), exact: true })).toHaveCount(0);
  await go(page, "/org?tab=entities");
  await page.getByRole("link", { name: t("entityQuick.title"), exact: true }).first().click();
  await expect(page).toHaveURL(/add=true/);
  await expect(page.getByRole("dialog", { name: t("entityQuick.title"), exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/org\?tab=entities$/);
  await expect(page.getByRole("dialog", { name: t("entityQuick.title"), exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await routeReady(page, "/");
  expect(fixture.unexpected).toEqual([]);
});

test("Back from a URL-opened Sheet (REPLACE onClose) leaves no dead history entry", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await go(page, "/");
  const cardPath = `/people/${id(4000)}`;
  await go(page, cardPath);
  await page.getByRole("button", { name: "부서 전보로", exact: true }).click();
  await expect(page).toHaveURL(/act=TRANSFER/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${cardPath}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await routeReady(page, "/");
  expect(fixture.unexpected).toEqual([]);
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
  await page.addStyleTag({ content: "#main > [data-read-region] { display: block; min-height: var(--restore-height, 1800px); }" });
  const main = page.locator("#main");
  await expect.poll(() => main.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1000);
  await main.evaluate(element => { element.scrollTop = 1000; });
  await main.dispatchEvent("scroll");
  const top = await main.evaluate(element => element.scrollTop);
  expect(top).toBeGreaterThan(500);
  await page.locator('a[href="/"]').first().evaluate((element: HTMLElement) => element.click());
  await expect(page).toHaveURL(/\/$/);
  await routeReady(page, "/");
  await page.evaluate(() => document.documentElement.style.setProperty("--restore-height", "0px"));
  await page.goBack();
  await expect(page).toHaveURL(/\/org$/);
  await routeReady(page, "/org");
  await expect.poll(() => main.evaluate(element => element.scrollTop)).not.toBe(top);
  await page.evaluate(() => document.documentElement.style.setProperty("--restore-height", "1800px"));
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
    await page.keyboard.press("Escape");
    await expect(sheet.getByText(t("composer.unsaved"), { exact: true })).toBeVisible();
    await expectAxe(page, "restored Sheet draft", { include: "[role=dialog]" });
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});


test("Escape inside a clean wide DockSheet closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/_gallery?entry=dock-sheet");
  const dock = page.getByRole("complementary", { name: tg("dockSheet.title"), exact: true });
  await dock.getByRole("heading").focus();
  await page.keyboard.press("Escape");
  await expect(dock).toHaveCount(0);
});

test("a committed picker change clears an armed Sheet prompt", async ({ page }) => {
  const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
  await page.goto(lifecycleSheetScreens[0].path);
  const sheet = page.getByRole("dialog");
  const picker = sheet.getByRole("combobox").first();
  await picker.fill("인사");
  await page.getByRole("option", { name: /인사팀/ }).first().click();
  await page.keyboard.press("Escape");
  const prompt = sheet.getByText(t("composer.unsaved"), { exact: true });
  await expect(prompt).toBeVisible();
  await picker.locator("..").getByRole("button").click();
  await page.getByRole("option", { name: /재무팀/ }).first().click();
  await expect(prompt).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(prompt).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Escape on an expanded picker leaves a dirty Sheet unarmed", async ({ page }) => {
  const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
  await page.goto(lifecycleSheetScreens[0].path);
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("textbox", { name: /^사유/ }).fill("배치 검토");
  const picker = sheet.getByRole("combobox").first();
  await picker.fill("인사");
  await expect(page.getByRole("option", { name: /인사팀/ }).first()).toBeVisible();
  await picker.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sheet.getByText(t("composer.unsaved"), { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet.getByText(t("composer.unsaved"), { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Escape from a listbox with DOM focus leaves a dirty Sheet unarmed", async ({ page }) => {
  const sheet = await openFormSheet(page);
  const draft = sheet.getByRole("textbox", { name: tg("sheet.reason") });
  await draft.fill("배치 검토");
  // A picker may put DOM focus in its list instead of retaining virtual focus on its combobox.
  await draft.evaluate(element => {
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "선택 목록");
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    option.tabIndex = 0;
    option.textContent = "선택지";
    list.append(option);
    element.parentElement!.append(list);
  });
  await sheet.getByRole("option", { name: "선택지", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(sheet.getByRole("status")).toHaveCount(0);
  await draft.focus();
  await page.keyboard.press("Escape");
  await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
});
