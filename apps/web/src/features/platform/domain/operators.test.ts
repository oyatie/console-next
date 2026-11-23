// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { canReissueOperator, operatorRevokeReason, operatorStats } from "./operators";

const op1 = { user_id: "op-1", status: "ACTIVE", is_active: true, has_passkey: true };
const op2 = { user_id: "op-2", status: "ACTIVE", is_active: true, has_passkey: true };
const opPending = { user_id: "op-3", status: "PENDING_ENROLMENT", is_active: true, has_passkey: false };
const opExpired = { user_id: "op-4", status: "EXPIRED", is_active: true, has_passkey: false };
const opRevoked = { user_id: "op-5", status: "REVOKED", is_active: false, has_passkey: true };

test("canReissueOperator only allows pending or expired operators without a passkey", () => {
  expect(canReissueOperator(opPending)).toBe(true);
  expect(canReissueOperator(opExpired)).toBe(true);
  expect(canReissueOperator(op1)).toBe(false);
  expect(canReissueOperator(opRevoked)).toBe(false);
  expect(canReissueOperator({ ...opPending, has_passkey: true })).toBe(false);
});

test("operatorRevokeReason enforces self-revoke, last-operator, and already-revoked guards", () => {
  expect(operatorRevokeReason(op1, [op1, op2], "op-1")).toBe("cannot_revoke_self");
  expect(operatorRevokeReason(op1, [op1, opPending], "op-other")).toBe("last_platform_operator");
  expect(operatorRevokeReason(opRevoked, [op1, op2, opRevoked], "op-1")).toBe("operator_already_revoked");
  expect(operatorRevokeReason(op2, [op1, op2], "op-1")).toBeUndefined();
});

test("operatorStats aggregates totals across active, pending/expired, and revoked", () => {
  expect(operatorStats([op1, opPending, opExpired, opRevoked])).toEqual({
    all: 4,
    active: 1,
    pending: 2,
    revoked: 1,
  });
});
