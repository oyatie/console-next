import { expect, test } from "vitest";
import { contractIssues, factValues, factsPatch, weeklyMinutes, type FactValues, type Facts } from "./facts";

const base: FactValues = { birth_date: null, work_email: "a@x.kr", id_type: null, base_pay_won: null, pay_unit: null, probation_end_date: "2026-12-31" };

test("facts recorded before classification stay visible and are the tested patch base", () => {
  const f: Facts = {
    employee_id: "e", hire_date: "2026-10-01", birth_date: null, work_email: null,
    id_type: null, employment: null, updated_at: "2026-10-01T00:00:00Z",
    pending_employment: {
      employment_type: null, worker_classification: null, base_pay_won: 3_000_000,
      pay_unit: "MONTHLY", probation_end_date: null, probation_confirmed_at: null,
      probation_state: "NONE", probation_days_left: null,
    },
  };
  expect(factValues(f)).toMatchObject({ base_pay_won: 3_000_000, pay_unit: "MONTHLY" });
  expect(factsPatch(factValues(f), factValues(f))).toEqual([]);
});

test("a facts patch tests each changed value as read, then writes it; pay and unit go together", () => {
  expect(factsPatch(base, base)).toEqual([]);
  expect(factsPatch(base, { ...base, birth_date: "1990-05-01" })).toEqual([
    { op: "test", path: "/birth_date", value: null },
    { op: "replace", path: "/birth_date", value: "1990-05-01" },
  ]);
  const pay = factsPatch(base, { ...base, base_pay_won: 3_000_000, pay_unit: "MONTHLY" });
  expect(pay.map((o) => `${o.op} ${o.path}`)).toEqual([
    "test /employment/base_pay_won",
    "replace /employment/base_pay_won",
    "test /employment/pay_unit",
    "replace /employment/pay_unit",
  ]);
  expect(factsPatch(base, { ...base, pay_unit: "HOURLY" })).toHaveLength(4);
});

test("a contract needs its kind's terms: a fixed term an end, a labour contract a wage above 0 and weekly hours", () => {
  const ok = { kind: "FIXED_TERM", start: "2026-10-01", end: "2027-09-30", wage: "3000000", unit: "MONTHLY", hours: "40" } as const;
  expect(contractIssues(ok)).toEqual({});
  expect(contractIssues({ ...ok, end: "" })).toEqual({ end: "required" });
  expect(contractIssues({ ...ok, end: "2026-09-01" })).toEqual({ end: "endBeforeStart" });
  expect(contractIssues({ ...ok, wage: "0" })).toEqual({ wage: "wagePositive" });
  expect(contractIssues({ ...ok, hours: "" })).toEqual({ hours: "required" });
  expect(contractIssues({ ...ok, hours: "200" })).toEqual({ hours: "hoursRange" });
  // A freelance service contract is not a labour contract: no weekly hours, and a fee of 0 is the server's call.
  expect(contractIssues({ ...ok, kind: "FREELANCE_SERVICE", end: "", wage: "0", hours: "" })).toEqual({});
  expect(contractIssues({ kind: null, start: "", end: "", wage: "", unit: null, hours: "" })).toEqual({ kind: "required", start: "required", wage: "required", unit: "required" });
});

test("weekly hours become minutes", () => {
  expect(weeklyMinutes("40")).toBe(2400);
  expect(weeklyMinutes("37.5")).toBe(2250);
  expect(weeklyMinutes("0")).toBeNull();
  expect(weeklyMinutes("")).toBeNull();
});
