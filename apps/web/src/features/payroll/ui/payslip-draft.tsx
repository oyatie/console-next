// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { ExternalLink } from "../../../ui/external-link";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { blockerText, contractCited, deductionCited, deductionSourcesCited, insuranceCited, draftBlockers, instrumentCited, type Instrument, type PayslipDraft } from "../present";
const won = (amount: number) => t("payroll.employee.won", { amount: fmtNumber(amount) });
function Source({ instrument, provenance }: { instrument: Instrument; provenance?: string }) {
  return instrumentCited(instrument, provenance) ? <div className="form">
    <ExternalLink href={instrument.url}>{instrument.name_ko} · {instrument.article_ko} · {instrument.promulgation_ko}</ExternalLink>
    <span>{t("payroll.reference.enforced", { date: fmtDate(instrument.enforced_on) })} · {t("payroll.reference.retrieved", { date: fmtDate(instrument.retrieved_on) })}</span>
    {provenance && <span>{provenance}</span>}
  </div> : <span>{t("payroll.reference.held")}</span>;
}
export function PayslipDraftView({ data }: { data: PayslipDraft }) {
  const contract = data.contract;
  const blockers = draftBlockers(data);
  const minimum = data.minimum_wage_check;
  const minimumCited = !!minimum && instrumentCited(minimum.instrument);
  const earningsCited = contractCited(contract) && !!data.earnings?.length && data.earnings.every(row => row.code === "BASE_PAY" && Number.isSafeInteger(row.amount_won));
  const amount = (value: number | null | undefined, sourced: boolean) => sourced && Number.isSafeInteger(value) ? won(value!) : t("payroll.reference.held");
  // shortcut: no attendance month-close proof in this contract; require it before marking a draft complete.
  return <div className="form">
    <Card title={data.employee_name} meta={<Chip tone="warn">{t("payroll.employee.incomplete")}</Chip>}>
      <KeyValue readOnly items={[
        { key: "period", label: t("payroll.period"), value: `${fmtDate(data.period.start)} – ${fmtDate(data.period.end)}` },
        { key: "payDate", label: t("payroll.setup.day"), value: fmtDate(data.pay_date) },
        { key: "net", label: t("payroll.employee.net"), value: t("payroll.employee.netUnavailable") },
      ]} />
      {blockers.length > 0 && <ul aria-label={t("payroll.employee.blockers")}>{blockers.map(code => <li key={code}>
        {blockerText(code)}
        {(code === "MINIMUM_WAGE_BELOW_FLOOR" || code === "MINIMUM_WAGE_NOT_COMPARABLE") && minimum && <Source instrument={minimum.instrument} />}
      </li>)}</ul>}
    </Card>
    <Card title={t("payroll.employee.contract")}>
      {contract ? <KeyValue readOnly items={[
        { key: "kind", label: t("payroll.employee.kind"), value: t(`payroll.rule.${contract.wage_kind}`) },
        { key: "amount", label: t("payroll.employee.amount"), value: contractCited(contract) ? won(contract.amount_won) : t("payroll.reference.held") },
        { key: "source", label: t("payroll.employee.source"), value: contract.source_note || t("payroll.reference.held") },
        { key: "effective", label: t("payroll.employee.effective"), value: fmtDate(contract.effective_from) },
      ]} /> : <EmptyState title={t("payroll.employee.noContract")} reason={t("payroll.employee.noContractReason")} />}
    </Card>
    {data.earnings && <Card title={t("payroll.employee.earnings")}>
      <KeyValue readOnly items={[
        ...data.earnings.flatMap(row => [
          { key: row.code, label: row.label_ko, value: amount(row.amount_won, earningsCited) },
          { key: `${row.code}:basis`, label: t("payroll.employee.earningsNote"), value: row.note_ko },
        ]),
        { key: "gross", label: t("payroll.employee.gross"), value: amount(data.gross_won, earningsCited) },
        { key: "source", label: t("payroll.employee.source"), value: contractCited(contract) ? contract!.source_note : t("payroll.reference.held") },
      ]} />
    </Card>}
    {minimum && <Card title={t("payroll.employee.minimumWage")} meta={<Chip tone={!minimumCited || minimum.passes === null ? "warn" : minimum.passes ? "ok" : "danger"}>{!minimumCited ? t("payroll.reference.held") : minimum.passes === null ? t("payroll.employee.minimumIncomparable") : minimum.passes ? t("payroll.employee.minimumPass") : t("payroll.employee.minimumBelow")}</Chip>}>
      <KeyValue readOnly items={[
        { key: "floor", label: t("payroll.employee.hourlyFloor"), value: amount(minimum.hourly_floor_won, minimumCited) },
        { key: "hourly", label: t("payroll.employee.effectiveHourly"), value: minimum.effective_hourly_won === null ? t("payroll.employee.unavailable") : amount(minimum.effective_hourly_won, minimumCited) },
      ]} />
      <Source instrument={minimum.instrument} />
    </Card>}
    <Card title={t("payroll.employee.deductions")}>
      <LongTable editable label={t("payroll.employee.deductions")} rows={data.deductions ?? []} rowId={row => row.code} empty={<EmptyState title={t("payroll.employee.noDeductions")} reason={t("payroll.employee.noDeductionsReason")} />} hasMore={false} onLoadMore={() => {}} columns={[
        { id: "name", header: t("payroll.reference.item"), rowHeader: true, card: "title", cell: row => row.label_ko },
        { id: "amount", header: t("payroll.employee.employeeAmount"), card: "fact", cell: row => row.employer_only ? t("payroll.employee.employerOnly") : deductionCited(row) ? won(row.employee_won!) : t("payroll.reference.held") },
        { id: "source", header: t("payroll.reference.citation"), width: "2fr", card: "action", cell: row => <div className="form">{deductionSourcesCited(row) ? <><Source instrument={row.instrument} provenance={row.provenance_ko} />{row.share_instrument && <Source instrument={row.share_instrument} provenance={row.provenance_ko} />}</> : <span>{t("payroll.reference.held")}</span>}{row.blocked_by && <p>{t("payroll.employee.blocker", { code: row.blocked_by })}</p>}</div> },
      ]} />
      {data.total_employee_insurance_won !== undefined && <KeyValue readOnly items={[
        { key: "insurance", label: t("payroll.employee.insuranceTotal"), value: amount(data.total_employee_insurance_won, insuranceCited(data)) },
        { key: "remainder", label: t("payroll.employee.afterInsurance"), value: amount(data.remainder_after_insurance_won, insuranceCited(data) && earningsCited) },
      ]} />}
    </Card>
    {data.not_computed?.map(row => <Card key={row.code} title={row.label_ko} meta={t("payroll.employee.notComputed")}><Source instrument={row.instrument} provenance={row.reason_ko} /></Card>)}
  </div>;
}
