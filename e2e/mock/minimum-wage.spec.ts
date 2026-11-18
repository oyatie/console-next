// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { test } from "../locale-fixture";
import { i18n, loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { payrollScreens } from "../states/payroll";
import { mockScreen } from "./screen";
import { employeePayScreen, minimumWageDraft } from "./employee-pay";

for (const year of [2026, 2027] as const) for (const locale of ["en", "ko"] as const)
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    test(`minimum wage on pay date: ${year} ${locale} ${width} ${theme}`, async ({ page }) => {
      await loadCatalog(locale);
      i18n.set(locale);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem("console.locale", locale);
        localStorage.setItem("console.theme", theme);
      }, { locale, theme });
      const fixture = await mockScreen(page, payrollScreens[0], "populated");
      const data = minimumWageDraft(year);
      const check = data.minimum_wage_check!;
      await page.route("**/api/v1/payroll/employees/*/payslip-draft?*", route => route.fulfill({ json: data }));
      await page.goto(employeePayScreen.path.replace("pay_date=2026-11-05", `pay_date=${data.pay_date}`));
      const main = page.getByRole("main");
      const blockers = main.getByRole("list", { name: t("payroll.employee.blockers") });
      await expect(blockers.getByRole("listitem")).toContainText(t("payroll.employee.minimumBelow"));
      await expect(blockers).toContainText(check.instrument.promulgation_ko);
      await expect(blockers).not.toContainText("MINIMUM_WAGE_BELOW_FLOOR");
      const minimum = main.getByRole("region", { name: t("payroll.employee.minimumWage"), exact: true });
      await expect(minimum.getByText(t("payroll.employee.won", { amount: fmtNumber(check.hourly_floor_won) }), { exact: true })).toBeVisible();
      await expect(minimum.getByText(t("payroll.employee.won", { amount: fmtNumber(check.monthly_209h_floor_won) }), { exact: true })).toBeVisible();
      await expect(minimum).toContainText(check.instrument.promulgation_ko);
      await fits(page, `minimum wage ${year} ${locale} ${width} ${theme}`);
      await expectAxe(page, `minimum wage ${year} ${locale} ${width} ${theme}`);
      await minimum.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath("minimum-wage.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    });
  }
