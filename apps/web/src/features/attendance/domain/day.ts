// A person-day as the screens draw it: the scheduled spans, what was recorded, what was recognised, and the short
// text of a grid cell. Drawing excludes scheduled breaks; the totals are always the server's.
import type { Shift, Window } from "./minutes";
import { duration } from "./minutes";

export const GLYPH: Partial<Record<string, string>> = { danger: "▲", warn: "◆", info: "●" };

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

/** Recorded spans without scheduled breaks (approval never clips the bar). */
export function withoutBreaks(recorded: readonly Window[], breaks: readonly Window[]): Window[] {
  return breaks.reduce<Window[]>((spans, rest) => spans.flatMap((span) => {
    if (rest.end <= span.start || rest.start >= span.end) return [span];
    return [
      ...(span.start < rest.start ? [{ start: span.start, end: rest.start }] : []),
      ...(rest.end < span.end ? [{ start: rest.end, end: span.end }] : []),
    ];
  }), [...recorded]);
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
