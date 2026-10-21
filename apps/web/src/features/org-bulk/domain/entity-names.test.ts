import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { LegalEntity, OrgStructureNodeServed as Node } from "@console/api/pending";
import { readXlsx } from "../../../lib/sheet-file";
import { guessColumns, readRows, type HeaderWords } from "./columns";
import { entityValues } from "./values";

const words: HeaderWords = { entity: ["회사", "법인", "상호"], brn: ["사업자등록번호"], workplace: ["사업장"], path: ["부서"], parent: [], code: [], head: [], shift: [] };
const ents = [{ id: "entity", kind: "LEGAL_ENTITY", name: "주식회사 가나테크", children: [] }] as unknown as Node[];
const e = { id: "entity", needs_confirmation: false, current: { name: "주식회사 가나테크", display_name: "GANATECH" }, workplaces: [], registrations: [{ id: "cert", needs_confirmation: false, brn: { value: "0000000000" }, current: { trade_name: "주식회사 가나테크" } }] } as unknown as LegalEntity;

it("reads merged headings and keeps company, trade name, representative and employee name separate", async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("명부");
  ws.addRow(["회사 자료", "", "", "직원 자료"]); ws.mergeCells("A1:C1");
  ws.addRow(["회사", "상호", "대표자", "성명", "사업장", "부서"]);
  ws.addRow(["GANATECH", "주식회사 가나테크", "김예시,박예시", "김직원", "본사", "인사팀"]);
  const sheet = (await readXlsx(await wb.xlsx.writeBuffer()))[0]!;
  const columns = guessColumns(sheet.rows[1]!, words);
  expect(columns.map((c) => c.role)).toEqual(["entity", "skip", "skip", "skip", "workplace", "path"]);
  const rows = readRows(sheet.rows, 1, columns);
  expect(rows[0]?.entitySource).toEqual({ cell: "A3", column: "회사", value: "GANATECH" });
  const values = entityValues(rows, ents, [e]);
  expect(values[0]?.match).toBeUndefined();
  expect(values[0]?.candidates[0]?.id).toBe("entity");
});
it("a person-list cell never creates or auto-matches an entity", () => {
  const rows = readRows([["법인", "사업장", "부서"], ["김예시,박예시", "본사", "인사팀"]], 0, guessColumns(["법인", "사업장", "부서"], words));
  expect(entityValues(rows, ents, [e])[0]).toMatchObject({ value: "김예시,박예시", problem: "unknown", candidates: [] });
});
it("registration number decides the proposed match before a conflicting label", () => {
  const row = { line: 4, entity: "another label", brn: "0000000000", workplace: "본사", path: [], parent: "", code: "", head: "" };
  expect(entityValues([row], ents, [e])[0]?.candidates.map((c) => c.id)).toEqual(["entity"]);
  expect(entityValues([{ ...row, brn: "0000000053", entity: "GANATECH" }], ents, [e])[0]?.candidates).toEqual([]);
  expect(entityValues([row], ents, [{ ...e, needs_confirmation: true }])[0]?.candidates).toEqual([]);
});
