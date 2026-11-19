// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext } from "react";
import { QueryState } from "../../lib/react/query-state";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { Band } from "../band/band";
import { Button } from "../button/button";
import { FlexibleColumns } from "../flexible-columns/flexible-columns";
import { PageHead } from "../page-head/page-head";
import { PageHeadActions } from "../page-head/page-head-actions";
import { PageHeadingLevel, PageScope } from "../page/page-scope";
import { shown } from "../shown";
import type { ListRecordProps } from "./list-record-contract";
import s from "./list-record.module.css";

/** Baseline keeps the roster's band, zero head-to-filter gap and existing record columns. */
export function ListRecord({ q, head, tabs, views, find, filters, tools, notes, foot, overlays, ...columns }: ListRecordProps) {
  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);
  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  // shortcut: baseline's position sentence lives in foot; packs may place facts instead.
  const { facts: _facts, ...panes } = columns;
  return <PageScope value={{ landmark: true, embedded: true }}>
    <Root className={`${s.frame}${secondary ? "" : ` ${s.standalone}`}`} data-pattern="list-record" data-floorplan="P-01" data-detail={Boolean(panes.record && q.data) || undefined}>
      {tabs}
      <PageReadGate q={q} head={available => available || !secondary ? <Band className={s.head}>
        <PageHeadingLevel value={secondary ? 2 : 1}><PageHead title={head.title} titleId={head.titleId}
          asOf={available ? head.asOf : undefined}
          primary={available && head.primary && <Button variant="primary" onClick={head.primary.onAction}>{head.primary.label}</Button>}
          actions={available && <>{head.actions}{head.commands && <PageHeadActions {...head.commands} />}</>}
          tabs={available && shown(views) ? views : undefined}
        /></PageHeadingLevel>
      </Band> : null}>
        {shown(find) || shown(tools) ? <div className={s.controls}>{find}{tools}</div> : null}
        {filters}
        {overlays}
        <PageHeadingLevel value={2}><QueryState q={q} layout="list">{() => <>
          {notes}
          <FlexibleColumns {...panes} />
          {foot}
        </>}</QueryState></PageHeadingLevel>
      </PageReadGate>
    </Root>
  </PageScope>;
}
