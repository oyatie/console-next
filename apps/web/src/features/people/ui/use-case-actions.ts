import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";
import { useCan } from "../../../reference/authz/ui/use-can";
import { hqNeedsSomeoneElse } from "../../../reference/settings/domain/policy";
import { usePolicyRouted } from "../../../reference/settings/ui/use-policy-routed";
import { mySub } from "../api";
import { forwardStep, isForward, usableActions, type BackKey } from "../domain/exits";

type Case = components["schemas"]["EmployeeExitCase"];

/**
 * Where the case stands for this user: what they can do on it and, for the next step someone else takes,
 * who that is. Under approval.policy.exit = route the HR confirmer holding the HQ grant is the one person the server
 * refuses for HQ; under none (decisions #26, the default) they finish it.
 */
export function useCaseActions(c: Case) {
  const can = useCan();
  const routed = usePolicyRouted("exit");
  // people-self-33: nobody acts on their own record (the server refuses own_record_forbidden).
  const usable = useOwnRecord(c.employee_id) ? [] : usableActions(c, can);
  // A scheduled exit that failed to apply moves no further: only rejecting is left.
  const next = c.exit_event_state === "APPLY_FAILED" ? null : forwardStep(c);
  const sameActor = next === "confirm_exit_hq" && usable.includes(next) && hqNeedsSomeoneElse(routed, c.hr_confirmed_by, mySub());
  const forward = next && usable.includes(next) && !sameActor ? next : null;
  const back = usable.filter((k): k is BackKey => !isForward(k));
  return { usable, next, forward, back, sameActor };
}

/** Whether `employeeId` is the signed-in account's own employee record (people-self-33: no verbs on it). */
export function useOwnRecord(employeeId: string) {
  const me = useQuery(get("/api/v1/users/me"));
  return me.data?.employee_id === employeeId;
}
