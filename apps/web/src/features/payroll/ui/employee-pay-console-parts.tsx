// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { jsonEqual } from "../../../lib/pure/three-way";
import { EmptyState } from "../../../ui/empty-state";
import { ExternalLink } from "../../../ui/external-link";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordSection } from "../../../ui/record/record-section";
import { Table } from "../../../ui/table";
import {
  deductionCited,
  deductionSourcesCited,
  insuranceCited,
  instrumentCited,
  type Instrument,
  type PayslipDraft,
} from "../present";
import s from "./payroll-console.module.css";

const won = (amount: number) => t("payroll.employee.won", { amount: fmtNumber(amount) });

export function SourceConsole({ instrument, provenance }: { instrument: Instrument; provenance?: string }) {
  return instrumentCited(instrument, provenance) ? (
    <div className={`${s.sectionStack} ${s.wrapUrl}`}>
      <ExternalLink href={instrument.url}>
        {instrument.name_ko} · {instrument.article_ko} · {instrument.promulgation_ko}
      </ExternalLink>
      <bdi className="muted">
        {t("payroll.reference.enforced", { date: fmtDate(instrument.enforced_on) })} ·{" "}
        {t("payroll.reference.retrieved", { date: fmtDate(instrument.retrieved_on) })}
      </bdi>
      {provenance ? <bdi>{provenance}</bdi> : null}
    </div>
  ) : (
    <bdi>{t("payroll.reference.held")}</bdi>
  );
}

export function EmployeePayDeductionsSection({
  data,
  earningsCited,
  amount,
}: {
  data: PayslipDraft;
  earningsCited: boolean;
  amount: (value: number | null | undefined, sourced: boolean) => string;
}) {
  return (
    <RecordSection id="emp-pay-deductions" title={t("payroll.employee.deductions")}>
      <div className={`${s.sectionStack} ${s.deductionsTable}`}>
        {data.deductions?.length ? (
          <Table
            label={t("payroll.employee.deductions")}
            rows={data.deductions}
            rowId={row => row.code}
            mobileLayout="cards"
            columns={[
              { header: t("payroll.reference.item"), card: "title", rowHeader: true, cell: row => row.label_ko },
              {
                header: t("payroll.employee.employeeAmount"),
                card: "fact",
                cell: row =>
                  row.employer_only
                    ? t("payroll.employee.employerOnly")
                    : deductionCited(row)
                      ? won(row.employee_won!)
                      : t("payroll.reference.held"),
              },
              {
                header: t("payroll.reference.citation"),
                card: "fact",
                cell: row => (
                  <div className={s.sectionStack}>
                    {deductionSourcesCited(row) ? (
                      <>
                        <SourceConsole instrument={row.instrument} provenance={row.provenance_ko} />
                        {row.share_instrument && !jsonEqual(row.instrument, row.share_instrument) ? (
                          <SourceConsole instrument={row.share_instrument} />
                        ) : null}
                      </>
                    ) : (
                      <bdi>{t("payroll.reference.held")}</bdi>
                    )}
                    {row.blocked_by ? <bdi>{t("payroll.employee.blocker", { code: row.blocked_by })}</bdi> : null}
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState
            compact
            title={t("payroll.employee.noDeductions")}
            reason={t("payroll.employee.noDeductionsReason")}
          />
        )}
        {data.total_employee_insurance_won !== undefined ? (
          <KeyValue
            readOnly
            items={[
              {
                key: "insurance",
                label: t("payroll.employee.insuranceTotal"),
                value: amount(data.total_employee_insurance_won, insuranceCited(data)),
              },
              {
                key: "remainder",
                label: t("payroll.employee.afterInsurance"),
                value: amount(data.remainder_after_insurance_won, insuranceCited(data) && earningsCited),
              },
            ]}
          />
        ) : null}
      </div>
    </RecordSection>
  );
}
