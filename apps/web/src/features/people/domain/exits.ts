// Exit cases: which step a user can take, where the case stands, and what a recorded step looks like.
import type { components } from "@console/api/schema";
import { addDays, isDate } from "../../../ui/date/days";

type Case = components["schemas"]["EmployeeExitCase"];
type Status = Case["status"];
type Key = components["schemas"]["ExitCaseNextAction"]["key"];
type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
/** The grants the exit steps need (a subset of reference/authz's Feature). */
type Grant = "exit_case_report" | "exit_case_hr_confirm" | "exit_case_hq_confirm" | "exit_settlement_manage";

/** Which grant each server-offered next action needs (advisory: the server re-checks capability, state and actor). */
const NEEDS: Record<Key, Grant[]> = {
  confirm_exit: ["exit_case_hr_confirm"],
  confirm_exit_hq: ["exit_case_hq_confirm"],
  prepare_settlement: ["exit_settlement_manage"],
  cancel_exit: ["exit_case_hr_confirm", "exit_case_report"],
  reject_exit: ["exit_case_hr_confirm", "exit_case_hq_confirm"],
};
/**
 * The case's next actions (from the server's state machine) that this user holds a grant for. A
 * scheduled exit that failed to apply left the employee employed: confirming or settling it would
 * record an exit that never happened, so only rejecting (then reporting again) is offered.
 */
export const usableActions = (c: Case, can: (f: Grant) => boolean) =>
  c.next_actions
    .map((a) => a.key)
    .filter((k) => NEEDS[k].some(can) && (c.exit_event_state !== "APPLY_FAILED" || k === "reject_exit"));

/** Steps that move the case on; the rest (reject, cancel) close it. */
export const FORWARD_KEYS = ["confirm_exit", "confirm_exit_hq", "prepare_settlement"] as const satisfies readonly Key[];
export type ForwardKey = (typeof FORWARD_KEYS)[number];
export type BackKey = Exclude<Key, ForwardKey>;
export const isForward = (k: Key): k is ForwardKey => (FORWARD_KEYS as readonly Key[]).includes(k);

/** The server's next forward step on the case, whoever takes it (null once closed or submitted). */
export const forwardStep = (c: Case): ForwardKey | null => c.next_actions.map((a) => a.key).find(isForward) ?? null;

/** The acknowledgements HR confirmation records on the exit; the server refuses it unless all four are given. */
export const EXIT_ACKS = ["korean_labor_law_ack", "payroll_cutoff_ack", "retirement_settlement_ack", "privacy_notice_ack"] as const;

/** The case's road, in order; REJECTED and CANCELLED leave it. */
export const EXIT_STEPS = ["REPORTED", "HR_CONFIRMED", "HQ_CONFIRMED", "SETTLEMENT_READY", "APPROVAL_DRAFTED", "SUBMITTED"] as const satisfies readonly Status[];
export type StepState = "done" | "current" | "waiting" | "failed";
export const isClosed = (c: Case) => c.status === "REJECTED" || c.status === "CANCELLED";

/** What the record shows of a step that happened on a case closed before the end of the road. */
const reached = (c: Case, step: (typeof EXIT_STEPS)[number]) => {
  const pkg = c.settlement_package?.status;
  switch (step) {
    case "REPORTED": return true;
    case "HR_CONFIRMED": return Boolean(c.hr_confirmed_at);
    case "HQ_CONFIRMED": return Boolean(c.hq_confirmed_at);
    case "SETTLEMENT_READY": return pkg !== undefined && pkg !== "NEEDS_SOURCE";
    case "APPROVAL_DRAFTED": return pkg === "APPROVAL_DRAFTED" || pkg === "SUBMITTED";
    case "SUBMITTED": return Boolean(c.approval_submitted_at);
  }
};

/**
 * Each step's state for the case axis. An open case: steps up to its status are done, the next is current,
 * the rest wait; an HR confirmation whose scheduled exit failed to apply is the failed step. A closed case
 * lists only the steps it reached (its close step follows them).
 */
export function stepStates(c: Case): { step: (typeof EXIT_STEPS)[number]; state: StepState }[] {
  if (isClosed(c)) return EXIT_STEPS.filter((s) => reached(c, s)).map((step) => ({ step, state: "done" }));
  const at = EXIT_STEPS.indexOf(c.status as (typeof EXIT_STEPS)[number]);
  return EXIT_STEPS.map((step, i) => ({
    step,
    state: step === "HR_CONFIRMED" && c.exit_event_state === "APPLY_FAILED" ? "failed" : i <= at ? "done" : i === at + 1 ? "current" : "waiting",
  }));
}

/** Who recorded a step and when (a closed case: who closed it). */
export type Effect = { by?: string; name: string | null; at?: string };
/**
 * Whether the case shows `key`'s outcome already, and whose: used after a lost response or a 409 to tell
 * "my click was recorded" from "someone else did it". `submit` is the settlement submission. Saving a
 * settlement draft has no single outcome to look for (re-saving is allowed), so it is never checked.
 */
export function effectOf(key: Key | "submit", c: Case): Effect | null {
  switch (key) {
    case "confirm_exit": return c.hr_confirmed_at ? { by: c.hr_confirmed_by, name: c.hr_confirmed_by_name, at: c.hr_confirmed_at } : null;
    case "confirm_exit_hq": return c.hq_confirmed_at ? { by: c.hq_confirmed_by, name: c.hq_confirmed_by_name, at: c.hq_confirmed_at } : null;
    case "reject_exit":
    case "cancel_exit": return c.closed_at ? { by: c.closed_by, name: c.closed_by_name, at: c.closed_at } : null;
    case "submit": return c.approval_submitted_at ? { by: c.approval_submitted_by, name: c.approval_submitted_by_name, at: c.approval_submitted_at } : null;
    case "prepare_settlement": return null;
  }
}

/**
 * Scheduled records an exit on `exitDate` would leave with nobody to apply to: the server refuses the HR
 * confirmation until they are withdrawn (lifecycle_schedule_conflict). Shown before the statements are
 * ticked; the server's refusal stays the referee. A scheduled exit itself is this case's own record.
 */
export const blockingSchedules = (events: readonly LifecycleEvent[], exitDate: string) =>
  events.filter((x) => x.state === "SCHEDULED" && x.event_type !== "TERMINATE" && x.effective_date > exitDate);


export type ProtectedPeriod = Case["protected_periods"][number];
export type NoticeDraft = { reason_text: string; served_on: string; method: string; evidence_ref: string };
export const EMPTY_NOTICE: NoticeDraft = { reason_text: "", served_on: "", method: "", evidence_ref: "" };
/** Advisory completeness only; the server checks legal applicability and the delivery evidence again. */
export function noticeMissing(draft: NoticeDraft, lastWorkingDay: string): (keyof NoticeDraft)[] {
  return (["reason_text", "served_on", "method", "evidence_ref"] as const).filter((key) =>
    !draft[key].trim() || (key === "served_on" && (!isDate(draft.served_on) || draft.served_on > addDays(lastWorkingDay, 1))));
}
/** Dates and citations belong to the server; this view never calculates protected periods. */
export const protectedLines = (c: Pick<Case, "protected_periods">): readonly ProtectedPeriod[] => c.protected_periods ?? [];
