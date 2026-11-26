// SPDX-License-Identifier: LicenseRef-Proprietary
import { isValidElement, useContext } from "react";
import { useActiveExperienceId } from "../../experience/dom";
import { QueryState } from "../../lib/react/query-state";
import { queryView } from "../../lib/react/query-view";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { Band } from "../band/band";
import { Button } from "../button/button";
import { FlexibleColumns } from "../flexible-columns/flexible-columns";
import { PageHead } from "../page-head/page-head";
import { PageHeadActions } from "../page-head/page-head-actions";
import { PageHeadingLevel, PageScope } from "../page/page-scope";
import { PaneGrid } from "../pane-grid/pane-grid";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import { shown } from "../shown";
import { useScreenStatusBar } from "../status-bar/status-bar-store";
import type { ListRecordPane, ListRecordProps } from "./list-record-contract";
import s from "./list-record.module.css";

function toSidePane(pane: ListRecordPane | false | "" | null | undefined): SidePaneSpec | false | "" | null | undefined {
  if (!pane) return pane;
  return {
    ...pane,
    meta: pane.meta ?? pane.crumb,
    actions: pane.actions ?? pane.expand,
  };
}

/** Baseline keeps the roster's band, zero head-to-filter gap and existing record columns; Console uses `PaneGrid` with optional `stats`, `rail`, and `indexBar`. */
export function ListRecord({
  q,
  head,
  tabs,
  views,
  find,
  filters,
  tools,
  stats,
  rail,
  indexBar,
  notes,
  foot,
  overlays,
  statusSegments,
  baseline,
  failedActions,
  facts: _facts,
  ...columns
}: ListRecordProps) {
  const experience = useActiveExperienceId();
  const useBaseline = experience === "baseline";
  const useBaselineFallback = Boolean(baseline && useBaseline);
  useScreenStatusBar(useBaseline ? null : statusSegments);

  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);

  if (useBaselineFallback && baseline) return <>{baseline()}</>;

  const primary = head.primary && (isValidElement(head.primary)
    ? head.primary
    : <Button variant="primary" onClick={head.primary.onAction}>{head.primary.label}</Button>);

  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  const panes = columns;

  if (useBaseline) {
    return <PageScope value={{ landmark: true, embedded: true }}>
      <Root className={`${s.frame}${secondary ? "" : ` ${s.standalone}`}`} data-pattern="list-record" data-floorplan="P-01" data-detail={Boolean(panes.record && q.data) || undefined}>
        {tabs}
        <PageReadGate q={q} head={available => available || !secondary ? <Band className={s.head}>
          <PageHeadingLevel value={secondary ? 2 : 1}><PageHead title={head.title} titleId={head.titleId}
            asOf={available ? head.asOf : undefined}
            primary={available && primary}
            actions={available && <>{head.actions}{head.commands && <PageHeadActions {...head.commands} />}</>}
            tabs={available && shown(views) ? views : undefined}
          /></PageHeadingLevel>
        </Band> : null}>
          {shown(find) || shown(tools) ? <div className={s.controls}>{find}{tools}</div> : null}
          {filters}
          {overlays}
          <PageHeadingLevel value={2}><QueryState q={q} layout="list" failedActions={failedActions}>{() => <>
            {notes}
            <FlexibleColumns {...panes} />
            {foot}
          </>}</QueryState></PageHeadingLevel>
        </PageReadGate>
      </Root>
    </PageScope>;
  }

  const hasFilters = shown(views) || shown(filters) || shown(find);
  const view = queryView(q);
  const showDetail = Boolean(panes.record && q.data) && (view === "ready" || view === "stale" || view === "offline");

  return (
    <PageScope value={{ landmark: true, embedded: true }}>
      <Root
        className={`${s.frame}${secondary ? "" : ` ${s.standalone}`}`}
        data-pattern="list-record"
        data-floorplan="P-01"
        data-detail={showDetail || undefined}
      >
        {tabs}
        <PageReadGate
          q={q}
          head={available => {
            if (!available && secondary) return null;
            const filterNode =
              available && hasFilters ? (
                <div className={s.inlineFilters}>
                  {views}
                  {filters}
                  {find}
                </div>
              ) : undefined;
            const primaryNode = available ? primary : undefined;
            const actionsNode =
              available && (head.actions || head.commands) ? (
                <>
                  {head.actions}
                  {head.commands && <PageHeadActions {...head.commands} />}
                </>
              ) : undefined;
            return (
              <Band className={s.head}>
                <PageHeadingLevel value={secondary ? 2 : 1}>
                  <PageHead
                    band
                    title={head.title}
                    titleId={head.titleId}
                    asOf={available ? head.asOf : undefined}
                    filters={filterNode}
                    tools={available && shown(tools) ? tools : undefined}
                    primary={primaryNode}
                    actions={actionsNode}
                  />
                </PageHeadingLevel>
              </Band>
            );
          }}
        >
          {overlays}
          <PageHeadingLevel value={2}>
            <QueryState q={q} layout="list" failedActions={failedActions}>
              {() => (
                <>
                  {shown(stats) ? <div className={s.statsBand}>{stats}</div> : null}
                  <PaneGrid
                    start={rail}
                    main={
                      <>
                        {notes}
                        {indexBar}
                        {panes.list}
                      </>
                    }
                    bottom={shown(foot) ? foot : undefined}
                    record={toSidePane(panes.record)}
                    related={toSidePane(panes.related)}
                    full={panes.full}
                    onFull={panes.onFull}
                    onSelect={panes.onSelect}
                    onOpen={panes.onOpen}
                  />
                </>
              )}
            </QueryState>
          </PageHeadingLevel>
        </PageReadGate>
      </Root>
    </PageScope>
  );
}
