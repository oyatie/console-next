import type { components } from "@console/api/schema";

type MonthState = components["schemas"]["AttendanceMonthState"];

/** What a page of people shows for its month: the strictest state among them, the lock to act on, the earliest re-lock. */
export type PageState = { state: MonthState["state"]; lockId: string | null; relockAt: string | null; people: number };

const RANK = { OPEN: 0, REOPENED: 1, CLOSED: 2 } as const;

/** A closed month takes no write; a reopened one does until it re-locks (the server decides, this only reads it). */
export const closed = (s: MonthState | undefined) => s?.state === "CLOSED";

/** Closed anywhere is closed; then reopened; then open. `people` counts the rows in the shown state. */
export function pageState(states: readonly MonthState[]): PageState {
  const top = states.reduce<MonthState["state"]>((a, s) => (RANK[s.state] > RANK[a] ? s.state : a), "OPEN");
  const shown = states.filter((s) => s.state === top);
  const relocks = shown.flatMap((s) => (s.relock_at ? [s.relock_at] : [])).sort();
  return { state: top, lockId: shown.find((s) => s.lock_id)?.lock_id ?? null, relockAt: relocks[0] ?? null, people: shown.length };
}
