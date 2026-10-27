// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, unwrap } from "@console/api";
import type { OrgChangeCounts } from "@console/api/pending";
import { read } from "../../../lib/query";
import { CHANGE_VIEWS, changesViewQuery, type ChangeView } from "../api";

type Range = Parameters<typeof changesViewQuery>[3];
type Counts = OrgChangeCounts;
const views = Object.keys(CHANGE_VIEWS) as ChangeView[];

// shortcut: old backends need per-view reads; delete this fallback when counts is in the generated contract.
async function legacyCounts(range: Range): Promise<Counts> {
  const totals = await Promise.all(views.map(async view => [view, (await changesViewQuery(view, 0, 1, range).queryFn()).total]));
  return Object.fromEntries(totals) as Counts;
}

/** One count cache entry, scoped and filtered by the server just like the list. */
export const orgChangeCountsQuery = (range: Range = {}) => read("/api/v1/org-changes/counts", async () => {
  let counts: Counts;
  try {
    counts = await unwrap(api.GET("/api/v1/org-changes/counts", { params: { query: range } }));
  } catch (error) {
    // The old /{id} route rejects the literal "counts" as an invalid UUID.
    if (!(error instanceof ApiError) || !([404, 405].includes(error.status) || (error.status === 400 && (!error.fromServer || error.code === "bad_request")))) throw error;
    counts = await legacyCounts(range);
  }
  if (!views.every(view => Number.isSafeInteger(counts?.[view]) && counts[view] >= 0)) throw new Error("Incomplete org change counts");
  return counts;
}, { query: range });
