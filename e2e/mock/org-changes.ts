// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import { AT, id, LONG_NAME, user } from "./fixtures";
import { recordStatuses, type OrgChangeState } from "../states/registry";

type S = components["schemas"];
export function orgChanges(count: number, long = false): S["OrgChangeSummary"][] {
  const statuses = ["DRAFT", "APPROVED", "APPLIED"] as const;
  return Array.from({ length: count }, (_, i) => ({
    id: id(3000 + i), code: `OC-2026-${String(i + 1).padStart(4, "0")}`, kind: "NEW", status: statuses[i % statuses.length]!,
    target: { kind: "ORG_UNIT", ref: id(5000 + i), label: long ? LONG_NAME.repeat(3) : `검증부서 ${i + 1}` },
    effectiveDate: "2026-11-01", reason: long ? LONG_NAME.repeat(8) : "조직 운영 개선",
    headcount: 3, siteCount: 1, teamCount: 1, draftedBy: user.id, draftedByName: long ? LONG_NAME : user.display_name,
    createdAt: AT, updatedAt: AT,
  }));
}

export function orgChange(state: OrgChangeState): S["OrgChangeDetail"] {
  const summary = orgChanges(1, state === "long")[0]!;
  const status = Object.entries(recordStatuses).find(([key]) => key === state)?.[1] ?? "APPLIED";
  const approval = status === "IN_APPROVAL" || status === "REJECTED";
  return {
    ...summary, status,
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: null, name: summary.target.label }],
    preflight: { computedAt: AT, stale: false, blockers: [], warnings: [], headcount: 3, dependentsTotal: 0 },
    approvalSteps: approval ? [{ id: id(6000), stepOrder: 1, roleKey: "hr", decision: status === "REJECTED" ? "REJECTED" : "PENDING", decidedByName: status === "REJECTED" ? "김검토" : null, memo: status === "REJECTED" ? "시행일을 다시 검토해 주십시오" : undefined }] : [],
    settlementItems: status === "SETTLING" ? [{ id: id(6001), itemKey: "POSITIONS", label: "직책 정리", done: false, doneByName: null }] : [],
    events: Array.from({ length: state === "large" ? 2000 : 3 }, () => ({ at: AT, actor: user.id, actorName: summary.draftedByName, action: "draft.update" })),
  };
}
