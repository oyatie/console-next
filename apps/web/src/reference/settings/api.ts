import { get } from "../../lib/query";

/** The tenant settings in force; screens read `approval.policy.<class>` from it (decisions #26). */
export const settingsQuery = { ...get("/api/v1/settings"), staleTime: 5 * 60_000 };
