import { expect, test } from "vitest";
import { endsWithin, filterGrants } from "./grant-filter";

const TODAY = "2026-10-08";
const g = (name: string, role: string, end: string | null, no: string | null = null) => ({
  account_display_name: name,
  account_employee_number: no,
  role_id: role,
  role_name_ko: role === "r1" ? "인사 실무" : "인사 조회",
  valid_to: end,
});
const rows = [g("문지호", "r1", "2027-10-06T00:00:00+09:00", "10094"), g("정가람", "r2", "2026-11-01T00:00:00+09:00", "20067"), g("위서진", "r1", null)];

test("the find box matches name, 사번 and role; the role filter and the 30-day chip narrow it", () => {
  expect(filterGrants(rows, { q: "2006", role: null, ending: false }, TODAY).map((r) => r.account_display_name)).toEqual(["정가람"]);
  expect(filterGrants(rows, { q: "실무", role: null, ending: false }, TODAY)).toHaveLength(2);
  expect(filterGrants(rows, { q: "", role: "r1", ending: false }, TODAY)).toHaveLength(2);
  expect(filterGrants(rows, { q: "", role: null, ending: true }, TODAY).map((r) => r.account_display_name)).toEqual(["정가람"]);
});

test("a grant ends within the window by its last day; an open end never does", () => {
  expect(endsWithin({ valid_to: "2026-11-08T00:00:00+09:00" }, TODAY)).toBe(true); // last day 11-07, within 30 days
  expect(endsWithin({ valid_to: "2026-11-09T00:00:00+09:00" }, TODAY)).toBe(false); // last day 11-08 is day 31
  expect(endsWithin({ valid_to: null }, TODAY)).toBe(false);
});
