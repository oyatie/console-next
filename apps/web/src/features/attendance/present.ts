import { isMessageId, t } from "@console/i18n";
import { ATTENDANCE_MARK } from "../../lib/labels";
import { fmtDate, fmtDateTime, fmtMonth, fmtWeekday } from "@console/i18n/format";
import { clock, duration, nextDay, workMinutes, type Shift } from "./domain/minutes";
import type { PageState } from "./domain/month-state";
import type { DaySpec } from "./domain/pattern";
import type { BoardRow, ContractualHoliday, Entry, Mark, Pattern } from "./api";

/** A grid row's mark totals retain their domain categories while tones come from the registry. */
export function toneCounts(marks: readonly string[]) {
  const n = { blocking: 0, decision: 0, info: 0 };
  for (const mark of marks) {
    const tone = ATTENDANCE_MARK.tone?.[mark as Mark];
    if (tone === "danger") n.blocking += 1;
    else if (tone === "warn") n.decision += 1;
    else if (tone === "info") n.info += 1;
  }
  return n;
}

/** A month label with its year. */
export const monthText = (d: string) => fmtMonth(d);
/** A full business date. */
export const dayText = (d: string) => fmtDate(d);
/** A weekday label for the attendance calendar. */
export const weekdayText = (d: string) => fmtWeekday(d);
export const dateText = (d: string) => fmtDate(d, { weekday: "short" });

/** A clock with the next-day mark: "06:00 (+1)". */
export const clockText = (min: number) => (nextDay(min) ? t("attendancePatterns.clock.next", { time: clock(min) }) : clock(min));

/** "08:00–17:00 · break 1:00": the window, then its breaks as a duration. */
export function shiftText(s: Shift): string {
  const rest = s.end - s.start - workMinutes(s);
  const span = t("attendancePatterns.shift.span", { start: clockText(s.start), end: clockText(s.end) });
  return rest ? t("attendancePatterns.shift.withBreak", { span, rest: duration(rest) }) : span;
}

/** What a day of a pattern is, in words: the shift, or weekly rest day / day off. */
export const daySpecText = (d: DaySpec) => (d.kind === "WORK" && d.shift ? shiftText(d.shift) : t(`attendance.dayKind.${d.kind}`));

/** A pattern's shape in one line: five days a week 08:00–17:00, a 6-day cycle with 4 work days, or the staggered starts. */
export function patternShape(p: Pick<Pattern, "kind" | "days" | "slots" | "start_choices" | "cycle_days">): string {
  const days = (p.kind === "ROTATION" ? p.slots?.map((s) => s.day) : p.days) ?? [];
  const working = days.filter((d) => d.kind === "WORK" && d.shift);
  const first = working[0]?.shift;
  if (p.kind === "ROTATION") return t("attendancePatterns.shape.rotation", { cycle: p.cycle_days, days: working.length });
  const span = first ? t("attendancePatterns.shift.span", { start: clockText(first.start), end: clockText(first.end) }) : "";
  if (p.kind === "STAGGERED") return t("attendancePatterns.shape.staggered", { starts: (p.start_choices ?? []).map(clock).join(" · "), days: working.length });
  return t("attendancePatterns.shape.weekly", { days: working.length, span });
}

/** The words for a server refusal this screen knows, else undefined (the generic failure text follows). */
export const refusalText = (code: string) => {
  const id = [`attendance.refusal.${code}`, `attendanceRecords.refusal.${code}`, `crud.refused.${code}`].find(isMessageId);
  return id ? t(id) : undefined;
};

/** A saved entry in words: "07:52–17:04", "07:52– (no clock-out)", or its kind (absent, outside work …). */
export function entryText(kind: Entry["kind"], segments: readonly { start: number; end: number }[]): string {
  if (kind === "TIMES") return segments.map((w) => t("attendancePatterns.shift.span", { start: clockText(w.start), end: clockText(w.end) })).join(", ");
  if (kind === "CLOCK_IN_ONLY") return t("attendanceRecords.entry.inOnly", { time: clockText(segments[0]?.start ?? 0) });
  return t(`attendanceRecords.entry.${kind}`);
}

/** People as a count: "28 people". */
export const peopleText = (n: number) => t("attendance.people", { count: n });

/** A company holiday's date rule: every year on a month and day, or one date. */
export const ruleText = (h: ContractualHoliday) =>
  h.rule_kind === "YEARLY" ? t("attendanceHolidays.holiday.yearly", { month: h.month ?? 0, day: h.day ?? 0 }) : t("attendanceHolidays.holiday.once", { date: h.on_date ?? "" });

/** What is wrong with a person-day, in one sentence (A1 "what is wrong"). */
export function problemText(row: BoardRow): string {
  const r = row.day.recognition;
  const m = row.day.marks[0];
  if (!m) return t("attendanceRecords.board.fine", { recognised: duration(r.recognised) });
  return t(`attendanceRecords.board.why.${m}`, {
    recognised: duration(r.recognised),
    late: duration(r.excess_open ?? r.early_unrecognised + r.late_unrecognised),
    minutes: r.late_in + r.early_out + r.away,
    start: row.day.entry?.segments[0] ? clock(row.day.entry.segments[0].start) : "",
  });
}

/** The sentence for a closed or reopened month, and where its link goes (a closed month's to the lock behind it). */
export function monthStateText(state: PageState, month: string) {
  const m = monthText(month);
  if (state.state === "REOPENED") {
    return { text: state.relockAt ? t("attendanceRecords.month.reopened", { month: m, at: fmtDateTime(state.relockAt) }) : t("attendanceRecords.month.reopenedOpenEnded", { month: m }), link: t("attendanceRecords.month.locks"), unlock: undefined };
  }
  return { text: t(state.lockId ? "attendanceRecords.month.closed" : "attendanceRecords.month.closedNoLock", { month: m }), link: t(state.lockId ? "attendanceRecords.month.requestUnlock" : "attendanceRecords.month.locks"), unlock: state.lockId ?? undefined };
}
