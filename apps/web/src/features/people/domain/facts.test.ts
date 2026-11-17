import { expect, test } from "vitest";
import { edit, isConflict, load, type Fields } from "../../../lib/pure/three-way";
import { contractIssues, factValues, factsPatch, rebaseFacts, weeklyMinutes, type FactKey, type FactValues, type Facts } from "./facts";

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

test("a birth date recorded meanwhile is taken as recorded, and the one entered is handed back to name it", () => {
  const read: Facts = { employee_id: "e", hire_date: null, birth_date: null, work_email: null, id_type: null, employment: null, updated_at: "2026-10-01T00:00:00Z" };
  const entered = { ...Object.fromEntries(Object.entries(factValues(read)).map(([k, v]) => [k, load(v)])), birth_date: edit(load(null), "1990-04-17") } as Fields<FactKey>;
  const { fields, typed } = rebaseFacts(entered, { ...read, birth_date: "••••-••-••", updated_at: "2026-10-02T00:00:00Z" });
  expect(typed).toBe("1990-04-17");
  expect(isConflict(fields.birth_date)).toBe(false);
  // Nothing is sent for it: a recorded birth date changes by correction, never by this form.
  const side = (s: "base" | "yours") => Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, x[s]])) as FactValues;
  expect(factsPatch(side("base"), side("yours"))).toEqual([]);
  // Any other field still asks which value to keep.
  const email = { ...entered, birth_date: load(null), work_email: edit(load(null), "a@x.kr") } as Fields<FactKey>;
  const other = rebaseFacts(email, { ...read, work_email: "b@x.kr", updated_at: "2026-10-02T00:00:00Z" });
  expect(other.typed).toBeNull();
  expect(isConflict(other.fields.work_email)).toBe(true);
});
