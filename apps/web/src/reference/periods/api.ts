// Period locks as every screen reads them (BW-15): the lock page manages them; Home lists the unlock requests waiting
// for this person as their second person.
import type { components } from "@console/api/schema";
import { get } from "../../lib/query";

export type PeriodLock = components["schemas"]["PeriodLock"];
export type UnlockRequest = NonNullable<PeriodLock["unlockRequest"]>;

/**
 * The locks in force now, for a date input: a write dated inside one is refused (409 `period_locked`), so a sheet can
 * name the lock before commit (`lockCovering`). Close authorities read it today; for every dated writer it waits on a
 * Cedar read of in-force locks (backend-followups, UX-R1-HOME), and a 403 here means "cannot check ahead", never "open".
 * Each lock carries its latest unlock request and whether the reader may decide it.
 */
export const inForceLocksQuery = get("/api/v1/period-locks", { params: { query: { active: true, limit: 200 } } });
