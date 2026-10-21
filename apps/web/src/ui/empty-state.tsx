import type { ReactNode } from "react";

/** `alert`: a failure state (load failed) that is announced when it appears. */
export function EmptyState({ title, reason, actions, alert }: { title: string; reason: ReactNode; actions?: ReactNode; alert?: boolean }) {
  return (
    <div className="state" role={alert ? "alert" : undefined}>
      <h2 className="state__title">{title}</h2>
      <span className="muted">{reason}</span>
      {actions && <div className="state__actions">{actions}</div>}
    </div>
  );
}
