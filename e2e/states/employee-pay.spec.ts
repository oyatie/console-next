// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { mockScreen } from "../mock/screen";
import { payrollScreens } from "./payroll";
import { failure } from "../mock/fixtures";
import { mockLifecycleSheets, moveDetail } from "../mock/lifecycle-sheets";
import { lifecycleSheetScreens } from "./lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { draft, employeePayScreen, mockEmployeePay } from "../mock/employee-pay";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
test.beforeAll(() => loadCatalog("ko"));
for (const state of Object.keys(employeePayScreen.states)) for (const [width, colorScheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const) test(`employee pay ${state} ${width} ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockEmployeePay(page, state, held);
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/v1/payroll/")) writes.push(request.url()); });
  try {
    await page.goto(employeePayScreen.path);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("payroll.employee.title"));
    await expect(main.getByRole("link", { name: t("payroll.employee.person"), exact: true })).toHaveAttribute("href", `/people?sel=${draft.employee_id}`);
    if (state === "loading") await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15000 });
    else if (state === "refused") {
      await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      await expect(main.getByRole("button", { name: t("payroll.employee.record") })).toHaveCount(0);
    }
    else {
      await expect(main.getByText(t("payroll.employee.incomplete"), { exact: true })).toBeVisible();
      await expect(main.getByText(t("payroll.employee.netUnavailable"), { exact: true })).toBeVisible();
      if (state === "empty") await expect(main.getByText(t("payroll.employee.noContract"), { exact: true })).toBeVisible();
      else {
        await expect(main.getByRole("region", { name: t("payroll.employee.contract"), exact: true }).getByText("3,456,789원", { exact: true })).toBeVisible();
        await expect(main).toContainText(draft.contract!.source_note);
      }
      const deductions = main.getByRole("region", { name: t("payroll.employee.deductions"), exact: true });
      if (state === "held" || state === "empty") {
        await expect(deductions.getByText("34,567원", { exact: true })).toHaveCount(0);
        await expect(deductions.getByRole("link")).toHaveCount(0);
        if (state === "held") {
          await expect(deductions.getByText(t("payroll.reference.held") + t("payroll.reference.held"), { exact: true })).toHaveCount(0);
          await expect(deductions.getByText(t("payroll.reference.held"), { exact: true })).toHaveCount(4);
        }
        if (state === "empty") await expect(deductions.getByText(t("payroll.employee.noDeductions"), { exact: true })).toBeVisible();
      } else {
        await expect(deductions.getByText("34,567원", { exact: true })).toHaveCount(2);
        await expect(deductions.getByRole("link").first()).toHaveAttribute("href", "https://example.com/payroll-source");
      }
      if (state !== "empty") {
        const earnings = main.getByRole("region", { name: t("payroll.employee.earnings"), exact: true });
        await expect(earnings.getByText("3,456,789원", { exact: true })).toHaveCount(2);
        await expect(earnings).toContainText(draft.earnings![0]!.note_ko);
        await expect(earnings).toContainText(draft.contract!.source_note);
        const minimum = main.getByRole("region", { name: t("payroll.employee.minimumWage"), exact: true });
        if (state === "held") {
          await expect(minimum.getByText("12,345원", { exact: true })).toHaveCount(0);
          await expect(minimum.getByRole("link")).toHaveCount(0);
          await expect(deductions.getByText("3,422,222원", { exact: true })).toHaveCount(0);
        } else {
          await expect(minimum.getByText("12,345원", { exact: true })).toBeVisible();
          await expect(minimum.getByRole("link")).toHaveAttribute("href", "https://example.com/payroll-source");
          await expect(minimum).toContainText("2026. 01. 01.");
          await expect(deductions.getByText("3,422,222원", { exact: true })).toBeVisible();
        }
        const blockers = main.getByRole("list", { name: t("payroll.employee.blockers") });
        await expect(blockers.getByText(t("payroll.employee.attendanceIncomplete"), { exact: true })).toBeVisible();
        await expect(blockers.getByText(t("payroll.employee.withholdingMissing"), { exact: true })).toBeVisible();
        if (state === "below" || state === "incomparable") {
          const refusal = blockers.getByRole("listitem").filter({ hasText: t(state === "below" ? "payroll.employee.minimumBelow" : "payroll.employee.minimumIncomparable") });
          await expect(refusal).toBeVisible();
          await expect(refusal.getByRole("link")).toHaveAttribute("href", "https://example.com/payroll-source");
          await expect(refusal).toContainText("2026. 01. 01.");
          await expect(main).not.toContainText("backend sentence must not render");
          await expect(main).not.toContainText("월 소정근로시간이 근로계약에 없다");
        }
      }
      await page.reload();
      await expect(main.getByText(t("payroll.employee.incomplete"), { exact: true })).toBeVisible();
    }
    await fits(page, `employee-pay/${state}/${width}`);
    await expectAxe(page, `employee-pay/${state}/${width}`);
    await page.screenshot({ path: test.info().outputPath(`${state}-${width}-${colorScheme}.png`), fullPage: true });
    if (["populated", "held", "empty"].includes(state)) {
      await main.getByRole("region", { name: t("payroll.employee.deductions"), exact: true }).last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`sources-${state}-${width}-${colorScheme}.png`) });
    }
    if (state === "populated") {
      await main.getByRole("button", { name: t("payroll.employee.record"), exact: true }).click();
      await main.locator("[data-composer-root]").scrollIntoViewIfNeeded();
      await fits(page, `employee-pay/composer/${width}/${colorScheme}`);
      await expectAxe(page, `employee-pay/composer/${width}/${colorScheme}`);
      await page.screenshot({ path: test.info().outputPath(`composer-${width}-${colorScheme}.png`) });
    }
    expect(writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); release(); fixture.release(); }
});

test("recording a contract requires explicit facts and refreshes the selected draft", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await mockEmployeePay(page, "populated", Promise.resolve());
  const bodies: unknown[] = [];
  await page.route("**/api/v1/payroll/employees/*/contract-wages", async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: draft.contract!.id } });
  });
  try {
    await page.goto(employeePayScreen.path);
    await page.getByRole("button", { name: t("payroll.employee.record"), exact: true }).click();
    const form = page.locator("[data-composer-root]");
    await expect(form.getByRole("combobox")).toHaveValue("");
    await form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false }).click();
    expect(bodies).toEqual([]);
    await form.getByLabel(t("payroll.employee.effective"), { exact: false }).fill("2026-10-01");
    await form.getByRole("combobox").selectOption("MONTHLY");
    await form.getByLabel(t("payroll.employee.amount"), { exact: false }).fill("3456789");
    await form.getByLabel(t("payroll.employee.hours"), { exact: false }).fill("173");
    await form.getByLabel(t("payroll.employee.source"), { exact: false }).fill("모의 근로계약서 제3조");
    const refreshed = page.waitForResponse(response => response.url().includes("payslip-draft") && response.request().method() === "GET");
    await form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false }).click();
    await refreshed;
    await expect(form.getByRole("status")).toHaveText(t("payroll.employee.saved"));
    await expect(form.getByRole("combobox")).toHaveValue("");
    for (const key of ["effective", "amount", "hours", "source"] as const) await expect(form.getByLabel(t(`payroll.employee.${key}`), { exact: false })).toHaveValue("");
    await form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false }).click();
    expect(bodies).toHaveLength(1);
    expect(bodies).toEqual([{ effective_from: "2026-10-01", wage_kind: "MONTHLY", amount_won: 3456789, monthly_standard_hours: 173, source_note: "모의 근로계약서 제3조" }]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});


test("a stale contract save after exit retains the entered facts and explains the refusal", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await mockEmployeePay(page, "populated", Promise.resolve());
  const writes: unknown[] = [];
  await page.route("**/api/v1/payroll/employees/*/contract-wages", route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: failure("employee_exited_read_only") });
  });
  try {
    await page.goto(employeePayScreen.path);
    await page.getByRole("button", { name: t("payroll.employee.record"), exact: true }).click();
    const form = page.locator("[data-composer-root]");
    await form.getByLabel(t("payroll.employee.effective"), { exact: false }).fill("2026-10-01");
    await form.getByRole("combobox").selectOption("MONTHLY");
    await form.getByLabel(t("payroll.employee.amount"), { exact: false }).fill("3456789");
    await form.getByLabel(t("payroll.employee.hours"), { exact: false }).fill("173");
    await form.getByLabel(t("payroll.employee.source"), { exact: false }).fill("모의 근로계약서 제3조");
    const refreshed = page.waitForResponse(response => response.url().includes("payslip-draft") && response.request().method() === "GET");
    await form.getByRole("button", { name: commitLabel({ kind: "contractWage", mode: "save" }), exact: false }).click();
    await refreshed;
    await expect(form.getByRole("alert")).toContainText(t("payroll.refuse.employee_exited_read_only"));
    await expect(form.getByLabel(t("payroll.employee.effective"), { exact: false })).toHaveValue(fmtDate("2026-10-01"));
    await expect(form.getByRole("combobox")).toHaveValue("MONTHLY");
    await expect(form.getByLabel(t("payroll.employee.amount"), { exact: false })).toHaveValue("3456789");
    await expect(form.getByLabel(t("payroll.employee.hours"), { exact: false })).toHaveValue("173");
    await expect(form.getByLabel(t("payroll.employee.source"), { exact: false })).toHaveValue("모의 근로계약서 제3조");
    await expect(form.getByRole("status")).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) test(`personnel button opens the selected person column ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await mockEmployeePay(page, "populated", Promise.resolve());
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, id: draft.employee_id, name: draft.employee_name } } });
  try {
    await page.goto(employeePayScreen.path);
    await page.getByRole("link", { name: t("payroll.employee.person"), exact: true }).click();
    await expect(page).toHaveURL(`/people?sel=${draft.employee_id}`);
    const person = page.getByRole("complementary", { name: t("people.panel"), exact: true });
    await expect(person).toContainText(draft.employee_name);
    await page.reload();
    await expect(person).toContainText(draft.employee_name);
    await fits(page, `payroll person column ${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});


test("an insurance total inconsistent with the visible rows is held with its remainder", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await page.route("**/api/v1/payroll/employees/*/payslip-draft?*", route => route.fulfill({ json: { ...draft, total_employee_insurance_won: draft.total_employee_insurance_won! + 1 } }));
  try {
    await page.goto(employeePayScreen.path);
    const deductions = page.getByRole("region", { name: t("payroll.employee.deductions"), exact: true });
    await expect(deductions.getByText("34,567원", { exact: true })).toHaveCount(1);
    await expect(deductions.getByText("34,568원", { exact: true })).toHaveCount(0);
    await expect(deductions.getByText("3,422,222원", { exact: true })).toHaveCount(0);
    await expect(deductions.getByText(t("payroll.reference.held"), { exact: true })).toHaveCount(2);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
