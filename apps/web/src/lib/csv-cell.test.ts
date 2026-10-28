// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { csvCell } from "./csv-cell";
import { spreadsheetCases } from "../../../../scripts/fixtures/spreadsheet-cases";

test.each(spreadsheetCases)("CSV cell preserves quoting and neutralizes $value", ({ value, csv }) => {
  expect(csvCell(value)).toBe(csv);
});

test.each([
  ["", ""], ["한글", "한글"], ["a,b", '"a,b"'], ['a"b', '"a""b"'],
  ["line\rbreak", '"line\rbreak"'], ["line\nbreak", '"line\nbreak"'], ["'＝1", "'＝1"],
])("ordinary CSV text round trips: %j", (value, expected) => {
  expect(csvCell(value)).toBe(expected);
});

test("numeric values keep their text representation and formula guard", () => {
  expect(csvCell(42)).toBe("42");
  expect(csvCell(-42)).toBe("'-42");
});
