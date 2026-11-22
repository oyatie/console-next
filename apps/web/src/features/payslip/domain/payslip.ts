// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type InboxDocSummary = components["schemas"]["InboxDocSummary"];

const KNOWN_DEDUCTION_CODES = [
  "NATIONAL_PENSION",
  "HEALTH_INSURANCE",
  "LONG_TERM_CARE",
  "EMPLOYMENT_INSURANCE",
  "INCOME_TAX",
  "LOCAL_INCOME_TAX",
] as const;

export type KnownDeductionCode = (typeof KNOWN_DEDUCTION_CODES)[number];

const KNOWN_DEDUCTION_SET = new Set<string>(KNOWN_DEDUCTION_CODES);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

type PayslipDeduction = {
  code: string;
  labelKo: string | null;
  amountWon: number;
};

export type PayslipPayload = {
  attributionMonth: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payDate: string | null;
  employeeNumber: string | null;
  employeeDisplayName: string | null;
  employeeCompany: string | null;
  orgUnit: string | null;
  position: string | null;
  workDays: number | null;
  paidHolidayDays: number | null;
  overtimeHours: number | null;
  leaveUsed: number | null;
  basePayWon: number | null;
  overtimePayWon: number | null;
  mealAllowanceWon: number | null;
  taxableWon: number | null;
  grossWon: number;
  deductions: PayslipDeduction[];
  totalDeductionsWon: number;
  netWon: number;
};

type EarningLine =
  | { kind: "base"; amountWon: number }
  | { kind: "overtime"; amountWon: number; overtimeHours: number | null }
  | { kind: "meal"; amountWon: number }
  | { kind: "gross_fallback"; amountWon: number };

type WorkSummary = {
  totalDays: number;
  workedDays: number;
  paidHolidayDays: number | null;
};

export function isKnownDeductionCode(code: string): code is KnownDeductionCode {
  return KNOWN_DEDUCTION_SET.has(code);
}

function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

export function formatShortMonthDay(isoDate: string | null | undefined): string | null {
  if (typeof isoDate !== "string" || !DATE_RE.test(isoDate)) return null;
  return isoDate.slice(5, 10);
}

export function payslipMonth(doc: Pick<InboxDocSummary, "title" | "payslip_meta">): string | null {
  const meta = doc.payslip_meta;
  if (isValidMonth(meta?.attribution_month)) return meta.attribution_month;
  const endMonth = meta?.period_end?.slice(0, 7);
  if (isValidMonth(endMonth)) return endMonth;
  const match = /\d{4}-(?:0[1-9]|1[0-2])/.exec(doc.title);
  return match ? match[0] : null;
}

export function selectPayslipDoc(
  items: readonly InboxDocSummary[],
  search: { doc?: string; month?: string },
): { active: InboxDocSummary | null; month: string | null } {
  const requestedMonth = isValidMonth(search.month) ? search.month : null;
  if (items.length === 0) {
    return { active: null, month: requestedMonth };
  }
  if (search.doc) {
    const byId = items.find(item => item.id === search.doc);
    if (byId) {
      return { active: byId, month: payslipMonth(byId) ?? requestedMonth };
    }
  }
  if (requestedMonth) {
    const byMonth = items.find(item => payslipMonth(item) === requestedMonth);
    return byMonth ? { active: byMonth, month: requestedMonth } : { active: null, month: requestedMonth };
  }
  const latest = items[0]!;
  const latestMonth = payslipMonth(latest) ?? (isValidMonth(latest.created_at.slice(0, 7)) ? latest.created_at.slice(0, 7) : null);
  return { active: latest, month: latestMonth };
}

export function findDocForMonth(items: readonly InboxDocSummary[], month: string): InboxDocSummary | null {
  if (!isValidMonth(month)) return null;
  return items.find(item => payslipMonth(item) === month) ?? null;
}

