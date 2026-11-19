// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, type ReactNode } from "react";
import { useActiveExperienceId } from "../../experience/dom";
import { QueryState } from "../../lib/react/query-state";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { Band } from "../band/band";
import { Button } from "../button/button";
import { PageHead } from "../page-head/page-head";
import { PageHeadActions } from "../page-head/page-head-actions";
import { PageHeadingLevel, PageScope } from "../page/page-scope";
import { PaneGrid } from "../pane-grid/pane-grid";
import { shown } from "../shown";
import { useScreenStatusBar } from "../status-bar/status-bar-store";
import type { WorklistProps } from "./worklist-contract";
import s from "./worklist.module.css";

const resolveLazy = (region: ReactNode | (() => ReactNode)): ReactNode =>
  typeof region === "function" ? region() : region;

/**
 * Worklist (`P1`) arrangement: command strip (`PageHead` with inline `views`, `filters`, `find`, and `tools`),
 * `PaneGrid` with actionable `list`, optional `schedule` and `bands` in `bottom`, and `record` / `related` side panes.
 */
export function Worklist({
  q,
  head,
  tabs,
  views,
  find,
  filters,
  tools,
  notes,
  list,
  schedule,
  bands,
  foot,
  facts: _facts,
  statusSegments,
  baseline,
  overlays,
  ...panes
}: WorklistProps) {
  const experience = useActiveExperienceId();
  const useBaselineFallback = Boolean(baseline && experience === "baseline");
  useScreenStatusBar(useBaselineFallback ? null : statusSegments);
  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);

  if (useBaselineFallback && baseline) return <>{baseline()}</>;

  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  const hasFilters = shown(views) || shown(filters) || shown(find);
  const resolvedList = resolveLazy(list);
  const resolvedSchedule = resolveLazy(schedule);
  const resolvedBands = resolveLazy(bands);
  const hasLower = shown(resolvedSchedule) || shown(resolvedBands);

  return (
    <PageScope value={{ landmark: true, embedded: true }}>
      <Root
        className={`${s.frame}${secondary ? "" : ` ${s.standalone}`}`}
        data-pattern="worklist"
        data-floorplan="P-03"
        data-detail={Boolean(panes.record && q.data) || undefined}
      >
        {tabs}
        <PageReadGate
          q={q}
          head={available =>
            available || !secondary ? (
              <Band className={s.head}>
                <PageHeadingLevel value={secondary ? 2 : 1}>
                  <PageHead
                    title={head.title}
                    titleId={head.titleId}
                    asOf={available ? head.asOf : undefined}
                    filters={
                      available && hasFilters ? (
                        <div className={s.inlineFilters}>
                          {views}
                          {filters}
                          {find}
                        </div>
                      ) : undefined
                    }
                    tools={available && shown(tools) ? tools : undefined}
                    primary={
                      available &&
                      head.primary && (
                        <Button variant="primary" onClick={head.primary.onAction}>
                          {head.primary.label}
                        </Button>
                      )
                    }
                    actions={
                      available && (
                        <>
                          {head.actions}
                          {head.commands && <PageHeadActions {...head.commands} />}
                        </>
                      )
                    }
                  />
                </PageHeadingLevel>
              </Band>
            ) : null
          }
        >
          {overlays}
          <PageHeadingLevel value={2}>
            <QueryState q={q} layout="list">
              {() => (
                <PaneGrid
                  {...panes}
                  main={
                    <>
                      {notes}
                      {resolvedList}
                      {foot}
                    </>
                  }
                  bottom={
                    hasLower ? (
                      <div className={s.lower}>
                        {resolvedSchedule}
                        {resolvedBands}
                      </div>
                    ) : undefined
                  }
                />
              )}
            </QueryState>
          </PageHeadingLevel>
        </PageReadGate>
      </Root>
    </PageScope>
  );
}
