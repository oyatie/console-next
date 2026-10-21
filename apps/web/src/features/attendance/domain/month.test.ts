import { expect, test } from "vitest";
import { monthDates, monthWeeks, shiftMonth, weekday } from "./month";

test("October 2026 runs Sunday 9/27 to Saturday 10/31 in five weeks", () => {
  const weeks = monthWeeks("2026-10");
  expect(weeks).toHaveLength(5);
  expect([weeks[0]![0], weeks[4]![6]]).toEqual(["2026-09-27", "2026-10-31"]);
  expect(weeks.every((w) => w.length === 7 && weekday(w[0]!) === 0)).toBe(true);
});

test("a month that starts on Sunday has no lead days; February 2026 is four weeks", () => {
  expect(monthWeeks("2026-02")).toHaveLength(4);
  expect(monthWeeks("2026-02")[0]![0]).toBe("2026-02-01");
});

test("month steps and dates", () => {
  expect([shiftMonth("2026-12", 1), shiftMonth("2026-01", -1)]).toEqual(["2027-01", "2025-12"]);
  expect(monthDates("2026-02")).toHaveLength(28);
});
