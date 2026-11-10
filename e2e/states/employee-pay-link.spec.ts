// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "../mock/screen";
import { authz, screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockLifecycleSheets, moveDetail } from "../mock/lifecycle-sheets";
import { lifecycleSheetScreens } from "./lifecycle-sheets";
import { payrollScreens } from "./payroll";
import { draft, mockEmployeePay } from "../mock/employee-pay";
import { expectAxe, fits } from "../a11y";

test.beforeAll(() => loadCatalog("ko"));
for (const viewer of ["hr", "exited", "reviewer", "denied", "unready"] as const) {
  for (const [width, colorScheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const) {
    test(`personnel payroll link ${viewer} ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await mockScreen(page, payrollScreens[0], "populated");
      await mockEmployeePay(page, "populated", Promise.resolve());
      await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
      await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, id: draft.employee_id, name: draft.employee_name, status: viewer === "exited" ? "EXITED" : "ACTIVE" } } });
      if (viewer === "reviewer") await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
      const peopleAccess = screenAccess("/people/synthetic");
      const payrollAccess = screenAccess("/payroll/employees/synthetic");
      await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...peopleAccess, entries: [...peopleAccess.entries, ...(viewer === "denied" ? [] : payrollAccess.entries)], decisions: { ...peopleAccess.decisions, ...Object.fromEntries(Object.keys(payrollAccess.decisions ?? {}).map(action => [action, viewer !== "denied"])) } } });
      await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: [{ key: "people", ready: true, unblock: null }, { key: "payroll", ready: viewer !== "unready", unblock: null }] });
      try {
        await page.goto(`/people/${draft.employee_id}`);
        const person = page.getByRole("main");
        await expect(person.getByRole("heading", { name: draft.employee_name, exact: true })).toBeVisible();
        const link = person.getByRole("link", { name: t("payroll.employee.title"), exact: true });
        const permitted = viewer !== "denied" && viewer !== "unready";
        await page.screenshot({ path: test.info().outputPath("personnel.png"), fullPage: true });
        await expect(link).toHaveCount(permitted ? 1 : 0);
        await fits(page, `personnel payroll link ${viewer} ${width} ${colorScheme}`);
        await expectAxe(page, `personnel payroll link ${viewer} ${width} ${colorScheme}`);
        if (permitted) {
          await expect(link).toHaveClass("link");
          await expect(link).toHaveAttribute("href", `/payroll/employees/${draft.employee_id}`);
          await link.click();
          await expect(page).toHaveURL(`/payroll/employees/${draft.employee_id}`);
          await expect(page.getByRole("main").getByRole("heading", { name: t("payroll.employee.title"), exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: t("payroll.employee.pick"), exact: true })).toBeVisible();
          await page.getByLabel(t("payroll.period"), { exact: false }).fill(draft.period.start.slice(0, 7));
          await page.getByLabel(t("payroll.setup.day"), { exact: false }).fill(draft.pay_date);
          await page.getByRole("button", { name: t("payroll.employee.preview"), exact: true }).click();
          await expect(page.getByRole("region", { name: draft.employee_name, exact: true })).toBeVisible();
        }
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}
