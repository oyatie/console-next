// SPDX-License-Identifier: LicenseRef-Proprietary
// Lifecycle sheet dates: when a date applies and the preset suggestions per action (the bounds come
// from verbStates in ./lifecycle). Nothing here picks a date: presets are buttons the user presses (no default).
import { addDays, isDate, nextMonday } from "../../../ui/date/days";
import type { Verb } from "./lifecycle";

/**
 * A date after today schedules the action; today or earlier applies it now (a past date is recorded
 * back-dated and applies immediately). Null while no valid date is picked.
 */
export const applies = (date: string, today: string): "past" | "today" | "future" | null =>
  !isDate(date) ? null : date > today ? "future" : date === today ? "today" : "past";

/** `YYYY-MM-DD` plus n calendar months, clamped to the month's last day (Jan 31 + 1 → Feb 28). */
export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10);
}

export type PresetId = "nextMonthFirst" | "nextMonday" | "today" | "returnDate" | "afterContract";
export type Preset = { id: PresetId; date: string };

/**
 * Effective-date suggestions in the order spec E5 draws them (today, next Monday, the 1st of next month for a
 * transfer or promotion; the follow-up date first for a leave, a return or a renewal). Dates outside the bounds are
 * dropped, and a suggestion that resolves to the same day as an earlier one gives way to it.
 */
export function effectivePresets(kind: Verb, c: { today: string; min?: string; max?: string; returnDate?: string | null; contractEnd?: string | null }): Preset[] {
  const first = addMonths(`${c.today.slice(0, 8)}01`, 1);
  const today: Preset = { id: "today", date: c.today };
  const list: Preset[] =
    kind === "TRANSFER" || kind === "PROMOTE" || kind === "APPOINT" ? [today, { id: "nextMonday", date: nextMonday(c.today) }, { id: "nextMonthFirst", date: first }]
    : kind === "LEAVE_OF_ABSENCE" || kind === "GROUP_TRANSFER" ? [{ id: "nextMonthFirst", date: first }, today]
    : kind === "EMPLOYMENT_TYPE_CHANGE" && c.contractEnd && isDate(c.contractEnd) ? [{ id: "afterContract", date: addDays(c.contractEnd, 1) }, { id: "nextMonthFirst", date: first }, today]
    : kind === "EMPLOYMENT_TYPE_CHANGE" ? [{ id: "nextMonthFirst", date: first }, today]
    : kind === "RETURN_FROM_LEAVE" && c.returnDate && isDate(c.returnDate) ? [{ id: "returnDate", date: c.returnDate }, today]
    : kind === "CONTRACT_RENEWAL" && c.contractEnd && isDate(c.contractEnd) ? [{ id: "afterContract", date: addDays(c.contractEnd, 1) }, today]
    : [today];
  return list
    .filter((p) => (!c.min || p.date >= c.min) && (!c.max || p.date <= c.max))
    .filter((p, i, all) => !all.slice(0, i).some((q) => q.date === p.date));
}

/** Expected-return suggestions for a leave: months after its start, never on or before it. */
export const returnPresets = (start: string) => (isDate(start) ? [3, 6, 12].map((months) => ({ months, date: addMonths(start, months) })) : []);

/** A new contract end `months` after it starts: the day before the same date that many months on. */
export const contractEndAfter = (start: string, months: number) => addDays(addMonths(start, months), -1);

/** New contract end suggestions from the renewal's start. */
export const endPresets = (start: string, twoYearDate?: string) => (isDate(start) ? [6, 12, 24].map((months) => {
  const date = contractEndAfter(start, months);
  return { months, date, ...(twoYearDate && date > twoYearDate ? { disabledReason: twoYearDate } : {}) };
}) : []);

/**
 * Whole-period renewals that set both dates in one press: from the day after the current contract ends,
 * for one or two years. None without a current end date, or when that start falls outside the bounds.
 */
export function periodPresets(contractEnd: string | null | undefined, b: { min?: string; max?: string }, twoYearDate?: string) {
  if (!contractEnd || !isDate(contractEnd)) return [];
  const start = addDays(contractEnd, 1);
  if ((b.min && start < b.min) || (b.max && start > b.max)) return [];
  return [12, 24].map((months) => {
    const end = contractEndAfter(start, months);
    return { months, start, end, ...(twoYearDate && end > twoYearDate ? { disabledReason: twoYearDate } : {}) };
  });
}
