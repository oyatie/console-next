import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "@console/i18n";
import { liveStatus } from "../../lib/live/live";
import { RECONNECTING_AFTER_MS } from "../../lib/freshness";
import { Chip } from "../chip";
import s from "./live.module.css";

/**
 * The shell's stream state (spec §5.4): silent while live and through a brief reconnect; once the stream has been
 * down for `display.reconnecting_after`, a visible `live.status.reconnecting` until it is back. Nothing on
 * screen re-reads meanwhile (decision #27); the reconnect catches up.
 */
export function LiveStatus() {
  const { state, since } = useSyncExternalStore(liveStatus.subscribe, liveStatus.get);
  // The `since` of the outage whose grace period ran out; a newer outage (or none) is not late yet.
  const [lateSince, setLateSince] = useState<number | null>(null);
  useEffect(() => {
    if (state !== "connecting") return;
    const id = setTimeout(() => setLateSince(since), Math.max(0, since + RECONNECTING_AFTER_MS - Date.now()));
    return () => clearTimeout(id);
  }, [state, since]);
  return (
    <span role="status" className={s.status}>
      {state === "connecting" && lateSince === since && <Chip tone="warn">{t("live.status.reconnecting")}</Chip>}
    </span>
  );
}
