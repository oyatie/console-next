// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type OperatorSummary = components["schemas"]["PlatformOperatorSummary"];
const OPERATOR_STATUSES = ["PENDING_ENROLMENT", "ACTIVE", "REVOKED", "EXPIRED"] as const;
type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

export const PLATFORM_OPERATOR_STATUS: {
  type: string;
  values: readonly OperatorStatus[];
  tone: Partial<Record<OperatorStatus, "ok" | "warn" | "danger" | "info" | "neutral">>;
  extensible: true;
  message: (v: string) => string;
} = {
  type: "platformOperatorStatus",
  values: OPERATOR_STATUSES,
  tone: { PENDING_ENROLMENT: "warn", ACTIVE: "ok", REVOKED: "neutral", EXPIRED: "danger" },
  extensible: true,
  message: (v) => `enum.platformOperatorStatus.${v}`,
};

export const canReissueOperator = (op: Pick<OperatorSummary, "status" | "has_passkey">) =>
  !op.has_passkey && (op.status === "PENDING_ENROLMENT" || op.status === "EXPIRED");

export function operatorRevokeReason(
  op: Pick<OperatorSummary, "user_id" | "status" | "is_active">,
  all: readonly Pick<OperatorSummary, "user_id" | "status" | "is_active">[],
  currentUserId?: string,
): "operator_already_revoked" | "cannot_revoke_self" | "last_platform_operator" | undefined {
  if (op.status === "REVOKED" || !op.is_active) return "operator_already_revoked";
  if (currentUserId && op.user_id === currentUserId) return "cannot_revoke_self";
  const activeCount = all.filter((item) => item.is_active && item.status === "ACTIVE").length;
  if (op.status === "ACTIVE" && activeCount <= 1) return "last_platform_operator";
  return undefined;
}

export function operatorStats(all: readonly Pick<OperatorSummary, "status" | "has_passkey">[]) {
  return {
    all: all.length,
    active: all.filter((o) => o.status === "ACTIVE" && o.has_passkey).length,
    pending: all.filter((o) => o.status === "PENDING_ENROLMENT" || o.status === "EXPIRED").length,
    revoked: all.filter((o) => o.status === "REVOKED").length,
  };
}
