// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import type { Page } from "@playwright/test";
import { id, failure } from "./fixtures";
const instrument: components["schemas"]["PayrollStatutoryInstrument"] = { name_ko: "모의 고시", article_ko: "모의 조문", promulgation_ko: "모의 제1호", enforced_on: "2026-01-01", url: "https://example.com/payroll-source", retrieved_on: "2026-10-29" };
export const draft: components["schemas"]["PayrollPayslipDraft"] = {
  employee_id: id(10), employee_name: "모의 직원", period: { start: "2026-10-01", end: "2026-10-31" }, pay_date: "2026-11-05",
  contract: { id: id(900), effective_from: "2026-10-01", wage_kind: "MONTHLY", amount_won: 3456789, monthly_standard_hours: 173, source_note: "모의 근로계약서 제3조" },
  attendance: { period_start: "2026-10-01", period_end: "2026-10-31", worked_days: 0, clock_in_events: 0, clock_out_events: 0 },
  issuable: false, blockers: ["ATTENDANCE_INCOMPLETE", "WITHHOLDING_NOT_COMPUTED"], statutory_citations: [],
  deductions: [{ code: "NationalPension", label_ko: "모의 공제", basis_kind: "MonthlyStandardIncome", basis_won: 3456789, rate_num: 1, rate_den: 100, total_won: 69134, employee_won: 34567, employer_only: false, blocked_by: null, total_rounding: "SYNTHETIC", employee_rounding: "SYNTHETIC", instrument, share_instrument: null, provenance_ko: "화면 검증용 가상 기준" }],
  net_pay_won: null, not_computed: [{ code: "INCOME_TAX", label_ko: "모의 원천징수", reason_ko: "원천징수 미계산", instrument }],
};
export const employeePayScreen = { key: "payroll-employee", path: `/payroll/employees/${draft.employee_id}?period=2026-10&pay_date=2026-11-05`, read: "/api/v1/payroll/employees/{employeeId}/payslip-draft", states: { populated: "Cited draft", empty: "No contract", held: "Missing citation", failed: "Read failed", refused: "Read refused", loading: "Hold read" }, registry: "payroll-employee", live: "mock" } as const;
export async function mockEmployeePay(page: Page, state: string, held: Promise<void>) {
  await page.route("**/api/v1/payroll/employees/*/payslip-draft?*", async route => {
    if (state === "loading") await held;
    if (page.isClosed()) return;
    if (state === "failed" || state === "refused") return route.fulfill({ status: state === "failed" ? 500 : 403, json: failure(state === "failed" ? "internal_error" : "forbidden") });
    await route.fulfill({ json: { ...draft, contract: state === "empty" ? null : draft.contract, deductions: state === "empty" ? [] : state === "held" ? draft.deductions!.map(row => ({ ...row, instrument: { ...instrument, url: "" }, share_instrument: { ...instrument, url: "" } })) : draft.deductions } });
  });
}
