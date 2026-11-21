// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { legacyPayrollBlockers } from "@console/i18n/payroll-blockers";
import type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "./api";
import {
  buildCompactRunStages,
  shortMonthDay,
  type PayrollLineSummary,
  type PayrollRunDetail,
} from "./domain/run-register";
const dayText = (day: number | "LAST_DAY" | "FIRST") => day === "LAST_DAY" ? t("payroll.rule.lastDay") : t("payroll.rule.day", { day: day === "FIRST" ? 1 : day });
export const payDateRule = (rule: PayGroup["pay_date_rule"]) => t("payroll.rule.payDate", { month: t(`payroll.rule.payMonth.${rule.month_offset}`), day: dayText(rule.day), business: t(`payroll.rule.${rule.non_business_day}`) });
export const periodRule = (rule: PayGroup["base_period"]) => t("payroll.rule.period", { month: t(`payroll.rule.periodMonth.${rule.month_offset}`), day: dayText(rule.start_day) });
export const runStatus = (status: PayrollRun["status"]) => t(`payroll.run.${status}`);
export const runName = (run: PayrollRun, group?: PayGroup) => group && group.id === run.pay_group_id && group.legal_entity_id === run.legal_entity_id && run.kind && run.attribution_month
  ? t("payroll.runLabel", { group: group.name, month: run.attribution_month, kind: t(`payroll.create.kind.${run.kind}`) })
  : run.pay_group_id ? t("payroll.runName") : run.source_label;
export function cited(rate: Pick<PayrollRate, "instrument_ko" | "article_ko" | "promulgation_ko" | "enforced_on" | "source_url" | "retrieved_on" | "provenance_ko">) {
  try {
    return [rate.instrument_ko, rate.article_ko, rate.promulgation_ko, rate.enforced_on, rate.retrieved_on, rate.provenance_ko].every(v => !!v.trim()) && new URL(rate.source_url).protocol === "https:";
  } catch { return false; }
}
export const rateValue = (rate: PayrollRate) => cited(rate) && rate.status !== "HELD" && rate.value !== null ? rate.value : t("payroll.reference.held");
export const referenceStatus = (rates: PayrollRates) => !rates.adopted ? t("payroll.reference.noPack") : rates.items.length ? null : t("payroll.reference.empty");

const stages = ["attendance", "calculate", "exceptions", "approval", "payment", "delivery"] as const;
const currentStage = {
  STAGED: "attendance", BLOCKED_LEGAL_GATE: "attendance", READY_FOR_REVIEW: "attendance",
  ATTENDANCE_CLOSED: "calculate", CALCULATING: "calculate", CALCULATED: "exceptions", REJECTED: "exceptions",
  SUBMITTED: "approval", APPROVED: "payment", DISBURSEMENT_SCHEDULED: "payment", PAID: "delivery", ISSUED: "complete", VOID: "void",
} as const satisfies Record<PayrollRun["status"], typeof stages[number] | "complete" | "void">;
export function runStages(status: PayrollRun["status"]) {
  const stage = currentStage[status];
  const current = stage === "complete" ? stages.length : stage === "void" ? -1 : stages.indexOf(stage);
  return stages.map((key, index) => ({ key, state: index === current ? "current" as const : index < current ? "done" as const : "waiting" as const }));
}

import type { components } from "@console/api/schema";
export type PayslipDraft = components["schemas"]["PayrollPayslipDraft"];
export type Instrument = components["schemas"]["PayrollStatutoryInstrument"];
export const instrumentCited = (instrument: Instrument, provenance: string = instrument.name_ko) => cited({ instrument_ko: instrument.name_ko, article_ko: instrument.article_ko, promulgation_ko: instrument.promulgation_ko, enforced_on: instrument.enforced_on, source_url: instrument.url, retrieved_on: instrument.retrieved_on, provenance_ko: provenance });
export const contractCited = (contract: PayslipDraft["contract"]) => !!contract?.source_note.trim() && Number.isSafeInteger(contract.amount_won);
type Deduction = NonNullable<PayslipDraft["deductions"]>[number];
export const deductionSourcesCited = (row: Deduction) => instrumentCited(row.instrument, row.provenance_ko) && (!row.share_instrument || instrumentCited(row.share_instrument, row.provenance_ko));
export const deductionCited = (row: Deduction) => !row.blocked_by && Number.isSafeInteger(row.employee_won) && deductionSourcesCited(row);
export function insuranceCited(data: PayslipDraft) {
  const rows = data.deductions?.filter(row => !row.employer_only) ?? [];
  return rows.length > 0 && rows.every(deductionCited) && Number.isSafeInteger(data.total_employee_insurance_won)
    && rows.reduce((sum, row) => sum + row.employee_won!, 0) === data.total_employee_insurance_won;
}
type MinimumWageBlocker = "MINIMUM_WAGE_BELOW_FLOOR" | "MINIMUM_WAGE_NOT_COMPARABLE";
export function draftBlockers(data: PayslipDraft): string[] {
  // Preserve minimum-wage findings from older servers that still send prose.
  const codes = data.blockers.map(code => { const key = code.split(":")[0]!; return Object.hasOwn(legacyPayrollBlockers, key) ? legacyPayrollBlockers[key as keyof typeof legacyPayrollBlockers] : code; });
  const check = data.minimum_wage_check;
  const minimum: MinimumWageBlocker | null = check?.passes === false ? "MINIMUM_WAGE_BELOW_FLOOR" : check?.passes === null ? "MINIMUM_WAGE_NOT_COMPARABLE" : null;
  return [...new Set([...codes, ...(minimum ? [minimum] : [])])];
}

