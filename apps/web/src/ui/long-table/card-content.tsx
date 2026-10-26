// SPDX-License-Identifier: LicenseRef-Proprietary
import type { LongColumn } from "./long-table";
import { cardRoles } from "./card-columns";
import css from "./table-cards.module.css";

export function CardContent<R>({ row, columns, titleId }: { row: R; columns: LongColumn<R>[]; titleId: string }) {
  const roles = cardRoles(columns);
  // The last row header is the primary name when an identifier precedes it (number, then name).
  const title = columns.findLast((column, index) => column.rowHeader && roles[index] === "title") ?? columns.find((_column, index) => roles[index] === "title");
  const fields = (role: typeof roles[number]) => columns.map((column, index) => roles[index] === role && (
    role === "fact" ? <div key={column.id} className={css.field}>
      <dt className={css.term}>{column.header}</dt>
      <dd>{column.cell(row)}</dd>
    </div> : <div key={column.id} id={column === title ? titleId : undefined}>{column.cell(row)}</div>
  ));
  return (
    <div className={css.content}>
      <div className={css.identity}>{fields("title")}</div>
      <div className={css.status}>{fields("status")}</div>
      <dl className={css.facts}>{fields("fact")}</dl>
      <div className={css.actions}>{fields("action")}</div>
    </div>
  );
}
