// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import {
  buildEarningLines,
  buildWorkSummary,
  findDocForMonth,
  formatShortMonthDay,
  isKnownDeductionCode,
  parsePayslipPayload,
  payslipMonth,
  selectPayslipDoc,
  stepBoundaries,
} from "./payslip";

type InboxDocSummary = components["schemas"]["InboxDocSummary"];

function makeDoc(id: string, month: string, netWon = 3_141_755): InboxDocSummary {
  return {
    id,
    recipient_user_id: "00000000-0000-4000-8000-000000000587",
    kind: "payslip",
    title: `Payslip ${month}-01 ~ ${month}-28`,
    source_kind: "payroll_run",
    source_id: "run-1",
    locked: false,
    confirmed_by: null,
    confirmed_at: null,
    created_at: `${month}-28T00:00:00Z`,
    payslip_meta: {
      attribution_month: month,
      period_start: `${month}-01`,
      period_end: `${month}-28`,
      pay_date: "2026-11-25",
      gross_won: 3_567_000,
      net_won: netWon,
    },
  };
}

describe("payslip domain", () => {
  test("selectPayslipDoc resolves by doc id, month, latest fallback, or empty month", () => {
    const docs = [makeDoc("d-10", "2026-10"), makeDoc("d-08", "2026-08")];
    expect(selectPayslipDoc(docs, {})).toEqual({ active: docs[0], month: "2026-10" });
    expect(selectPayslipDoc(docs, { doc: "d-08" })).toEqual({ active: docs[1], month: "2026-08" });
    expect(selectPayslipDoc(docs, { month: "2026-08" })).toEqual({ active: docs[1], month: "2026-08" });
    expect(selectPayslipDoc(docs, { month: "2026-09" })).toEqual({ active: null, month: "2026-09" });
    expect(selectPayslipDoc([], { month: "2026-10" })).toEqual({ active: null, month: "2026-10" });
    expect(selectPayslipDoc([], { month: "bad" })).toEqual({ active: null, month: null });
  });

  test("stepBoundaries disables prev at oldest month and next at latest month", () => {
    const docs = [makeDoc("d-10", "2026-10"), makeDoc("d-09", "2026-09"), makeDoc("d-08", "2026-08")];
    expect(stepBoundaries("2026-10", docs)).toMatchObject({
      minMonth: "2026-08",
      maxMonth: "2026-10",
      disablePrev: false,
      disableNext: true,
    });
    expect(stepBoundaries("2026-09", docs)).toMatchObject({
      disablePrev: false,
      disableNext: false,
    });
    expect(stepBoundaries("2026-08", docs)).toMatchObject({
      disablePrev: true,
      disableNext: false,
    });
    expect(findDocForMonth(docs, "2026-09")?.id).toBe("d-09");
    expect(findDocForMonth(docs, "2026-07")).toBeNull();
  });

  test("payslipMonth falls back from attribution_month to period_end then title", () => {
    const withTitleOnly = {
      title: "Statement 2026-07-01 ~ 2026-07-31",
      payslip_meta: null,
    };
    expect(payslipMonth(withTitleOnly)).toBe("2026-07");
    expect(formatShortMonthDay("2026-11-25")).toBe("11-25");
    expect(formatShortMonthDay("invalid")).toBeNull();
  });

  test("parsePayslipPayload validates totals, nullable breakdowns, and deduction items", () => {
    expect(parsePayslipPayload(null)).toBeNull();
    expect(parsePayslipPayload({ gross_won: "bad" })).toBeNull();

    const parsed = parsePayslipPayload({
      attribution_month: "2026-10",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      pay_date: "2026-11-25",
      employee_number: "10587",
      employee_display_name: "Yoon Ha-jun",
      work_days: 18,
      paid_holiday_days: 4,
      overtime_hours: 12,
      leave_used: 0,
      base_pay_won: 3_100_000,
      overtime_pay_won: 267_000,
      meal_allowance_won: 200_000,
      taxable_won: 3_367_000,
      gross_won: 3_567_000,
      deductions: [
        { code: "NATIONAL_PENSION", label_ko: "Pension", amount_won: 151_515 },
        { code: "UNION_DUES", label_ko: "Union dues", amount_won: 10_000 },
        { code: "MALFORMED", amount_won: "oops" },
      ],
      total_deductions_won: 425_245,
      net_won: 3_141_755,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.deductions).toHaveLength(2);
    expect(isKnownDeductionCode(parsed!.deductions[0]!.code)).toBe(true);
    expect(isKnownDeductionCode(parsed!.deductions[1]!.code)).toBe(false);
    expect(buildEarningLines(parsed!)).toEqual([
      { kind: "base", amountWon: 3_100_000 },
      { kind: "overtime", amountWon: 267_000, overtimeHours: 12 },
      { kind: "meal", amountWon: 200_000 },
    ]);
    expect(buildWorkSummary(parsed!.workDays, parsed!.paidHolidayDays)).toEqual({
      totalDays: 22,
      workedDays: 18,
      paidHolidayDays: 4,
    });
  });

  test("legacy payslips without itemized earnings fall back cleanly without fabricating 0s", () => {
    const legacy = parsePayslipPayload({
      gross_won: 3_200_000,
      total_deductions_won: 320_000,
      net_won: 2_880_000,
      deductions: [],
      work_days: 20,
      paid_holiday_days: null,
    });
    expect(legacy).not.toBeNull();
    expect(buildEarningLines(legacy!)).toEqual([
      { kind: "gross_fallback", amountWon: 3_200_000 },
    ]);
    expect(buildWorkSummary(legacy!.workDays, legacy!.paidHolidayDays)).toEqual({
      totalDays: 20,
      workedDays: 20,
      paidHolidayDays: null,
    });
    expect(buildWorkSummary(null, 4)).toBeNull();
  });
});
