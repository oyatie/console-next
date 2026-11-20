// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { employees, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

test("the roster search shortcut returns to people search after a successful retry @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "failed");
  try {
    await page.goto("/people");
    const retry = page.getByRole("button", { name: t("common.retry"), exact: true });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: t("shell.jumpLabel"), exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const items = employees(fixture.count);
    await mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items, total: items.length, offset: 0, limit: 100, next_cursor: null } });
    await retry.click();
    await expect(page.getByRole("grid", { name: t("people.table") })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: t("peopleJump.label"), exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});

for (const width of [1440, 390]) {
  test(`list-record baseline: populated at ${width}px @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
    await page.goto("/_review/patterns/list-record");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("roster.head.title"));
    await expect(main.getByRole("grid", { name: t("people.table") })).toBeVisible();
    await expect(main.getByRole("link", { name: t("roster.page.roster"), exact: true })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("button", { name: t("roster.view.current"), exact: true })).toHaveAttribute("aria-pressed", "true");
    // Keyboard activation reaches both the visible primary and the narrow command menu.
    const register = main.getByRole("button", { name: t("people.register"), exact: true });
    await register.focus();
    await page.keyboard.press("Enter");
    const registerDialog = page.getByRole("dialog", { name: t("people.register") });
    await expect(registerDialog).toBeVisible();
    await expect(page.locator('[role="dialog"]:focus, [role="dialog"] :focus')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(registerDialog).toBeHidden();
    await expect(register).toBeFocused();
    if (width === 390) {
      await main.getByRole("button", { name: t("common.more"), exact: true }).click();
      await page.getByRole("menuitem", { name: t("roster.head.import"), exact: true }).click();
    } else {
      const command = main.getByRole("button", { name: t("roster.head.import"), exact: true });
      await command.focus();
      await page.keyboard.press("Enter");
    }
    const importDialog = page.getByRole("dialog", { name: t("roster.head.import") });
    await expect(importDialog).toBeVisible();
    await expect(page.locator('[role="dialog"]:focus, [role="dialog"] :focus')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(importDialog).toBeHidden();
    if (width === 1440) {
      await main.getByRole("grid").getByRole("row").nth(1).dblclick();
      const record = main.getByRole("complementary", { name: t("people.panel"), exact: true });
      await expect(record).toBeVisible();
      await record.getByRole("button", { name: t("roster.panel.unit"), exact: true }).click();
      await expect(main.getByRole("complementary", { name: t("roster.panel.unit"), exact: true })).toBeVisible();
    }
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await fits(page, `list-record/${width}/${theme}`);
      await expectAxe(page, `list-record populated/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`list-record-${width}-${theme}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}

test("list-record baseline: refused at 390px @ui-state", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
  await page.goto("/_review/patterns/list-record?state=refused");
  const main = page.getByRole("main");
  await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(main.getByRole("link", { name: t("roster.page.roster"), exact: true })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("grid")).toHaveCount(0);
  await expect(main.getByRole("complementary")).toHaveCount(0);
  await expect(main.getByRole("button", { name: t("people.register"), exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: t("roster.head.import"), exact: true })).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(page, `list-record/refused/${theme}`);
    await expectAxe(page, `list-record refused/390/${theme}`);
    await page.screenshot({ path: info.outputPath(`list-record-refused-${theme}.png`), fullPage: true });
  }
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

test("the first-run roster ignores selected-pane URLs at 390px @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "empty");
  try {
    await page.goto(`/people?sel=${id(10)}&sel2=${id(20)}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: t("roster.first.title"), exact: true })).toBeVisible();
    await expect(main.getByRole("complementary")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
