import { expect, test } from "vitest";
import type { ImportRow, ReviewItem } from "./contract";
import { canRecordRowIdentifier, repairableCellField, resolveKind } from "./review";
import { answerOf, initialPicks, withChoice } from "./steps";

test("unfamiliar response values keep their evidence without offering an unsupported write", () => {
  const item: ReviewItem = { id: "new", reason: "new_review", blocking: true, sheet: "source", rows: 1,
    resolution: { decision: "future_map" as never, key: "source:2", choices: ["x"] } };
  expect(resolveKind(item)).toBe("info");
  const picks = initialPicks();
  expect(answerOf(picks, item.resolution!.decision, item.resolution!.key)).toBeNull();
  expect(answerOf(picks, "__proto__" as never, "anything")).toBeNull();
  expect(() => withChoice(picks, "future_map" as never, "source:2", "x")).toThrow(TypeError);
  expect(picks).toEqual(initialPicks());
});

test("cells resolution maps to inline repair while blocking restricted cell targets", () => {
  const twoDigit: ReviewItem = {
    id: "yr",
    reason: "two_digit_year",
    blocking: true,
    sheet: "S1",
    row: 5,
    field: "hire_date",
    expected_format: "YYYY-MM-DD",
    rows: 1,
    resolution: { decision: "cells", key: "S1:5", choices: [] },
  };
  expect(resolveKind(twoDigit)).toBe("cells");
  expect(repairableCellField(twoDigit)).toBe("hire_date");

  const restrictedRepair: ReviewItem = { ...twoDigit, field: "rrn" };
  expect(repairableCellField(restrictedRepair)).toBeNull();
  expect(repairableCellField({ ...twoDigit, field: "phone" })).toBeNull();
  expect(repairableCellField({ ...twoDigit, field: "name" })).toBeNull();

  const invalidDateExcl: ReviewItem = {
    ...twoDigit,
    reason: "invalid_date",
    resolution: { decision: "exclusions", key: "S1:5", choices: [] },
  };
  expect(repairableCellField(invalidDateExcl)).toBe("hire_date");
});

test("canRecordRowIdentifier matches RRN refusals and PRE_HIRE NOT_ISSUED rows", () => {
  const preHireNotIssued = {
    source_key: "S1:2",
    sheet: "S1",
    row: 2,
    name: "Sample",
    outcome: "insert",
    new_person: { status: "PRE_HIRE", id_type: "NOT_ISSUED", migrated_former: false },
  } as unknown as ImportRow;
  expect(canRecordRowIdentifier(undefined, preHireNotIssued)).toBe(true);

  const activeRrn = {
    ...preHireNotIssued,
    new_person: { status: "ACTIVE", id_type: "RRN", migrated_former: false },
  } as unknown as ImportRow;
  expect(canRecordRowIdentifier(undefined, activeRrn)).toBe(false);

  const mod11Item = { id: "m11", reason: "rrn_mod11_invalid", blocking: true, sheet: "S1", rows: 1 } as ReviewItem;
  expect(canRecordRowIdentifier(mod11Item, activeRrn)).toBe(true);
});
