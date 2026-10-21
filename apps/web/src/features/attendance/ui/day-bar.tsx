import type { Day } from "../api";
import { ShiftBar } from "../../../ui/shift-bar/shift-bar";
import { intersect, scheduledSpans } from "../domain/day";

/** The ShiftBar of one saved person-day, 06:00–21:00 unless the shift or record runs outside it. */
export function DayBar({ day }: { day: Day }) {
  const plan = scheduledSpans(day.plan.shift);
  const rec = day.entry?.kind === "TIMES" ? day.entry.segments : [];
  const open = day.entry?.kind === "CLOCK_IN_ONLY" ? day.entry.segments[0]?.start : undefined;
  const all = [...plan, ...rec];
  const from = Math.min(360, ...all.map((w) => w.start));
  const to = Math.max(1260, ...all.map((w) => w.end));
  return <ShiftBar from={from} to={to} scheduled={plan} recorded={rec} recognised={intersect(rec, plan)} open={open} />;
}
