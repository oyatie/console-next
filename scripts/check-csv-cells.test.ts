// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { checkCsvCells, csvCellProblems } from "./check-csv-cells.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sheet = "apps/web/src/features/onboarding/domain/sheet.ts";
const registry = "apps/web/src/features/structure/domain/registry.ts";
const imported = 'import { csvCell } from "../../../lib/csv-cell"; ';

test("every current browser CSV writer uses the shared cell writer", () => {
  expect(checkCsvCells(root)).toEqual([]);
});

test.each([sheet, registry])("removing cell writes from %s fails even when the import remains", file => {
  const source = readFileSync(path.join(root, file), "utf8");
  expect(csvCellProblems(file, source.replaceAll(".map(csvCell)", ""))).not.toEqual([]);
});

test.each([
  'const csv = rows.map(row => row.join(",")).join("\\r\\n");',
  imported + 'const csv = rows.map(row => row.join(",")).join("\\r\\n");',
  imported + 'const csv = [headers.join(","), ...rows.map(row => row.map(csvCell).join(","))].join("\\n");',
  'const file = new Blob([rows.map(row => row.join(",")).join("\\n")], { type: "text/csv" });',
  imported + 'const file = new Blob([rows.map(row => row.join(",")).join("\\n")], { type: "text/csv" });',
  'import { csvCell } from "./pretend-csv-cell"; const csv = rows.map(row => row.map(csvCell).join(",")).join("\\r\\n");',
])("a new bypass is refused: %s", source => {
  expect(csvCellProblems(sheet, source)).not.toEqual([]);
});

test("CSV headers and data cells both require the writer", () => {
  const source = imported + 'const csv = [headers.map(csvCell).join(","), ...rows.map(row => row.map(csvCell).join(","))].join("\\r\\n");';
  expect(csvCellProblems(sheet, source)).toEqual([]);
  expect(csvCellProblems(sheet, source.replace("headers.map(csvCell)", "headers"))).toHaveLength(1);
  expect(csvCellProblems(sheet, source.replace("row.map(csvCell)", "row"))).toHaveLength(1);
});

test("comma joins used for query strings are outside CSV output", () => {
  expect(csvCellProblems("query.ts", 'const ids = rows.map(row => row.id).join(",");')).toEqual([]);
});
