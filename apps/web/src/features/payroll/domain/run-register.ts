// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

export type PayrollRunDetail = components["schemas"]["PayrollRunDetail"];
export type PayrollLineSummary = components["schemas"]["PayrollLineSummary"];
type PayrollCalculationDeduction = components["schemas"]["PayrollCalculationDeduction"];
export type DeductionCode = PayrollCalculationDeduction["code"];
type PayrollRunSummary = components["schemas"]["PayrollRunSummary"];
type PayrollRunStatus = PayrollRunSummary["status"];
type PayrollRate = components["schemas"]["PayrollRate"];
export type PayrollRates = components["schemas"]["PayrollRates"];

type DeductionRateBasis =
  | { kind: "taxable"; rate: string }
  | { kind: "healthInsurance"; rate: string }
  | { kind: "simplifiedTax" }
  | { kind: "localIncomeTax"; rate: string };

export const DEDUCTION_CODES = [
  "NATIONAL_PENSION",
  "HEALTH_INSURANCE",
  "LONG_TERM_CARE",
  "EMPLOYMENT_INSURANCE",
  "INCOME_TAX",
  "LOCAL_INCOME_TAX",
] as const satisfies readonly DeductionCode[];

export type RegisterFilterMode = "all" | "attention";

type CompactRunStage = {
  key: "calc" | "approval" | "payment";
  state: "done" | "current" | "waiting";
};

type PageSubtotals = {
  basePayWon: number | null;
  overtimePayWon: number | null;
  mealAllowanceWon: number | null;
  grossWon: number | null;
  totalDeductionsWon: number | null;
  netWon: number | null;
  deductions: Record<DeductionCode, number | null>;
};

export function deductionAmount(line: PayrollLineSummary, code: DeductionCode): number | null {
  const hit = line.deductions?.find(item => item.code === code);
  if (!hit || typeof hit.amount_won !== "number" || !Number.isFinite(hit.amount_won)) return null;
  return hit.amount_won;
}

function blockerCode(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const rec = entry as Record<string, unknown>;
    if (typeof rec.code === "string") return rec.code;
    if (typeof rec.kind === "string") return rec.kind;
  }
  return "";
}

export function hasBankBlocker(line: PayrollLineSummary): boolean {
  return (
    !line.bank_account_registered ||
    line.blockers.some(entry => {
      const code = blockerCode(entry).toUpperCase();
      return code === "ACCOUNT_VERIFICATION" || code.includes("BANK") || code.includes("ACCOUNT");
    })
  );
}

export function isLineAttention(line: PayrollLineSummary): boolean {
  return hasBankBlocker(line) || line.blockers.length > 0 || line.calculation_status === "BLOCKED_LEGAL_GATE";
}

export function filterRegisterLines(
  lines: readonly PayrollLineSummary[],
  filter: RegisterFilterMode,
  query: string,
): PayrollLineSummary[] {
  const needle = query.trim().toLowerCase();
  return lines.filter(line => {
    if (filter === "attention" && !isLineAttention(line)) return false;
    if (!needle) return true;
    return (
      line.employee_display_name.toLowerCase().includes(needle) ||
      line.employee_company.toLowerCase().includes(needle) ||
      (line.employee_id?.toLowerCase().includes(needle) ?? false) ||
      (line.employee_number?.toLowerCase().includes(needle) ?? false) ||
      (line.org_unit?.toLowerCase().includes(needle) ?? false) ||
      (line.position?.toLowerCase().includes(needle) ?? false)
    );
  });
}

const RATE_CODE_BY_DEDUCTION: Partial<Record<DeductionCode, string>> = {
  NATIONAL_PENSION: "NATIONAL_PENSION_EMPLOYEE",
  HEALTH_INSURANCE: "HEALTH_INSURANCE_TOTAL",
  LONG_TERM_CARE: "LONG_TERM_CARE_TOTAL",
  EMPLOYMENT_INSURANCE: "EMPLOYMENT_INSURANCE_EMPLOYEE",
};

function findEffectiveRate(
  rates: PayrollRates | undefined,
  code: string,
  effectiveOn?: string | null,
): PayrollRate | undefined {
  const matches = rates?.items.filter(item => item.code === code) ?? [];
  if (matches.length === 0) return undefined;
  if (effectiveOn && /^\d{4}-\d{2}-\d{2}$/.test(effectiveOn)) {
    const onDates = matches
      .filter(
        item =>
          item.effective_from <= effectiveOn &&
          (!item.effective_to_exclusive || effectiveOn < item.effective_to_exclusive),
      )
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
    if (onDates[0]) return onDates[0];
  }
  return matches.find(item => item.status === "ACTIVE") ?? matches[0];
}

function formatRatePct(percent: number): string {
  return String(Math.round(percent * 1000) / 1000);
}

