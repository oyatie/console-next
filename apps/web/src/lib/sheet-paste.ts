import { readDelimited } from "./sheet-file";

/** Keep pasted cell text literal; the existing roster preview owns mapping, validation and apply. */
export async function pastedWorkbook(text: string, name: string): Promise<File> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Roster");
  sheet.addRows(readDelimited(text));
  const bytes = await workbook.xlsx.writeBuffer();
  return new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
