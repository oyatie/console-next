// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, type ReactNode } from "react";
import { t } from "@console/i18n";
import s from "./ledger.module.css";

/** Visual emphasis for a ledger line amount (`negative` pairs with an explicit minus sign; `zero` and `muted` recede). */
export type LedgerRowTone = "default" | "negative" | "zero" | "muted";

/** Structural role of a footer summary row (`subtotal`, bold `total`, or muted derived `note`). */
export type LedgerTotalKind = "subtotal" | "total" | "note";

/** One itemized earning, deduction, or ledger line. */
export type LedgerRow = {
  /** Stable React key within the ledger. */
  key: string;
  /** Item name rendered as the row header (`<th scope="row">`). */
  label: ReactNode;
  /** Optional basis, hours, tax-exempt qualifier, or provenance link. */
  detail?: ReactNode;
  /** Formatted monetary or numeric value (caller formats separators, currency, and minus sign). */
  amount: ReactNode;
  /** Optional machine-readable numeric value emitted on `<data value>`. */
  numericValue?: number;
  /** Visual tone of the row (`negative` uses `--danger-tx`; `zero` uses `--faint`; `muted` uses `--steel`). */
  tone?: LedgerRowTone;
};

/** Subtotal, total, or derived summary line rendered in `<tfoot>`. */
export type LedgerTotalRow = {
  /** Stable React key within the footer. */
  key: string;
  /** Summary label. */
  label: ReactNode;
  /** Optional formula or basis text. */
  detail?: ReactNode;
  /** Formatted summary amount. */
  amount: ReactNode;
  /** Optional machine-readable numeric value emitted on `<data value>`. */
  numericValue?: number;
  /** Footer row hierarchy (`total` by default). */
  kind?: LedgerTotalKind;
  /** Optional numeric tone override. */
  tone?: LedgerRowTone;
};

export type LedgerProps = {
  /** Visible section heading. */
  title?: ReactNode;
  /** Optional id applied to the heading element for external focus management. */
  titleId?: string;
  /** Heading level (`3` by default). */
  level?: 2 | 3 | 4;
  /** Accessible name for the section and table when `title` is omitted or extra context is needed. */
  label?: string;
  /** Right-aligned unit header text. */
  unit?: ReactNode;
  /** Optional badge or status chip placed beside `title`. */
  headerTag?: ReactNode;
  /** Header surface style: `"surface"` for embedded desk panes, `"muted"` for standalone phone bands. */
  headerSurface?: "surface" | "muted";
  /** Placement of row `detail`: `"column"` aligns details in a middle column; `"inline"` sits beside `label`. */
  detailLayout?: "column" | "inline";
  /** Itemized ledger lines rendered in `<tbody>`. */
  rows: readonly LedgerRow[];
  /** Subtotal, total, and derived summary rows rendered in `<tfoot>`. */
  totals?: readonly LedgerTotalRow[];
  /** Optional footer text rendered beneath the table when non-null. */
  footnote?: ReactNode;
  /** Custom `sr-only` table column labels (defaults to `uiLedger.colItem`, `uiLedger.colDetail`, `uiLedger.colAmount`). */
  columns?: { item?: string; detail?: string; amount?: string };
  /** Busy loading state replacing rows with a skeleton outside `<table>`. */
  loading?: boolean;
  /** Empty state content shown when `rows.length === 0` and not loading or error. */
  empty?: ReactNode;
  /** Error alert content shown when truthy, replacing rows. */
  error?: ReactNode;
};

