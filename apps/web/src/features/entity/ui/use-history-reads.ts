// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { LegalEntity } from "@console/api/pending";
import { entityHistoryQuery, registrationHistoryQuery } from "../api";

/**
 * The history tab's reads, and whether the tab is still arriving: until it first draws, the tab and what sits under it
 * (the correction register) wait for every first answer, since drawn read by read each pushed down what followed. Once
 * drawn, a read asked again (a retry, a live change, a certificate added) waits in its own section. `enabled`: off the
 * tab these observers read nothing and hold nothing, though other parts of the page may be reading the same keys.
 */
export function useHistoryReads(e: LegalEntity, enabled = true) {
  const own = useQuery({ ...entityHistoryQuery(e.id), retry: false, enabled });
  const regs = useQueries({ queries: e.registrations.map((r) => ({ ...registrationHistoryQuery(r.id), retry: false, enabled })) });
  const [drawn, setDrawn] = useState(false);
  const draws = enabled && (drawn || ![own, ...regs].some((q) => q.isLoading));
  if (draws !== drawn) setDrawn(draws);
  return { own, regs, arriving: enabled && !draws };
}
