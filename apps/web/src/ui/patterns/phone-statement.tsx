// SPDX-License-Identifier: LicenseRef-Proprietary
import { shown } from "../shown";
import { PatternShell } from "./pattern-shell";
import type { PhoneStatementProps } from "./phone-statement-contract";
import s from "./phone-statement.module.css";

/**
 * PhoneStatement (`P13`) arrangement: `period` bar, `hero` figure band, flush `stats`, stacked `ledgers`,
 * optional `contextStats`, and bottom `actions`.
 */
export function PhoneStatement({
  q,
  head,
  tabs,
  period,
  periodMeta,
  hero,
  stats,
  notes,
  ledgers,
  contextStats,
  actions,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
}: PhoneStatementProps) {
  const hasPeriod = shown(period) || shown(periodMeta);
  return (
    <PatternShell
      pattern="phone-statement"
      floorplan="P-02"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="record"
      phoneHeadAware
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.column}>
          {hasPeriod ? (
            <div className={s.periodBar}>
              {period}
              {shown(periodMeta) ? <div className={s.periodMeta}>{periodMeta}</div> : null}
            </div>
          ) : null}
          <div className={s.hero}>{hero}</div>
          {shown(stats) ? <div className={s.stats}>{stats}</div> : null}
          {notes}
          <div className={s.ledgers}>{ledgers}</div>
          {shown(contextStats) ? <div className={s.contextStats}>{contextStats}</div> : null}
          {shown(actions) ? <div className={s.actions}>{actions}</div> : null}
          {foot}
        </div>
      )}
    </PatternShell>
  );
}
