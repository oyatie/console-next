// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import type { LiveStatusSnapshot } from "../lib/live-sse";
import { fmtColon, formatUtcClock, formatUtcTimestamp } from "../lib/format";
import s from "./ops-shell.module.css";

export function OpsStatusBar({
  authenticated,
  evaluatedAt,
  currentTitle,
  canWrite,
  live,
}: {
  authenticated: boolean;
  evaluatedAt?: string;
  currentTitle: string;
  canWrite: boolean;
  live: LiveStatusSnapshot;
}) {
  return (
    <footer className={s.statusBar} data-surface="chrome">
      <span className={`${s.statusSeg} ${s.statusStrong}`}>{COPY.brand}</span>
      {authenticated ? (
        <>
          <span className={s.statusSeg}>{currentTitle}</span>
          <span className={s.statusSeg}>
            {fmtColon(COPY.status.evaluatedAt, evaluatedAt ? formatUtcTimestamp(evaluatedAt) : COPY.loading.firstEventPending)}
          </span>
          {live.lastEventAt ? (
            <span className={s.statusSeg}>
              {fmtColon(COPY.status.lastEvent, formatUtcClock(live.lastEventAt))}
            </span>
          ) : null}
        </>
      ) : null}
      <span className={s.statusTrailing}>{canWrite ? COPY.status.auditLogged : COPY.status.readOnly}</span>
    </footer>
  );
}
