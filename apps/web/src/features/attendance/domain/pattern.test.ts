import { expect, test } from "vitest";
import { cycleDays, patternProblems, shiftProblems, weeklyMinutes, type DaySpec, type PatternDraft } from "./pattern";

const factory = { start: 480, end: 1020, breaks: [{ start: 720, end: 780 }] };
const work = (shift = factory): DaySpec => ({ kind: "WORK", shift });
const week = (d: DaySpec = work()): DaySpec[] => [d, d, d, d, d, { kind: "REST_DAY" }, { kind: "WEEKLY_HOLIDAY" }];
const draft = (p: Partial<PatternDraft>): PatternDraft => ({ kind: "WEEKLY", days: week(), slots: [], startOptions: [], ...p });

test("공장 주간 08–17 with 휴게 12–13 is 40 hours and breaks no rule", () => {
  expect(patternProblems(draft({}))).toEqual([]);
  expect(weeklyMinutes(draft({}))).toBe(2400);
  expect(cycleDays(draft({}))).toBe(7);
});

test("§54: 8 hours of work need an hour off, 4 hours need 30 minutes", () => {
  expect(shiftProblems({ start: 480, end: 990, breaks: [{ start: 720, end: 750 }] })).toEqual(["break_below_minimum"]);
  expect(shiftProblems({ start: 540, end: 780, breaks: [] })).toEqual(["break_below_minimum"]);
  expect(shiftProblems({ start: 540, end: 750, breaks: [] })).toEqual([]);
});

test("§50: over 8 a day or 40 a week is not a 소정 schedule", () => {
  expect(shiftProblems({ start: 360, end: 1080, breaks: [{ start: 720, end: 780 }] })).toEqual(["daily_hours_over_8"]);
  const six = draft({ days: [work(), work(), work(), work(), work(), work(), { kind: "WEEKLY_HOLIDAY" }] });
  expect(patternProblems(six)).toEqual(["weekly_hours_over_40"]);
});

test("a window that ends before it starts, or a break outside it, is refused as a window", () => {
  expect(shiftProblems({ start: 600, end: 540, breaks: [] })).toEqual(["shift_window_invalid"]);
  expect(shiftProblems({ start: 480, end: 1020, breaks: [{ start: 1020, end: 1080 }] })).toEqual(["shift_window_invalid"]);
});

test("§55: a week without 주휴 is refused; a 6-day rotation needs one, a 14-day rotation two", () => {
  expect(patternProblems(draft({ days: [...week().slice(0, 6), { kind: "REST_DAY" }] }))).toContain("weekly_holiday_missing");
  const day = { start: 360, end: 900, breaks: [{ start: 600, end: 660 }] };
  const night = { start: 1260, end: 1800, breaks: [{ start: 1560, end: 1620 }] };
  const six = [{ code: "주", day: work(day) }, { code: "주", day: work(day) }, { code: "야", day: work(night) }, { code: "야", day: work(night) }, { code: "비", day: { kind: "REST_DAY" as const } }, { code: "휴", day: { kind: "WEEKLY_HOLIDAY" as const } }];
  const rotation = draft({ kind: "ROTATION", slots: six });
  expect([patternProblems(rotation), cycleDays(rotation), weeklyMinutes(rotation)]).toEqual([[], 6, 2240]);
  expect(patternProblems(draft({ kind: "ROTATION", slots: [...six, ...six.slice(0, 5), ...six.slice(0, 3)] }))).toContain("weekly_holiday_missing");
});

test("시차출퇴근 needs two or more distinct starts that keep every shift inside the date", () => {
  expect(patternProblems(draft({ kind: "STAGGERED", startOptions: [480, 540, 600] }))).toEqual([]);
  expect(patternProblems(draft({ kind: "STAGGERED", startOptions: [480] }))).toEqual(["start_choice_invalid"]);
  expect(patternProblems(draft({ kind: "STAGGERED", startOptions: [480, 480] }))).toEqual(["start_choice_invalid"]);
});
