// A day or a rotation slot as typed in the pattern sheet: the kind, and the four clocks of a working day (empty
// until typed; nothing is assumed).
import { endOf, parseClock, type Shift } from "./minutes";
import type { DayKind, DaySpec } from "./pattern";

export type DayForm = { kind: DayKind | null; start: string; end: string; breakStart: string; breakEnd: string };
export type SlotForm = DayForm & { code: string };

export const blankDay = (kind: DayKind | null = null): DayForm => ({ kind, start: "", end: "", breakStart: "", breakEnd: "" });
export const blankSlot = (): SlotForm => ({ ...blankDay(), code: "" });

/**
 * The typed day as the spec the server takes, or null while a clock is missing or unreadable. A time at or before
 * the start is the next day's (21:00–06:00); a break reads the same way from the start.
 */
export function toSpec(d: DayForm): DaySpec | null {
  if (!d.kind) return null;
  if (d.kind !== "WORK") return { kind: d.kind };
  const [a, b] = [parseClock(d.start), parseClock(d.end)];
  if (a === null || b === null) return null;
  const shift: Shift = { start: a, end: endOf(a, b), breaks: [] };
  if (d.breakStart || d.breakEnd) {
    const [bs, be] = [parseClock(d.breakStart), parseClock(d.breakEnd)];
    if (bs === null || be === null) return null;
    const start = bs < a ? bs + 1440 : bs;
    shift.breaks = [{ start, end: endOf(start, be) }];
  }
  return { kind: "WORK", shift };
}

/** Moves item `i` by `by` places; a move past either end keeps the order. */
export function moveItem<T>(xs: readonly T[], i: number, by: number): T[] {
  const j = i + by;
  const out = [...xs];
  if (j < 0 || j >= xs.length) return out;
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
