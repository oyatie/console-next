import { useQuery } from "@tanstack/react-query";
import { orgPolicyQuery } from "../api";

/**
 * Whether org changes go through approval (decisions #26: the tenant setting `approval.policy.org_structure`, pilot default
 * `none`: a change applies at submit, or on its effective date). Copy only: the server decides; until the read lands the
 * server's default is assumed.
 */
export function useOrgRouted() {
  const q = useQuery(orgPolicyQuery);
  return q.data?.items.find((x) => x.key === "approval.policy.org_structure")?.value === "route";
}
