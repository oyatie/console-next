// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { EmptyState } from "../../../ui/empty-state";
import { ExternalLink } from "../../../ui/external-link";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import type { PayrollRates } from "../api";
import { cited, rateValue, referenceStatus } from "../present";
export function ReferenceRegister({ data }: { data: PayrollRates }) {
  const status = referenceStatus(data);
  // Content-sized rows keep the full citation visible even though this register is read-only.
  return status ? <EmptyState title={status} reason={t("payroll.reference.noPackReason", { country: data.country_code })} /> :
    <LongTable editable label={t("payroll.reference.title")} empty={null} rows={data.items} rowId={rate => rate.code} hasMore={false} onLoadMore={() => {}} columns={[
      { id: "name", header: t("payroll.reference.item"), rowHeader: true, card: "title", cell: rate => <>{rate.name} <Chip>{t(`payroll.reference.${cited(rate) ? rate.status : "HELD"}`)}</Chip></> },
      { id: "value", card: "fact", header: t("payroll.reference.value"), cell: rateValue },
      { id: "citation", card: "action", header: t("payroll.reference.citation"), width: "2fr", cell: rate => <div className="form">
        <span>{t("payroll.reference.period", { from: fmtDate(rate.effective_from), to: rate.effective_to_exclusive ? t("payroll.reference.until", { date: fmtDate(rate.effective_to_exclusive) }) : t("payroll.reference.open") })}</span>
        {cited(rate) ? <><ExternalLink href={rate.source_url}>{rate.instrument_ko} · {rate.article_ko} · {rate.promulgation_ko}</ExternalLink>
          <span>{t("payroll.reference.enforced", { date: fmtDate(rate.enforced_on) })}</span><span>{t("payroll.reference.retrieved", { date: fmtDate(rate.retrieved_on) })} · {rate.provenance_ko}</span></> : <span>{t("payroll.reference.held")}</span>}
      </div> },
    ]} />;
}
