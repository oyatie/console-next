import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { errorsFirst, groupRows, hintFor, MAX_LINES, matchUnit, monthEnd, nextMonthFirst, parsePaste, resolvePaste, selectionRows, whenOf, type UnitRef } from "./bulk";

type Employee = components["schemas"]["Employee"];
const emp = (x: Partial<Employee>) => ({ status: "ACTIVE", ...x }) as Employee;

const units: UnitRef[] = [
  { id: "u-hr", name: "인사부", path: "본사 › 인사부" },
  { id: "u-rec", name: "채용팀", path: "본사 › 인사부 › 채용팀" },
  { id: "u-sales-a", name: "영업팀", path: "본사 › 영업1부 › 영업팀" },
  { id: "u-sales-b", name: "영업팀", path: "본사 › 영업2부 › 영업팀" },
];
const employees = [
  emp({ id: "e1", employee_number: "HK-0001", name: "김일번", org_unit_id: "u-hr", position: "사원" }),
  emp({ id: "e2", employee_number: "HK-0002", name: "이 하나", org_unit_id: "u-rec" }),
  emp({ id: "e3", employee_number: "HK-0003", name: "박삼번", status: "ON_LEAVE" }),
  emp({ id: "e4a", employee_number: "D-1", name: "가" }),
  emp({ id: "e4b", employee_number: "d-1", name: "나" }),
  emp({ id: "e5", employee_number: "HK-0005", name: "정오번" }),
];

test("a spreadsheet copy: header skipped, blanks ignored, tabs or commas, duplicates merged, a different duplicate is a conflict", () => {
  const lines = parsePaste("사번\t새 조직\t이름\nHK-0001\t채용팀\t김일번\n\n  \nHK-0002, 인사부 ,이하나\nhk-0001\t채용팀\nHK-0002\t채용팀");
  expect(lines.map((l) => [l.line, l.number, l.target, l.name, l.merged, l.issue])).toEqual([
    [2, "HK-0001", "채용팀", "김일번", [6], undefined],
    [5, "HK-0002", "인사부", "이하나", [7], "conflict"],
  ]);
  // A first line with a digit is data, not a header.
  expect(parsePaste("1234\n5678").map((l) => l.number)).toEqual(["1234", "5678"]);
});

test("employee numbers past the batch limit are refused, not dropped", () => {
  const lines = parsePaste(Array.from({ length: MAX_LINES + 2 }, (_, i) => `N-${i + 1}`).join("\n"));
  expect(lines).toHaveLength(MAX_LINES + 2);
  expect(lines.filter((l) => l.issue === "overLimit").map((l) => l.number)).toEqual([`N-${MAX_LINES + 1}`, `N-${MAX_LINES + 2}`]);
});

test("quoted appointment cells keep tabs and newlines without shifting names or duplicate rows", () => {
  const lines = parsePaste('사번\t새 조직\t이름\r\n001\t"HR\tlead\nPM"\t"Kim, Min"\r\n\r\n001,"HR\tlead\nPM","Kim, Min"\r\n002\tHR, payroll\tLee');
  expect(lines).toEqual([
    { line: 2, number: "001", target: "HR\tlead\nPM", name: "Kim, Min", merged: [4], issue: undefined },
    { line: 5, number: "002", target: "HR, payroll", name: "Lee", merged: [], issue: undefined },
  ]);
});

test.each(["\t", ","])("an unclosed appointment quote keeps all rows with delimiter %j", (separator) => {
  const text = `001${separator}"인사부${separator}김\n002${separator}재무팀${separator}이\n003${separator}영업팀${separator}박`;
  expect(parsePaste(text).map((l) => [l.line, l.number, l.target, l.name])).toEqual([
    [1, "001", '"인사부', "김"], [2, "002", "재무팀", "이"], [3, "003", "영업팀", "박"],
  ]);
});

test.each(['"A" 팀', '인사 "A" 팀', '"A""B" 팀'])("literal appointment quotes survive: %s", (value) => {
  expect(parsePaste(`001\t${value}\t김`).map((l) => [l.number, l.target, l.name])).toEqual([["001", value, "김"]]);
});

test.each(["\t", ","])("an Excel-quoted appointment cell keeps tabs, newlines and escaped quotes (%j)", (separator) => {
  expect(parsePaste(`001${separator}"""A"" 팀\t인사\n담당"${separator}김\r\n002\t재무팀\t이`).map((l) => [l.line, l.number, l.target, l.name])).toEqual([
    [1, "001", '"A" 팀\t인사\n담당', "김"], [2, "002", "재무팀", "이"],
  ]);
});

