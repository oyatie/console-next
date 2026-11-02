// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tenantInSetup } from "./setup-flows";
import { go } from "./flows";
import { commitLabel } from "../apps/web/src/ui/composer/actions";

test.beforeAll(() => loadCatalog("ko"));
test("pay group setup persists every explicit rule through the real service", async ({ browser }) => {
  const { admin, exec } = await tenantInSetup(browser, "pay-group-setup", "모의급여설정상사", false, "본점", "none");
  try {
    await go(admin, "/payroll/setup");
    await admin.getByRole("main").getByRole("button", { name: t("payroll.setup.add"), exact: true }).click();
    const sheet = admin.getByRole("dialog", { name: t("payroll.setup.add"), exact: true });
    await sheet.getByLabel(t("payroll.entity"), { exact: false }).selectOption({ label: "주식회사 모의급여설정상사" });
    await sheet.getByLabel(t("payroll.setup.name"), { exact: false }).fill("모의 월급 그룹");
    const pay = sheet.getByRole("group", { name: t("payroll.payDateRule"), exact: false });
    await pay.getByLabel(t("payroll.setup.month"), { exact: false }).selectOption("0");
    await pay.getByLabel(t("payroll.setup.day"), { exact: false }).selectOption("LAST_DAY");
    await pay.getByLabel(t("payroll.setup.holiday"), { exact: false }).selectOption("PREVIOUS");
    for (const period of ["basePeriod", "variablePeriod"] as const) {
      const group = sheet.getByRole("group", { name: t(`payroll.${period}`), exact: false });
      await group.getByLabel(t("payroll.setup.month"), { exact: false }).selectOption("0");
      await group.getByLabel(t("payroll.setup.startDay"), { exact: false }).selectOption("FIRST");
    }
    await sheet.getByLabel(t("payroll.proration"), { exact: false }).selectOption("CALENDAR_DAYS");
    await sheet.getByLabel(t("payroll.channel"), { exact: false }).selectOption("ATTESTATION_ONLY");
    await sheet.getByLabel(t("payroll.sensitive"), { exact: false }).selectOption("false");
    await sheet.getByRole("checkbox", { name: t("payroll.rule.MONTHLY"), exact: true }).press("Space");
    const saved = admin.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/payroll/pay-groups");
    await sheet.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      name: "모의 월급 그룹", sensitive: false, pay_basis_allowed: ["MONTHLY"],
      pay_date_rule: { day: "LAST_DAY", month_offset: 0, non_business_day: "PREVIOUS" },
      base_period: { start_day: "FIRST", month_offset: 0 }, variable_period: { start_day: "FIRST", month_offset: 0 },
      proration: "CALENDAR_DAYS", channel: "ATTESTATION_ONLY",
    });
    await expect(sheet).toHaveCount(0);
    await go(admin, "/payroll");
    const card = admin.getByRole("region", { name: "모의 월급 그룹", exact: true });
    await expect(card).toContainText(t("payroll.rule.sensitive.false"));
    await expect(card).toContainText(t("payroll.rule.MONTHLY"));
    await admin.reload();
    await expect(card).toBeVisible();
  } finally { await admin.context().close(); await exec.context().close(); }
});
