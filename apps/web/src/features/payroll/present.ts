// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "./api";
const dayText = (day: number | "LAST_DAY" | "FIRST") => day === "LAST_DAY" ? t("payroll.rule.lastDay") : t("payroll.rule.day", { day: day === "FIRST" ? 1 : day });
export const payDateRule = (rule: PayGroup["pay_date_rule"]) => t("payroll.rule.payDate", { month: t(`payroll.rule.payMonth.${rule.month_offset}`), day: dayText(rule.day), business: t(`payroll.rule.${rule.non_business_day}`) });
export const periodRule = (rule: PayGroup["base_period"]) => t("payroll.rule.period", { month: t(`payroll.rule.periodMonth.${rule.month_offset}`), day: dayText(rule.start_day) });
export const runStatus = (status: PayrollRun["status"]) => t(`payroll.run.${status}`);
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
export const instrumentCited = (instrument: Instrument, provenance: string) => cited({ instrument_ko: instrument.name_ko, article_ko: instrument.article_ko, promulgation_ko: instrument.promulgation_ko, enforced_on: instrument.enforced_on, source_url: instrument.url, retrieved_on: instrument.retrieved_on, provenance_ko: provenance });
export const contractCited = (contract: PayslipDraft["contract"]) => !!contract?.source_note.trim() && Number.isSafeInteger(contract.amount_won);
export const deductionCited = (row: NonNullable<PayslipDraft["deductions"]>[number]) => !row.blocked_by && Number.isSafeInteger(row.employee_won) && instrumentCited(row.instrument, row.provenance_ko) && (!row.share_instrument || instrumentCited(row.share_instrument, row.provenance_ko));

const blockerLabels = { ATTENDANCE_INCOMPLETE: "payroll.employee.attendanceIncomplete", WITHHOLDING_NOT_COMPUTED: "payroll.employee.withholdingMissing", CONTRACT_WAGE_NOT_IN_FORCE: "payroll.employee.noContract", HOURLY_WAGE_NOT_SUPPORTED_IN_THIS_SLICE: "payroll.employee.hourlyUnsupported" } as const;
export function blockerText(code: string) {
  const key = code.split(":")[0]!;
  return Object.hasOwn(blockerLabels, key) ? t(blockerLabels[key as keyof typeof blockerLabels]) : t("payroll.employee.blocker", { code });
}
