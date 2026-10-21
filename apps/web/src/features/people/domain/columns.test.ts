import { expect, test } from "vitest";
import { moveColumn, OPTIONAL_COLUMNS, parseColumns, toggleColumn } from "./columns";

test("a stored column choice is read back safely", () => {
  expect(parseColumns(null)).toEqual([...OPTIONAL_COLUMNS]);
  expect(parseColumns("hired,entity,bogus,hired")).toEqual(["hired", "entity"]);
  expect(parseColumns("bogus")).toEqual([...OPTIONAL_COLUMNS]);
});

test("columns move one place at a time and toggle on at the end", () => {
  expect(moveColumn(["entity", "unit", "type"], "unit", -1)).toEqual(["unit", "entity", "type"]);
  expect(moveColumn(["entity", "unit"], "entity", -1)).toEqual(["entity", "unit"]);
  expect(toggleColumn(["entity"], "type")).toEqual(["entity", "type"]);
  expect(toggleColumn(["entity", "type"], "entity")).toEqual(["type"]);
});
