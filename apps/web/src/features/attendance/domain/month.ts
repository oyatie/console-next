// Calendar months as "YYYY-MM" and days as "YYYY-MM-DD" (business dates, no time zone).
import { addDays, addMonths, utc } from "../../../ui/date/days";

export const monthOf = (date: string) => date.slice(0, 7);
/** The month `n` months from `month`. */
export const shiftMonth = (month: string, n: number) => monthOf(addMonths(`${month}-01`, n));
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: string) => new Date(utc(date)).getUTCDay();

/** Every date of the month, in order. */
export function monthDates(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; monthOf(d) === month; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The month as Sunday-first weeks (A2 calendar): each week holds 7 dates, including the neighbouring months' days that
 * fill the first and last week, so the grid keeps its shape.
 */
export function monthWeeks(month: string): string[][] {
  let d = addDays(`${month}-01`, -weekday(`${month}-01`));
  const weeks: string[][] = [];
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
    d = addDays(d, 7);
  } while (monthOf(d) === month);
  return weeks;
}