export function stepBoundaries(currentMonth: string | null, items: readonly InboxDocSummary[]) {
  const months = items
    .map(item => payslipMonth(item))
    .filter((m): m is string => m !== null)
    .sort();
  const minMonth = months[0] ?? null;
  const maxMonth = months.at(-1) ?? null;
  return {
    minMonth,
    maxMonth,
    latestDoc: items[0] ?? null,
    disablePrev: !currentMonth || !minMonth || currentMonth <= minMonth,
    disableNext: !currentMonth || !maxMonth || currentMonth >= maxMonth,
  };
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parsePayslipPayload(raw: unknown): PayslipPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const grossWon = asNonNegativeInt(obj.gross_won);
  const totalDeductionsWon = asNonNegativeInt(obj.total_deductions_won);
  const netWon = asInt(obj.net_won);
  if (grossWon === null || totalDeductionsWon === null || netWon === null) return null;

  const deductionsRaw = Array.isArray(obj.deductions) ? obj.deductions : [];
  const deductions: PayslipDeduction[] = [];
  for (const entry of deductionsRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const code = asText(item.code);
    const amountWon = asNonNegativeInt(item.amount_won);
    if (!code || amountWon === null) continue;
    deductions.push({ code, labelKo: asText(item.label_ko), amountWon });
  }

  return {
    attributionMonth: isValidMonth(obj.attribution_month) ? obj.attribution_month : null,
    periodStart: asText(obj.period_start),
    periodEnd: asText(obj.period_end),
    payDate: asText(obj.pay_date),
    employeeNumber: asText(obj.employee_number),
    employeeDisplayName: asText(obj.employee_display_name),
    employeeCompany: asText(obj.employee_company),
    orgUnit: asText(obj.org_unit),
    position: asText(obj.position),
    workDays: asNonNegativeNumber(obj.work_days),
    paidHolidayDays: asNonNegativeNumber(obj.paid_holiday_days),
    overtimeHours: asNonNegativeNumber(obj.overtime_hours),
    leaveUsed: asNonNegativeNumber(obj.leave_used),
    basePayWon: asNonNegativeInt(obj.base_pay_won),
    overtimePayWon: asNonNegativeInt(obj.overtime_pay_won),
    mealAllowanceWon: asNonNegativeInt(obj.meal_allowance_won),
    taxableWon: asNonNegativeInt(obj.taxable_won),
    grossWon,
    deductions,
    totalDeductionsWon,
    netWon,
  };
}

export function buildEarningLines(payload: PayslipPayload): EarningLine[] {
  const hasItemized =
    payload.basePayWon !== null || payload.overtimePayWon !== null || payload.mealAllowanceWon !== null;
  if (!hasItemized) {
    return [{ kind: "gross_fallback", amountWon: payload.grossWon }];
  }
  const lines: EarningLine[] = [];
  if (payload.basePayWon !== null) {
    lines.push({ kind: "base", amountWon: payload.basePayWon });
  }
  if (
    payload.overtimePayWon !== null &&
    (payload.overtimePayWon > 0 || (payload.overtimeHours !== null && payload.overtimeHours > 0))
  ) {
    lines.push({ kind: "overtime", amountWon: payload.overtimePayWon, overtimeHours: payload.overtimeHours });
  }
  if (payload.mealAllowanceWon !== null) {
    lines.push({ kind: "meal", amountWon: payload.mealAllowanceWon });
  }
  return lines.length > 0 ? lines : [{ kind: "gross_fallback", amountWon: payload.grossWon }];
}

export function buildWorkSummary(
  workDays: number | null,
  paidHolidayDays: number | null,
): WorkSummary | null {
  if (workDays === null || !Number.isFinite(workDays) || workDays < 0) return null;
  const holiday =
    paidHolidayDays !== null && Number.isFinite(paidHolidayDays) && paidHolidayDays > 0
      ? paidHolidayDays
      : null;
  return {
    totalDays: workDays + (holiday ?? 0),
    workedDays: workDays,
    paidHolidayDays: holiday,
  };
}
