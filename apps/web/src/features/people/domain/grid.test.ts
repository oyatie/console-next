import { expect, test } from "vitest";
import { GRID_FIELDS, parseTsv, readCell, refusedCells, rowState, shownText } from "./grid";

const f = (k: string) => GRID_FIELDS.find((x) => x.key === k)!;
const SEX = { MALE: "남", FEMALE: "여" };

test("a typed cell reads as a value, a keep, or why it is not one", () => {
  expect(readCell(f("sex"), "여", SEX)).toEqual({ send: "FEMALE" });
  expect(readCell(f("sex"), "M?", SEX)).toEqual({ bad: "choice", suggest: undefined });
  expect(readCell(f("job"), "  ", SEX)).toEqual({ keep: true });
  expect(readCell(f("job"), "∅", SEX)).toEqual({ send: null });
  expect(readCell(f("hire_date"), "2026.10.12", SEX)).toEqual({ send: "2026-10-12" });
  expect(readCell(f("hire_date"), "2026-13-01", SEX)).toEqual({ bad: "date" });
  expect(readCell(f("employment_type"), "계약", { REGULAR: "정규직", CONTRACT: "계약직" })).toEqual({ bad: "choice", suggest: "계약직" });
  expect(readCell(f("address"), "경기 평택시 고덕동 31", SEX)).toEqual({ send: { source: "MANUAL_UNVERIFIED", road_addr_part1: "경기 평택시 고덕동 31", si_nm: "경기", sgg_nm: "평택시" } });
  expect(readCell(f("address"), "고덕동 31", SEX)).toEqual({ bad: "address" });
});

test("a spreadsheet copy splits into rows and cells; a row counts its changes and errors", () => {
  expect(parseTsv("a\tb\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
  expect(rowState([{ send: "FEMALE" }, { keep: true }, { bad: "date" }], ["남", "x", ""], ["여", "", "2026-13-01"])).toEqual({ changed: 1, errors: 1 });
});

test("a quoted spreadsheet cell keeps embedded tabs, newlines and commas", () => {
  expect(parseTsv('"HR\tlead"\t"two\r\nlines"\r\n"HR, payroll"\t"a ""quote"""\r\n')).toEqual([
    ["HR\tlead", "two\r\nlines"], ["HR, payroll", 'a "quote"'],
  ]);
  expect(parseTsv("HR, payroll")).toEqual([["HR, payroll"]]);
});

test.each(["\n", "\r\n"])("an unclosed quote stays literal and keeps following rows (%j)", (newline) => {
  expect(parseTsv(`001\t"인사부\t김${newline}002\t재무팀\t이${newline}003\t영업팀\t박`)).toEqual([
    ["001", '"인사부', "김"], ["002", "재무팀", "이"], ["003", "영업팀", "박"],
  ]);
});

test.each(['"A" 팀', '인사 "A" 팀', '"A""B" 팀'])("quotes inside a literal cell survive: %s", (value) => {
  expect(parseTsv(`001\t${value}\t김`)).toEqual([["001", value, "김"]]);
});

test("an Excel-quoted cell decodes escaped quotes, tabs and newlines together", () => {
  expect(parseTsv('001\t"""A"" 팀\t인사\n담당"\t김\r\n002\t재무팀\t이')).toEqual([
    ["001", '"A" 팀\t인사\n담당', "김"], ["002", "재무팀", "이"],
  ]);
});

test("the check's values read as the grid shows them", () => {
  expect(shownText(f("address"), JSON.stringify({ road_addr_part1: "경기 평택시 고덕동 31", zip_no: null }), SEX)).toBe("경기 평택시 고덕동 31");
  expect(shownText(f("sex"), "FEMALE", SEX)).toBe(SEX.FEMALE);
  expect(shownText(f("address"), "not json", SEX)).toBe("not json");
});

test("cells the server refused are kept per person and field; a refusal of the whole row names no cell", () => {
  const p = { rows: [
    { employee_id: "a", outcome: "REFUSED", code: "employee_number_in_use", refusals: [{ field: "employee_number", code: "employee_number_in_use", message: "" }, { field: "address", code: "address_invalid", message: "" }], fields: [] },
    { employee_id: "b", outcome: "REFUSED", code: "stale_record", refusals: [{ field: null, code: "stale_record", message: "" }], fields: [] },
    { employee_id: "c", outcome: "CHANGE", fields: [] },
  ] } as never;
  expect(refusedCells(p)).toEqual({ a: { employee_number: "employee_number_in_use", address: "address_invalid" }, b: {} });
});
