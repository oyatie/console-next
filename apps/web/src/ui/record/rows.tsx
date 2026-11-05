import type { ReactNode } from "react";
import { cardRoles, type CardColumn } from "../long-table/card-columns";
import cards from "../long-table/table-cards.module.css";
import s from "./record.module.css";

/** A compact column of a section's rows; `end` is the row tools column (right-aligned, fitted). */
export type RowColumn<R> = CardColumn & { header?: ReactNode; cell: (r: R) => ReactNode; end?: boolean };

/**
 * The rows of one record section (career, education, contract, leave): dense, no selection; a voided row stays struck in place.
 * Without any header the head row is left out.
 */
export function RecordRows<R>({ label, rows, columns, rowId, isVoid, mobileLayout }: { label: string; rows: R[]; columns: RowColumn<R>[]; rowId: (r: R) => string; isVoid?: (r: R) => boolean; mobileLayout?: "cards" }) {
  const roles = cardRoles(columns);
  const table = (
    <table className={mobileLayout ? `${s.rows} table ${cards.short} ${cards.surface}` : s.rows} aria-label={label}>
      {columns.some((c) => c.header) && (
        <thead>
          <tr>{columns.map((c, i) => <th key={i} scope="col">{c.header}</th>)}</tr>
        </thead>
      )}
      <tbody>
        {rows.map((r) => (
          <tr key={rowId(r)} data-void={isVoid?.(r) || undefined}>
            {columns.map((c, i) => <td key={i} data-card={mobileLayout ? roles[i] : undefined} data-label={mobileLayout && typeof c.header === "string" ? c.header : undefined} data-end={c.end || undefined}>{c.cell(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return mobileLayout ? <div className={cards.container}>{table}</div> : table;
}
