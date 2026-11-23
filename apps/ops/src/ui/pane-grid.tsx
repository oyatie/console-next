// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./pane-grid.module.css";

export function PaneGrid({
  locked = true,
  center,
  record,
  recordTitle,
  recordActions,
}: {
  locked?: boolean;
  center: ReactNode;
  record?: ReactNode;
  recordTitle?: string;
  recordActions?: ReactNode;
}) {
  const hasRecord = record !== undefined && record !== null;
  return (
    <div
      className={s.grid}
      data-locked={locked ? "true" : undefined}
      data-has-record={hasRecord ? "true" : undefined}
    >
      <div className={s.center}>
        <div className={s.centerScroll}>{center}</div>
      </div>
      {hasRecord ? (
        <aside className={s.record} aria-label={recordTitle ?? ""}>
          {recordTitle || recordActions ? (
            <div className={s.paneHead}>
              <h2 className={s.paneTitle}>{recordTitle}</h2>
              {recordActions ? <div>{recordActions}</div> : null}
            </div>
          ) : null}
          <div className={s.paneBody}>{record}</div>
        </aside>
      ) : null}
    </div>
  );
}
