// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import {
  buildCompactRunStages,
  buildRunCsvMatrix,
  computePageSubtotals,
  deductionAmount,
  deductionRateBasis,
  filterRegisterLines,
  hasBankBlocker,
  isLineAttention,
  shortMonthDay,
  type PayrollLineSummary,
  type PayrollRates,
} from "./run-register";

function makeLine(overrides: Partial<PayrollLineSummary> = {}): PayrollLineSummary {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    employee_id: "00000000-0000-4000-8000-000000000201",
    employee_display_name: "Employee One",
    employee_company: "Saeon Precision",
    work_days: 22,
    overtime_hours: 12,
    leave_used: 0,
    gross_pay_source_present: true,
    net_pay_source_present: true,
    nts_tax_row_status: "VERIFIED_SOURCE_ROW",
    calculation_status: "READY_FOR_REVIEW",
    blockers: [],
    gross_won: 3_567_000,
    deductions: [
      { code: "NATIONAL_PENSION", label_ko: "NPS", amount_won: 151_515, source_url: "https://example.com" },
      { code: "HEALTH_INSURANCE", label_ko: "NHIS", amount_won: 119_360, source_url: "https://example.com" },
      { code: "LONG_TERM_CARE", label_ko: "LTC", amount_won: 15_457, source_url: "https://example.com" },
      { code: "EMPLOYMENT_INSURANCE", label_ko: "EI", amount_won: 30_303, source_url: "https://example.com" },
      { code: "INCOME_TAX", label_ko: "TAX", amount_won: 98_740, source_url: "https://example.com" },
      { code: "LOCAL_INCOME_TAX", label_ko: "LOCAL", amount_won: 9_870, source_url: "https://example.com" },
    ],
    total_deductions_won: 425_245,
    net_won: 3_141_755,
    ...overrides,
  };
}

