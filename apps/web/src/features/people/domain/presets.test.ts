import { expect, test } from "vitest";
import { addMonths, applies, effectivePresets, endPresets, periodPresets, returnPresets } from "./presets";

const TODAY = "2026-10-02";

test("a future date schedules; today or a past date applies now; no date is neither", () => {
  expect(applies("2026-10-03", TODAY)).toBe("future");
  expect(applies("2026-10-02", TODAY)).toBe("today");
  expect(applies("2026-09-30", TODAY)).toBe("past");
  expect(applies("", TODAY)).toBeNull();
  expect(applies("2026-02-30", TODAY)).toBeNull();
});

test("months clamp to the month's last day", () => {
  expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
});

test("transfer presets as spec E5 draws them: today, next Monday, next month's 1st", () => {
  expect(effectivePresets("TRANSFER", { today: TODAY })).toEqual([
    { id: "today", date: TODAY },
    { id: "nextMonday", date: "2026-10-05" },
    { id: "nextMonthFirst", date: "2026-11-01" },
  ]);
  // On a Sunday the 31st, next Monday is the 1st of next month: the later duplicate gives way.
  expect(effectivePresets("PROMOTE", { today: "2027-01-31" }).map((p) => p.id)).toEqual(["today", "nextMonday"]);
});

test("presets outside the bounds are dropped", () => {
  expect(effectivePresets("TRANSFER", { today: TODAY, max: "2026-10-20" }).map((p) => p.id)).toEqual(["today", "nextMonday"]);
  expect(effectivePresets("RETURN_FROM_LEAVE", { today: TODAY, min: "2026-11-03", returnDate: "2027-04-30" })).toEqual([{ id: "returnDate", date: "2027-04-30" }]);
});

test("return and renewal presets come from the leave's return date and the current contract end", () => {
  expect(effectivePresets("RETURN_FROM_LEAVE", { today: TODAY }).map((p) => p.id)).toEqual(["today"]);
  expect(effectivePresets("LEAVE_OF_ABSENCE", { today: TODAY }).map((p) => p.id)).toEqual(["nextMonthFirst", "today"]);
  expect(effectivePresets("CONTRACT_RENEWAL", { today: TODAY, contractEnd: "2027-01-31" })).toEqual([
    { id: "afterContract", date: "2027-02-01" },
    { id: "today", date: TODAY },
  ]);
});

test("follow-up dates resolve from the start: a leave's return, a contract's end the day before", () => {
  expect(returnPresets("2026-11-01").map((p) => p.date)).toEqual(["2027-02-01", "2027-05-01", "2027-11-01"]);
  expect(endPresets("2027-02-01").map((p) => p.date)).toEqual(["2027-07-31", "2028-01-31", "2029-01-31"]);
  expect(returnPresets("")).toEqual([]);
});

test("whole-period renewals set both dates from the day after the contract ends", () => {
  expect(periodPresets("2027-01-31", {})).toEqual([
    { months: 12, start: "2027-02-01", end: "2028-01-31" },
    { months: 24, start: "2027-02-01", end: "2029-01-31" },
  ]);
  expect(periodPresets(null, {})).toEqual([]);
  expect(periodPresets("2027-01-31", { max: "2027-01-15" })).toEqual([]);
});
