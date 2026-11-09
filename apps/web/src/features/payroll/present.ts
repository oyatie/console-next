// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { legacyPayrollBlockers } from "@console/i18n/payroll-blockers";
import type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "./api";
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
export const rateValue = (rate: PayrollRate) => cited(rate) && rate.status !== "HELD" ? rate.value : t("payroll.reference.held");
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
  // shortcut: the API still sends minimum-wage prose; remove the mapping when it emits codes.
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