describe("run-register domain helpers", () => {
  test("deductionAmount extracts exact integer amounts and preserves null when absent", () => {
    const computed = makeLine();
    expect(deductionAmount(computed, "NATIONAL_PENSION")).toBe(151_515);
    expect(deductionAmount(computed, "LOCAL_INCOME_TAX")).toBe(9_870);

    const uncomputed = makeLine({ deductions: null, gross_won: null, total_deductions_won: null, net_won: null });
    expect(deductionAmount(uncomputed, "NATIONAL_PENSION")).toBeNull();
  });

  test("computePageSubtotals sums computed rows and returns null for completely uncomputed columns", () => {
    const a = makeLine();
    const b = makeLine({
      id: "00000000-0000-4000-8000-000000000102",
      gross_won: 2_900_000,
      total_deductions_won: 341_000,
      net_won: 2_559_000,
      deductions: [
        { code: "NATIONAL_PENSION", label_ko: "NPS", amount_won: 121_500, source_url: "https://example.com" },
      ],
    });
    const subtotals = computePageSubtotals([a, b]);
    expect(subtotals.grossWon).toBe(6_467_000);
    expect(subtotals.totalDeductionsWon).toBe(766_245);
    expect(subtotals.netWon).toBe(5_700_755);
    expect(subtotals.deductions.NATIONAL_PENSION).toBe(273_015);
    expect(subtotals.deductions.HEALTH_INSURANCE).toBe(119_360);

    const empty = computePageSubtotals([
      makeLine({ gross_won: null, total_deductions_won: null, net_won: null, deductions: null }),
    ]);
    expect(empty.grossWon).toBeNull();
    expect(empty.totalDeductionsWon).toBeNull();
    expect(empty.netWon).toBeNull();
    expect(empty.deductions.NATIONAL_PENSION).toBeNull();
  });

  test("bank blockers, attention filter, and text query work cleanly", () => {
    const clean = makeLine({ employee_display_name: "Alpha Person" });
    const missingBank = makeLine({
      id: "00000000-0000-4000-8000-000000000103",
      employee_id: "00000000-0000-4000-8000-000000000202",
      employee_display_name: "Beta Person",
      calculation_status: "BLOCKED_LEGAL_GATE",
      blockers: ["ACCOUNT_VERIFICATION"],
    });
    expect(hasBankBlocker(clean)).toBe(false);
    expect(hasBankBlocker(missingBank)).toBe(true);
    expect(isLineAttention(missingBank)).toBe(true);

    expect(filterRegisterLines([clean, missingBank], "attention", "")).toEqual([missingBank]);
    expect(filterRegisterLines([clean, missingBank], "all", "alpha")).toEqual([clean]);
    expect(filterRegisterLines([clean, missingBank], "attention", "alpha")).toEqual([]);

    const directory = new Map([[clean.employee_id!, { employee_number: "10587" }]]);
    expect(filterRegisterLines([clean, missingBank], "all", "10587", directory)).toEqual([clean]);
  });

  test("deductionRateBasis resolves effective statutory rates, half-shares, tax table, and local income tax", () => {
    const line = makeLine({ tax_table_version: "2026-10" });
    const citation = {
      effective_from: "2026-01-01",
      effective_to_exclusive: "2027-01-01",
      floor_won: null,
      cap_won: null,
      instrument_ko: "Statute",
      article_ko: "Art 1",
      promulgation_ko: "No 1",
      enforced_on: "2026-01-01",
      source_url: "https://example.com",
      retrieved_on: "2026-10-01",
      provenance_ko: "Verified",
      status: "ACTIVE" as const,
    };
    const rates: PayrollRates = {
      country_code: "KR",
      adopted: true,
      items: [
        { ...citation, code: "NATIONAL_PENSION_EMPLOYEE", name: "NPS", value: "45/1000", rate_num: 45, rate_den: 1000, basis: "PENSION_STANDARD_INCOME", bearer: "EMPLOYEE_WHOLE" },
        { ...citation, code: "HEALTH_INSURANCE_TOTAL", name: "NHIS", value: "7090/100000", rate_num: 7090, rate_den: 100_000, basis: "MONTHLY_REMUNERATION", bearer: "HALF_EACH" },
        { ...citation, code: "LONG_TERM_CARE_TOTAL", name: "LTC", value: "1295/10000", rate_num: 1295, rate_den: 10_000, basis: "HEALTH_INSURANCE_PREMIUM", bearer: "HALF_EACH", effective_to_exclusive: "2026-11-27" },
        { ...citation, code: "LONG_TERM_CARE_TOTAL", name: "LTC", value: "1314/10000", rate_num: 1314, rate_den: 10_000, basis: "HEALTH_INSURANCE_PREMIUM", bearer: "HALF_EACH", effective_from: "2026-11-27", status: "SCHEDULED" },
        { ...citation, code: "EMPLOYMENT_INSURANCE_EMPLOYEE", name: "EI", value: "9/1000", rate_num: 9, rate_den: 1000, basis: "MONTHLY_REMUNERATION", bearer: "EMPLOYEE_WHOLE" },
        { ...citation, code: "SIMPLIFIED_WITHHOLDING_TABLE", name: "Tax", value: null, rate_num: null, rate_den: null, basis: "NOT_APPLICABLE", bearer: "NOT_APPLICABLE" },
      ],
    };

    expect(deductionRateBasis("NATIONAL_PENSION", line, rates, "2026-11-25")).toEqual({ kind: "taxable", rate: "4.5" });
    expect(deductionRateBasis("HEALTH_INSURANCE", line, rates, "2026-11-25")).toEqual({ kind: "taxable", rate: "3.545" });
    expect(deductionRateBasis("LONG_TERM_CARE", line, rates, "2026-11-25")).toEqual({ kind: "healthInsurance", rate: "12.95" });
    expect(deductionRateBasis("LONG_TERM_CARE", line, rates, "2026-12-01")).toEqual({ kind: "healthInsurance", rate: "13.14" });
    expect(deductionRateBasis("EMPLOYMENT_INSURANCE", line, rates, "2026-11-25")).toEqual({ kind: "taxable", rate: "0.9" });
    expect(deductionRateBasis("INCOME_TAX", line, rates, "2026-11-25")).toEqual({ kind: "simplifiedTax" });
    expect(deductionRateBasis("LOCAL_INCOME_TAX", line, rates, "2026-11-25")).toEqual({ kind: "localIncomeTax", rate: "10" });

    expect(deductionRateBasis("NATIONAL_PENSION", line, undefined, "2026-11-25")).toBeNull();
    expect(deductionRateBasis("INCOME_TAX", makeLine({ tax_table_version: undefined }), undefined, "2026-11-25")).toBeNull();
  });

  test("buildCompactRunStages maps all run statuses and shortMonthDay formats pay dates", () => {
    expect(buildCompactRunStages("STAGED")).toEqual([
      { key: "calc", state: "current" },
      { key: "approval", state: "waiting" },
      { key: "payment", state: "waiting" },
    ]);
    expect(buildCompactRunStages("CALCULATED")).toEqual([
      { key: "calc", state: "done" },
      { key: "approval", state: "current" },
      { key: "payment", state: "waiting" },
    ]);
    expect(buildCompactRunStages("APPROVED")).toEqual([
      { key: "calc", state: "done" },
      { key: "approval", state: "done" },
      { key: "payment", state: "current" },
    ]);
    expect(buildCompactRunStages("ISSUED")).toEqual([
      { key: "calc", state: "done" },
      { key: "approval", state: "done" },
      { key: "payment", state: "done" },
    ]);
    expect(buildCompactRunStages("VOID").every(step => step.state === "waiting")).toBe(true);

    expect(shortMonthDay("2026-11-25")).toBe("11-25");
    expect(shortMonthDay(null)).toBe("—");
  });

  test("buildRunCsvMatrix preserves numeric values and nulls without fabrication", () => {
    const matrix = buildRunCsvMatrix([makeLine()]);
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toEqual([
      "Employee One",
      "Saeon Precision",
      3_567_000,
      151_515,
      119_360,
      15_457,
      30_303,
      98_740,
      9_870,
      425_245,
      3_141_755,
      22,
      0,
    ]);
  });
});
