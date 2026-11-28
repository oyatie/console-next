// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { csvCell } from "../../../lib/csv-cell";
import { parseSheetText } from "./records-import-parse";

test("a multiline exported award stays with its employee when imported", () => {
  const title = 'Line one, "awarded"\r\nLine two';
  const raw = [["employee_number", "title"], ["001", title], ["002", "Next award"]]
    .map(row => row.map(csvCell).join(",")).join("\r\n");
  const rows = parseSheetText("award", raw, { numberCol: "No.", nameCol: "Name", voidCol: "Void", fieldLabel: key => key });
  expect(rows.map(row => [row.row, row.employee_number, row.fields])).toEqual([[2, "001", { title }], [3, "002", { title: "Next award" }]]);
});
