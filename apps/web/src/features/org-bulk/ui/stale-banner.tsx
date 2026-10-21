import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { CornerDownRight, History, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import s from "./conflict.module.css";

/**
 * A move the server refused as stale (409 stale_revision, S11, R23): a full-width alert under the page head, never
 * over the redrawn chart, focused when it appears. It says where the unit is now (read from the refetched tree),
 * recaps what this user tried, and offers the three ways on: move again from where it is, leave it, or open the
 * history. Who moved it and when are not in the refusal, so they are not shown.
 */
export function StaleMoveBanner({ name, now, tried, onRetry, onLeave }: {
  name: string;
  /** The unit's current path, legal entity first; empty when the unit is gone. */
  now: string[];
  tried: { from: string; to: string; members?: number };
  onRetry?: () => void;
  onLeave: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div ref={box} role="alert" tabIndex={-1} className={s.banner}>
      <TriangleAlert size={18} aria-hidden className={s.icon} />
      <div className={s.text}>
        <p className={s.title}>{t("orgConflict.stale.title")}</p>
        <p>{now.length ? t("orgConflict.stale.now", { name, path: now.join(" › ") }) : t("orgConflict.stale.gone", { name })}</p>
        <p className="muted">{t("orgConflict.stale.tried", { name, from: tried.from, to: tried.to, members: tried.members ?? -1 })}</p>
      </div>
      <div className={s.actions}>
        {onRetry && now.length > 0 && (
          <Button variant="primary" onClick={onRetry}><CornerDownRight size={16} aria-hidden /> {t("orgConflict.stale.retry")}</Button>
        )}
        <Button onClick={onLeave}>{t("orgConflict.stale.leave")}</Button>
        <Link to="/org/history" className="btn btn--ghost"><History size={16} aria-hidden /> {t("orgConflict.stale.history")}</Link>
      </div>
    </div>
  );
}
