// SPDX-License-Identifier: LicenseRef-Proprietary
import { PaneGrid } from "../pane-grid/pane-grid";
import { PatternShell } from "./pattern-shell";
import { shownSlot } from "./pattern-slot";
import type { RegisterTotalsProps } from "./register-totals-contract";
import s from "./register-totals.module.css";

/**
 * RegisterTotals (`P6`) arrangement: command strip, flush `totals` band, conditional `blockers` strip,
 * `PaneGrid` with scrollable `register` table (`main`), optional `preview` (`bottom`), and optional side panes.
 */
export function RegisterTotals({
  q,
  head,
  tabs,
  totals,
  blockers,
  notes,
  register,
  foot,
  preview,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
  ...panes
}: RegisterTotalsProps) {
  return (
    <PatternShell
      pattern="register-totals"
      floorplan="P-02"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="list"
      detailActive={Boolean(panes.record)}
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <>
          {shownSlot(totals) ? <div className={s.totals}>{totals}</div> : null}
          {shownSlot(blockers) ? <div className={s.blockers}>{blockers}</div> : null}
          <PaneGrid
            {...panes}
            main={
              <>
                {notes}
                <div className={s.registerWrap}>{register}</div>
                {foot}
              </>
            }
            bottom={shownSlot(preview) ? <div className={s.preview}>{preview}</div> : undefined}
          />
        </>
      )}
    </PatternShell>
  );
}
