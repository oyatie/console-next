import type { ReactNode } from "react";
import { fmtDateTime } from "@console/i18n/format";

/** History, newest first as given; an item may carry the one action it still admits (e.g. withdrawing a scheduled change). */
export function Timeline({ items }: { items: { key: string; at: unknown; title: ReactNode; detail?: ReactNode; action?: ReactNode }[] }) {
  if (items.length === 0) return null;
  return (
    <ol className="timeline">
      {items.map((e) => (
        <li key={e.key} className="timeline__item">
          <span className="timeline__at num">{fmtDateTime(e.at)}</span>
          <span>{e.title}</span>
          {e.detail && <span className="muted">{e.detail}</span>}
          {e.action && <div className="row timeline__action">{e.action}</div>}
        </li>
      ))}
    </ol>
  );
}
