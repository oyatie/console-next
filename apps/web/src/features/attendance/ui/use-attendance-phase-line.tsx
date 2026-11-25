import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { PhaseLine } from "../../../ui/page-head/phase-line";

/** The attendance head's phase line: what the tenant's phase means for schedules, or nothing until the tenant is read. */
export function useAttendancePhaseLine() {
  const phase = useQuery(get("/api/v1/users/me")).data?.tenant?.phase;
  return phase ? <PhaseLine phase={phase === "OPERATING" ? "operating" : "setup"}>{t(phase === "OPERATING" ? "attendance.phase.operating" : "attendance.phase.setup")}</PhaseLine> : null;
}
