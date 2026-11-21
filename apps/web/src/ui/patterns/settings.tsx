// SPDX-License-Identifier: LicenseRef-Proprietary
import { PaneGrid } from "../pane-grid/pane-grid";
import { PatternShell } from "./pattern-shell";
import { shownSlot } from "./pattern-slot";
import type { SettingsPatternProps } from "./settings-contract";
import s from "./settings.module.css";

/**
 * Settings (`P9`) arrangement: optional `summary` band, `PaneGrid` with optional `views` rail in `start`, primary
 * rule-divided `panel` in `main`, and optional `record`/`related` side pane.
 */
export function SettingsPattern({
  q,
  head,
  tabs,
  summary,
  views,
  notes,
  panel,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
  ...panes
}: SettingsPatternProps) {
  return (
    <PatternShell
      pattern="settings"
      floorplan="P-05"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="record"
      detailActive={Boolean(panes.record)}
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.shell}>
          {shownSlot(summary) ? <div className={s.summary}>{summary}</div> : null}
          <PaneGrid
            {...panes}
            start={shownSlot(views) ? <div className={s.views}>{views}</div> : undefined}
            main={
              <div className={s.panel}>
                {notes}
                {panel}
                {foot}
              </div>
            }
          />
        </div>
      )}
    </PatternShell>
  );
}
