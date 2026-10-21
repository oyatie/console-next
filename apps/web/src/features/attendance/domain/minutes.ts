// Minutes of a work date: 0 = 00:00 of the date, 1440 = 00:00 of the next day (a night shift ends past it).
// Every duration on attendance screens is an integer of minutes (G9); nothing is a decimal hour.

export type Window = { start: number; end: number };
export type Shift = Window & { breaks: Window[] };

/**
 * "9", "09", "9:30", "0930", "18:00", "24:00" → minutes of the day, or null. Never guesses past 24:00: a night
 * shift's end is read by `endOf`, which rolls a time not after the start into the next day.
 */
export function parseClock(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** An end time typed as a clock: at or before `start` it is the next day's (22:00–06:00 → 1320–1800). */
export const endOf = (start: number, end: number) => (end <= start ? end + 1440 : end);

const pad = (n: number) => String(n).padStart(2, "0");
/** "06:00" for 360 and for 1800 (the next day's 06:00); `nextDay` says which. */
export const clock = (min: number) => `${pad(Math.floor((min % 1440) / 60))}:${pad(min % 60)}`;
export const nextDay = (min: number) => min >= 1440;

/** A duration as h:mm ("8:00", "37:20", "0:30"). */
export const duration = (min: number) => `${Math.floor(min / 60)}:${pad(Math.abs(min) % 60)}`;

const overlap = (a: Window, b: Window) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Scheduled work minutes: the span less its breaks (inside the span only). */
export const workMinutes = (s: Shift) => s.end - s.start - s.breaks.reduce((n, b) => n + overlap(s, b), 0);

// 22:00–06:00 on the date, before it and after it.
const NIGHTS: readonly Window[] = [{ start: 0, end: 360 }, { start: 1320, end: 1800 }, { start: 2760, end: 2880 }];
/** Work minutes between 22:00 and 06:00 (Labor Standards Act §56 ③), breaks excluded. */
export const nightMinutes = (s: Shift) =>
  NIGHTS.reduce((n, w) => n + overlap(s, w) - s.breaks.reduce((b, br) => b + overlap(br, w), 0), 0);
