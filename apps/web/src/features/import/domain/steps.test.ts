import { describe, expect, it, test } from "vitest";
import type { ImportDryRun, ImportPreview, ImportRow } from "./contract";
import { answerOf, applyBlockers, filterRows, initialPicks, isAnsweredPattern, NEW_PERSON, NONE, picksPending, reasonsMissing, siteNoticeColumns, tally, withChoice, withGroupAnswer, withNumber, withRowAnswer, withValue } from "./steps";
import { workbookKind } from "./workbook";

const preview = (columns: ImportPreview["columns"]): ImportPreview => ({
  run_id: "r1",
  entity_type: "employee_hr",
  source_filename: "roster.xlsx",
  source_sha256: "a".repeat(64),
  input_rows: 3,
  candidate_rows: 3,
  preserved_rows: 0,
  columns,
  sample_rows: [],
  mapping_profile: {},
  sheets: [],
  sheets_needing_mapping: 0,
  available_targets: [],
  sealed_identities: 0,
});
const row = (over: Partial<ImportRow>): ImportRow => ({ source_key: `k${over.row ?? 2}`, sheet: "A", row: 2, name: "n", outcome: "insert", ...over });
const dry = (over: Partial<ImportDryRun> = {}): ImportDryRun => ({
  run_id: "r1",
  input_rows: 0,
  candidate_rows: 0,
  preserved_rows: 0,
  insert_candidates: 0,
  update_candidates: 0,
  unchanged_rows: 0,
  excluded_rows: 0,
  unsettled_rows: 0,
  companies: [],
  org_unit_bound_rows: 0,
  org_unit_unbound_rows: 0,
  unresolved_org_units: [],
  dry_run_digest: "f".repeat(64),
  decisions: {},
  rows: [],
  review: { count: 0, blocking: 0, items: [], groups: [] },
  remembered: [],
  auto_mapped: [],
  employment_type_empty_rows: 0,
  unplaced: { rows: 0, by_reason: {} },
  phone_unstored_rows: 0,
  ...over,
});

describe("preview", () => {
  it("names the columns the server read as a customer site", () => {
    const cols = [
      { source_header: "사업장", normalized_header: "사업장", target: "worksite_name", classification: "canonical", preview_allowed: true, notice: "customer_site_not_workplace" },
      { source_header: "성명", normalized_header: "성명", target: "name", classification: "canonical", preview_allowed: true },
    ] as ImportPreview["columns"];
    expect(siteNoticeColumns(preview(cols))).toEqual(["사업장"]);
  });
});