test("a unit matches by exact name, then exact path; never partly", () => {
  expect(matchUnit("채용팀", units).map((u) => u.id)).toEqual(["u-rec"]);
  expect(matchUnit("영업팀", units).map((u) => u.id)).toEqual(["u-sales-a", "u-sales-b"]);
  expect(matchUnit("본사 › 영업2부 › 영업팀", units).map((u) => u.id)).toEqual(["u-sales-b"]);
  expect(matchUnit("채용", units)).toEqual([]);
});

test("each line resolves to one employee by number and one unit, or says why not", () => {
  const lines = parsePaste("HK-0001\t채용팀\nHK-0002\t채용팀\t이한나\nHK-9999\t채용팀\nD-1\t채용팀\nHK-0003\t채용팀\nHK-0001x\nHK-0005\t영업팀");
  const rows = resolvePaste(parsePaste("HK-0001\t채용팀\nhk-0002\t인사부\t이하나\nHK-9999\t채용팀\nD-1\t채용팀\nHK-0003\t채용팀\nHK-0004"), { employees, units, kind: "TRANSFER", sheet: {}, picks: {} });
  expect(rows.map((r) => [r.number, r.employee?.id, r.unitId, r.problem, r.hint])).toEqual([
    ["HK-0001", "e1", "u-rec", undefined, undefined],
    ["hk-0002", "e2", "u-hr", undefined, undefined], // the pasted name matches ignoring spaces
    ["HK-9999", undefined, undefined, "notFound", undefined],
    ["D-1", undefined, undefined, "numberAmbiguous", undefined],
    ["HK-0003", "e3", "u-rec", undefined, "onLeave"],
    ["HK-0004", undefined, undefined, "notFound", undefined],
  ]);
  const mixed = resolvePaste(lines, { employees, units, kind: "TRANSFER", sheet: {}, picks: {} });
  expect(mixed[1]?.problem).toBe("nameMismatch");
  expect(mixed[5]?.problem).toBe("notFound");
  expect(mixed[6]).toMatchObject({ problem: "unitAmbiguous", candidates: [{ id: "u-sales-a" }, { id: "u-sales-b" }] });
  // Choosing one of the candidates resolves the line.
  const picked = resolvePaste(lines, { employees, units, kind: "TRANSFER", sheet: {}, picks: { "7": "u-sales-b" } });
  expect(picked[6]).toMatchObject({ unitId: "u-sales-b" });
  expect(picked[6]?.problem).toBeUndefined();
});

test("targets: a line without one when others have one is incomplete; without any column the sheet's target applies", () => {
  const some = resolvePaste(parsePaste("HK-0001\t채용팀\nHK-0002"), { employees, units, kind: "TRANSFER", sheet: {}, picks: {} });
  expect(some.map((r) => r.problem)).toEqual([undefined, "targetMissing"]);
  const none = resolvePaste(parsePaste("HK-0001\nHK-0002"), { employees, units, kind: "TRANSFER", sheet: { unitId: "u-rec" }, picks: {} });
  expect(none.map((r) => [r.unitId, r.hint])).toEqual([["u-rec", undefined], ["u-rec", "sameUnit"]]);
  const unknown = resolvePaste(parsePaste("HK-0001\t없는팀"), { employees, units, kind: "TRANSFER", sheet: {}, picks: {} });
  expect(unknown[0]?.problem).toBe("unitNotFound");
  // Before the type is chosen, only the employee is matched.
  expect(resolvePaste(parsePaste("HK-0001\t없는팀"), { employees, units, kind: null, sheet: {}, picks: {} })[0]).toMatchObject({ employee: { id: "e1" } });
});

test("a promotion reads the second column as the position, and groups by it", () => {
  const rows = resolvePaste(parsePaste("HK-0001\t대리\nHK-0002\t과장\nHK-0003\t대리\nHK-0004\t대리"), { employees, units, kind: "PROMOTE", sheet: {}, picks: {} });
  expect(rows.map((r) => r.hint)).toEqual([undefined, undefined, "onLeave", undefined]);
  expect(resolvePaste(parsePaste("HK-0001\t사원"), { employees, units, kind: "PROMOTE", sheet: {}, picks: {} })[0]?.hint).toBe("samePosition");
  expect(groupRows(rows, "PROMOTE", {}).map((g) => [g.target, g.rows.map((r) => r.key)])).toEqual([["대리", ["1", "3"]], ["과장", ["2"]]]);
});

test("groups hold only lines that can be sent; errors sort first, then hints", () => {
  const rows = resolvePaste(parsePaste("HK-0001\t채용팀\nHK-9999\t채용팀\nHK-0003\t인사부\nHK-0002\t인사부"), { employees, units, kind: "TRANSFER", sheet: {}, picks: {} });
  expect(groupRows(rows, "TRANSFER", {}).map((g) => [g.target, g.rows.map((r) => r.number)])).toEqual([["u-rec", ["HK-0001"]], ["u-hr", ["HK-0003", "HK-0002"]]]);
  expect(errorsFirst(rows).map((r) => r.number)).toEqual(["HK-9999", "HK-0003", "HK-0001", "HK-0002"]);
});

