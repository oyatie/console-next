import { expect, test } from "vitest";
import { blankDay, moveItem, toSpec } from "./day-form";

test("a typed working day becomes minutes; a night shift and its break roll into the next day", () => {
  expect(toSpec({ ...blankDay("WORK"), start: "8", end: "17", breakStart: "12", breakEnd: "13" })).toEqual({ kind: "WORK", shift: { start: 480, end: 1020, breaks: [{ start: 720, end: 780 }] } });
  expect(toSpec({ ...blankDay("WORK"), start: "21:00", end: "06:00", breakStart: "02:00", breakEnd: "03:00" })).toEqual({ kind: "WORK", shift: { start: 1260, end: 1800, breaks: [{ start: 1560, end: 1620 }] } });
});

test("nothing is assumed: no kind, a missing clock or half a break is not a day yet", () => {
  expect(toSpec(blankDay())).toBeNull();
  expect(toSpec({ ...blankDay("WORK"), start: "9" })).toBeNull();
  expect(toSpec({ ...blankDay("WORK"), start: "9", end: "18", breakStart: "12" })).toBeNull();
  expect(toSpec(blankDay("WEEKLY_HOLIDAY"))).toEqual({ kind: "WEEKLY_HOLIDAY" });
});

test("moving a slot past either end keeps the order", () => {
  expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
});
