import { decodeSheetText, readDelimited } from "./sheet-file";

/** Keep pasted cell text literal; the existing roster preview owns mapping, validation and apply. */
export async function pastedWorkbook(text: string, name: string, delimiter?: "," | "\t"): Promise<File> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Roster");
  sheet.addRows(readDelimited(text, { delimiter }));
  const bytes = await workbook.xlsx.writeBuffer();
  return new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** Decode exported CSV strictly before sending it through the same reviewed workbook workflow. */
export async function csvWorkbook(file: File): Promise<File> {
  return pastedWorkbook(decodeSheetText(await file.arrayBuffer()).text, file.name.replace(/\.csv$/i, ".xlsx"), ",");
}
