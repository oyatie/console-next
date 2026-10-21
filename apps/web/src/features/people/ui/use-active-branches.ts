import { useQuery } from "@tanstack/react-query";
import { branchesQuery } from "../../../reference/org/api";

/** The tenant's open branches (what a branch-scoped role can be assigned to), and whether they have loaded. */
export function useActiveBranches() {
  const q = useQuery(branchesQuery);
  return { branches: q.data?.filter((b) => !b.deactivated_at) ?? [], loaded: q.isSuccess, pending: q.isPending };
}
