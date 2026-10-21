import { useEffect } from "react";
import { holdLive } from "./live";

/**
 * Holds live re-reads while `on` (lib/live `holdLive`): a sheet or dialog while open, so nothing moves under it and
 * its own reads stay as opened; a dashboard (`notice`) while mounted, so another session's change waits for the
 * user's press on the held notice instead of moving rows nobody touched.
 */
export const useLiveHold = (on: boolean, notice = false) => useEffect(() => (on ? holdLive(notice) : undefined), [on, notice]);
