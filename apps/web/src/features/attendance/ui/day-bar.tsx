import type { ReactNode } from "react";
import type { Day } from "../api";
import { ShiftBar, ShiftBarGroup } from "../../../ui/shift-bar/shift-bar";
import { withoutBreaks, scheduledSpans } from "../domain/day";
import { clockText } from "../present";

/** Translate saved day spans for the shared bar; totals remain server-owned. */
function tracks(day: Day) {
  const shift = day.plan.kind === "WORK" || day.plan.holiday_work ? day.plan.shift : undefined;
  const plan = day.plan.kind === "WORK" ? scheduledSpans(shift) : [];
  const rec = day.entry?.kind === "TIMES" ? day.entry.segments : [];
  const open = day.entry?.kind === "CLOCK_IN_ONLY" ? day.entry.segments[0]?.start : undefined;
  // Without interval judgments, a confirmed non-work total cannot locate the paid spans.
  const recognised = day.intervals ? day.intervals.filter(i => i.recognised) : day.recognition.not_work ? [] : withoutBreaks(rec, shift?.breaks ?? []);
  return { scheduled: plan, recorded: rec, recognised, open };
}

export function DayBars({ days, labels, children }: { days: readonly Day[]; labels: readonly string[]; children: ReactNode }) {
  return <ShiftBarGroup rows={days.map((day, i) => ({ label: labels[i] ?? day.date, ...tracks(day) }))} formatTime={clockText}>{children}</ShiftBarGroup>;
}

export function DayBar({ day }: { day: Day }) {
  return <ShiftBar from={0} to={24 * 60} {...tracks(day)} />;
}
