import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "../api";
import { policyRouted, type ApprovalClass } from "../domain/policy";

/**
 * Whether the tenant routes this change class through a second person (decisions #26). Copy and affordances only:
 * the server decides. Until the read lands, or when the reader may not read settings, the default `none` is assumed
 * and the server's refusal (with its reason) is the backstop.
 */
export function usePolicyRouted(cls: ApprovalClass) {
  return policyRouted(useQuery(settingsQuery).data?.items, cls);
}
