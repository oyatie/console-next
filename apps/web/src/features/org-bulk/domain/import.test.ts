import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { columnsReady, guessColumns, headerRow, readRows, type HeaderWords } from "./columns";
import { importPlan } from "./import-plan";
import { entityValues, openPicks, rowEntity, workplaceValues } from "./values";
import { readDelimited, readXlsx } from "../../../lib/sheet-file";

const WORDS: HeaderWords = {
  entity: ["회사", "법인"], workplace: ["근무지", "사업장"], path: ["본부", "부", "팀", "부서"],
  parent: ["상위부서"], code: ["부서코드"], head: ["팀장사번"], shift: ["교대조"],
};
const node = (kind: Node["kind"], id: string, name: string, children: Node[] = []): Node => ({ kind, id, name, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const ents = [
  node("LEGAL_ENTITY", "E1", "(주)새온정밀", [node("WORKPLACE", "W1", "서울 본사", [node("DEPARTMENT", "D1", "인사팀")]), node("WORKPLACE", "W2", "평택공장")]),
  node("LEGAL_ENTITY", "E2", "(주)새온물류", [node("WORKPLACE", "W3", "인천 본사")]),
];
const SHEET = [
  ["회사", "근무지", "본부", "부", "팀", "부서코드", "팀장사번", "비고"],
  ["새온정밀", "서울 본사", "경영지원본부", "", "인사팀", "HQ-HR", "00112", ""],
  ["(주)새온정밀", "서울 본사", "", "", "인사팀", "", "", ""],
  ["(주)새온정밀", "서울본사", "", "", "재무팀", "", "", ""],
  ["(주)새온정밀", "평택공장", "", "생산부", "생산1팀", "", "", ""],
  ["", "본사", "", "", "총무팀", "", "", ""],
  ["(주)새온물류", "천안센터", "", "", "운영팀", "", "", "11월 개설"],
  ["(주)새온물류", "", "", "", "배송팀", "", "", ""],
];

describe("files", () => {
  it("reads an .xlsx written by Excel's library, shared strings and gaps included", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("부서");
    SHEET.forEach((r) => ws.addRow(r));
    wb.addWorksheet("빈 시트");
    const sheets = await readXlsx((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(sheets.map((s) => s.name)).toEqual(["부서", "빈 시트"]);
    expect(sheets[0]!.rows[1]!.slice(0, 5)).toEqual(["새온정밀", "서울 본사", "경영지원본부", "", "인사팀"]);
    expect(sheets[0]!.rows).toHaveLength(SHEET.length);
  });
  it("reads CSV with quotes and TSV by whichever delimiter the first line has more of", () => {
    expect(readDelimited('회사,근무지\n"(주)새온, 정밀","서울 ""본사"""\n')).toEqual([["회사", "근무지"], ["(주)새온, 정밀", '서울 "본사"']]);
    expect(readDelimited("회사\t근무지\r\nA\tB")).toEqual([["회사", "근무지"], ["A", "B"]]);
  });
  it("rejects a file that is not a workbook", async () => {
    await expect(readXlsx(new TextEncoder().encode("not a zip").buffer)).rejects.toThrow("not_xlsx");
  });
});

describe("columns and values", () => {
  const cols = guessColumns(SHEET[headerRow(SHEET)]!, WORDS);
  const rows = readRows(SHEET, 0, cols);
  it("maps known headers, names the ones it cannot keep and leaves the rest out", () => {
    expect(cols.map((c) => c.unsupported ?? c.role)).toEqual(["entity", "workplace", "path", "path", "path", "code", "head", "skip"]);
    expect(columnsReady(cols)).toBe(true);
    expect(rows[0]).toEqual(expect.objectContaining({ line: 2, entity: "새온정밀", workplace: "서울 본사", path: ["경영지원본부", "인사팀"], parent: "", code: "HQ-HR", head: "00112" }));
  });
  const eItems = entityValues(rows, ents);
  it("never confirms a legal entity from an imported name alone", () => {
    expect(eItems.map((i) => [i.value, i.match ?? i.problem])).toEqual([["새온정밀", "unknown"], ["(주)새온정밀", "unknown"], ["(주)새온물류", "unknown"]]);
  });
  const picks = { "e:(주)새온정밀": { to: "id", id: "E1" } as const, "e:(주)새온물류": { to: "id", id: "E2" } as const, "e:새온정밀": { to: "id", id: "E1" } as const };
  const wItems = workplaceValues(rows, ents, (r) => rowEntity(r, ents, picks, eItems));
  it("asks about a near miss, an ambiguous value and an unknown one; never guesses", () => {
    expect(wItems.map((i) => [i.value, i.match ?? i.problem, i.candidates.map((c) => c.id)])).toEqual([
      ["서울 본사", "W1", []],
      ["서울본사", "nearMiss", ["W1"]],
      ["평택공장", "W2", []],
      ["본사", "noEntity", []],
      ["천안센터", "unknown", []],
    ]);
    expect(openPicks(wItems, {})).toBe(3);
    expect(openPicks(wItems, { [wItems[1]!.key]: { to: "id", id: "W1" }, [wItems[3]!.key]: { to: "skip" }, [wItems[4]!.key]: { to: "create" } })).toBe(0);
  });
  it("plans per entity, links what exists, and splits the rows into applied, errors and left out", () => {
    const all = { ...picks, [wItems[1]!.key]: { to: "id", id: "W1" }, [wItems[3]!.key]: { to: "skip" }, [wItems[4]!.key]: { to: "create" } } as const;
    const p = importPlan(rows, ents, [...eItems, ...wItems], all);
    expect(p.lines).toEqual({ total: 7, apply: 5, error: 1, skipped: 1 });
    expect(p.errors).toEqual([{ line: 8, kind: "noWorkplace" }]);
    const e1 = p.byEntity.find((b) => b.entity.id === "E1")!.rows;
    expect(e1.map((r) => `${r.depth}:${r.name}:${r.status}`)).toEqual([
      "0:서울 본사:link", "1:경영지원본부:create", "2:인사팀:create", "1:인사팀:link", "1:재무팀:create", "0:평택공장:link", "1:생산부:create", "2:생산1팀:create",
    ]);
    expect(p.byEntity.find((b) => b.entity.id === "E2")!.rows.map((r) => `${r.name}:${r.status}`)).toEqual(["천안센터:create", "운영팀:create"]);
  });
});

describe("regression (r3 org-06): a parent column, the code and the head", async () => {
  const { orgOps } = await import("./ops");
  const BY_PARENT = [
    ["사업장", "부서", "상위부서", "부서코드", "팀장사번"],
    ["서울 본사", "총무팀", "", "GA", ""],
    ["서울 본사", "구매파트", "총무팀", "GA-P", "E-1"],
    ["서울 본사", "보안운영파트", "인사팀", "", ""],
    ["서울 본사", "고아파트", "없는팀", "", ""],
    ["서울 본사", "갑파트", "을파트", "", ""],
    ["서울 본사", "을파트", "갑파트", "", ""],
    ["서울 본사", "누구파트", "총무팀", "", "E-404"],
  ];
  const cols = guessColumns(BY_PARENT[0]!, WORDS);
  const rows = readRows(BY_PARENT, 0, cols);
  const eItems = entityValues(rows, ents);
  const items = [...eItems, ...workplaceValues(rows, ents, (r) => rowEntity(r, ents, {}, eItems))];
  const heads = new Map([["E-1", "P1"], ["E-404", null]]);
  const p = importPlan(rows, ents, items, {}, heads);
  it("maps 상위부서, 부서코드 and 팀장사번 to roles the server keeps", () => {
    expect(cols.map((c) => c.role)).toEqual(["workplace", "path", "parent", "code", "head"]);
  });
  it("keeps the hierarchy from the sheet's own rows and from the chart", () => {
    const e1 = p.byEntity.find((b) => b.entity.id === "E1")!.rows;
    expect(e1.map((r) => `${r.depth}:${r.name}:${r.status}`)).toEqual(["0:서울 본사:link", "1:총무팀:create", "2:구매파트:create", "1:인사팀:link", "2:보안운영파트:create"]);
  });
  it("refuses by name a parent found nowhere, a loop and a head nobody has", () => {
    expect(p.errors).toEqual([
      { line: 5, kind: "noParent", name: "없는팀" },
      { line: 6, kind: "noParent", name: "갑파트" },
      { line: 7, kind: "noParent", name: "을파트" },
      { line: 8, kind: "headUnknown", name: "E-404" },
    ]);
  });
  it("sends the code and the head with the unit's own create", () => {
    const e1 = p.byEntity.find((b) => b.entity.id === "E1")!;
    const ops = orgOps({ kind: "entity", node: e1.entity }, e1.rows, {}, "", heads);
    expect(ops.map((o) => [o.name, (o as { code?: string }).code, (o as { head_employee_id?: string }).head_employee_id])).toEqual([
      ["총무팀", "GA", undefined], ["구매파트", "GA-P", "P1"], ["보안운영파트", undefined, undefined],
    ]);
  });
});

describe("bulk edit", async () => {
  const { editLines } = await import("./bulk-edit");
  const rel = (insurer: "NPS" | "NHIS" | "EI" | "IACI", status: "ESTABLISHED" | "NOT_ESTABLISHED" | "ESTABLISHED_NUMBER_PENDING", version = 1) =>
    ({ insurer, status, version, effective_from: "2026-10-01", before_first_record: false, unit_mode: "OWN" }) as never;
  const all = (status: "ESTABLISHED" | "NOT_ESTABLISHED") => (["NPS", "NHIS", "EI", "IACI"] as const).map((i, n) => rel(i, status, n + 1));
  const rows = [
    { id: "a", name: "아산공장", entity: "E", insurance: [rel("NPS", "ESTABLISHED"), rel("NHIS", "ESTABLISHED"), rel("EI", "NOT_ESTABLISHED"), rel("IACI", "NOT_ESTABLISHED")] },
    { id: "b", name: "부산영업소", entity: "E", insurance: all("NOT_ESTABLISHED") },
    { id: "c", name: "광주지점", entity: "F", insurance: [] },
  ];
  it("changes only rows with no insurer already settled, and pins each to its insurance version", () => {
    const lines = editLines(rows, "LATER");
    expect(lines.map((l) => [l.name, l.before, l.change, l.expectedVersion])).toEqual([["아산공장", "MIXED", false, 1], ["부산영업소", "NOT_ESTABLISHED", true, 4], ["광주지점", "EMPTY", true, 0]]);
    expect(lines[1]!.insurers.every((i) => i.status === "ESTABLISHED_NUMBER_PENDING")).toBe(true);
    expect(editLines(rows, "NONE").map((l) => l.change)).toEqual([false, false, true]);
  });
});
