// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { PayrollRate, PayrollRates, PayrollRun } from "./api";
export const runStatus = (status: PayrollRun["status"]) => t(`payroll.run.${status}`);
export function cited(rate: PayrollRate) {
  try {
    return [rate.instrument_ko, rate.article_ko, rate.promulgation_ko, rate.enforced_on, rate.retrieved_on, rate.provenance_ko].every(v => !!v.trim()) && new URL(rate.source_url).protocol === "https:";
  } catch { return false; }
}
export const rateValue = (rate: PayrollRate) => cited(rate) && rate.status !== "HELD" ? rate.value : t("payroll.reference.held");
export const referenceStatus = (rates: PayrollRates) => !rates.adopted ? t("payroll.reference.noPack") : rates.items.length ? null : t("payroll.reference.empty");
