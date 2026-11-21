// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { codeText } from "../../lib/labels";
import { shortMonthDay } from "../../lib/pure/kst-day";
import { catalogRefusal } from "../../lib/refusal";
import { describeOp } from "../../reference/org/present";
import type { ApprovalDocument, ApprovalViewer } from "./api";

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
        return { id: `op-${index}`, subject: t("orgPropose.diff.chip.renamed"), before: fallback(op.orgUnitId), after: op.name };
      case "MOVE_ORG_UNIT":
        return { id: `op-${index}`, subject: fallback(op.orgUnitId), before: t("orgPropose.diff.now"), after: fallback(op.parentId) };
      case "REASSIGN_ORG_UNIT":
        return {
          id: `op-${index}`,
          subject: op.employeeIds?.length
            ? `${t("home.worklist.impact.transfer")} (${t("home.worklist.personCount", { count: op.employeeIds.length })})`
            : t("home.worklist.impact.transfer"),
          before: fallback(op.fromOrgUnit),
          after: fallback(op.toOrgUnit),
        };
      case "DISSOLVE_ORG_UNIT":
        return {
          id: `op-${index}`,
          subject: fallback(op.orgUnitId),
          before: t("enum.unitStatus.ACTIVE"),
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
  return d.route.map((step, index) => {
    if (d.decision_refusal && step.state === "current") {
      return {
        key: step.id,
        who: [step.label, step.assignee].filter(Boolean).join(" · "),
        state: step.state,
        meta: undefined,
      };
    }
    const fallbackDate = index === 0 && d.requested_at ? shortMonthDay(d.requested_at) : undefined;
    const defaultMeta =
      step.state === "done"
        ? fallbackDate
          ? `${t("home.inbox.tab.done")} ${fallbackDate}`
          : t("home.inbox.tab.done")
        : step.state === "current"
          ? t("orgChange.chain.current")
          : step.state === "failed"
            ? t("home.inbox.outcome.REJECTED")
            : t("orgChange.settle.waiting");
    return {
      key: step.id,
      who: [step.label, step.assignee].filter(Boolean).join(" · "),
      state: step.state,
      meta: step.meta ?? defaultMeta,
    };
  });
}

type ApprovalRelatedLink =
  | { key: string; kind: string; label: string; to: "/people"; search: { unit: string } }
  | { key: string; kind: string; label: string; to: "/org"; search: { sel: string } }
  | { key: string; kind: string; label: string; to: "/org/changes/$id"; params: { id: string } }
  | { key: string; kind: string; label: string; to: "/people/$id"; params: { id: string }; search: Record<string, never> }
  | { key: string; kind: string; label: string; to: "/people/exits/$id"; params: { id: string }; search: Record<string, never> }
  | { key: string; kind: string; label: string; to: "/audit/support-access"; search: { review: string } }
  | { key: string; kind: string; label: string; to: "/requests/$id"; params: { id: string } }
  | { key: string; kind: string; label: string; to: "/people/period-locks"; search: { review: string } }
  | { key: string; kind: string; label: string; to: "/statutory"; search: { event: string } }
  | { key: string; kind: string; label: string; to: "/account" };

function viewerRelatedLink(viewer: ApprovalViewer, kindLabel: string): ApprovalRelatedLink {
  const label = t("approvals.openSource");
  if (viewer.kind === "org_change") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/org/changes/$id", params: { id: viewer.id } };
  if (viewer.kind === "employee") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/people/$id", params: { id: viewer.id }, search: {} };
  if (viewer.kind === "exit_case") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/people/exits/$id", params: { id: viewer.id }, search: {} };
  if (viewer.kind === "support_session") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/audit/support-access", search: { review: viewer.id } };
  if (viewer.kind === "change_request") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/requests/$id", params: { id: viewer.id } };
  if (viewer.kind === "period_lock") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/people/period-locks", search: { review: viewer.id } };
  if (viewer.kind === "statutory") return { key: `viewer-${viewer.id}`, kind: kindLabel, label, to: "/statutory", search: { event: viewer.id } };
  return { key: "viewer-account", kind: kindLabel, label, to: "/account" };
}

/** Derives pre-decision reference links strictly from server-provided viewer and proposal unit references. */
export function relatedApprovalLinks(d: Pick<ApprovalDocument, "source" | "viewer" | "proposal" | "proposal_names">): ApprovalRelatedLink[] {
  const links: ApprovalRelatedLink[] = [];
  const dissolved = new Set<string>();
  const rosterAdded = new Set<string>();
  for (const op of d.proposal ?? []) {
    if (op.op === "DISSOLVE_ORG_UNIT") dissolved.add(op.orgUnitId);
    if (op.op === "REASSIGN_ORG_UNIT" && !rosterAdded.has(op.fromOrgUnit)) {
      const unitName = d.proposal_names?.[op.fromOrgUnit];
      if (unitName) {
        rosterAdded.add(op.fromOrgUnit);
        links.push({
          key: `roster-${op.fromOrgUnit}`,
          kind: t("approvals.related.roster"),
          label: unitName,
          to: "/people",
          search: { unit: op.fromOrgUnit },
        });
      }
    }
  }
  for (const [unitId, unitName] of Object.entries(d.proposal_names ?? {})) {
    links.push({
      key: `org-${unitId}`,
      kind: t("approvals.related.org"),
      label: dissolved.has(unitId) ? `${unitName} (${t("orgPropose.diff.chip.dissolved")})` : unitName,
      to: "/org",
      search: { sel: unitId },
    });
  }
  if (d.viewer) {
    links.push(viewerRelatedLink(d.viewer, d.source.label));
  }
  return links;
}