/** Derives the statutory rate/basis note metadata for a deduction row without hardcoding locale prose. */
export function deductionRateBasis(
  code: DeductionCode,
  line: PayrollLineSummary,
  rates?: PayrollRates,
  effectiveOn?: string | null,
): DeductionRateBasis | null {
  if (code === "INCOME_TAX") {
    const tableRate = findEffectiveRate(rates, "SIMPLIFIED_WITHHOLDING_TABLE", effectiveOn);
    if ((tableRate && tableRate.status !== "HELD") || Boolean(line.tax_table_version)) {
      return { kind: "simplifiedTax" };
    }
    return null;
  }
  if (code === "LOCAL_INCOME_TAX") {
    return deductionAmount(line, "INCOME_TAX") != null ? { kind: "localIncomeTax", rate: "10" } : null;
  }
  const rateCode = RATE_CODE_BY_DEDUCTION[code];
  if (!rateCode) return null;
  const item = findEffectiveRate(rates, rateCode, effectiveOn);
  if (!item || item.status === "HELD" || item.rate_num == null || item.rate_den == null || item.rate_den <= 0) {
    return null;
  }
  const rawPct = (item.rate_num / item.rate_den) * 100;
  if (code === "LONG_TERM_CARE" && item.basis === "HEALTH_INSURANCE_PREMIUM") {
    return { kind: "healthInsurance", rate: formatRatePct(rawPct) };
  }
  const employeePct = item.bearer === "HALF_EACH" ? rawPct / 2 : rawPct;
  return { kind: "taxable", rate: formatRatePct(employeePct) };
}

export function shortMonthDay(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "—";
  return isoDate.slice(5);
}

const PRE_CALC_STATUSES = new Set<PayrollRunStatus>([
  "STAGED",
  "BLOCKED_LEGAL_GATE",
  "READY_FOR_REVIEW",
  "ATTENDANCE_CLOSED",
  "CALCULATING",
]);

const APPROVAL_STATUSES = new Set<PayrollRunStatus>(["CALCULATED", "REJECTED", "SUBMITTED"]);
const PAYMENT_PENDING_STATUSES = new Set<PayrollRunStatus>(["APPROVED", "DISBURSEMENT_SCHEDULED"]);
const PAID_STATUSES = new Set<PayrollRunStatus>(["PAID", "ISSUED"]);

export function buildCompactRunStages(status: PayrollRunStatus): readonly CompactRunStage[] {
  if (status === "VOID") {
    return [
      { key: "calc", state: "waiting" },
      { key: "approval", state: "waiting" },
      { key: "payment", state: "waiting" },
    ];
  }
  if (PRE_CALC_STATUSES.has(status)) {
    return [
      { key: "calc", state: "current" },
      { key: "approval", state: "waiting" },
      { key: "payment", state: "waiting" },
    ];
  }
  if (APPROVAL_STATUSES.has(status)) {
    return [
      { key: "calc", state: "done" },
      { key: "approval", state: "current" },
      { key: "payment", state: "waiting" },
    ];
  }
  if (PAYMENT_PENDING_STATUSES.has(status)) {
    return [
      { key: "calc", state: "done" },
      { key: "approval", state: "done" },
      { key: "payment", state: "current" },
    ];
  }
  if (PAID_STATUSES.has(status)) {
    return [
      { key: "calc", state: "done" },
      { key: "approval", state: "done" },
      { key: "payment", state: "done" },
    ];
  }
  return [
    { key: "calc", state: "waiting" },
    { key: "approval", state: "waiting" },
    { key: "payment", state: "waiting" },
  ];
}

function sumNullable(values: readonly (number | null | undefined)[]): number | null {
  let seen = false;
  let total = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

export function computePageSubtotals(lines: readonly PayrollLineSummary[]): PageSubtotals {
  const deductions = Object.fromEntries(
    DEDUCTION_CODES.map(code => [code, sumNullable(lines.map(line => deductionAmount(line, code)))]),
  ) as Record<DeductionCode, number | null>;

  return {
    basePayWon: sumNullable(lines.map(line => line.base_pay_won)),
    overtimePayWon: sumNullable(lines.map(line => line.overtime_pay_won)),
    mealAllowanceWon: sumNullable(lines.map(line => line.meal_allowance_won)),
    grossWon: sumNullable(lines.map(line => line.gross_won)),
    totalDeductionsWon: sumNullable(lines.map(line => line.total_deductions_won)),
    netWon: sumNullable(lines.map(line => line.net_won)),
    deductions,
  };
}

export const RUN_CSV_COLUMN_COUNT = 13;

export function buildRunCsvMatrix(lines: readonly PayrollLineSummary[]): (string | number)[][] {
  return lines.map(line => [
    line.employee_display_name,
    line.org_unit || line.employee_company,
    line.gross_won ?? "",
    deductionAmount(line, "NATIONAL_PENSION") ?? "",
    deductionAmount(line, "HEALTH_INSURANCE") ?? "",
    deductionAmount(line, "LONG_TERM_CARE") ?? "",
    deductionAmount(line, "EMPLOYMENT_INSURANCE") ?? "",
    deductionAmount(line, "INCOME_TAX") ?? "",
    deductionAmount(line, "LOCAL_INCOME_TAX") ?? "",
    line.total_deductions_won ?? "",
    line.net_won ?? "",
    line.work_days ?? "",
    line.leave_used ?? "",
  ]);
}
