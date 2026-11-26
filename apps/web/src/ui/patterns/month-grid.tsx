// SPDX-License-Identifier: LicenseRef-Proprietary
import { PaneGrid } from "../pane-grid/pane-grid";
import { shown } from "../shown";
import { PatternShell } from "./pattern-shell";
import type { MonthGridPatternProps } from "./month-grid-contract";
import s from "./month-grid.module.css";

/**
 * MonthGrid (`P5`) arrangement: merged command strip, optional flush `summary` `StatRow`, `PaneGrid` with
 * scrollable `grid` (`main`), optional `bottom` split panel, and optional `record`/`related` docks.
 */
export function MonthGridPattern({
  q,
  head,
  tabs,
  summary,
  notes,
  grid,
  bottom,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  keepOnLoss,
  back,
  own,
  removed,
  baseline,
  ...panes
}: MonthGridPatternProps) {
  return (
    <PatternShell
      pattern="month-grid"
      floorplan="P-03"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="grid"
      detailActive={Boolean(panes.record)}
      statusSegments={statusSegments}
      keepOnLoss={keepOnLoss}
      back={back}
      own={own}
      removed={removed}
      baseline={baseline}
    >
      {() => (
        <>
          {shown(summary) ? <div className={s.summary}>{summary}</div> : null}
          <PaneGrid
            {...panes}
            main={
              <>
                {notes}
                <div className={s.gridWrap}>{grid}</div>
                {foot}
              </>
            }
            bottom={shown(bottom) ? <div className={s.bottom}>{bottom}</div> : undefined}
          />
        </>
      )}
    </PatternShell>
  );
}