test("date presets resolve from today; a date today or earlier is in effect at once, a later one is scheduled", () => {
  expect(nextMonthFirst("2026-10-02")).toBe("2026-11-01");
  expect(nextMonthFirst("2026-12-31")).toBe("2027-01-01");
  expect(monthEnd("2026-10-02")).toBe("2026-10-31");
  expect(monthEnd("2028-02-10")).toBe("2028-02-29");
  expect(whenOf("", "2026-10-02")).toBe("none");
  expect(whenOf("2026-09-30", "2026-10-02")).toBe("past");
  expect(whenOf("2026-10-02", "2026-10-02")).toBe("today");
  expect(whenOf("2026-11-01", "2026-10-02")).toBe("future");
});

test("a selection is re-read: current status and unit decide the hints, and a person no longer listed stops the commit", () => {
  const picked = new Map([["e1", "김일번"], ["e3", "박삼번"], ["gone", "최퇴사"]]);
  const rows = selectionRows(picked, employees, "TRANSFER", { unitId: "u-hr" });
  expect(rows.map((r) => [r.key, r.employee?.id, r.hint, r.problem, r.pastedName])).toEqual([
    ["e1", "e1", "sameUnit", undefined, "김일번"],
    ["e3", "e3", "onLeave", undefined, "박삼번"],
    ["gone", undefined, undefined, "notFound", "최퇴사"],
  ]);
  expect(groupRows(rows, "TRANSFER", { unitId: "u-hr" }).map((g) => g.rows.map((r) => r.key))).toEqual([["e1", "e3"]]);
});

// Edges the mutation run found unpinned (npm run mutants).
test("only the first line can be a header; a repeat naming someone else is a conflict even with the same target", () => {
  expect(parsePaste("HK-0001\t채용팀\n김사번\t채용팀").map((l) => l.number)).toEqual(["HK-0001", "김사번"]);
  expect(parsePaste("HK-0001\t채용팀\t김일번\nHK-0001\t채용팀\t김이번")[0]?.issue).toBe("conflict");
  expect(parsePaste("HK-0001\t채용팀\t김일번\nHK-0001\t채용팀")[0]?.issue).toBeUndefined();
});

test("hints: leave and exit first, then a no-op for the chosen kind only", () => {
  const e = employees[0]!;
  expect(hintFor({ ...e, status: "EXITED" }, "TRANSFER", "u-rec")).toBe("exited");
  expect(hintFor(e, "TRANSFER", "u-hr")).toBe("sameUnit");
  expect(hintFor(e, "TRANSFER", undefined)).toBeUndefined();
  expect(hintFor(e, "PROMOTE", "u-hr")).toBeUndefined();
  expect(hintFor(e, "TRANSFER", undefined, "사원")).toBeUndefined();
  expect(hintFor(e, "PROMOTE", undefined, " 사 원 ")).toBe("samePosition");
  expect(hintFor({ ...e, position: null }, "PROMOTE", undefined, "사원")).toBeUndefined();
  expect(hintFor(e, "PROMOTE", undefined, undefined)).toBeUndefined();
});

test("rows carry the paste's own facts; numberless records never match; a refused line keeps its reason", () => {
  const staff = [...employees, emp({ id: "x", employee_number: null, name: "무번호" })];
  const [row] = resolvePaste(parsePaste("HK-0001"), { employees: staff, units, kind: null, sheet: {}, picks: {} });
  expect(row).toEqual({ key: "1", line: 1, number: "HK-0001", pastedName: undefined, merged: [], target: "", employee: employees[0] });
  const over = parsePaste("HK-0001").map((l) => ({ ...l, issue: "overLimit" as const }));
  expect(resolvePaste(over, { employees, units, kind: "TRANSFER", sheet: {}, picks: {} })[0]?.problem).toBe("overLimit");
  expect(selectionRows(new Map([["e1", ""]]), employees, null, {})[0]).toMatchObject({ merged: [], pastedName: undefined });
});

test("a promotion with the sheet's position groups by it trimmed; a row with no target or employee is left out", () => {
  const rows = resolvePaste(parsePaste("HK-0001\nHK-0002"), { employees, units, kind: "PROMOTE", sheet: { position: " 대리 " }, picks: {} });
  expect(groupRows(rows, "PROMOTE", { position: " 대리 " }).map((g) => [g.target, g.rows.length])).toEqual([["대리", 2]]);
  expect(groupRows(rows, "PROMOTE", {})).toEqual([]);
  expect(groupRows([{ key: "k", merged: [], target: "대리" }], "PROMOTE", {})).toEqual([]);
  expect([whenOf("x2026-10-02", "2026-10-02"), whenOf("2026-10-02x", "2026-10-02")]).toEqual(["none", "none"]);
});
