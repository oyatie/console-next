import { useQuery } from "@tanstack/react-query";
import type { Checklist } from "@console/api/pending";
import { freshOnOpen } from "../../../lib/query";
import { isAnswer } from "../../../lib/react/query-defaults";
import { queryView } from "../../../lib/react/query-view";
import { authzApplies, authzQuery } from "../../../reference/authz/api";
import { canReadSetupChecklist } from "../domain/phase";
import { checklistQuery } from "../api";

/** The server checklist while the tenant is in setup; `served` says whether this server has the setup phase at all. */
export function useSetupChecklist(placeholderData?: Checklist) {
  const access = useQuery({ ...authzQuery, enabled: authzApplies() });
  const readable = canReadSetupChecklist(access.data);
  const allowed = access.isError || access.failureCount > 0 || readable;
  // Cached step states must not paint before the arrival read and move the rail's actions.
  const read = useQuery({ ...checklistQuery, placeholderData, subscribed: allowed, retry: false, retryOnMount: false,
    refetchOnMount: query => isAnswer(query.state.error) ? false : "always" });
  const q = allowed ? freshOnOpen(read) : { ...read, data: undefined, isPending: access.isPending && authzApplies(), isSuccess: false, isError: false, error: null };
  return { q, phaseQ: allowed || access.isPending ? read : q, readable: readable && access.isSuccess, checklist: q.data?.phase === "SETUP" && queryView(q) !== "denied" ? q.data : undefined, served: q.isSuccess, loaded: !q.isPending && (q.isSuccess || q.isError) };
}
