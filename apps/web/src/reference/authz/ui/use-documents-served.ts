// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ServedCapability } from "../domain/access";
import { useQuery } from "@tanstack/react-query";
import { authzApplies, authzQuery, servedAuthzApplies } from "../api";

/** Build availability and permission come from the same server projection. */
export function useDocumentsServed() {
  const q = useQuery({ ...authzQuery, enabled: authzApplies() });
  return !q.isError && (q.data?.capabilities?.some((c) => c.feature === "documents" && c.permission !== "request_only") ?? false);
}

type Capabilities = Awaited<ReturnType<typeof authzQuery.queryFn>>["capabilities"];

/** The evidence register handlers require an org-wide grant and a build with docs mounted. */
const canReadEvidence = (caps?: Capabilities) =>
  caps?.some(cap => cap.feature === "documents" && cap.org_wide && cap.permission !== "request_only") ?? false;

export function canUseServed(feature: ServedCapability, caps?: Capabilities) {
  if (feature === "lifecycle_manage") return caps?.some(cap => cap.feature === feature && cap.org_wide && cap.permission !== "request_only") ?? false;
  return feature === "documents" ? canReadEvidence(caps) : caps?.some(cap => cap.feature === feature && cap.permission !== "request_only") ?? false;
}

export function useServedCapability(feature: ServedCapability, enabled = true) {
  const q = useQuery({ ...authzQuery, enabled: enabled && servedAuthzApplies() });
  return !q.isError && canUseServed(feature, q.data?.capabilities);
}

/** Navigation uses one mounted-module answer for the audit alternatives and evaluation entry. */
export function useServedDestinations(enabled = true) {
  const q = useQuery({ ...authzQuery, enabled: enabled && servedAuthzApplies() });
  const caps = q.isError ? undefined : q.data?.capabilities;
  return {
    payrollOutlook: canUseServed("analytics_projection", caps),
    consents: canUseServed("served_location_consent_ledger", caps), evidenceVault: canReadEvidence(caps),
    findings: canUseServed("served_integrity_findings", caps),
    served: (["served_consulting_entry", "served_evaluation_cycles", "served_evaluation_cycle_create"] as const).filter(feature => canUseServed(feature, caps)),
  };
}
