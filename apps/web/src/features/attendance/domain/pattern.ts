// The work pattern rules the server applies, mirrored so a sheet can name a problem while the person types. The server
// re-checks every rule and its answer wins; the codes are the server's refusal codes.
import { workMinutes, type Shift } from "./minutes";

export type DayKind = "WORK" | "WEEKLY_HOLIDAY" | "REST_DAY";
export type DaySpec = { kind: DayKind; shift?: Shift };
export type Slot = { code: string; day: DaySpec };
export type PatternKind = "WEEKLY" | "ROTATION" | "STAGGERED";
export type PatternDraft = { kind: PatternKind; days: DaySpec[]; slots: Slot[]; startOptions: number[] };

export type RuleCode =
  | "shift_window_invalid"
  | "break_below_minimum"
  | "daily_hours_over_8"
  | "weekly_hours_over_40"
  | "weekly_holiday_missing"
  | "start_choice_invalid";

/** Labor Standards Act §50 ①② (40 / 8 hours) and §54 ① (30 minutes from 4 hours, 1 hour from 8). */
export const WEEK_LIMIT = 2400;
export const DAY_LIMIT = 480;
const SPAN_LIMIT = 960;

/** One working day's own problems, in the order a person fixes them. */
export function shiftProblems(s: Shift): RuleCode[] {
  const sorted = [...s.breaks].sort((a, b) => a.start - b.start);
  const inside = sorted.every((b, i) => b.start > s.start && b.end < s.end && b.end > b.start && (i === 0 || b.start >= sorted[i - 1]!.end));
  if (s.start < 0 || s.start >= 1440 || s.end <= s.start || s.end - s.start > SPAN_LIMIT || s.end > 2880 || !inside) return ["shift_window_invalid"];
  const work = workMinutes(s);
  const rest = s.end - s.start - work;
  const out: RuleCode[] = [];
  if (work > DAY_LIMIT) out.push("daily_hours_over_8");
  if ((work >= DAY_LIMIT && rest < 60) || (work >= 240 && rest < 30)) out.push("break_below_minimum");
  return out;
}

/** The days one cycle runs through: 7 for a week, the slot count for a rotation (derived, never typed). */
export const cycleDays = (p: PatternDraft) => (p.kind === "ROTATION" ? p.slots.length : 7);
const cycle = (p: PatternDraft): DaySpec[] => (p.kind === "ROTATION" ? p.slots.map((s) => s.day) : p.days);

/** Weekly scheduled minutes; for a rotation, the cycle's average week (rounded down). */
export function weeklyMinutes(p: PatternDraft): number {
  const days = cycle(p);
  const total = days.reduce((n, d) => n + (d.kind === "WORK" && d.shift ? workMinutes(d.shift) : 0), 0);
  return days.length ? Math.floor((total * 7) / days.length) : 0;
}

/** Every rule the pattern breaks, each code once. A rotation needs one weekly rest per started 7 days of its cycle. */
export function patternProblems(p: PatternDraft): RuleCode[] {
  const days = cycle(p);
  const found = new Set<RuleCode>();
  for (const d of days) if (d.kind === "WORK") (d.shift ? shiftProblems(d.shift) : ["shift_window_invalid" as const]).forEach((c) => found.add(c));
  const holidays = days.filter((d) => d.kind === "WEEKLY_HOLIDAY").length;
  if (holidays < Math.ceil(days.length / 7) || holidays === 0) found.add("weekly_holiday_missing");
  if (weeklyMinutes(p) > WEEK_LIMIT) found.add("weekly_hours_over_40");
  if (p.kind === "STAGGERED") {
    const base = days.find((d) => d.kind === "WORK" && d.shift)?.shift?.start;
    const distinct = new Set(p.startOptions).size === p.startOptions.length;
    const fits = base !== undefined && days.every((d) => !d.shift || p.startOptions.every((c) => d.shift!.end + c - base <= 2880));
    if (p.startOptions.length < 2 || !distinct || !fits) found.add("start_choice_invalid");
  }
  return [...found];
}

/** The week, Monday first, as a person sets it up: 5 working days, Saturday day off, Sunday weekly rest. */
export const emptyWeek = (): DaySpec[] => [
  ...Array.from({ length: 5 }, (): DaySpec => ({ kind: "WORK" })),
  { kind: "REST_DAY" },
  { kind: "WEEKLY_HOLIDAY" },
];
