import { Link } from "@tanstack/react-router";
import { AlertTriangle, History, RefreshCw } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import css from "./chart.module.css";

/**
 * The structure could not be read again (S11-load-failed): the chart below is the one last read, at its time, until
 * a retry lands. A change made on it meanwhile is checked against the server's versions (a stale one is refused and
 * said, StaleNotice), so the banner states what is shown rather than locking it.
 */
export function LoadFailed({ at, onRetry }: { at: number; onRetry: () => void }) {
  return (
    <div className={css.loadFailed} role="alert">
      <AlertTriangle size={18} aria-hidden />
      <p className={css.loadFailedText}><b>{t("structure.loadFailed.title")}</b> {t("structure.loadFailed.detail", { at: fmtDateTimeShort(new Date(at).toISOString()) })}</p>
      <Button variant="primary" onClick={onRetry}><RefreshCw size={16} aria-hidden />{t("structure.loadFailed.retry")}</Button>
      <Link to="/org/history" className="btn btn--ghost"><History size={16} aria-hidden />{t("structure.stale.history")}</Link>
    </div>
  );
}
