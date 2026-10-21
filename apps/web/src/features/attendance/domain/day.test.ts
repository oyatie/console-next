import { expect, test } from "vitest";
import { cellShape, hours, intersect, scheduledSpans, toneCounts } from "./day";

test("scheduled spans skip the breaks and recognised drawing is their overlap with the record", () => {
  const plan = scheduledSpans({ start: 480, end: 1020, breaks: [{ start: 720, end: 780 }] });
  expect(plan).toEqual([{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
  expect(intersect([{ start: 472, end: 1150 }], plan)).toEqual(plan);
  expect(intersect([{ start: 490, end: 600 }], plan)).toEqual([{ start: 490, end: 600 }]);
});

test("a grid cell prints whole hours, h:mm, a code, a rest day or nothing", () => {
  expect(hours(480)).toBe("8");
  expect(hours(459)).toBe("7:39");
  expect(cellShape({ plan_kind: "WORK", entry_kind: "TIMES", recognised: 480 })).toEqual({ kind: "hours", text: "8" });
  expect(cellShape({ plan_kind: "WORK", entry_kind: "ABSENT", recognised: 0 })).toEqual({ kind: "code", code: "ABSENT" });
  expect(cellShape({ plan_kind: "WEEKLY_HOLIDAY", recognised: 0 })).toEqual({ kind: "code", code: "REST" });
  expect(cellShape({ plan_kind: "WORK", recognised: 0 })).toEqual({ kind: "empty" });
  expect(toneCounts(["NO_RECORD", "UNAPPROVED_EXCESS", "LATE", "LATE"])).toEqual({ blocking: 1, decision: 1, info: 2 });
});
