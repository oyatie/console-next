import { expect, test } from "vitest";
import { cellShape, hours, withoutBreaks, scheduledSpans } from "./day";

test("recorded work outside the shift stays on the recognised bar", () => {
  const plan = scheduledSpans({ start: 480, end: 1020, breaks: [{ start: 720, end: 780 }] });
  expect(plan).toEqual([{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
  expect(withoutBreaks([{ start: 472, end: 1150 }], [{ start: 720, end: 780 }])).toEqual([{ start: 472, end: 720 }, { start: 780, end: 1150 }]);
  expect(withoutBreaks([{ start: 490, end: 600 }], [])).toEqual([{ start: 490, end: 600 }]);
  expect(withoutBreaks([{ start: 720, end: 780 }], [{ start: 700, end: 800 }])).toEqual([]);
  expect(withoutBreaks([{ start: 700, end: 900 }], [{ start: 720, end: 800 }, { start: 780, end: 850 }])).toEqual([{ start: 700, end: 720 }, { start: 850, end: 900 }]);
});

test("a grid cell prints whole hours, h:mm, a code, a rest day or nothing", () => {
  expect(hours(480)).toBe("8");
  expect(hours(459)).toBe("7:39");
  expect(cellShape({ plan_kind: "WORK", entry_kind: "TIMES", recognised: 480 })).toEqual({ kind: "hours", text: "8" });
  expect(cellShape({ plan_kind: "WORK", entry_kind: "ABSENT", recognised: 0 })).toEqual({ kind: "code", code: "ABSENT" });
  expect(cellShape({ plan_kind: "WEEKLY_HOLIDAY", recognised: 0 })).toEqual({ kind: "code", code: "REST" });
  expect(cellShape({ plan_kind: "WORK", recognised: 0 })).toEqual({ kind: "empty" });
});
