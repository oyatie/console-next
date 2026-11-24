// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment } from "react";
import type { LongColumn } from "./long-table";
import { cardRoles } from "./card-columns";
import css from "./table-cards.module.css";

export function CardContent<R>({ row, columns, titleId }: { row: R; columns: LongColumn<R>[]; titleId: string }) {
  const roles = cardRoles(columns);
  // The last row header is the primary name when an identifier precedes it (number, then name).
  const title = columns.findLast((column, index) => column.rowHeader && roles[index] === "title") ?? columns.find((_column, index) => roles[index] === "title");
  const fields = (role: typeof roles[number]) => columns.map((column, index) => roles[index] === role && (
    role === "fact" ? <div key={column.id} className={css.field}>
      <dt className={css.term}>{column.cardHeader ?? column.header}</dt>
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

/**
 * Compact 2-line operational row (`52–68px`) for phone viewports (`mobileLayout="compact"`). On a Console phone the
 * status and actions stand across both lines; a name or fact line that holds a 44px control grows the row.
 */
export function CompactCardContent<R>({ row, columns, titleId }: { row: R; columns: LongColumn<R>[]; titleId: string }) {
  const roles = cardRoles(columns);
  const title = columns.findLast((column, index) => column.rowHeader && roles[index] === "title") ?? columns.find((_column, index) => roles[index] === "title");
  const titles = columns.filter((_column, index) => roles[index] === "title");
  const statuses = columns.filter((_column, index) => roles[index] === "status");
  const facts = columns.filter((_column, index) => roles[index] === "fact");
  const actions = columns.filter((_column, index) => roles[index] === "action");
  return (
    <div className={css.compactRow}>
      <div className={css.compactLine1}>
        <div className={css.compactLead}>
          {titles.map(column => (
            <bdi key={column.id} id={column === title ? titleId : undefined} className={column === title ? css.compactTitle : css.compactSub}>
              {column.cell(row)}
            </bdi>
          ))}
        </div>
        {statuses.length > 0 || actions.length > 0 ? (
          <div className={css.compactTail}>
            {statuses.map(column => <bdi key={column.id}>{column.cell(row)}</bdi>)}
            {actions.map(column => <bdi key={column.id}>{column.cell(row)}</bdi>)}
          </div>
        ) : null}
      </div>
      {facts.length > 0 ? (
        <div className={css.compactLine2}>
          {facts.map((column, idx) => (
            <Fragment key={column.id}>
              {idx > 0 ? <bdi aria-hidden="true"> · </bdi> : null}
              <bdi>{column.cell(row)}</bdi>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
