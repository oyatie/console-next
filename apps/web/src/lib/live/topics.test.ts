import { expect, test } from "vitest";
import { matchChange, matchRecord, TOPICS } from "./topics";

const detail = (id: string) => ({ path: { id } });

test.each(["employee", "change_request", "exit_case"])("a %s change refreshes import records and rollback dependency previews", (topic) => {
  const matches = matchChange(topic, "changed-record");
  expect(matches("/api/v1/employee-import-runs", null)).toBe(true);
  expect(matches("/api/v1/employee-import-runs/{run_id}", { path: { run_id: "run" } })).toBe(true);
  expect(matches("/api/v1/employee-import-runs/{run_id}/rollback/preview", { path: { run_id: "run" } })).toBe(true);
});

test.each(["org_change", "period_lock", "legal_entity", "business_registration", "workplace", "org_unit", "entity_setup_batch", "employee", "exit_case", "change_request", "import_run", "user", "role", "tenant", "me"])("%s changes re-read the unified inbox for every filter and cursor page", (type) => {
  for (const id of ["changed-record", null]) {
    const matches = matchChange(type, id);
    expect(matches("/api/v1/me/action-inbox", { query: { lane: "turn" } })).toBe(true);
    expect(matches("/api/v1/me/action-inbox", { query: { lane: "waiting", cursor: "next-page" } })).toBe(true);
  }

});

test("a change to one employee re-reads that employee and the lists, not another employee or other modules", () => {
  const m = matchChange("employee", "e1");
  expect(m("/api/v1/employees", { query: { limit: 100 } })).toBe(true);
  expect(m("/api/v1/employees/{id}", detail("e1"))).toBe(true);
  expect(m("/api/v1/employees/{id}/lifecycle-events", detail("e1"))).toBe(true);
  expect(m("/api/v1/employees/{id}", detail("e2"))).toBe(false);
  expect(m("/api/v1/directory/people", null)).toBe(true);
  expect(m("/api/v1/statutory/insurance-filings", null)).toBe(true);
  expect(m("/api/v1/statutory/worker-register", null)).toBe(true);
  expect(m("/api/v1/me/action-inbox", null)).toBe(true);
  expect(m("/api/v1/org-units/{id}", detail("u1"))).toBe(true); // a unit's members include the employee
  // A person placed at a 사업장 decides its end options (delete while unused, close once used: UX-R2 ENDS).
  expect(m("/api/v1/workplaces/{workplaceId}/end-options", { path: { workplaceId: "w1" } })).toBe(true);
  expect(m("/api/v1/org-changes", null)).toBe(false);
  expect(m("/api/v1/employees-import", null)).toBe(false);
});

test("a coalesced frame (id null) re-reads every record of its topic", () => {
  const m = matchChange("employee", null);
  expect(m("/api/v1/employees/{id}", detail("e1"))).toBe(true);
  expect(m("/api/v1/employees/{id}", detail("e2"))).toBe(true);
});

test("an unmapped topic, and `me` (a changed grant), re-read everything shown rather than leave it stale", () => {
  for (const type of ["me", "some_future_topic"]) {
    const m = matchChange(type, "x");
    expect(m("/api/v1/me/authz", null)).toBe(true);
    expect(m("/api/v1/period-locks", null)).toBe(true);
  }
});

test("every type the BE-RT contract emits has an entry", () => {
  const contract = ["tenant", "legal_entity", "business_registration", "workplace", "org_unit", "org_change", "entity_setup_batch", "employee", "exit_case", "change_request", "import_run", "user", "role"];
  for (const type of contract) expect(TOPICS[type], type).toBeDefined();
});

test("a tenant change (go-live) re-reads every screen; a role change re-reads grants, not employee records", () => {
  expect(matchChange("tenant", "t1")("/api/v1/employees/{id}", detail("e1"))).toBe(true);
  const role = matchChange("role", "r1");
  expect(role("/api/v1/me/authz", null)).toBe(true);
  expect(role("/api/v1/employees/{id}", detail("e1"))).toBe(false);
});

test("record matching: only that record's own reads, and none for a list-only topic or a coalesced frame", () => {
  const r = matchRecord("org_change", "c1")!;
  expect(r("/api/v1/org-changes/{id}", detail("c1"))).toBe(true);
  expect(r("/api/v1/org-changes/{id}", detail("c2"))).toBe(false);
  expect(r("/api/v1/org-changes", null)).toBe(false);
  expect(matchRecord("import_run", "r1")).toBeNull();
  expect(matchRecord("employee", null)).toBeNull();
});

