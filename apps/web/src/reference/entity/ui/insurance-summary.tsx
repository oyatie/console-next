// SPDX-License-Identifier: LicenseRef-Proprietary
import type { InsuranceRelation } from "@console/api/pending";
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";

/** One summary for a workplace's social insurance relations across lists. */
export function InsuranceSummary({ insurance }: { insurance: InsuranceRelation[] }) {
  const pending = insurance.filter(i => i.status === "ESTABLISHED_NUMBER_PENDING").length;
  const done = insurance.filter(i => i.status === "ESTABLISHED").length;
  if (pending) return <Chip tone="warn">{t("entityRecord.workplaces.insPending", { count: pending })}</Chip>;
  return done ? <Chip tone="ok">{t("entityRecord.workplaces.insDone", { count: done })}</Chip> : <Chip tone="neutral">{t("entityRecord.workplaces.insNone")}</Chip>;
}
