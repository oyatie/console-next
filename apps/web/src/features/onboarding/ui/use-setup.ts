import { useQuery } from "@tanstack/react-query";
import { freshOnOpen } from "../../../lib/query";
import { checklistQuery } from "../api";

/** The server checklist while the tenant is in setup; `served` says whether this server has the setup phase at all. */
export function useSetupChecklist() {
  // Cached step states must not paint before the arrival read and move the rail's actions.
  const q = freshOnOpen(useQuery({ ...checklistQuery, retry: false, refetchOnMount: "always" }));
  return { checklist: q.data?.phase === "SETUP" ? q.data : undefined, served: q.isSuccess, loaded: !q.isPending && (q.isSuccess || q.isError) };
}
