// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { authzApplies, authzQuery, evidenceAuthzApplies } from "../api";

/** Build availability and permission come from the same server projection. */
export function useDocumentsServed() {
  const q = useQuery({ ...authzQuery, enabled: authzApplies() });
  return !q.isError && (q.data?.capabilities?.some((c) => c.feature === "documents" && c.permission !== "request_only") ?? false);
}

type Capabilities = Awaited<ReturnType<typeof authzQuery.queryFn>>["capabilities"];

/** The evidence register handlers require an org-wide grant and a build with docs mounted. */
export const canReadEvidence = (caps?: Capabilities) =>
  caps?.some(cap => cap.feature === "documents" && cap.org_wide && cap.permission !== "request_only") ?? false;

export function useEvidenceServed(enabled = true) {
  const q = useQuery({ ...authzQuery, enabled: enabled && evidenceAuthzApplies() });
  return !q.isError && canReadEvidence(q.data?.capabilities);
}
