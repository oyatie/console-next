// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure, inbox } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

// The server's read is as of 2026-11-13 in Korea, so the picker's earliest day is the 14th. The device clock runs a
// day fast: the picker follows the server.
const AS_OF = "2026-11-13T03:00:00Z";
const NOW = new Date("2026-11-14T03:00:00Z");
const PRESETS = [
  { key: "short", date: "2026-11-14" },
  { key: "next_week", date: "2026-11-16" },
  { key: "long", date: "2026-11-20" },
] as const;

/**
 * Four items: one that may be postponed, one bounded by a legal deadline, one a decision someone waits on, and one
 * whose legal deadline leaves no later day.
 */
function queue() {
  const data = inbox(4);
  data.items[0]!.snooze = { allowed: true };
  data.items[1]!.snooze = { allowed: true, latest: "2026-11-15" };
  data.items[2]!.snooze = { allowed: false, reason: "blocks_others" };
  data.items[3]!.snooze = { allowed: false, latest: "2026-11-12" };
  return { ...data, as_of: AS_OF, snooze_presets: [...PRESETS] };
}

async function open(page: Page, data = queue()) {
  await page.clock.setFixedTime(NOW);
  const mock = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  const sent: { id: string; until: string }[] = [];
  await mockRoute(page, "post", "/api/v1/me/action-inbox/items/{id}/snooze", request => {
    sent.push({ id: decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2)!), until: request.postDataJSON().until });
    return { status: 204 };
  });
  await page.goto("/inbox");
  return { mock, sent, row: (i: number) => page.locator(`[data-id="${data.items[i]!.id}"]`) };
}

