// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
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
        await expect(deductions.getByRole("link")).toHaveCount(0);
        await expect(deductions.getByText(/https:\/\/example.com\/payroll-source/).first()).toBeVisible();
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
          await expect(minimum.getByRole("link")).toHaveCount(0);
          await expect(minimum.getByText(/https:\/\/example.com\/payroll-source/)).toBeVisible();
          await expect(minimum).toContainText("2026. 01. 01.");
          await expect(deductions.getByText("3,422,222원", { exact: true })).toBeVisible();
        }
        const blockers = main.getByRole("list", { name: t("payroll.employee.blockers") });
        await expect(blockers.getByText(t("payroll.employee.attendanceIncomplete"), { exact: true })).toBeVisible();
        await expect(blockers.getByText(t("payroll.employee.withholdingMissing"), { exact: true })).toBeVisible();
        if (state === "below" || state === "incomparable") {
          const refusal = blockers.getByRole("listitem").filter({ hasText: t(state === "below" ? "payroll.employee.minimumBelow" : "payroll.employee.minimumIncomparable") });
          await expect(refusal).toBeVisible();
          await expect(refusal.getByRole("link")).toHaveCount(0);
          await expect(refusal.getByText(/https:\/\/example.com\/payroll-source/)).toBeVisible();
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

for (const [width, colorScheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const) test(`deduction sources follow the page scroll ${width} ${colorScheme} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const sample = draft.deductions![0]!;
  const deductions = (["NationalPension", "HealthInsurance", "LongTermCare", "EmploymentUnemployment"] as const).map((code, index) => ({
    ...sample, code, label_ko: `모의 공제 ${index + 1}`, employee_won: sample.employee_won! + index,
    instrument: { ...sample.instrument, name_ko: `모의 공제 산정 기준 ${index + 1}`, article_ko: "모의 공제 산정과 적용 범위를 정하는 조문", url: `https://example.com/deduction/${index + 1}` },
    share_instrument: { ...sample.instrument, name_ko: `모의 직원 부담 기준 ${index + 1}`, article_ko: "모의 직원 부담액과 분담 범위를 정하는 조문", url: `https://example.com/share/${index + 1}` },
    provenance_ko: "화면 검증용 가상 기준 · 공제 산정 근거와 직원 부담 근거를 함께 확인합니다.",
  })) satisfies NonNullable<typeof draft.deductions>;
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/v1/payroll/")) writes.push(request.url()); });
  await page.route("**/api/v1/payroll/employees/*/payslip-draft?*", route => route.fulfill({ json: {
    ...draft, deductions, total_employee_insurance_won: deductions.reduce((sum, row) => sum + row.employee_won, 0),
    remainder_after_insurance_won: draft.gross_won! - deductions.reduce((sum, row) => sum + row.employee_won, 0),
  } }));
  try {
    await page.goto(employeePayScreen.path);
    const section = page.getByRole("region", { name: t("payroll.employee.deductions"), exact: true }).first();
    await expect(section.getByText(deductions[0]!.label_ko, { exact: true })).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`deductions-${width}-${colorScheme}.png`), fullPage: true });
    expect(await section.evaluate(root => [...root.querySelectorAll<HTMLElement>("*")].filter(element => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    }).map(element => element.getAttribute("role") ?? element.tagName))).toEqual([]);
    for (const deduction of deductions) {
      const row = section.getByRole("row").filter({ hasText: deduction.label_ko });
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByText(t("payroll.employee.won", { amount: fmtNumber(deduction.employee_won) }), { exact: true })).toBeVisible();
      for (const instrument of [deduction.instrument, deduction.share_instrument]) {
        const link = row.getByRole("link", { name: `${instrument.name_ko} · ${instrument.article_ko} · ${instrument.promulgation_ko}`, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", instrument.url);
        await link.focus();
        await expect(link).toBeFocused();
      }
      await expect(row.getByRole("cell")).toHaveCount(3);
      expect(await row.getByRole("cell").evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1 && cell.scrollHeight <= cell.clientHeight + 1))).toBe(true);
    }
    await fits(page, `deduction-sources/${width}/${colorScheme}`);
    await expectAxe(page, `deduction-sources/${width}/${colorScheme}`);
    expect(writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
