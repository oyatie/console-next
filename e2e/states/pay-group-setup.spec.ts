// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { failure, id, screenAccess } from "../mock/fixtures";
import { payGroups } from "../mock/payroll";
import { payrollScreens } from "./payroll";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";

test.beforeAll(() => loadCatalog("ko"));
const label = (key: string) => t(key as Parameters<typeof t>[0]);
async function fill(sheet: Locator, numeric = false, withBases = true) {
  await sheet.getByLabel(t("payroll.entity"), { exact: false }).selectOption(id(801));
  await sheet.getByLabel(t("payroll.setup.name"), { exact: false }).fill("모의 신규 그룹");
  const pay = sheet.getByRole("group", { name: t("payroll.payDateRule"), exact: false });
  await pay.getByLabel(t("payroll.setup.month"), { exact: false }).selectOption("1");
  await pay.getByLabel(t("payroll.setup.day"), { exact: false }).selectOption(numeric ? "31" : "LAST_DAY");
  await pay.getByLabel(t("payroll.setup.holiday"), { exact: false }).selectOption("NEXT");
  for (const [period, month, day] of [["basePeriod", "0", numeric ? "28" : "FIRST"], ["variablePeriod", "-1", "16"]]) {
    const group = sheet.getByRole("group", { name: label(`payroll.${period}`), exact: false });
    await group.getByLabel(t("payroll.setup.month"), { exact: false }).selectOption(month!);
    await group.getByLabel(t("payroll.setup.startDay"), { exact: false }).selectOption(day!);
  }
  await sheet.getByLabel(t("payroll.proration"), { exact: false }).selectOption("SCHEDULED_WORKDAYS");
  await sheet.getByLabel(t("payroll.channel"), { exact: false }).selectOption("FILE_GENERIC");
  await sheet.getByLabel(t("payroll.sensitive"), { exact: false }).selectOption(numeric ? "false" : "true");
  if (withBases) {
    await sheet.getByRole("checkbox", { name: t("payroll.rule.MONTHLY"), exact: true }).press("Space");
    await sheet.getByRole("checkbox", { name: t("payroll.rule.HOURLY"), exact: true }).press("Space");
  }
}

