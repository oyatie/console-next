import type { ReactNode } from "react";
import s from "./paper.module.css";

export type PaperCell = [string, ReactNode];

/** Label · value pairs on a printed form, two facts a row (a personnel record's identity block). */
export function PaperGrid({ rows, label }: { rows: readonly PaperCell[]; label?: string }) {
  const pairs: PaperCell[][] = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));
  return (
    <table className={s.grid} aria-label={label}>
      <tbody>
        {pairs.map((p, i) => (
          <tr key={`${p[0]![0]}-${i}`}>
            {p.map(([k, v]) => [<th key={`${k}h`} scope="row">{k}</th>, <td key={`${k}v`}>{v || "—"}</td>])}
            {p.length === 1 && <><td aria-hidden /><td aria-hidden /></>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A plain table on a printed form: headed columns, one row each (an action history on the paper). */
export function PaperTable({ head, rows, label }: { head: readonly string[]; rows: readonly { id: string; cells: readonly ReactNode[] }[]; label?: string }) {
  return (
    <table className={s.table} aria-label={label}>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}>{r.cells.map((c, i) => <td key={`${r.id}-${head[i]}`}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
