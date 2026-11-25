// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { myAccessQuery } from "../../../reference/authz/api";
import { PhaseLine } from "../../../ui/page-head/phase-line";

/**
 * The attendance head's phase line: what the tenant's phase means for schedules, or nothing until the tenant is read.
 * The phase comes from the access answer, which the shell's phase hold waits for before it shows the page, so the
 * line lands with the head's controls rather than pushing them aside later (unless that answer outlasts the hold).
 * This observer adds no refetch of its own on mount, and a failed read shows no cached phase.
 */
export function useAttendancePhaseLine() {
  const access = useQuery({ ...myAccessQuery, refetchOnMount: false });
  const phase = access.error ? undefined : access.data?.phase;
  return phase ? <PhaseLine phase={phase === "OPERATING" ? "operating" : "setup"}>{t(phase === "OPERATING" ? "attendance.phase.operating" : "attendance.phase.setup")}</PhaseLine> : null;
}
