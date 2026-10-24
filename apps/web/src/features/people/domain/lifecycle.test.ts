import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { correctable, byEffective, cancellable, isFuture, lanes, nextItems, tenure, unitByName, verbStates, voidable } from "./lifecycle";

type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
type Detail = components["schemas"]["EmployeeDetail"];
const event = (x: Partial<LifecycleEvent>): LifecycleEvent =>
  ({
    id: "e1",
    employee_id: "p1",
    event_type: "TRANSFER",
    to_status: "ACTIVE",
    state: "APPLIED",
    effective_date: "2026-10-15",
    comment: "사유",
    signoffs: {},
    created_by: "u1",
    created_by_name: "김인사",
    created_at: "2026-10-01T00:00:00Z",
    from_org_unit: "인사부",
    to_org_unit: "채용팀",
    ...x,
  }) as LifecycleEvent;
const allowed = (...types: string[]) => types.map((event_type) => ({ event_type, required_signoffs: [] })) as unknown as Detail["allowed_events"];
const detail = (x: Partial<Detail> & { status?: string; type?: string | null }): Detail =>
  ({
    employee: { id: "p1", name: "정하늘", status: x.status ?? "ACTIVE", next_event: null, failed_event: null },
    employment: x.type === null ? null : { employment_type: x.type ?? "REGULAR", currency: "KRW" },
    allowed_events: [],
    allowed_scheduled_events: [],
    schedule_after: null,
    ...x,
  }) as unknown as Detail;

test("only a scheduled non-exit action is withdrawn here (a scheduled exit goes through its exit case)", () => {
  expect(cancellable(event({ state: "SCHEDULED" }))).toBe(true);
  expect(cancellable(event({ state: "SCHEDULED", event_type: "TERMINATE" }))).toBe(false);
  expect(cancellable(event({ state: "APPLIED" }))).toBe(false);
});

test("history sorts by effective date: a back-dated record lands at its date, not when it was recorded", () => {
  const backDated = event({ id: "back", effective_date: "2026-09-01", created_at: "2026-10-02T00:00:00Z" });
  const promoted = event({ id: "promo", event_type: "PROMOTE", effective_date: "2026-09-20", created_at: "2026-09-20T00:00:00Z" });
  const sameDayLater = event({ id: "later", effective_date: "2026-09-20", created_at: "2026-09-21T00:00:00Z" });
  expect(byEffective([backDated, promoted, sameDayLater]).map((x) => x.id)).toEqual(["later", "promo", "back"]);
});

test("lanes: scheduled records above today, withdrawn ones only on request", () => {
  const items = [event({ id: "s", state: "SCHEDULED" }), event({ id: "a" }), event({ id: "c", state: "CANCELLED" }), event({ id: "f", state: "APPLY_FAILED" })];
  const hidden = lanes(items, false);
  expect(hidden.upcoming.map((x) => x.id)).toEqual(["s"]);
  expect(hidden.past.map((x) => x.id).sort()).toEqual(["a", "f"]);
  expect(hidden.cancelled).toBe(1);
  expect(lanes(items, true).past.map((x) => x.id).sort()).toEqual(["a", "c", "f"]);
});

test("only a date after today schedules; today or a malformed date applies now", () => {
  expect(isFuture("2026-10-03", "2026-10-02")).toBe(true);
  expect(isFuture("2026-10-02", "2026-10-02")).toBe(false);
  expect(isFuture("", "2026-10-02")).toBe(false);
});

test("verbs: the server lists decide what is enabled; relevant verbs it leaves out say why", () => {
  const on = verbStates(detail({ status: "ACTIVE", allowed_events: allowed("TRANSFER", "GROUP_TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE") }), []);
  expect(on.map((v) => [v.verb, v.enabled])).toEqual([["TRANSFER", true], ["GROUP_TRANSFER", true], ["PROMOTE", true], ["LEAVE_OF_ABSENCE", true]]);
  // On leave: 복직 replaces 휴직, and 전보·전적·승진 name the leave.
  const leave = verbStates(detail({ status: "ON_LEAVE", allowed_events: allowed("RETURN_FROM_LEAVE") }), []);
  expect(leave.map((v) => (v.enabled ? v.verb : `${v.verb}:${v.why.kind}`))).toEqual(["TRANSFER:onLeave", "GROUP_TRANSFER:onLeave", "PROMOTE:onLeave", "RETURN_FROM_LEAVE"]);
  // A contract shows 계약 갱신; a record without employment shows it disabled with why.
  expect(verbStates(detail({ type: "CONTRACT", allowed_events: allowed("CONTRACT_RENEWAL") }), []).at(-1)).toEqual({ verb: "CONTRACT_RENEWAL", enabled: true });
  expect(verbStates(detail({ type: null }), []).at(-1)).toEqual({ verb: "CONTRACT_RENEWAL", enabled: false, why: { kind: "noEmployment" } });
});