const blockerLabels = { MINIMUM_WAGE_BELOW_FLOOR: "payroll.employee.minimumBelow", MINIMUM_WAGE_NOT_COMPARABLE: "payroll.employee.minimumIncomparable", ATTENDANCE_INCOMPLETE: "payroll.employee.attendanceIncomplete", WITHHOLDING_NOT_COMPUTED: "payroll.employee.withholdingMissing", CONTRACT_WAGE_NOT_IN_FORCE: "payroll.employee.noContract", HOURLY_WAGE_NOT_SUPPORTED_IN_THIS_SLICE: "payroll.employee.hourlyUnsupported" } as const;
export function blockerText(code: string) {
  const key = code.split(":")[0]!;
  return Object.hasOwn(blockerLabels, key) ? t(blockerLabels[key as keyof typeof blockerLabels]) : t("payroll.employee.blocker", { code });
}

const RUN_CSV_HEADERS = [
  "payroll.run.col.name",
  "payroll.run.col.unit",
  "payroll.run.col.grossTotal",
  "enum.insurer.NPS",
  "enum.insurer.NHIS",
  "payroll.run.col.longTermCare",
  "enum.insurer.EI",
  "payroll.run.col.incomeTax",
  "payroll.run.col.localIncomeTax",
  "payroll.run.col.deductionsTotal",
  "payroll.run.col.netPay",
  "payroll.run.col.workDays",
  "payroll.run.col.leaveUsed",
] as const satisfies readonly Parameters<typeof t>[0][];

export function buildRunCsvHeader(): string[] {
  return RUN_CSV_HEADERS.map(key => t(key));
}

export function buildRunStageSteps(run: PayrollRunDetail["run"]) {
  return buildCompactRunStages(run.status).map(step => ({
    ...step,
    label:
      step.key === "calc"
        ? t("payroll.run.CALCULATED")
        : step.key === "approval"
          ? run.status === "SUBMITTED"
            ? t("payroll.run.SUBMITTED")
            : t("payroll.run.stagePendingApproval")
          : t("payroll.run.stagePayDate", { date: shortMonthDay(run.pay_date) }),
  }));
}

export function buildRunStatusSegments({
  runHeadcount,
  rangeFrom,
  rangeTo,
  checkedLines,
  selectedStatusLine,
  selectedStatusCount,
  selectedStatusName,
  attentionCount,
  hasBankIssues,
}: {
  runHeadcount: number;
  rangeFrom: number;
  rangeTo: number;
  checkedLines: readonly PayrollLineSummary[];
  selectedStatusLine?: PayrollLineSummary;
  selectedStatusCount: number;
  selectedStatusName: string;
  attentionCount: number;
  hasBankIssues: boolean;
}) {
  const selectedNetWon =
    checkedLines.length > 1
      ? checkedLines.every(line => typeof line.net_won === "number" && Number.isFinite(line.net_won))
        ? checkedLines.reduce((sum, line) => sum + line.net_won!, 0)
        : null
      : (selectedStatusLine?.net_won ?? null);

  return [
    { id: "target", tone: "strong" as const, content: t("payroll.run.statusTarget", { count: runHeadcount }) },
    ...(rangeTo > 0 ? [{ id: "shown", content: t("payroll.run.statusShown", { from: rangeFrom, to: rangeTo }) }] : []),
    ...(selectedStatusLine && selectedStatusCount > 0
      ? [
          {
            id: "selected",
            content: t("payroll.run.statusSelected", { count: selectedStatusCount, name: selectedStatusName }),
          },
          ...(selectedNetWon != null
            ? [{ id: "selected-net", content: t("payroll.run.statusSelectedNet", { amount: fmtNumber(selectedNetWon) }) }]
            : []),
        ]
      : []),
    ...(attentionCount > 0
      ? [
          {
            id: "attention",
            tone: "attention" as const,
            content: hasBankIssues
              ? t("payroll.run.statusBankHold", { count: attentionCount })
              : t("payroll.run.statusAttention", { count: attentionCount }),
          },
        ]
      : []),
  ];
}
