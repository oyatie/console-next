// SPDX-License-Identifier: LicenseRef-Proprietary
import { t, type MessageId } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import {
  buildEarningLines,
  buildWorkSummary,
  isKnownDeductionCode,
  type KnownDeductionCode,
  type PayslipPayload,
} from "./domain/payslip";

const DEDUCTION_KEY_MAP: Record<KnownDeductionCode, MessageId> = {
  NATIONAL_PENSION: "payslip.deduction.NATIONAL_PENSION",
  HEALTH_INSURANCE: "payslip.deduction.HEALTH_INSURANCE",
  LONG_TERM_CARE: "payslip.deduction.LONG_TERM_CARE",
  EMPLOYMENT_INSURANCE: "payslip.deduction.EMPLOYMENT_INSURANCE",
  INCOME_TAX: "payslip.deduction.INCOME_TAX",
  LOCAL_INCOME_TAX: "payslip.deduction.LOCAL_INCOME_TAX",
};

type PresentedLedgerRow = {
  key: string;
  label: string;
  detail?: string;
  amount: string;
  numericValue: number;
};

type PresentedStatItem = {
  key: string;
  label: string;
  value: string;
  meta?: string;
};

export function presentEarningRows(payload: PayslipPayload): PresentedLedgerRow[] {
  return buildEarningLines(payload).map(line => {
    if (line.kind === "base") {
      return {
        key: "base",
        label: t("payslip.item.basePay"),
        amount: fmtNumber(line.amountWon),
        numericValue: line.amountWon,
      };
    }
    if (line.kind === "overtime") {
      return {
        key: "overtime",
        label: t("payslip.item.overtimePay"),
        detail:
          line.overtimeHours != null && line.overtimeHours > 0
            ? t("payslip.item.overtimeHours", { hours: fmtNumber(line.overtimeHours) })
            : undefined,
        amount: fmtNumber(line.amountWon),
        numericValue: line.amountWon,
      };
    }
    if (line.kind === "meal") {
      return {
        key: "meal",
        label: t("payslip.item.mealAllowance"),
        detail: t("payslip.item.taxExempt"),
        amount: fmtNumber(line.amountWon),
        numericValue: line.amountWon,
      };
    }
    return {
      key: "gross",
      label: t("payslip.item.grossFallback"),
      amount: fmtNumber(line.amountWon),
      numericValue: line.amountWon,
    };
  });
}

export function presentDeductionRows(payload: PayslipPayload): PresentedLedgerRow[] {
  return payload.deductions.map((item, idx) => ({
    key: `${item.code}-${idx}`,
    label: isKnownDeductionCode(item.code)
      ? t(DEDUCTION_KEY_MAP[item.code])
      : item.labelKo ?? item.code,
    amount: fmtNumber(item.amountWon),
    numericValue: item.amountWon,
  }));
}

export function presentSummaryStats(payload: PayslipPayload): PresentedStatItem[] {
  return [
    { key: "gross", label: t("payslip.grossTotal"), value: fmtNumber(payload.grossWon) },
    { key: "deductions", label: t("payslip.deductionsMinus"), value: fmtNumber(payload.totalDeductionsWon) },
  ];
}

export function presentContextStats(payload: PayslipPayload): PresentedStatItem[] {
  const work = buildWorkSummary(payload.workDays, payload.paidHolidayDays);
  if (work === null && payload.leaveUsed === null) return [];
  return [
    {
      key: "work",
      label: t("payslip.context.work"),
      value: work !== null ? t("payslip.context.days", { days: fmtNumber(work.totalDays) }) : t("payslip.context.unset"),
      meta:
        work !== null && work.paidHolidayDays !== null
          ? t("payslip.context.workBreakdown", {
              worked: fmtNumber(work.workedDays),
              holiday: fmtNumber(work.paidHolidayDays),
            })
          : undefined,
    },
    {
      key: "leave",
      label: t("payslip.context.leave"),
      value:
        payload.leaveUsed !== null
          ? t("payslip.context.days", { days: fmtNumber(payload.leaveUsed) })
          : t("payslip.context.unset"),
    },
  ];
}