describe("dry run answers", () => {
  it("a served choice is typed as its decision needs: a person or new, a code, an id or none, a 사번", () => {
    let p = withChoice(initialPicks(), "identity", "k2", "p1");
    expect(p.identity).toEqual({ k2: { employee_id: "p1" } });
    p = withChoice(p, "identity", "k2", NEW_PERSON);
    expect(p.identity).toEqual({ k2: { employee_id: null } });
    expect(answerOf(p, "identity", "k2")).toBe(NEW_PERSON);
    p = withChoice(p, "status_map", "휴직중", "ON_LEAVE");
    p = withChoice(p, "leave_type_map", "", "OTHER");
    p = withChoice(p, "unit_map", "품질팀", NONE);
    p = withChoice(p, "employee_numbers", "k3", " E-77 ");
    expect(p.status_map).toEqual({ 휴직중: "ON_LEAVE" });
    expect(p.leave_type_map).toEqual({ "": "OTHER" });
    expect(p.unit_map).toEqual({ 품질팀: null });
    expect(answerOf(p, "unit_map", "품질팀")).toBe(NONE);
    expect(p.employee_numbers).toEqual({ k3: "E-77" });
    expect(withNumber(p, "k3", "  ").employee_numbers).toEqual({});
    expect(answerOf(p, "mapping", "x")).toBeNull();
  });

  it("an answer the last dry run did not carry blocks apply until the next one; the server's stored answers compare equal in any key order", () => {
    const picks = withValue(withValue(initialPicks(), "unit_map", "b", null), "workplace_map", "a", "w1");
    expect(applyBlockers(dry(), picks)).toMatchObject({ pending: true, any: true });
    const stored = dry({ decisions: { workplace_map: { a: "w1" }, unit_map: { b: null } } });
    expect(applyBlockers(stored, picks)).toMatchObject({ pending: false, any: false });
    expect(picksPending(stored, withValue(picks, "unit_map", "b", "u1"))).toBe(true);
  });

  it("answers the company's memory filled in are not answers waiting for a dry run", () => {
    const d = dry({ decisions: { unit_map: { 품질팀: null }, status_map: { 휴직중: "ON_LEAVE" } }, remembered: [{ decision: "unit_map", key: "품질팀" }] });
    expect(picksPending(d, withValue(initialPicks(), "status_map", "휴직중", "ON_LEAVE"))).toBe(false);
    expect(picksPending(d, initialPicks())).toBe(true);
  });

  it("the served queue's blocking items block apply; the rest never do", () => {
    expect(applyBlockers(dry({ review: { count: 3, blocking: 2, items: [], groups: [] } }), initialPicks())).toMatchObject({ rows: 2, any: true });
    expect(applyBlockers(dry({ review: { count: 3, blocking: 0, items: [], groups: [] } }), initialPicks())).toMatchObject({ rows: 0, any: false });
  });

  it("one answer per row: a person, a new person, or left out with a reason", () => {
    let p = withRowAnswer(initialPicks(), "k2", { employeeId: "p1" });
    expect(p.identity).toEqual({ k2: { employee_id: "p1" } });
    p = withRowAnswer(p, "k2", { exclude: { reason_code: "" } });
    expect(p.identity).toEqual({});
    expect(reasonsMissing(p, "OTHER")).toBe(1);
    p = withRowAnswer(p, "k2", { exclude: { reason_code: "OTHER" } });
    expect(reasonsMissing(p, "OTHER")).toBe(1);
    p = withRowAnswer(p, "k2", { exclude: { reason_code: "OTHER", note: "test row" } });
    expect(reasonsMissing(p, "OTHER")).toBe(0);
    expect(withRowAnswer(p, "k2", null)).toEqual(initialPicks());
  });
});

describe("rows", () => {
  const rows = [
    row({ row: 2 }),
    row({ row: 3, outcome: "refused", refusal_code: "invalid_date", refusal_field: "hire_date" }),
    row({ row: 4, outcome: "update", deferred: [{ field: "org_unit", route: "lifecycle_transfer" }] }),
    row({ row: 5, unit_name: "x" }),
    row({ row: 6, outcome: "unresolved_identity" }),
    row({ row: 7, new_person: { status: "ON_LEAVE", hire_date: "2020-01-01", migrated_former: false, employee_number: null } }),
  ];
  it("counts every outcome, zero included", () => {
    expect(tally(rows)).toEqual({ insert: 3, update: 1, unchanged: 0, excluded: 0, refused: 1, unresolved_identity: 1 });
  });
  it("attention holds rows to settle first, then deferred differences, unplaced values and 사번 미부여", () => {
    expect(filterRows(rows, "attention").map((r) => r.row)).toEqual([3, 6, 4, 5, 7]);
    expect(filterRows(rows, "insert").map((r) => r.row)).toEqual([2, 5, 7]);
    expect(filterRows(rows, "on_leave").map((r) => r.row)).toEqual([7]);
  });
});

describe("workbook bytes", () => {
  it("tells an .xlsx (zip), a protected file (OLE) and anything else apart", () => {
    expect(workbookKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBe("xlsx");
    expect(workbookKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("protected");
    expect(workbookKind(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]))).toBe("unreadable");
  });
});

// r3:hire-19: a conflict pattern is one answer, taken back the same way, and the dry run waits for it.
test("a group answer is kept once per pattern and taken back", () => {
  const p = withGroupAnswer(initialPicks(), "workplace_conflict", "follow_unit");
  expect(p.group_answers).toEqual({ workplace_conflict: "follow_unit" });
  expect(withGroupAnswer(p, "workplace_conflict", "follow_workplace").group_answers).toEqual({ workplace_conflict: "follow_workplace" });
  expect(withGroupAnswer(p, "workplace_conflict", null).group_answers).toEqual({});
  expect(isAnsweredPattern("status_conflict") && !isAnsweredPattern("invalid_date")).toBe(true);
});