test("a 근무 일정 change re-reads every 근태 read and nothing outside it", () => {
  const m = matchChange("attendance_schedule", null);
  expect(m("/api/v1/attendance/schedule/calendar", { query: { scope_kind: "WORKPLACE" } })).toBe(true);
  expect(m("/api/v1/attendance/patterns", null)).toBe(true);
  expect(m("/api/v1/employees", null)).toBe(false);
  expect(TOPICS.attendance_schedule?.detail).toBeUndefined();
});

test("an unlock, its decision or a re-lock re-reads the lock list and the attendance months it opens or closes", () => {
  const m = matchChange("period_lock", "l1");
  expect(m("/api/v1/period-locks", { query: { active: true, limit: 200 } })).toBe(true);
  expect(m("/api/v1/attendance/month", { query: { month: "2026-09" } })).toBe(true);
  expect(m("/api/v1/attendance/days", { query: { date: "2026-09-30" } })).toBe(true);
  expect(m("/api/v1/attendance/people/{employee_id}/month", { path: { employee_id: "e" } })).toBe(true);
  expect(m("/api/v1/attendance/schedule/calendar", null)).toBe(false);
  expect(m("/api/v1/org-changes", null)).toBe(false);
  expect(m("/api/v1/employees", null)).toBe(false);
});

test("role and account changes invalidate the setup census and permission rail", () => {
  for (const type of ["role", "user"]) {
    expect(matchChange(type, null)("/api/v1/onboarding/checklist", null)).toBe(true);
    expect(matchChange(type, null)("/api/v1/onboarding/go-live/preview", null)).toBe(true);
  }
});

test("a person-day change re-reads the grid, the day board and the person cards, not the schedule", () => {
  const m = matchChange("attendance_day", null);
  expect(m("/api/v1/attendance/month", { query: { month: "2026-10" } })).toBe(true);
  expect(m("/api/v1/attendance/days", { query: { date: "2026-10-06" } })).toBe(true);
  expect(m("/api/v1/attendance/people/{employee_id}/month", { path: { employee_id: "e" } })).toBe(true);
  expect(m("/api/v1/attendance/schedule/calendar", null)).toBe(false);
});

test("a reorder or rename of a 법인, 사업장 or 부서 re-reads 근태's scope tree and day board, not its patterns", () => {
  for (const type of ["legal_entity", "workplace", "org_unit"]) {
    const m = matchChange(type, null);
    expect(m("/api/v1/attendance/schedule/tree", null), type).toBe(true);
    expect(m("/api/v1/attendance/days", null), type).toBe(true);
    expect(m("/api/v1/attendance/patterns", null), type).toBe(false);
  }
});


test("recovery events re-read the vendor panel and tenant card only", () => {
  const m = matchChange("ops_recovery", "r1");
  expect(m("/api/platform/orgs/{id}/ops-recovery", detail("o1"))).toBe(true);
  expect(m("/api/v1/tenant/ops-recovery", null)).toBe(true);
  expect(m("/api/v1/employees", null)).toBe(false);
});

 test("the account inbox hint invalidates only the queue", () => {
  const match = matchChange("inbox", null);
  expect(match("/api/v1/me/action-inbox", null)).toBe(true);
  expect(match("/api/v1/employees", null)).toBe(false);
});

 test("identifier correction requests, decisions and reviews refresh the inbox and their case only", () => {
  expect(TOPICS.identifier_correction).toBeDefined();
  const matches = matchChange("identifier_correction", "case");
  expect(matches("/api/v1/me/action-inbox", null)).toBe(true);
  expect(matches("/api/v1/entity-identifier-corrections", null)).toBe(true);
  expect(matches("/api/v1/entity-identifier-corrections/{id}", detail("case"))).toBe(true);
  expect(matches("/api/v1/entity-identifier-corrections/{id}", detail("other"))).toBe(false);
  expect(matches("/api/v1/employees", null)).toBe(false);
});

test.each(["org_unit", "org_change"])("%s refreshes each open unit's scheduled timeline", (topic) => {
  const matches = matchChange(topic, "unit");
  expect(matches("/api/v1/org-changes", { query: { target_ref: "unit", status: ["APPROVED"] } })).toBe(true);
});

test.each(["legal_entity", "workplace", "entity_setup_batch"])("%s refreshes registration rows in open organization history", (topic) => {
  expect(matchChange(topic, "record")("/api/v1/entity-setup/batches", null)).toBe(true);
});
