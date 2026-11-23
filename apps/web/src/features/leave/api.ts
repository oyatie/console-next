// SPDX-License-Identifier: LicenseRef-Proprietary
export { ApiError } from "@console/api";
import { api, unwrap, type components } from "@console/api";
import { t } from "@console/i18n";
import { get } from "../../lib/query";
import type { LeaveOptionKind } from "./domain/leave-form";

export function leaveOptionLabel(kind: LeaveOptionKind): string {
  switch (kind) {
    case "annual":
      return t("leave.type.annual");
    case "half_am":
      return t("leave.type.halfAm");
    case "half_pm":
      return t("leave.type.halfPm");
  }
}

export type LeaveRequestView = components["schemas"]["LeaveRequestV2View"];
export type TeamOverlapView = components["schemas"]["SelfLeaveTeamOverlap"];
export type ApprovalPreviewStep = components["schemas"]["LeaveApprovalPreviewStep"];
type LeaveCreateBody = components["schemas"]["LeaveCreateRequest"];

/** Self-service leave balance and recent request history. */
/** The signed-in account; its employee link decides whether the self reads below can answer at all. */
export const meQuery = get("/api/v1/users/me");
export const myLeaveQuery = get("/api/v2/me/leave");

/** Self-service team overlap for the selected leave date range. */
export const myLeaveTeamOverlapQuery = (startDate: string, endDate: string) =>
  get("/api/v2/me/leave/team-overlap", {
    params: { query: { start_date: startDate, end_date: endDate } },
  });

/** Self-service approval chain preview for leave filing. */
export const myLeaveApprovalPreviewQuery = get("/api/v2/me/leave/approval-preview");

/** Self-service monthly schedule used to exclude non-working holidays when estimating multi-day leave. */
export const myScheduleQuery = (month: string) =>
  get("/api/v1/attendance/me/schedule", { params: { query: { month } } });

/** Files a self-service annual or half-day leave request with a caller-owned idempotency key. */
export function createLeaveRequest(body: LeaveCreateBody) {
  return unwrap(api.POST("/api/v2/leave/requests", { body }));
}

/** Maps domain-specific leave filing errors to localized user copy. */
export function leaveSubmitError(code: string): string | undefined {
  switch (code) {
    case "leave_home_branch_review_required":
      return t("leave.failed.homeBranchRequired");
    case "leave_overlapping_request":
    case "leave_create.overlapping_request":
      return t("common.failed.code.leave_overlapping_request");
    case "leave_period_closed":
    case "leave_create.period_closed":
      return t("common.failed.code.leave_period_closed");
    case "leave_create.idempotency_conflict":
    case "idempotency_key_reused":
      return t("leave.failed.idempotencyConflict");
    case "invalid_date_range":
    case "validation":
      return t("leave.failed.invalidRange");
    case "leave.refuse.identity_unbound":
      return t("leave.refuse.identity_unbound");
    default:
      return undefined;
  }
}
