// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { codeText } from "../../lib/labels";
import { catalogRefusal } from "../../lib/refusal";
import { describeOp } from "../../reference/org/present";
import type { ApprovalDocument } from "./api";

export const decisionRefusalText = (code: string) =>
  code === "approval_decision_unavailable" ? t("approvals.viewer.unavailable") : catalogRefusal(code) ?? codeText(`requestOutcome.code.${code}`, t("approvals.viewer.blockedHint"));

/** Builds structured before/after diff entries from server-provided proposal operations and unit names. */
export function proposalDiffs(d: Pick<ApprovalDocument, "title" | "proposal" | "proposal_names">) {
  const ops = d.proposal ?? [];
  if (ops.length === 0) return [];
  const name = (unitId?: string | null) => (unitId ? d.proposal_names?.[unitId] : undefined);
  const fallback = (unitId?: string | null) => name(unitId) ?? (unitId ? unitId.slice(0, 8) : "—");
  const names = { unit: name, region: name, branch: name };
  return ops.map((op, index) => {
    switch (op.op) {
      case "RENAME_ORG_UNIT":
        return { id: `op-${index}`, subject: fallback(op.orgUnitId), before: fallback(op.orgUnitId), after: op.name };
      case "MOVE_ORG_UNIT":
        return { id: `op-${index}`, subject: fallback(op.orgUnitId), before: d.title || "—", after: fallback(op.parentId) };
      case "REASSIGN_ORG_UNIT":
        return { id: `op-${index}`, subject: fallback(op.fromOrgUnit), before: fallback(op.fromOrgUnit), after: fallback(op.toOrgUnit) };
      case "DISSOLVE_ORG_UNIT":
        return {
          id: `op-${index}`,
          subject: fallback(op.orgUnitId),
          before: fallback(op.orgUnitId),
          after: t("orgPropose.diff.chip.dissolved"),
        };
      case "CREATE_ORG_UNIT":
        return { id: `op-${index}`, subject: op.name, before: "—", after: fallback(op.parentId) };
      default:
        return { id: `op-${index}`, subject: t("approvals.field.proposal"), before: "—", after: describeOp(op, names) };
    }
  });
}

export function approvalRouteSteps(d: ApprovalDocument) {
  return d.route.map(step => ({
    key: step.id,
    who: [step.label, step.assignee].filter(Boolean).join(" · "),
    state: step.state,
    meta: d.decision_refusal && step.state === "current" ? undefined : step.meta,
  }));
}
