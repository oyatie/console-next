// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

export const DEADLINE_BUCKETS = ["overdue", "soon", "later", "undated"] as const;

/** The server owns the clock and configured due-soon window; the browser only groups its projection. */
export function deadlineBucket({ due, days_remaining: days, dueTone }: Pick<components["schemas"]["ActionInboxItem"], "due" | "days_remaining" | "dueTone">): typeof DEADLINE_BUCKETS[number] {
  if (!due || days == null) return "undated";
  if (days < 0) return "overdue";
  return dueTone === "warn" || dueTone === "danger" ? "soon" : "later";
}
