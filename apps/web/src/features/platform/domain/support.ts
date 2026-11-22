// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type SupportSessionMetadata = components["schemas"]["SupportSessionMetadata"];

export const SUPPORT_SCOPES = ["org", "hr_basic"] as const;
export type SupportScope = (typeof SUPPORT_SCOPES)[number];

export const SUPPORT_REASON_CODES = ["INCIDENT", "ONBOARDING", "DATA_CHECK", "OTHER"] as const;
export type SupportReasonCode = (typeof SUPPORT_REASON_CODES)[number];

export const SUPPORT_DURATIONS = [900, 1800, 3600, 7200] as const;

export function supportActionEligibility(
  session: Pick<SupportSessionMetadata, "state" | "operator_ref" | "tenant_approved">,
  currentOperatorId?: string,
) {
  if (!currentOperatorId) {
    return {
      canApprove: false,
      approveRefusal: undefined,
      canStart: false,
      startRefusal: undefined,
      canEnd: false,
      endRefusal: undefined,
    };
  }
  const isRequester = session.operator_ref === currentOperatorId;
  const isSameOperator = isRequester;
  const canApprove = session.state === "REQUESTED" && !isSameOperator;
  const approveRefusal =
    session.state === "REQUESTED" && isSameOperator ? ("support.refuse.requester_cannot_approve" as const) : undefined;
  const canStart = session.state === "OPERATOR_APPROVED" && Boolean(session.tenant_approved) && isRequester;
  const startRefusal =
    session.state === "OPERATOR_APPROVED" && !session.tenant_approved
      ? ("support.refuse.not_tenant_approved" as const)
      : session.state === "OPERATOR_APPROVED" && !isRequester
        ? ("requesterOnly" as const)
        : undefined;
  const canEnd =
    (session.state === "REQUESTED" || session.state === "OPERATOR_APPROVED" || session.state === "ACTIVE") &&
    isRequester;
  const endRefusal =
    (session.state === "REQUESTED" || session.state === "OPERATOR_APPROVED" || session.state === "ACTIVE") &&
    !isRequester
      ? ("requesterOnly" as const)
      : undefined;

  return { canApprove, approveRefusal, canStart, startRefusal, canEnd, endRefusal };
}