for (const width of [1440, 390]) test(`a row is postponed to a preset day, a legal deadline holds later days back, and a decision others wait on offers none, at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const { mock, sent, row } = await open(page);
  const snooze = { name: t("home.inbox.snooze"), exact: true };
  await expect(row(0).getByRole("button", snooze)).toBeVisible();
  await expect(row(2).getByRole("button", snooze)).toHaveCount(0);
  await expect(row(3).getByRole("button", snooze)).toHaveCount(0);

  await row(1).getByRole("button", snooze).click();
  const menu = page.getByRole("menu", { name: t("home.inbox.snooze"), exact: true });
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  await expect(menu.getByRole("menuitem", { name: new RegExp(t("home.inbox.snooze.short")) })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: new RegExp(t("home.inbox.snooze.short")) })).toContainText(fmtDate("2026-11-14", { weekday: "short" }));
  const later = menu.getByRole("menuitem", { name: new RegExp(t("home.inbox.snooze.next_week")) });
  await expect(later).toBeDisabled();
  await expect(later).toContainText(t("home.inbox.snooze.latest", { date: fmtDate("2026-11-15") }));
  await fits(page, `inbox snooze menu ${width}`);
  await expectAxe(page, `inbox snooze menu ${width}`);
  await page.screenshot({ path: info.outputPath(`inbox-snooze-menu-${width}.png`), fullPage: true });
  await page.keyboard.press("Escape");

  await row(0).getByRole("button", snooze).click();
  await menu.getByRole("menuitem", { name: new RegExp(t("home.inbox.snooze.long")) }).click();
  await expect.poll(() => sent).toEqual([{ id: queue().items[0]!.id, until: "2026-11-20" }]);
  // The row leaves the list with its trigger, so focus lands on the list's title rather than the page.
  await expect(page.locator("#inbox-title")).toBeFocused();
  expect(mock.unexpected).toEqual([]);
});

test("a picked day stays inside its bounds before anything is sent", async ({ page }) => {
  const { mock, sent, row } = await open(page);
  await row(1).getByRole("button", { name: t("home.inbox.snooze"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("home.inbox.snooze.pick") }).click();
  const dialog = page.getByRole("dialog", { name: t("home.inbox.snooze.pick"), exact: true });
  const day = dialog.getByRole("textbox", { name: new RegExp(t("home.inbox.snooze.until")) });
  const submit = dialog.getByRole("button", { name: t("home.inbox.snooze"), exact: true });
  await day.fill("20261116");
  await day.blur();
  await expect(dialog).toContainText(t("home.inbox.snooze.latest", { date: fmtDate("2026-11-15") }));
  await expect(submit).toBeDisabled();
  await day.fill("20261115");
  await day.blur();
  await submit.click();
  await expect(dialog).toBeHidden();
  expect(sent).toEqual([{ id: queue().items[1]!.id, until: "2026-11-15" }]);
  await expect(page.locator("#inbox-title")).toBeFocused();
  expect(mock.unexpected).toEqual([]);
});

test("a day the server no longer takes is refused inside the picker", async ({ page }) => {
  const { mock, row } = await open(page);
  await mockRoute(page, "post", "/api/v1/me/action-inbox/items/{id}/snooze", { status: 422, json: failure("snooze_past") });
  await row(0).getByRole("button", { name: t("home.inbox.snooze"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("home.inbox.snooze.pick") }).click();
  const dialog = page.getByRole("dialog", { name: t("home.inbox.snooze.pick"), exact: true });
  const day = dialog.getByRole("textbox", { name: new RegExp(t("home.inbox.snooze.until")) });
  await day.fill("20261114");
  await day.blur();
  await dialog.getByRole("button", { name: t("home.inbox.snooze"), exact: true }).click();
  await expect(dialog).toContainText(t("common.failed.code.snooze_past"));
  await expect(dialog).toBeVisible();
  expect(mock.unexpected).toEqual([]);
});

test("a refused postponement says why in place and the item stays", async ({ page }) => {
  const { mock, row } = await open(page);
  await mockRoute(page, "post", "/api/v1/me/action-inbox/items/{id}/snooze", { status: 422, json: failure("snooze_past_legal_due") });
  await row(0).getByRole("button", { name: t("home.inbox.snooze"), exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(t("home.inbox.snooze.short")) }).click();
  await expect(row(0)).toContainText(t("common.failed.code.snooze_past_legal_due"));
  expect(mock.unexpected).toEqual([]);
});

test("the snoozed chip opens what I postponed, with its day, and brings one back now", async ({ page }, info) => {
  const data = queue();
  data.counts.snoozed = { total: 1, total_is_exact: true };
  const parked = inbox(1);
  parked.items[0]!.snooze = { allowed: true, until: "2026-11-20" };
  await page.clock.setFixedTime(NOW);
  const mock = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", request => ({ status: 200, json: new URL(request.url()).searchParams.get("snoozed") === "only" ? parked : data }));
  const back: string[] = [];
  await mockRoute(page, "delete", "/api/v1/me/action-inbox/items/{id}/snooze", request => {
    back.push(decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2)!));
    return { status: 204 };
  });
  await page.goto("/inbox");
  const chip = page.getByRole("button", { name: new RegExp(t("home.inbox.filter.snoozed")) });
  await expect(chip).toContainText("1");
  await chip.click();
  await expect(page).toHaveURL(/tab=snoozed/);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // The snoozed view is another card: the chip is drawn anew and keeps the focus.
  await expect(chip).toBeFocused();
  const row = page.locator(`[data-id="${parked.items[0]!.id}"]`);
  await expect(row).toContainText(t("home.inbox.snooze.returns", { date: fmtDate("2026-11-20", { weekday: "short" }) }));
  await expect(row.getByRole("button", { name: t("home.inbox.snooze"), exact: true })).toHaveCount(0);
  await fits(page, "inbox snoozed view");
  await expectAxe(page, "inbox snoozed view");
  await page.screenshot({ path: info.outputPath("inbox-snoozed.png"), fullPage: true });
  await row.getByRole("button", { name: t("home.inbox.snooze.back"), exact: true }).click();
  await expect.poll(() => back).toEqual([parked.items[0]!.id]);
  await expect(page.locator("#inbox-title")).toBeFocused();
  expect(mock.unexpected).toEqual([]);
});
