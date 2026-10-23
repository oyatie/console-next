import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { blockingSchedules, exitUndoVerb, noticeMissing, protectedLines, effectOf, forwardStep, stepStates, usableActions } from "./exits";

type Case = components["schemas"]["EmployeeExitCase"];
type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
const exitCase = (x: Partial<Case>) => ({ next_actions: [], exit_event_state: null, status: "REPORTED", ...x }) as unknown as Case;
const keys = (...k: string[]) => k.map((key) => ({ key })) as never;

test("a failed HR-confirmed exit offers only rejecting, never cancellation, HQ confirmation or settlement", () => {
  const all = () => true;
  const next = keys("confirm_exit_hq", "prepare_settlement", "reject_exit", "cancel_exit");
  expect(usableActions(exitCase({ status: "HR_CONFIRMED", next_actions: next, exit_event_state: "APPLY_FAILED" }), all)).toEqual(["reject_exit"]);
  expect(usableActions(exitCase({ status: "HR_CONFIRMED", next_actions: keys("confirm_exit_hq", "reject_exit"), exit_event_state: "APPLIED" }), all)).toEqual(["confirm_exit_hq", "reject_exit"]);
});

test("the forward step is the first step that moves the case on, whoever holds it", () => {
  expect(forwardStep(exitCase({ next_actions: keys("reject_exit", "confirm_exit_hq", "cancel_exit") }))).toBe("confirm_exit_hq");
  expect(forwardStep(exitCase({ next_actions: keys("reject_exit") }))).toBeNull();
});

test("an open case: done up to its status, the next step current, an exit that failed to apply marks HR confirmation", () => {
  const states = (c: Partial<Case>) => stepStates(exitCase(c)).map((s) => `${s.step}:${s.state}`);
  expect(states({ status: "HR_CONFIRMED" })).toEqual([
    "REPORTED:done", "HR_CONFIRMED:done", "HQ_CONFIRMED:current", "SETTLEMENT_READY:waiting", "APPROVAL_DRAFTED:waiting", "SUBMITTED:waiting",
  ]);
  expect(states({ status: "HR_CONFIRMED", exit_event_state: "APPLY_FAILED" })[1]).toBe("HR_CONFIRMED:failed");
  expect(states({ status: "SUBMITTED" }).every((s) => s.endsWith(":done"))).toBe(true);
});

test("a closed case lists only the steps it reached", () => {
  const c = exitCase({ status: "REJECTED", hr_confirmed_at: "2026-10-02T01:00:00Z", closed_at: "2026-10-03T01:00:00Z" });
  expect(stepStates(c).map((s) => s.step)).toEqual(["REPORTED", "HR_CONFIRMED"]);
});

test("a recorded step names who recorded it; a draft save is never looked up", () => {
  const c = exitCase({ hq_confirmed_at: "2026-10-02T01:00:00Z", hq_confirmed_by: "u2", hq_confirmed_by_name: "이임원" });
  expect(effectOf("confirm_exit_hq", c)).toEqual({ by: "u2", name: "이임원", at: "2026-10-02T01:00:00Z" });
  expect(effectOf("confirm_exit", c)).toBeNull();
  expect(effectOf("prepare_settlement", c)).toBeNull();
});

test("only scheduled non-exit records after the exit date block HR confirmation", () => {
  const ev = (id: string, x: Partial<LifecycleEvent>) => ({ id, state: "SCHEDULED", event_type: "TRANSFER", effective_date: "2026-12-01", ...x }) as LifecycleEvent;
  const events = [ev("after", {}), ev("before", { effective_date: "2026-11-01" }), ev("exit", { event_type: "TERMINATE" }), ev("done", { state: "APPLIED" })];
  expect(blockingSchedules(events, "2026-11-30").map((x) => x.id)).toEqual(["after"]);
});


test("notice evidence lists exactly the missing fields and refuses service after the statutory exit date", () => {
  const empty = { reason_text: " ", served_on: "", method: "", evidence_ref: "" };
  expect(noticeMissing(empty, "2026-04-30")).toEqual(["reason_text", "served_on", "method", "evidence_ref"]);
  const full = { reason_text: "해고 사유", served_on: "2026-05-01", method: "CERTIFIED_MAIL", evidence_ref: "receipt-1" };
  expect(noticeMissing(full, "2026-04-30")).toEqual([]);
  expect(noticeMissing({ ...full, served_on: "2026-05-02" }, "2026-04-30")).toEqual(["served_on"]);
  expect(noticeMissing({ ...full, evidence_ref: " " }, "2026-04-30")).toEqual(["evidence_ref"]);
});

test("protected lines preserve the server's dates and citation without recalculating a tail", () => {
  const p = { lifecycle_event_id: "leave-1", leave_type: "MATERNITY", leave_from: "2026-01-01", leave_until: "2026-03-31", protected_until: "2026-05-03", instrument: "근로기준법", article: "제23조제2항" };
  expect(protectedLines(exitCase({ protected_periods: [p] }))).toEqual([p]);
});
test.each([
  ["APPLIED", true, "revoke"], ["APPLIED", false, "revoke"],
  ["SCHEDULED", true, "cancel"], ["SCHEDULED", false, "cancel"],
  [null, true, "reject"], [null, false, "cancel"],
] as const)("exit undo in %s uses %s's defined meaning", (state, reject, expected) => {
  expect(exitUndoVerb({ exit_event_state: state, hr_confirmed_at: undefined }, reject)).toBe(expected);
});
