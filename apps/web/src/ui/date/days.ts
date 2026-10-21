// Calendar-date arithmetic on `YYYY-MM-DD` strings (business dates, no clock, no time zone).
import { i18n, type Locale } from "@console/i18n";

const DAY = 86_400_000;

export const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(utc(d)).toISOString().startsWith(d);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY).toISOString().slice(0, 10);
export const inBounds = (d: string, min?: string, max?: string) => (!min || d >= min) && (!max || d <= max);

/**
 * The Monday after a Saturday or Sunday, else null: a suggestion only, never applied by itself.
 * weekends only; take the tenant's working-day calendar from settings once it exists.
 */
export function nextWeekday(d: string): string | null {
  const day = new Date(utc(d)).getUTCDay();
  return day === 6 ? addDays(d, 2) : day === 0 ? addDays(d, 1) : null;
}

/**
 * `YYYY-MM-DD` plus n calendar months, clamped to the month's last day (Jan 31 + 1 → Feb 28).
 * people/domain/presets keeps its own copy (another lane's file); point it here when that lane next touches it.
 */
export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10);
}

/** The first day of the month after `d`. */
export const nextMonthFirst = (d: string) => {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};
/** The Monday after `d` (a Monday gives the next one). */
export const nextMonday = (d: string) => addDays(d, ((8 - new Date(utc(d)).getUTCDay()) % 7) || 7);

/** What a typed date was: a date, nothing yet, or why it is not one (a month or a day the calendar has not got). */
export type Typed = { date: string } | { empty: true } | { bad: "format" } | { bad: "month"; month: number } | { bad: "day"; month: number; day: number };

/** A date as people type it: 2026-10-12, 2026.10.12, 2026/10/12, 2026. 10. 12. or 20261012. */
export function parseTyped(text: string, locale: Locale = i18n.locale): Typed {
  const s = text.trim();
  if (!s) return { empty: true };
  const clean = s.replace(/\s+/g, " ");
  const yearFirst = /^(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})\.?$/.exec(clean) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(clean);
  const monthFirst = locale === "en" && !yearFirst ? /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(clean) : null;
  const m = yearFirst ?? (monthFirst ? [monthFirst[0], monthFirst[3], monthFirst[1], monthFirst[2]] : null);
  if (!m) return { bad: "format" };
  const [y, mo, d] = [m[1]!, Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return { bad: "month", month: mo };
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isDate(iso) ? { date: iso } : { bad: "day", month: mo, day: d };
}
