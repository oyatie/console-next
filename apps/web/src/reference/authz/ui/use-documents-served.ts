// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { authzApplies, authzQuery } from "../api";

/** Build availability and permission come from the same server projection. */
export function useDocumentsServed() {
  const q = useQuery({ ...authzQuery, enabled: authzApplies() });
  return !q.isError && (q.data?.capabilities?.some((c) => c.feature === "documents" && c.permission !== "request_only") ?? false);
}
