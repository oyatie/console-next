// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Chip } from "../chip";
import { Ledger } from "./index";

export const order = 94;

/** Rule-divided itemized financial ledger in desktop column and phone inline layouts. */
export default function LedgerGallery() {
  return (
    <section className="card gallery__section" data-ledger-gallery="">
      <h2 className="toolbar__title">{tg("section.ledger")}</h2>

      <Ledger
        title={t("payroll.stage.payment")}
        headerSurface="surface"
        detailLayout="column"
        rows={[
          { key: "base", label: t("people.field.basePay"), amount: "3,100,000", numericValue: 3100000 },
          {
            key: "ot",
            label: t("attendance.tab.overtime"),
            detail: <a href="#ledger-overtime">{tg("ledger.overtimeDesk")}</a>,
            amount: "267,000",
            numericValue: 267000,
          },
          { key: "meal", label: tg("ledger.meal"), detail: tg("ledger.taxExempt"), amount: "200,000", numericValue: 200000 },
        ]}
        totals={[
          { key: "gross", label: t("payroll.employee.gross"), amount: "3,567,000", numericValue: 3567000, kind: "total" },
          {
            key: "taxable",
            label: tg("ledger.taxable"),
            detail: tg("ledger.taxableFormula"),
            amount: "3,367,000",
            numericValue: 3367000,
            kind: "note",
          },
        ]}
      />

      <Ledger
        title={t("payroll.employee.deductions")}
        headerTag={<Chip tone="warn">{tg("ledger.pendingReview")}</Chip>}
        headerSurface="surface"
        detailLayout="column"
        rows={[
          { key: "pension", label: t("enum.insurer.NPS"), detail: tg("ledger.pensionBasis"), amount: "151,515", numericValue: 151515 },
          { key: "health", label: t("enum.insurer.NHIS"), detail: tg("ledger.healthBasis"), amount: "119,360", numericValue: 119360 },
          { key: "adj", label: tg("ledger.retro"), detail: tg("ledger.retroBasis"), amount: "-12,000", numericValue: -12000, tone: "negative" },
          { key: "zero", label: tg("ledger.union"), amount: "0", numericValue: 0, tone: "zero" },
        ]}
        totals={[
          { key: "sub", label: tg("ledger.subtotal"), amount: "258,875", numericValue: 258875, kind: "subtotal" },
          { key: "ded", label: tg("ledger.deductionTotal"), amount: "258,875", numericValue: 258875, kind: "total" },
        ]}
        footnote={tg("ledger.footnote")}
      />

      <div className="gallery__phone">
        <Ledger
          title={t("payroll.stage.payment")}
          unit={tg("ledger.unit")}
          headerSurface="muted"
          detailLayout="inline"
          rows={[
            { key: "base", label: t("people.field.basePay"), amount: "3,100,000", numericValue: 3100000 },
            { key: "ot", label: t("attendance.tab.overtime"), detail: tg("ledger.overtimePhone"), amount: "267,000", numericValue: 267000 },
            { key: "meal", label: tg("ledger.meal"), detail: tg("ledger.taxExempt"), amount: "200,000", numericValue: 200000 },
          ]}
          totals={[{ key: "gross", label: t("payroll.employee.gross"), amount: "3,567,000", numericValue: 3567000 }]}
        />
      </div>

      <Ledger title={tg("ledger.loadingTitle")} rows={[]} loading />
      <Ledger title={tg("ledger.emptyTitle")} rows={[]} empty={tg("empty.title")} />
      <Ledger title={tg("ledger.errorTitle")} rows={[]} error={tg("error.message")} />
    </section>
  );
}
