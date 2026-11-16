// SPDX-License-Identifier: LicenseRef-Proprietary
import { Band } from "../band/band";
import { Button } from "../button/button";
import { FlexibleColumns } from "../flexible-columns/flexible-columns";
import { Page } from "../page/page";
import { PageHeadActions } from "../page-head/page-head-actions";
import type { ListRecordProps } from "./list-record-contract";
import s from "./list-record.module.css";

/** Baseline arrangement: band head and the existing responsive, token-sized record columns. */
export function ListRecord({ q, head, tabs, views, find, filters, tools, notes, foot, facts, overlays, ...columns }: ListRecordProps) {
  return <Page floorplan="P-01" q={q} head={{
    title: head.title, titleId: head.titleId, asOf: head.asOf, band: true,
    primary: head.primary && <Button variant="primary" onClick={head.primary.onAction}>{head.primary.label}</Button>,
    actions: head.commands && <PageHeadActions {...head.commands} />,
    tabs: <>{tabs}{views}</>,
  }} toolbar={<Band className={s.controls}>{find}{filters}{tools}</Band>}>
    {() => <div className={s.body} data-pattern="list-record">
      {notes}
      <FlexibleColumns {...columns} />
      {foot}
      {facts}
      {overlays}
    </div>}
  </Page>;
}
