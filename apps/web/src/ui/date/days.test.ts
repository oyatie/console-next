import { expect, test } from "vitest";
import { addDays, addMonths, daysBetween, inBounds, isDate, nextMonday as nm, nextMonthFirst as nmf, nextWeekday, parseTyped as pt } from "./days";

test("calendar-date arithmetic", () => {
  expect(isDate("2026-02-29")).toBe(false);
  expect(isDate("2028-02-29")).toBe(true);
  expect(isDate("")).toBe(false);
  expect(daysBetween("2026-10-01", "2026-11-01")).toBe(31);
  expect(daysBetween("2026-10-01", "2026-09-28")).toBe(-3);
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(inBounds("2026-09-28", "2026-10-01")).toBe(false);
  expect(inBounds("2026-10-01", "2026-10-01", "2027-09-30")).toBe(true);
  expect(inBounds("2027-10-01", undefined, "2027-09-30")).toBe(false);
});

test("a weekend date suggests the next Monday; a weekday suggests nothing", () => {
  expect(nextWeekday("2026-10-31")).toBe("2026-11-02"); // Saturday
  expect(nextWeekday("2026-11-01")).toBe("2026-11-02"); // Sunday
  expect(nextWeekday("2026-11-02")).toBeNull();
});

test("months clamp to the month's last day", () => {
  expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
});

test("typed dates: separators, compact form, and the month or day the calendar has not got", () => {
  for (const s of ["2026-10-12", "2026.10.12", "2026. 10. 12.", "2026/10/12", "20261012", " 2026.10.12 "]) expect(pt(s, "ko")).toEqual({ date: "2026-10-12" });
  expect(pt("10/12/2026", "en")).toEqual({ date: "2026-10-12" });
  expect(pt("2026-10-12", "en")).toEqual({ date: "2026-10-12" });
  expect(pt("")).toEqual({ empty: true });
  expect(pt("2026-13-01", "ko")).toEqual({ bad: "month", month: 13 });
  expect(pt("2026-02-30", "ko")).toEqual({ bad: "day", month: 2, day: 30 });
  expect(pt("13/01/2026", "en")).toEqual({ bad: "month", month: 13 });
  expect(pt("next week")).toEqual({ bad: "format" });
  expect(nm("2026-10-06")).toBe("2026-10-12");
  expect(nm("2026-10-12")).toBe("2026-10-19");
  expect(nmf("2026-12-15")).toBe("2027-01-01");
});

test("compact dates need all eight digits and Korean dates do not accept month-first order", () => {
  for (const text of ["202611", "2026111", "2026-1115", "202611-15", "11/15/2026"]) {
    expect(pt(text, "ko")).toEqual({ bad: "format" });
  }
});
