// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type PayrollRun = components["schemas"]["PayrollRunSummary"];

export type RunLifecycleSheetKind =
  | "closeAttendance"
  | "calculate"
  | "submit"
  | "decide"
  | "withdraw"
  | "scheduleDisbursement"
  | "attestDisbursement"
  | "issuePayslips";

type RunStageAction =
  | { kind: "sheet"; sheet: RunLifecycleSheetKind; labelKey: string }
  | { kind: "pane"; pane: "delivery"; labelKey: string };

export function resolveRunStageAction(status: PayrollRun["status"]): RunStageAction | null {
  switch (status) {
    case "STAGED":
    case "BLOCKED_LEGAL_GATE":
    case "READY_FOR_REVIEW":
      return { kind: "sheet", sheet: "closeAttendance", labelKey: "payrollRun.cta.closeAttendance" };
    case "ATTENDANCE_CLOSED":
      return { kind: "sheet", sheet: "calculate", labelKey: "payrollRun.cta.calculate" };
    case "CALCULATED":
      return { kind: "sheet", sheet: "submit", labelKey: "payroll.run.requestApproval" };
    case "SUBMITTED":
      return { kind: "sheet", sheet: "decide", labelKey: "payrollRun.cta.decide" };
    case "REJECTED":
      return { kind: "sheet", sheet: "withdraw", labelKey: "payrollRun.cta.withdraw" };
    case "APPROVED":
      return { kind: "sheet", sheet: "scheduleDisbursement", labelKey: "payrollRun.cta.scheduleDisbursement" };
    case "DISBURSEMENT_SCHEDULED":
      return { kind: "sheet", sheet: "attestDisbursement", labelKey: "payrollRun.cta.attestDisbursement" };
    case "PAID":
      return { kind: "sheet", sheet: "issuePayslips", labelKey: "payrollRun.cta.issuePayslips" };
    case "ISSUED":
      return { kind: "pane", pane: "delivery", labelKey: "payrollRun.cta.viewDelivery" };
    default:
      return null;
  }
}

export function payrollErrorMessageKey(code: string): string | null {
  switch (code) {
    case "sod_violation":
    case "legal_gate":
    case "exceptions_open":
    case "nothing_calculated":
    case "preflight_blocked":
    case "payroll.refuse.identity_unbound":
      return `payrollRun.error.${code}`;
    default:
      return null;
  }
}
