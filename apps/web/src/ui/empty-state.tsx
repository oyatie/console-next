import type { ReactNode } from "react";

/** `alert` announces a failure; `compact` keeps embedded reads' retry and reference beside each other. */
export function EmptyState({ title, titleId, reason, actions, meta, alert, compact }: { title: string; titleId?: string; reason: ReactNode; actions?: ReactNode; meta?: ReactNode; alert?: boolean; compact?: boolean }) {
  return (
    <div className={compact ? "state state--compact" : "state"} role={alert ? "alert" : undefined}>
      <h2 id={titleId} className="state__title">{title}</h2>
      {reason != null && <span className="muted">{reason}</span>}
      {actions && <div className="state__actions">{actions}</div>}
      {meta}
    </div>
  );
}
