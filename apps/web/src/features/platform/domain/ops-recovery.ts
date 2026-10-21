// SPDX-License-Identifier: LicenseRef-Proprietary
/** One primary action, or the prerequisite the operator must satisfy. */
export function recoveryAction(state: "WAITING_APPROVAL" | "HOLD" | "READY" | "ISSUED" | "CANCELLED" | null, enrolled: boolean, second: boolean, party: boolean, active = true, holdUntil?: string | null, now = Date.now()) {
  if (state === "HOLD" && holdUntil && Date.parse(holdUntil) <= now) state = "READY";
  if (!active && (state === null || state === "READY")) return "inactive";
  switch (state) {
    case "WAITING_APPROVAL": return party ? "otherOperator" : "approve";
    case "HOLD": return "hold";
    case "READY": return party ? "issue" : "notParty";
    case "ISSUED": return "issued";
    case "CANCELLED": return "cancelled";
    default: return !enrolled ? "notEnrolled" : !second ? "noSecondOperator" : "open";
  }
}