for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`explicit setup creates a group and refreshes its card at ${width}px ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "empty");
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll/setup") }));
  const writes: components["schemas"]["CreatePayGroup"][] = [];
  let created: components["schemas"]["PayGroup"] | undefined;
  await page.route("**/api/v1/payroll/pay-groups", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ...payGroups, items: created ? [created] : [] } });
    writes.push(route.request().postDataJSON());
    created = { ...writes[0]!, id: id(819) };
    await route.fulfill({ status: 201, json: created });
  });
  try {
    await page.goto("/payroll");
    const rail = page.getByRole("region", { name: t("payroll.setup.title"), exact: true });
    await rail.getByRole("link", { name: t("payroll.setup.add"), exact: true }).click();
    await expect(page).toHaveURL(/\/payroll\/setup$/);
    await expect(page.getByRole("main").getByText(t("payroll.setup.groupCount", { count: 0 }), { exact: true })).toBeVisible();
    await expect(page.getByText(t("payroll.setup.explicit"), { exact: true })).toHaveCount(0);
    await page.getByRole("main").getByRole("button", { name: t("payroll.setup.add"), exact: true }).click();
    const sheet = page.getByRole("dialog", { name: t("payroll.setup.add"), exact: true });
    await expect(sheet).toBeVisible();
    await expect(page.getByText(t("payroll.setup.explicit"), { exact: true })).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: t("composer.section.effects"), exact: true })).toHaveCount(0);
    const choices = sheet.getByRole("combobox");
    for (const choice of await choices.all()) await expect(choice).toHaveValue("");
    await expect(sheet.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    await expect(sheet.getByRole("alert")).toHaveText(t("payroll.setup.required"));
    await expect(page.getByText(t("payroll.setup.explicit"), { exact: true })).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: t("composer.section.effects"), exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    await fits(page, `pay-group-setup/invalid/${width}`);
    await expectAxe(page, `pay-group-setup/invalid/${width}`);
    await page.screenshot({ path: test.info().outputPath(`pay-group-setup-invalid-${width}.png`) });
    await fill(sheet, width === 390, false);
    await sheet.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    await expect(sheet.getByText(t("payroll.setup.basisRequired"), { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await sheet.getByRole("checkbox", { name: t("payroll.rule.MONTHLY"), exact: true }).press("Space");
    await sheet.getByRole("checkbox", { name: t("payroll.rule.HOURLY"), exact: true }).press("Space");
    await expect(sheet.getByRole("heading", { name: t("composer.section.effects"), exact: true })).toBeVisible();
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await fits(page, `pay-group-setup/${width}`);
    await expectAxe(page, `pay-group-setup/${width}`);
    await page.screenshot({ path: test.info().outputPath(`pay-group-setup-${width}.png`) });
    await sheet.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(writes).toEqual([{
      legal_entity_id: id(801), name: "모의 신규 그룹",
      pay_date_rule: { day: width === 390 ? 31 : "LAST_DAY", month_offset: 1, non_business_day: "NEXT" },
      base_period: { start_day: width === 390 ? 28 : "FIRST", month_offset: 0 }, variable_period: { start_day: 16, month_offset: -1 },
      proration: "SCHEDULED_WORKDAYS", channel: "FILE_GENERIC", sensitive: width !== 390, pay_basis_allowed: ["MONTHLY", "HOURLY"],
    }]);
    await page.getByRole("main").getByRole("link", { name: t("payroll.title"), exact: true }).click();
    const card = page.getByRole("region", { name: "모의 신규 그룹", exact: true });
    await expect(card).toContainText("모의상사 해외법인");
    for (const key of ["sensitive", "payBasisAllowed", "rule.MONTHLY", "rule.HOURLY", width === 390 ? "rule.sensitive.false" : "rule.sensitive.true"])
      await expect(card).toContainText(label(`payroll.${key}`));
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("server refusal preserves all choices and cancel sends no additional command", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  let writes = 0;
  await page.route("**/api/v1/payroll/pay-groups", route => {
    if (route.request().method() === "GET") return route.fallback();
    writes++;
    return route.fulfill({ status: 403, json: failure("forbidden") });
  });
  try {
    await page.goto("/payroll/setup");
    await page.getByRole("main").getByRole("button", { name: t("payroll.setup.add"), exact: true }).click();
    const sheet = page.getByRole("dialog");
    await fill(sheet);
    await sheet.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    await expect(sheet.getByRole("alert")).toBeVisible();
    await expect(sheet.getByRole("alert")).toContainText("forbidden");
    await expect(sheet.getByLabel(t("payroll.setup.name"), { exact: false })).toHaveValue("모의 신규 그룹");
    await expect(sheet.getByLabel(t("payroll.sensitive"), { exact: false })).toHaveValue("true");
    const close = sheet.getByRole("button", { name: t("uiSheet.close"), exact: true });
    await close.click();
    await expect(sheet.getByRole("status")).toHaveText(t("composer.unsaved"));
    await close.click();
    await expect(sheet).toHaveCount(0);
    expect(writes).toBe(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("redacted group facts are shown as unknown rather than false or an empty pay basis", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await page.route("**/api/v1/payroll/pay-groups", route => route.fulfill({ json: { ...payGroups, items: [{ ...payGroups.items[0], sensitive: null, pay_basis_allowed: null }] } }));
  try {
    await page.goto("/payroll");
    const card = page.getByRole("region", { name: payGroups.items[0]!.name, exact: true });
    await expect(card.getByText(t("payroll.rule.unknown"), { exact: true })).toHaveCount(2);
    await expect(card.getByText(t("payroll.rule.sensitive.false"), { exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["loading", "failed", "refused"] as const) test(`setup read ${state} offers no create control`, async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], state);
  try {
    await page.goto("/payroll/setup");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: t("payroll.setup.page"), exact: true })).toBeVisible();
    if (state === "loading") await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
    else await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    await expect(main.getByRole("button", { name: t("payroll.setup.add"), exact: true })).toHaveCount(0);
    await expectAxe(page, `payroll-setup/${state}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["empty", "populated"] as const) test(`view-only payroll ${state} hides every setup action`, async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], state);
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll") }));
  try {
    await page.goto("/payroll");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: t("payroll.title"), exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: state === "empty" ? t("payroll.setup.title") : payGroups.items[0]!.name, exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: t("payroll.setup.add"), exact: true })).toHaveCount(0);
    await expect(main.getByRole("link", { name: t("payroll.reference.title"), exact: true }).first()).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("an empty legal entity list does not invent a company or offer a create command", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "empty");
  await page.route("**/api/v1/payroll/pay-groups", route => route.fulfill({ json: { items: [], legal_entities: [] } }));
  try {
    await page.goto("/payroll/setup");
    await expect(page.getByRole("main").getByText(t("payroll.setup.noEntities"), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t("payroll.setup.add"), exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("the payroll gallery opens the same blank setup sheet", async ({ page }) => {
  await page.goto("/_gallery?entry=payroll");
  await page.getByRole("button", { name: t("payroll.setup.add"), exact: true }).click();
  const sheet = page.getByRole("dialog", { name: t("payroll.setup.add"), exact: true });
  await expect(sheet).toBeVisible();
  for (const control of await sheet.getByRole("combobox").all()) await expect(control).toHaveValue("");
  await sheet.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
  await expect(sheet).toHaveCount(0);
});
