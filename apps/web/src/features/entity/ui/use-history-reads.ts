// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQueries, useQuery } from "@tanstack/react-query";
import type { LegalEntity } from "@console/api/pending";
import { entityHistoryQuery, registrationHistoryQuery } from "../api";

/**
 * The history tab's reads, and whether any first answer is still on its way: the tab and what sits under it (the
 * correction register) wait for all of them, since drawn read by read each pushed down what followed. `enabled`: off
 * the tab, nothing is read.
 */
export function useHistoryReads(e: LegalEntity, enabled = true) {
  const own = useQuery({ ...entityHistoryQuery(e.id), retry: false, enabled });
  const regs = useQueries({ queries: e.registrations.map((r) => ({ ...registrationHistoryQuery(r.id), retry: false, enabled })) });
  return { own, regs, arriving: [own, ...regs].some((q) => q.isLoading) };
}
