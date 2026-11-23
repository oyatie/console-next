// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { payrollErrorMessageKey, resolveRunStageAction } from "./run-lifecycle";

describe("resolveRunStageAction", () => {
  test("maps each run stage to its expected primary sheet or pane CTA", () => {
    expect(resolveRunStageAction("STAGED")).toEqual({ kind: "sheet", sheet: "closeAttendance", labelKey: "payrollRun.cta.closeAttendance" });
    expect(resolveRunStageAction("BLOCKED_LEGAL_GATE")).toEqual({ kind: "sheet", sheet: "closeAttendance", labelKey: "payrollRun.cta.closeAttendance" });
    expect(resolveRunStageAction("READY_FOR_REVIEW")).toEqual({ kind: "sheet", sheet: "closeAttendance", labelKey: "payrollRun.cta.closeAttendance" });
    expect(resolveRunStageAction("ATTENDANCE_CLOSED")).toEqual({ kind: "sheet", sheet: "calculate", labelKey: "payrollRun.cta.calculate" });
    expect(resolveRunStageAction("CALCULATED")).toEqual({ kind: "sheet", sheet: "submit", labelKey: "payroll.run.requestApproval" });
    expect(resolveRunStageAction("SUBMITTED")).toEqual({ kind: "sheet", sheet: "decide", labelKey: "payrollRun.cta.decide" });
    expect(resolveRunStageAction("REJECTED")).toEqual({ kind: "sheet", sheet: "withdraw", labelKey: "payrollRun.cta.withdraw" });
    expect(resolveRunStageAction("APPROVED")).toEqual({ kind: "sheet", sheet: "scheduleDisbursement", labelKey: "payrollRun.cta.scheduleDisbursement" });
    expect(resolveRunStageAction("DISBURSEMENT_SCHEDULED")).toEqual({ kind: "sheet", sheet: "attestDisbursement", labelKey: "payrollRun.cta.attestDisbursement" });
    expect(resolveRunStageAction("PAID")).toEqual({ kind: "sheet", sheet: "issuePayslips", labelKey: "payrollRun.cta.issuePayslips" });
    expect(resolveRunStageAction("ISSUED")).toEqual({ kind: "pane", pane: "delivery", labelKey: "payrollRun.cta.viewDelivery" });
  });
});

describe("payrollErrorMessageKey", () => {
  test("maps authoritative payroll refusal codes and ignores unknown codes", () => {
    expect(payrollErrorMessageKey("sod_violation")).toBe("payrollRun.error.sod_violation");
    expect(payrollErrorMessageKey("legal_gate")).toBe("payrollRun.error.legal_gate");
    expect(payrollErrorMessageKey("exceptions_open")).toBe("payrollRun.error.exceptions_open");
    expect(payrollErrorMessageKey("preflight_blocked")).toBe("payrollRun.error.preflight_blocked");
    expect(payrollErrorMessageKey("payroll.refuse.identity_unbound")).toBe("payrollRun.error.payroll.refuse.identity_unbound");
    expect(payrollErrorMessageKey("unexpected_code")).toBeNull();
  });
});
