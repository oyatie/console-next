import type { ReactNode } from "react";

/** `alert`: a failure state (load failed) that is announced when it appears. */
export function EmptyState({ title, titleId, reason, actions, meta, alert }: { title: string; titleId?: string; reason: ReactNode; actions?: ReactNode; meta?: ReactNode; alert?: boolean }) {
  return (
    <div className="state" role={alert ? "alert" : undefined}>
      <h2 id={titleId} className="state__title">{title}</h2>
      {reason != null && <span className="muted">{reason}</span>}
      {actions && <div className="state__actions">{actions}</div>}
      {meta}
    </div>
  );
}
