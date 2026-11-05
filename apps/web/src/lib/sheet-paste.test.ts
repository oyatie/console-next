import ExcelJS from "exceljs";
import { expect, test } from "vitest";
import { csvWorkbook, pastedWorkbook } from "./sheet-paste";

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

test.each([
  ["UTF-8", new TextEncoder().encode('사번,성명,메모\r\n00123,가나다,"=1+1\t참고"\r\n')],
  ["UTF-8 BOM", new TextEncoder().encode('\uFEFF사번,성명,메모\r\n00123,가나다,"=1+1\t참고"\r\n')],
  ["EUC-KR", new Uint8Array(Buffer.from("bbe7b9f82cbcbab8ed2cb8deb8f00d0a30303132332cb0a1b3aab4d92c223d312b3109c2fcb0ed220d0a", "hex"))],
])("a %s CSV enters the workbook workflow with literal cell values", async (_encoding, bytes) => {
  const source = new File([bytes], "명부.CSV", { type: "text/csv" });
  const file = await csvWorkbook(source);
  expect(file.name).toBe("명부.xlsx");
  expect(file.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, "사번", "성명", "메모"]);
  expect(workbook.worksheets[0]!.getRow(2).values).toEqual([undefined, "00123", "가나다", "=1+1\t참고"]);
});

test("malformed CSV text is refused", async () => {
  await expect(csvWorkbook(new File([new Uint8Array([0xb0])], "broken.csv"))).rejects.toThrow(TypeError);
});

test("CSV uses commas even when a quoted header contains tabs", async () => {
  const file = await csvWorkbook(new File(['"메모\t참고\t설명",사번\r\n"두 줄\r\n메모",00123'], "명부.csv"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, "메모\t참고\t설명", "사번"]);
  expect(workbook.worksheets[0]!.getRow(2).values).toEqual([undefined, "두 줄\n메모", "00123"]);
});
