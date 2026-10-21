// Period-lock rules on `YYYY-MM-DD` business dates: month windows, the client overlap check the
// server applies on create (one active lock per domain and window), and the start-shift fix.
import { addDays, daysBetween } from "../../../ui/date/days";

import type { Window } from "../../../reference/periods/domain/window";

export { monthWindow, wholeMonth, type Window } from "../../../reference/periods/domain/window";
export type Lock = Window & { id: string; domain: string; unlockedAt?: string; active?: boolean };

/** In force now: the server's `active` (BW-15: never unlocked, or its unlock window has passed). */
export const inForce = (l: Lock) => l.active ?? !l.unlockedAt;

/**
 * The lock in force whose window holds `date`: a write dated then is refused. Locks come newest first, as the server
 * checks them; `domain` narrows to one business domain.
 */
export const lockCovering = <L extends Lock>(locks: readonly L[], date: string, domain?: string): L | undefined =>
  locks.find((l) => inForce(l) && (domain === undefined || l.domain === domain) && l.periodStart <= date && date <= l.periodEnd);

/** The `n` months before `today`'s month, newest first: locks close finished months. */
export function recentMonths(today: string, n = 12): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 2 - i, 1)).toISOString().slice(0, 7));
}

/** Days in a window, both ends included. */
export const windowDays = (w: Window) => daysBetween(w.periodStart, w.periodEnd) + 1;

const overlap = (a: Window, b: Window) => a.periodStart <= b.periodEnd && a.periodEnd >= b.periodStart;

/** The active lock in `domain` that `w` overlaps (the server refuses the create), if any. */
export const overlapping = <L extends Lock>(locks: readonly L[], domain: string, w: Window): L | undefined =>
  locks.find((l) => inForce(l) && l.domain === domain && overlap(l, w));

/**
 * The start that clears `other` when `w` overlaps only its tail (the day after it ends), else null:
 * an overlap at the end or a window inside `other` has no one-click fix.
 */
export function shiftedStart(w: Window, other: Window): string | null {
  if (w.periodStart < other.periodStart || w.periodEnd <= other.periodEnd) return null;
  return addDays(other.periodEnd, 1);
}

/** The lock a create just made, when its response was lost: same domain and window, still active. */
export const sameLock = <L extends Lock>(locks: readonly L[], domain: string, w: Window): L | undefined =>
  locks.find((l) => inForce(l) && l.domain === domain && l.periodStart === w.periodStart && l.periodEnd === w.periodEnd);

/** Changes whose effective date falls inside `w`: a lock there blocks their effectuate and archive. */
export const datedWithin = <C extends { effectiveDate: string }>(changes: readonly C[], w: Window) =>
  changes.filter((c) => c.effectiveDate >= w.periodStart && c.effectiveDate <= w.periodEnd);

/**
 * BW-15 unlock time box: the period locks again at the start of the day after `until` (KST), so the last day a
 * window may run to keeps it within `maxDays` (period_lock.unlock_max_days) of today.
 */
export const relockAt = (until: string) => `${addDays(until, 1)}T00:00:00+09:00`;
export const lastUnlockDay = (today: string, maxDays: number) => addDays(today, Math.max(maxDays - 1, 0));

