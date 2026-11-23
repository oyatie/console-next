// SPDX-License-Identifier: LicenseRef-Proprietary
import { shown } from "../shown";
import { PatternShell } from "./pattern-shell";
import type { RecordProps } from "./record-contract";
import s from "./record.module.css";

/**
 * Record (`P3`) arrangement: `PageHead`, optional sticky `secNav`, optional `strip`, ordered `sections`,
 * and an optional sticky right-hand `spine` timeline.
 */
export function RecordPattern({
  q,
  head,
  tabs,
  secNav,
  notes,
  strip,
  sections,
  spine,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  keepOnLoss,
  back,
  own,
  removed,
  baseline,
}: RecordProps) {
  const hasSpine = shown(spine);
  return (
    <PatternShell
      pattern="record"
      floorplan="P-02"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="record"
      statusSegments={statusSegments}
      keepOnLoss={keepOnLoss}
      back={back}
      own={own}
      removed={removed}
      baseline={baseline}
    >
      {() => (
        <>
          {shown(secNav) ? <div className={s.secNavBar}>{secNav}</div> : null}
          <div className={s.body} data-has-spine={hasSpine || undefined}>
            <div className={s.main}>
              {notes}
              {shown(strip) ? <div className={s.strip}>{strip}</div> : null}
              <div className={s.sections}>{sections}</div>
              {foot}
            </div>
            {hasSpine ? <div className={s.spineCol}>{spine}</div> : null}
          </div>
        </>
      )}
    </PatternShell>
  );
}
