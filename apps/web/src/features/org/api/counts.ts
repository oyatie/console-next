// SPDX-License-Identifier: LicenseRef-Proprietary
import { read } from "../../../lib/query";
import { CHANGE_VIEWS, changesViewQuery, type ChangeView } from "../api";

type Range = Parameters<typeof changesViewQuery>[3];
type Counts = Record<ChangeView, number>;
const views = Object.keys(CHANGE_VIEWS) as ChangeView[];

/** List totals use the same server filters and access decisions as the saved views. */
export const orgChangeCountsQuery = (range: Range = {}) => read("/api/v1/org-changes", async () => {
  const totals = await Promise.all(views.map(async view => [view, (await changesViewQuery(view, 0, 1, range).queryFn()).total]));
  const counts = Object.fromEntries(totals) as Counts;
  if (!views.every(view => Number.isSafeInteger(counts?.[view]) && counts[view] >= 0)) throw new Error("Incomplete org change counts");
  return counts;
}, { query: range, projection: "counts" });
