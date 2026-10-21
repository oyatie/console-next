import { useSyncExternalStore } from "react";
import { t } from "@console/i18n";
import { liveHeld, showHeld } from "../../lib/live/live";
import s from "./live.module.css";

/**
 * A dashboard's held changes (decision #27 amendment): floats over the page, so it never moves a row; the press
 * applies them (the user's own act, so whatever moves then is what they asked for).
 */
export function HeldNotice() {
  const count = useSyncExternalStore(liveHeld.subscribe, liveHeld.get);
  if (!count) return null;
  return (
    <div className={`notice ${s.held}`} role="status">
      <button className="btn btn--ghost" onClick={showHeld}>{t("live.list.new_rows", { count })}</button>
    </div>
  );
}