/** Rule-divided itemized financial or payroll ledger with semantic table structure and tabular numerals. */
export function Ledger({
  title,
  titleId,
  level = 3,
  label,
  unit,
  headerTag,
  headerSurface = "surface",
  detailLayout = "column",
  rows,
  totals,
  footnote,
  columns,
  loading,
  empty,
  error,
}: LedgerProps) {
  const autoId = useId();
  const headId = titleId ?? autoId;
  const hasHead = title != null || headerTag != null || unit != null;
  const Heading = level === 2 ? "h2" : level === 4 ? "h4" : "h3";
  const hasColumnDetail =
    detailLayout === "column" &&
    (rows.some(r => r.detail != null) || Boolean(totals?.some(r => r.detail != null)));

  const renderAmount = (amount: ReactNode, numericValue?: number) =>
    numericValue != null && Number.isFinite(numericValue) ? (
      <data value={String(numericValue)} className={s.amountVal}>
        <bdi>{amount}</bdi>
      </data>
    ) : (
      <bdi className={s.amountVal}>{amount}</bdi>
    );

  return (
    <section
      className={s.ledger}
      data-ledger=""
      data-header-surface={headerSurface}
      data-detail-layout={detailLayout}
      aria-busy={loading || undefined}
      aria-labelledby={title != null ? headId : undefined}
      aria-label={title != null ? undefined : label}
    >
      {hasHead && (
        <header className={s.head}>
          <div className={s.headMain}>
            {title != null && (
              <Heading id={headId} className={s.title} tabIndex={titleId ? -1 : undefined}>
                {title}
              </Heading>
            )}
            {headerTag != null && <div className={s.headerTag}>{headerTag}</div>}
          </div>
          {unit != null && <bdi className={s.unit}>{unit}</bdi>}
        </header>
      )}
      {error ? (
        <div className={s.error} role="alert" data-state="error">
          {error}
        </div>
      ) : loading ? (
        <div className={s.loading} role="status">
          <div className={s.skeleton} />
          <div className={s.skeleton} />
        </div>
      ) : rows.length === 0 ? (
        empty != null ? <div className={s.empty}>{empty}</div> : null
      ) : (
        <table
          className={s.table}
          data-has-detail={hasColumnDetail || undefined}
          aria-labelledby={title != null ? headId : undefined}
          aria-label={title != null ? undefined : label}
        >
          <thead className="sr-only">
            <tr>
              <th scope="col">{columns?.item ?? t("uiLedger.colItem")}</th>
              {hasColumnDetail && <th scope="col">{columns?.detail ?? t("uiLedger.colDetail")}</th>}
              <th scope="col">{columns?.amount ?? t("uiLedger.colAmount")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className={s.row} data-tone={row.tone}>
                <th scope="row" className={s.itemCell}>
                  <div className={s.itemWrap}>
                    <bdi className={s.itemLabel}>{row.label}</bdi>
                    {detailLayout === "inline" && row.detail != null && (
                      <bdi className={s.inlineDetail}>{row.detail}</bdi>
                    )}
                  </div>
                </th>
                {hasColumnDetail && (
                  <td className={s.detailCell}>{row.detail != null ? <bdi>{row.detail}</bdi> : null}</td>
                )}
                <td className={s.amountCell}>{renderAmount(row.amount, row.numericValue)}</td>
              </tr>
            ))}
          </tbody>
          {totals && totals.length > 0 && (
            <tfoot>
              {totals.map(tot => (
                <tr key={tot.key} className={s.totalRow} data-kind={tot.kind ?? "total"} data-tone={tot.tone}>
                  <th scope="row" className={s.itemCell}>
                    <div className={s.itemWrap}>
                      <bdi className={s.itemLabel}>{tot.label}</bdi>
                      {detailLayout === "inline" && tot.detail != null && (
                        <bdi className={s.inlineDetail}>{tot.detail}</bdi>
                      )}
                    </div>
                  </th>
                  {hasColumnDetail && (
                    <td className={s.detailCell}>{tot.detail != null ? <bdi>{tot.detail}</bdi> : null}</td>
                  )}
                  <td className={s.amountCell}>{renderAmount(tot.amount, tot.numericValue)}</td>
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      )}
      {!loading && !error && footnote != null && <div className={s.footnote}>{footnote}</div>}
    </section>
  );
}
