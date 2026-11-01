// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "./api";
const dayText = (day: number | "LAST_DAY" | "FIRST") => day === "LAST_DAY" ? t("payroll.rule.lastDay") : t("payroll.rule.day", { day: day === "FIRST" ? 1 : day });
export const payDateRule = (rule: PayGroup["pay_date_rule"]) => t("payroll.rule.payDate", { month: t(`payroll.rule.payMonth.${rule.month_offset}`), day: dayText(rule.day), business: t(`payroll.rule.${rule.non_business_day}`) });
export const periodRule = (rule: PayGroup["base_period"]) => t("payroll.rule.period", { month: t(`payroll.rule.periodMonth.${rule.month_offset}`), day: dayText(rule.start_day) });
export const runStatus = (status: PayrollRun["status"]) => t(`payroll.run.${status}`);
export function cited(rate: PayrollRate) {
  try {
    return [rate.instrument_ko, rate.article_ko, rate.promulgation_ko, rate.enforced_on, rate.retrieved_on, rate.provenance_ko].every(v => !!v.trim()) && new URL(rate.source_url).protocol === "https:";
  } catch { return false; }
}
export const rateValue = (rate: PayrollRate) => cited(rate) && rate.status !== "HELD" ? rate.value : t("payroll.reference.held");
export const referenceStatus = (rates: PayrollRates) => !rates.adopted ? t("payroll.reference.noPack") : rates.items.length ? null : t("payroll.reference.empty");
