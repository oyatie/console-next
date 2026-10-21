import ExcelJS from "exceljs";
import { expect, test } from "vitest";
import { pastedWorkbook } from "./sheet-paste";

test("pasted rows preserve Unicode, quoted cells, leading zeroes and formula-like text", async () => {
  const file = await pastedWorkbook('Name,Number,Note\n"Kim, Min",00123,"=1+1"\n윤하준,00001,"two\nlines"', "roster.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0]!;
  expect(sheet.getRow(2).values).toEqual([undefined, "Kim, Min", "00123", "=1+1"]);
  expect(sheet.getCell("A3").value).toBe("윤하준");
  expect(sheet.getCell("C3").value).toBe("two\nlines");
});

test("a 2,000-person paste reaches the existing workbook workflow intact", async () => {
  const text = ["Name\tNumber", ...Array.from({ length: 2000 }, (_, i) => `Person ${i}\t${String(i).padStart(5, "0")}`)].join("\n");
  const file = await pastedWorkbook(text, "roster.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  expect(workbook.worksheets[0]!.rowCount).toBe(2001);
  expect(workbook.worksheets[0]!.getCell("B2001").value).toBe("01999");
});
