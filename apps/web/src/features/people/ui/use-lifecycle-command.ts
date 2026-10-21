import { useCommand } from "../../../lib/react/command";
import { get } from "../../../lib/query";
import { correctEvent, eventsQuery, recordLifecycleEvent, type LifecycleEvent, type LifecycleRequest } from "../api";
import { factsBody } from "../../../reference/group-transfer/domain/facts";
import type { Verb } from "../domain/lifecycle";
import type { Draft } from "./use-lifecycle-draft";

/** APPOINT with no role: the employee holds no role after (vacate_position_kind). */
export const VACATE = "vacate";
export const NO_ACKS = { korean_labor_law_ack: false, payroll_cutoff_ack: false, retirement_settlement_ack: false, privacy_notice_ack: false };

/** What the sheet knows beyond the typed draft: the version it read (BW-11 pin) and what it replaces or corrects. */
export type Context = {
  employeeId: string;
  kind: Verb;
  unitName?: string;
  /** The employee's lifecycle version when the sheet read it; a change since is refused (409 stale_record). */
  pin: number;
  /** The contract end the sheet showed (a renewal over a changed end is refused as stale). */
  contractEnd?: string | null;
  /** A reservation of the same kind and date this record replaces (BW-11: named, never silent). */
  replaces?: string;
  /** The applied record this one corrects: posted as its replacement, in one step. */
  corrects?: LifecycleEvent;
};

/** The request a draft records: only the fields its kind takes, with the pins and the replacement named. */
export function lifecycleBody(v: Draft, c: Context): LifecycleRequest {
  const { kind } = c;
  const body: LifecycleRequest = {
    event_type: kind,
    effective_date: v.date,
    comment: v.comment.trim(),
    signoffs: { ...NO_ACKS, ...v.acks },
    to_org_unit_id: kind === "TRANSFER" || kind === "GROUP_TRANSFER" ? v.unit : undefined,
    to_workplace_id: kind === "GROUP_TRANSFER" ? v.workplaceId : undefined,
    group_transfer: kind === "GROUP_TRANSFER" ? factsBody(v) : undefined,
    to_org_unit: kind === "TRANSFER" ? c.unitName : undefined,
    to_grade_id: kind === "PROMOTE" && v.gradeId ? v.gradeId : undefined,
    to_job_title_id: kind === "PROMOTE" && v.titleId ? v.titleId : undefined,
    to_position: kind === "PROMOTE" && !v.titleId && v.position.trim() ? v.position.trim() : undefined,
    reason_code: (kind === "TRANSFER" || kind === "PROMOTE") && v.reasonCode ? v.reasonCode : undefined,
    expected_return_date: kind === "LEAVE_OF_ABSENCE" && v.returnDate ? v.returnDate : undefined,
    contract_end_date: kind === "CONTRACT_RENEWAL" || (kind === "EMPLOYMENT_TYPE_CHANGE" && v.toType === "CONTRACT") ? v.endDate : undefined,
    to_position_kind_id: kind === "APPOINT" && v.roleId && v.roleId !== VACATE ? v.roleId : undefined,
    vacate_position_kind: kind === "APPOINT" && v.roleId === VACATE ? true : undefined,
    to_job_id: kind === "APPOINT" && v.jobId ? v.jobId : undefined,
    to_job_family_id: kind === "APPOINT" && v.familyId ? v.familyId : undefined,
    to_employment_type: kind === "EMPLOYMENT_TYPE_CHANGE" ? (v.toType as LifecycleRequest["to_employment_type"]) : undefined,
    leave_type: kind === "LEAVE_OF_ABSENCE" && v.leaveType ? (v.leaveType as LifecycleEvent["leave_type"]) : undefined,
  };
  // A correction is checked against the record it replaces, not against the version pins.
  if (c.corrects) return body;
  return {
    ...body,
    expected_head_version: c.pin,
    expected_contract_end_date: kind === "CONTRACT_RENEWAL" ? (c.contractEnd ?? undefined) : undefined,
    replaces_event_id: c.replaces,
    replace_reason_code: c.replaces ? (v.voidCode ?? undefined) : undefined,
  };
}

/** Records the draft (one user intent per key), or posts it as the correction of `corrects`. */
export function useLifecycleCommand(c: Context, v: Draft, onSuccess: (out: LifecycleEvent) => void) {
  return useCommand({
    run: (_: void, key: string) =>
      c.corrects
        ? correctEvent(c.corrects, lifecycleBody(v, c), { reason_code: v.voidCode ?? "", note: v.voidNote.trim() }, key)
        : recordLifecycleEvent(c.employeeId, lifecycleBody(v, c), key),
    verify: async (_: void, key: string) => {
      const outcome = await get("/api/v1/requests/{key}", { params: { path: { key } } }).queryFn();
      if (outcome.state !== "APPLIED") throw new Error("outcome_not_applied");
      const history = await eventsQuery(c.employeeId).queryFn();
      const event = history.items.find((x) => x.command_id === outcome.id);
      if (!event) throw new Error("outcome_record_not_found");
      return event;
    },
    // A transfer into another workplace's department moves the workplace (UX-R1 PLACEMENT): the placement and every count move with it.
    invalidates: ["/api/v1/employees", "/api/v1/org-units", "/api/v1/employment-assignments", "/api/v1/org-structure", "/api/v1/legal-entities"],
    settle: true,
    onSuccess,
  });
}
