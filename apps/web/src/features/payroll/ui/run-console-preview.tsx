// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { ExternalLink } from "lucide-react";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Ledger, type LedgerRow, type LedgerTotalRow } from "../../../ui/ledger/ledger";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import {
  RegisterNetBox,
  RegisterNowrap,
  RegisterPreviewCols,
} from "../../../ui/patterns/register-totals-parts";
import {
  DEDUCTION_CODES,
  deductionAmount,
  deductionRateBasis,
  hasBankBlocker,
  type DeductionCode,
  type PayrollLineSummary,
  type PayrollRates,
  type PayrollRunDetail,
} from "../domain/run-register";

const DEDUCTION_LABEL_KEY = {
  NATIONAL_PENSION: "enum.insurer.NPS",
  HEALTH_INSURANCE: "enum.insurer.NHIS",
  LONG_TERM_CARE: "payroll.run.col.longTermCare",
  EMPLOYMENT_INSURANCE: "enum.insurer.EI",
  INCOME_TAX: "payroll.run.col.incomeTax",
  LOCAL_INCOME_TAX: "payroll.run.col.localIncomeTax",
} as const satisfies Record<DeductionCode, Parameters<typeof t>[0]>;

export function RunPayslipPreview({
  detail,
  line,
  rates,
}: {
  detail: PayrollRunDetail;
  line: PayrollLineSummary;
  rates?: PayrollRates;
}) {
  const unreviewed = detail.calculation ? !detail.calculation.payable : false;
  const monthNum = Number(detail.run.attribution_month?.slice(5, 7) ?? 0);
  const monthText = monthNum > 0 ? t("attendanceHolidays.monthN", { n: monthNum }) : detail.run.attribution_month;
  const effectiveOn = detail.run.pay_date || detail.run.period_end;
  const hasBreakdown = line.base_pay_won != null || line.overtime_pay_won != null || line.meal_allowance_won != null;
  const earningsRows: LedgerRow[] = hasBreakdown
    ? [
        ...(line.base_pay_won != null
          ? [
              {
                key: "base-pay",
                label: t("payroll.run.col.basePay"),
                amount: fmtNumber(line.base_pay_won),
                numericValue: line.base_pay_won,
              },
            ]
          : []),
        ...(line.overtime_pay_won != null
          ? [
              {
                key: "overtime-pay",
                label: t("payroll.run.col.overtimePay"),
                detail:
                  line.overtime_hours != null && line.overtime_hours > 0
                    ? t("payroll.run.overtimeDetail", { hours: line.overtime_hours, month: monthText })
                    : undefined,
                amount: fmtNumber(line.overtime_pay_won),
                numericValue: line.overtime_pay_won,
              },
            ]
          : []),
        ...(line.meal_allowance_won != null
          ? [
              {
                key: "meal-allowance",
                label: t("payroll.run.col.mealAllowance"),
                detail: t("payroll.run.taxExempt"),
                amount: fmtNumber(line.meal_allowance_won),
                numericValue: line.meal_allowance_won,
              },
            ]
          : []),
      ]
    : line.gross_won != null
      ? [
          {
            key: "gross-line",
            label: t("payroll.employee.gross"),
            detail:
              line.overtime_hours != null && line.overtime_hours > 0
                ? t("payroll.run.overtimeDetail", { hours: line.overtime_hours, month: monthText })
                : undefined,
            amount: fmtNumber(line.gross_won),
            numericValue: line.gross_won,
          },
        ]
      : [];
  const earningsTotalsList: LedgerTotalRow[] = [];
  if (line.gross_won != null) {
    earningsTotalsList.push({
      key: "gross-total",
      label: t("payroll.run.col.grossTotal"),
      amount: fmtNumber(line.gross_won),
      numericValue: line.gross_won,
      kind: "total",
    });
  }
  if (hasBreakdown && line.taxable_won != null) {
    earningsTotalsList.push({
      key: "taxable-total",
      label: t("payroll.run.taxablePay"),
      detail: t("payroll.run.taxableDetail"),
      amount: fmtNumber(line.taxable_won),
      numericValue: line.taxable_won,
      kind: "note",
      tone: "muted",
    });
  }
  const earningsTotals: LedgerTotalRow[] | undefined = earningsTotalsList.length > 0 ? earningsTotalsList : undefined;

  const deductionRows: LedgerRow[] = DEDUCTION_CODES.flatMap(code => {
    const amt = deductionAmount(line, code);
    if (amt == null) return [];
    const basis = deductionRateBasis(code, line, rates, effectiveOn);
    const detailText =
      basis?.kind === "taxable"
        ? t("payroll.run.rateNote.taxable", { rate: basis.rate })
        : basis?.kind === "healthInsurance"
          ? t("payroll.run.rateNote.healthInsurance", { rate: basis.rate })
          : basis?.kind === "simplifiedTax"
            ? t("payroll.run.rateNote.simplifiedTax")
            : basis?.kind === "localIncomeTax"
              ? t("payroll.run.rateNote.localIncomeTax", { rate: basis.rate })
              : undefined;
    return [
      {
        key: code,
        label: t(DEDUCTION_LABEL_KEY[code]),
        detail: detailText,
        amount: fmtNumber(amt),
        numericValue: amt,
      },
    ];
  });
  const deductionTotals: LedgerTotalRow[] | undefined =
    line.total_deductions_won != null
      ? [
          {
            key: "ded-total",
            label: t("payroll.run.col.deductionsTotal"),
            amount: fmtNumber(line.total_deductions_won),
            numericValue: line.total_deductions_won,
            kind: "total",
          },
        ]
      : undefined;

  const bankMissing = !line.bank_account_registered || hasBankBlocker(line);
  const netFormula =
    line.gross_won != null && line.total_deductions_won != null
      ? `${fmtNumber(line.gross_won)} − ${fmtNumber(line.total_deductions_won)}`
      : undefined;
  const headerMeta = [
    [line.employee_display_name, line.employee_number].filter(Boolean).join(" "),
    line.org_unit || line.employee_company || "—",
    line.position || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <PaneHead
        title={t("payroll.run.previewTitle")}
        meta={headerMeta}
        actions={
          line.employee_id ? (
            <Link to="/people/$id" params={{ id: line.employee_id }} className={buttonClass("secondary", { size: "sm" })}>
              <ExternalLink size={12} aria-hidden="true" />
              <RegisterNowrap>{t("payroll.run.openCard")}</RegisterNowrap>
            </Link>
          ) : undefined
        }
      />
      <RegisterPreviewCols
        left={
          <Ledger
            title={t("payroll.run.colGroup.earnings")}
            detailLayout="column"
            rows={earningsRows}
            totals={earningsTotals}
            empty={t("payroll.employee.notComputed")}
          />
        }
        middle={
          <Ledger
            title={t("payroll.run.colGroup.deductions")}
            headerTag={unreviewed ? <Chip tone="warn">{t("payroll.run.unreviewedPreviewTag")}</Chip> : undefined}
            detailLayout="column"
            rows={deductionRows}
            totals={deductionTotals}
            empty={t("payroll.employee.notComputed")}
          />
        }
        right={
          <RegisterNetBox
            label={t("payroll.run.col.netPay")}
            formula={netFormula}
            amount={line.net_won != null ? t("payroll.employee.won", { amount: fmtNumber(line.net_won) }) : "—"}
            details={
              <KeyValue
                readOnly
                density="dense"
                items={[
                  {
                    key: "payDate",
                    label: t("payroll.create.payDate"),
                    value: detail.run.pay_date && /^\d{4}-\d{2}-\d{2}$/.test(detail.run.pay_date) ? (
                      <RegisterNowrap>
                        <time dateTime={detail.run.pay_date}>{detail.run.pay_date}</time>
                      </RegisterNowrap>
                    ) : (
                      fmtDate(detail.run.pay_date)
                    ),
                  },
                  {
                    key: "bank",
                    label: t("payroll.run.bankField"),
                    value: bankMissing ? t("payroll.run.bankMissingHold") : t("payroll.run.bankRegistered"),
                  },
                  {
                    key: "work",
                    label: t("payroll.run.attendanceLeave"),
                    value:
                      line.work_days != null || line.leave_used != null ? (
                        <>
                          {t("payroll.run.attendanceLeaveVal", { work: line.work_days ?? 0, leave: line.leave_used ?? 0 })}
                          {line.paid_holiday_days != null && line.paid_holiday_days > 0 && (
                            <>
                              {" "}
                              <bdi className="muted">
                                {t("payroll.run.attendanceHolidaySplit", {
                                  worked: Math.max(0, (line.work_days ?? 0) - line.paid_holiday_days),
                                  holiday: line.paid_holiday_days,
                                })}
                              </bdi>
                            </>
                          )}
                        </>
                      ) : (
                        "—"
                      ),
                  },
                ]}
              />
            }
          />
        }
      />
    </>
  );
}
