// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
import { draft, employeePayScreen, mockEmployeePay } from "../mock/employee-pay";
import { failure } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { payrollScreens } from "./payroll";

test.beforeAll(() => loadCatalog("ko"));

for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`duplicate wage date preserves facts and permits a corrected date ${width} ${colorScheme} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await mockEmployeePay(page, "populated", Promise.resolve());
  const original = { effective_from: "2026-10-01", wage_kind: "MONTHLY", amount_won: 3999999, monthly_standard_hours: 173, source_note: "모의 근로계약서 제3조" };
  const writes: unknown[] = [];
  await page.route("**/api/v1/payroll/employees/*/contract-wages", route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    return body.effective_from === original.effective_from
      ? route.fulfill({ status: 409, json: failure("contract_wage_exists") })
      : route.fulfill({ status: 201, json: { id: draft.contract!.id } });
  });
  try {
    await page.goto(employeePayScreen.path);
    await page.getByRole("button", { name: t("payroll.employee.record"), exact: true }).click();
    const form = page.locator("[data-composer-root]");
    await form.getByLabel(t("payroll.employee.effective"), { exact: false }).fill(original.effective_from);
    await form.getByRole("combobox").selectOption(original.wage_kind);
    await form.getByLabel(t("payroll.employee.amount"), { exact: false }).fill(String(original.amount_won));
    await form.getByLabel(t("payroll.employee.hours"), { exact: false }).fill(String(original.monthly_standard_hours));
    await form.getByLabel(t("payroll.employee.source"), { exact: false }).fill(original.source_note);
    const submit = form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false });
    await submit.click();
    await expect(form.getByRole("alert")).toContainText("이 직원의 같은 적용 시작일에 계약 임금이 이미 등록되어 있습니다. 등록된 계약 임금을 확인하고 적용 시작일을 변경하십시오.");
    await expect(form.getByRole("alert")).toContainText("contract_wage_exists");
    await expect(form.getByRole("status")).toHaveCount(0);
    await expect(form.getByLabel(t("payroll.employee.effective"), { exact: false })).toHaveValue(fmtDate(original.effective_from));
    await expect(form.getByRole("combobox")).toHaveValue(original.wage_kind);
    await expect(form.getByLabel(t("payroll.employee.amount"), { exact: false })).toHaveValue(String(original.amount_won));
    await expect(form.getByLabel(t("payroll.employee.hours"), { exact: false })).toHaveValue(String(original.monthly_standard_hours));
    await expect(form.getByLabel(t("payroll.employee.source"), { exact: false })).toHaveValue(original.source_note);
    const contract = page.getByRole("region", { name: t("payroll.employee.contract"), exact: true });
    await expect(contract).toContainText(draft.contract!.source_note);
    await expect(contract.getByText("3,456,789원", { exact: true })).toBeVisible();
    await expect(contract.getByText("3,999,999원", { exact: true })).toHaveCount(0);
    await expect(form.getByRole("button", { name: t("requestOutcome.check"), exact: true })).toHaveCount(0);
    expect(writes).toEqual([original]);
    await form.scrollIntoViewIfNeeded();
    await fits(page, `contract-wage-conflict/${width}`);
    await expectAxe(page, `contract-wage-conflict/${width}`);
    await page.screenshot({ path: test.info().outputPath(`conflict-${width}-${colorScheme}.png`), fullPage: true });
    await form.getByLabel(t("payroll.employee.effective"), { exact: false }).fill("2026-11-01");
    await submit.click();
    await expect(form.getByRole("status")).toHaveText(t("payroll.employee.saved"));
    await expect(form.getByRole("alert")).toHaveCount(0);
    expect(writes).toEqual([original, { ...original, effective_from: "2026-11-01" }]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