test("verbs: a scheduled exit is read from the history, not the nearest record; a listed verb is never overridden", () => {
  const events = [event({ id: "t", state: "SCHEDULED", effective_date: "2026-11-02" }), event({ id: "x", state: "SCHEDULED", event_type: "TERMINATE", effective_date: "2026-11-30" })];
  const states = verbStates(detail({ allowed_events: allowed("TRANSFER"), schedule_after: "2026-11-30" }), events);
  // 전보 is still offered before the exit date (the server listed it); 승진 is not, and the exit is why.
  expect(states[0]).toEqual({ verb: "TRANSFER", enabled: true, max: "2026-11-29", before: "2026-11-30" });
  expect(states[1]).toEqual({ verb: "GROUP_TRANSFER", enabled: false, why: { kind: "exitScheduled", date: "2026-12-01" } });
  expect(states[2]).toEqual({ verb: "PROMOTE", enabled: false, why: { kind: "exitScheduled", date: "2026-12-01" } });
});

test("verbs: offered only after the last scheduled record gets a lower bound; offered in both lists, no bound", () => {
  const events = [event({ state: "SCHEDULED", event_type: "LEAVE_OF_ABSENCE", effective_date: "2026-11-02" })];
  const states = verbStates(detail({ allowed_events: allowed("TRANSFER", "PROMOTE"), allowed_scheduled_events: allowed("RETURN_FROM_LEAVE", "PROMOTE"), schedule_after: "2026-11-02" }), events);
  expect(states).toEqual([
    { verb: "TRANSFER", enabled: true, max: "2026-11-01", before: "2026-11-02" },
    { verb: "GROUP_TRANSFER", enabled: false, why: { kind: "generic" } },
    { verb: "PROMOTE", enabled: true },
    { verb: "RETURN_FROM_LEAVE", enabled: true, min: "2026-11-03", after: "2026-11-02" },
  ]);
});

test("tenure in years and whole months; a future hire date has none", () => {
  expect(tenure("2021-03-02", "2026-10-02")).toEqual({ years: 5, months: 7 });
  expect(tenure("2021-03-03", "2026-10-02")).toEqual({ years: 5, months: 6 });
  expect(tenure("2026-10-02", "2026-10-02")).toEqual({ years: 0, months: 0 });
  expect(tenure("2026-10-03", "2026-10-02")).toBeNull();
});

test("next box: by date, the open return date last; the return date comes from the leave in effect", () => {
  const d = detail({ status: "ON_LEAVE", type: "CONTRACT" });
  d.employee.next_event = { id: "n", event_type: "RETURN_FROM_LEAVE", effective_date: "2026-12-01" };
  d.employment!.contract_end_date = "2026-11-01";
  const leave = event({ event_type: "LEAVE_OF_ABSENCE", expected_return_date: "2027-01-31" });
  expect(nextItems(d.employee, d.employment, [leave], "2026-10-02").map((i) => i.kind)).toEqual(["contract", "event", "return"]);
  expect(nextItems(d.employee, d.employment, [leave], "2026-10-02").at(-1)).toEqual({ kind: "return", date: "2027-01-31" });
  expect(nextItems(d.employee, d.employment, [], "2026-10-02").at(-1)).toEqual({ kind: "return", date: null });
  expect(nextItems(d.employee, d.employment, [], "2026-10-02")[0]).toEqual({ kind: "contract", date: "2026-11-01", days: 30 });
});

test("a record's unit is carried only when exactly one active unit has its name", () => {
  const units = [{ id: "a", name: "채용팀", status: "ACTIVE" }, { id: "b", name: "영업팀", status: "ACTIVE" }, { id: "c", name: "영업팀", status: "ACTIVE" }, { id: "d", name: "폐지팀", status: "DISSOLVED" }];
  expect(unitByName("채용팀", units)).toBe("a");
  expect(unitByName("영업팀", units)).toBeNull();
  expect(unitByName("폐지팀", units)).toBeNull();
  expect(unitByName(null, units)).toBeNull();
});

test("only the latest change in force can be corrected or rescinded, and never an exit, registration or rescission", () => {
  const onboard = event({ id: "a", event_type: "ONBOARD", created_at: "2026-01-01T00:00:00Z" });
  const transfer = event({ id: "b", created_at: "2026-02-01T00:00:00Z" });
  const promote = event({ id: "c", event_type: "PROMOTE", created_at: "2026-03-01T00:00:00Z" });
  const scheduled = event({ id: "d", state: "SCHEDULED", created_at: "2026-04-01T00:00:00Z" });
  const all = [onboard, transfer, promote, scheduled];
  expect(all.map((x) => voidable(x, all))).toEqual([false, false, true, false]);
  // Rescinding the promotion leaves the transfer as the latest change in force.
  const voided = { ...promote, voided_by: "r" };
  const rescind = event({ id: "r", event_type: "RESCIND", created_at: "2026-05-01T00:00:00Z", voids_event_id: "c" });
  const after = [onboard, transfer, voided, scheduled, rescind];
  expect(after.map((x) => voidable(x, after))).toEqual([false, true, false, false, false]);
  const exit = [transfer, event({ id: "t", event_type: "TERMINATE", created_at: "2026-06-01T00:00:00Z" })];
  expect(exit.map((x) => voidable(x, exit))).toEqual([false, false]);
});

test("a group transfer can be rescinded but never corrected", () => {
  const group = { id: "group", event_type: "GROUP_TRANSFER", state: "APPLIED", created_at: "2026-10-12T01:00:00Z" } as never;
  expect(voidable(group, [group])).toBe(true);
  expect(correctable(group, [group])).toBe(false);
});
