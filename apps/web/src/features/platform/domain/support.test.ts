// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { supportActionEligibility } from "./support";

test("supportActionEligibility enforces maker-checker separation on approve", () => {
  const requested = { state: "REQUESTED", operator_ref: "op-1", tenant_approved: false };
  expect(supportActionEligibility(requested, "op-1")).toEqual({
    canApprove: false,
    approveRefusal: "support.refuse.requester_cannot_approve",
    canStart: false,
    startRefusal: undefined,
    canEnd: true,
    endRefusal: undefined,
  });
  expect(supportActionEligibility(requested, "op-2")).toEqual({
    canApprove: true,
    approveRefusal: undefined,
    canStart: false,
    startRefusal: undefined,
    canEnd: false,
    endRefusal: "requesterOnly",
  });
});

test("supportActionEligibility requires customer consent and original requester to start", () => {
  const operatorApprovedNoConsent = { state: "OPERATOR_APPROVED", operator_ref: "op-1", tenant_approved: false };
  expect(supportActionEligibility(operatorApprovedNoConsent, "op-1").canStart).toBe(false);
  expect(supportActionEligibility(operatorApprovedNoConsent, "op-1").startRefusal).toBe(
    "support.refuse.not_tenant_approved",
  );

  const consented = { state: "OPERATOR_APPROVED", operator_ref: "op-1", tenant_approved: true };
  expect(supportActionEligibility(consented, "op-1").canStart).toBe(true);
  expect(supportActionEligibility(consented, "op-2").canStart).toBe(false);
  expect(supportActionEligibility(consented, "op-2").startRefusal).toBe("requesterOnly");
});

test("supportActionEligibility ends open or active sessions for requester only", () => {
  expect(supportActionEligibility({ state: "ACTIVE", operator_ref: "op-1", tenant_approved: true }, "op-1").canEnd).toBe(true);
  expect(supportActionEligibility({ state: "ENDED", operator_ref: "op-1", tenant_approved: true }, "op-1").canEnd).toBe(false);
});

test("supportActionEligibility fails closed when currentOperatorId is missing or empty", () => {
  const closed = {
    canApprove: false,
    approveRefusal: undefined,
    canStart: false,
    startRefusal: undefined,
    canEnd: false,
    endRefusal: undefined,
  };
  for (const currentOperatorId of [undefined, ""]) {
    expect(supportActionEligibility({ state: "REQUESTED", operator_ref: "op-1", tenant_approved: false }, currentOperatorId)).toEqual(closed);
    expect(supportActionEligibility({ state: "OPERATOR_APPROVED", operator_ref: "op-1", tenant_approved: false }, currentOperatorId)).toEqual(closed);
    expect(supportActionEligibility({ state: "OPERATOR_APPROVED", operator_ref: "op-1", tenant_approved: true }, currentOperatorId)).toEqual(closed);
    expect(supportActionEligibility({ state: "ACTIVE", operator_ref: "op-1", tenant_approved: true }, currentOperatorId)).toEqual(closed);
  }
});
