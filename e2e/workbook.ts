import ExcelJS from "exceljs";

/** Builds an employee roster workbook in memory: one sheet per company, header row first. */
export async function rosterXlsx(company: string, rows: (string | Date)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(company);
  sheet.addRow(["사번", "성명", "부서", "직위", "입사일"]);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
