import { describe, expect, it, test } from "vitest";
import type { ImportSheet } from "./contract";
import { draftOf, draftProblem, mappingJson, rereadsSkipped, sheetMapping, sheetsToMap, withHeaderRow, withTarget } from "./mapping";
import type { ReviewItem } from "./contract";
import { filterQueue, heldAnswer, placeOf, resolveKind } from "./review";
import { initialPicks, withChoice } from "./steps";

const unread: ImportSheet = {
  name: "명부",
  status: "needs_mapping",
  rows: 40,
  header_candidates: [
    { row: 3, cells: [{ column: "A", label: "직원번호" }, { column: "B", label: "이름" }, { column: "C", label: "팀" }] },
    { row: 1, cells: [{ column: "A", label: "2026년 인사 명부" }] },
  ],
};
const read: ImportSheet = {
  name: "본사",
  status: "mapped",
  rows: 12,
  header_row: 2,
  columns: [{ column: "A", label: "사번", target: "employee_number", source: "catalog" }, { column: "B", label: "성명", target: "name", source: "remembered" }],
  header_candidates: [{ row: 4, cells: [{ column: "A", label: "x" }] }],
};

describe("sheet mapping", () => {
  it("starts an unread sheet at its likeliest header row with nothing mapped, and a read sheet as read", () => {
    expect(draftOf(unread)).toEqual({ header_row: 3, skip: false, columns: [{ column: "A", label: "직원번호", target: null }, { column: "B", label: "이름", target: null }, { column: "C", label: "팀", target: null }] });
    expect(draftOf(read).columns.map((c) => c.target)).toEqual(["employee_number", "name"]);
  });

  it("needs a header row and a name column, and no field twice; a skipped sheet needs nothing", () => {
    let d = draftOf(unread);
    expect(draftProblem({ ...d, header_row: null })).toBe("header");
    expect(draftProblem(d)).toBe("name");
    d = withTarget(withTarget(d, "B", "name"), "A", "employee_number");
    expect(draftProblem(d)).toBeNull();
    expect(draftProblem(withTarget(d, "C", "name"))).toBe("duplicate");
    expect(draftProblem({ ...d, header_row: null, skip: true })).toBeNull();
  });

  it("moving the header row starts its columns over from that row's labels", () => {
    const d = withHeaderRow(unread, withTarget(draftOf(unread), "B", "name"), 1);
    expect(d.columns).toEqual([{ column: "A", label: "2026년 인사 명부", target: null }]);
  });

  it("sends every column of an edited sheet (null: not imported), or skip; nothing when no sheet was edited", () => {
    const d = withTarget(withTarget(draftOf(unread), "B", "name"), "A", "employee_number");
    expect(sheetMapping(d)).toEqual({ header_row: 3, columns: { A: "employee_number", B: "name", C: null } });
    expect(sheetMapping({ ...d, skip: true })).toEqual({ skip: true });
    expect(mappingJson({})).toBeUndefined();
    expect(JSON.parse(mappingJson({ 명부: { skip: true } })!)).toEqual({ sheets: { 명부: { skip: true } } });
    expect(sheetsToMap([unread, read]).map((s) => s.name)).toEqual(["명부"]);
  });
});

const item = (over: Partial<ReviewItem>): ReviewItem => ({ id: "i", reason: "status_unmapped", blocking: true, sheet: "명부", rows: 1, ...over });

describe("review queue", () => {
  it("offers the control each served resolution needs", () => {
    const r = (decision: NonNullable<ReviewItem["resolution"]>["decision"], choices: string[] = []) => item({ resolution: { decision, key: "k", choices } });
    expect([r("status_map", ["ACTIVE"]), r("leave_type_map"), r("identity", ["p1", "new"]), r("exclusions"), r("unit_map"), r("workplace_map"), r("employment_type_map"), r("employee_numbers"), r("mapping"), item({})].map(resolveKind))
      .toEqual(["choices", "choices", "identity", "exclude", "unit", "workplace", "type", "number", "mapping", "info"]);
  });

  it("names the cell, else the row; says what the screen holds; shows blocking items alone on request", () => {
    expect(placeOf(item({ cell: "B14", row: 14 }))).toEqual({ sheet: "명부", cell: "B14" });
    expect(placeOf(item({ row: 9 }))).toEqual({ sheet: "명부", cell: "9" });
    const i = item({ value: "휴직중", resolution: { decision: "status_map", key: "휴직중", choices: ["ACTIVE", "ON_LEAVE"] } });
    expect(heldAnswer(initialPicks(), i)).toBeNull();
    expect(heldAnswer(withChoice(initialPicks(), "status_map", "휴직중", "ON_LEAVE"), i)).toBe("ON_LEAVE");
    const list = [i, item({ id: "j", blocking: false })];
    expect(filterQueue(list, "blocking")).toEqual([i]);
    expect(filterQueue(list, "all")).toHaveLength(2);
  });
});

// regression (r3:hire-18): a sheet skipped by an earlier import had no header read, so un-ticking the skip left the
// save closed ("머리글 행을 고르십시오") and the sheet unimportable; it is now read again with `skip: false`.
test("un-skipping a sheet that was never read sends skip: false, and the draft needs no header first", () => {
  const skipped = { name: "퇴사자", status: "skipped", rows: 0 } as ImportSheet;
  const d = { ...draftOf(skipped), skip: false };
  expect(rereadsSkipped(skipped, d)).toBe(true);
  expect(sheetMapping(d)).toEqual({ skip: false });
  expect(sheetMapping({ ...d, skip: true })).toEqual({ skip: true });
  expect(rereadsSkipped({ ...skipped, status: "needs_mapping" }, d)).toBe(false);
});
