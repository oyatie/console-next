// A person-day as the screens draw it: the scheduled spans, what was recorded, what was recognised, and the short
// text of a grid cell. Recognition here is drawing only (recorded ∩ scheduled); the numbers are always the server's.
import type { Shift, Window } from "./minutes";
import { duration } from "./minutes";

export const MARK_TONE = {
  NO_RECORD: "blocking",
  MISSING_OUT: "blocking",
  NO_SCHEDULE: "blocking",
  UNAPPROVED_EXCESS: "decision",
  WORK_ON_REST_DAY: "decision",
  LATE: "info",
  EARLY_OUT: "info",
  AWAY: "info",
  ABSENT: "info",
} as const;
export type MarkCode = keyof typeof MARK_TONE;
type Tone = (typeof MARK_TONE)[MarkCode];
export const GLYPH: Record<Tone, string> = { blocking: "▲", decision: "◆", info: "●" };

/** Scheduled work: the shift without its breaks. */
export function scheduledSpans(shift: Shift | undefined): Window[] {
  if (!shift) return [];
  const out: Window[] = [];
  let at = shift.start;
  for (const b of [...shift.breaks].sort((a, c) => a.start - c.start)) {
    if (b.start > at) out.push({ start: at, end: b.start });
    at = Math.max(at, b.end);
  }
  if (shift.end > at) out.push({ start: at, end: shift.end });
  return out;
}

/** The overlap of two span lists. */
export function intersect(a: readonly Window[], b: readonly Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) for (const y of b) {
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
  }
  return out.sort((p, q) => p.start - q.start);
}

/** Hours as the grid prints them: "8" for whole hours, else "7:39". */
export const hours = (min: number) => (min % 60 === 0 ? String(min / 60) : duration(min));

/** The words a grid cell shows for a saved entry (the catalog renders the one-letter codes). */
type CellShape =
  | { kind: "hours"; text: string }
  | { kind: "code"; code: "ABSENT" | "OUTSIDE_WORK" | "BUSINESS_TRIP" | "CLOCK_IN_ONLY" | "REST" }
  | { kind: "empty" };

export function cellShape(c: { plan_kind: string; entry_kind?: string; recognised: number; segments?: readonly Window[] }): CellShape {
  switch (c.entry_kind) {
    case "TIMES":
      return { kind: "hours", text: hours(c.recognised) };
    case "ABSENT":
    case "OUTSIDE_WORK":
    case "BUSINESS_TRIP":
    case "CLOCK_IN_ONLY":
      return { kind: "code", code: c.entry_kind };
    default:
      return c.plan_kind !== "WORK" && c.plan_kind !== "NO_SCHEDULE" ? { kind: "code", code: "REST" } : { kind: "empty" };
  }
}

/** A grid row's marks by tone, for the totals column. */
export function toneCounts(marks: readonly string[]) {
  const n = { blocking: 0, decision: 0, info: 0 };
  for (const m of marks) if (m in MARK_TONE) n[MARK_TONE[m as MarkCode]] += 1;
  return n;
}
