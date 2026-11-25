// SPDX-License-Identifier: LicenseRef-Proprietary
import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { APPROVAL_ROLE, ORG_CHANGE_KIND, label } from "../../../lib/labels";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { shortMonthDay } from "../../../lib/pure/kst-day";
import { unitsQuery } from "../../../reference/org/api";
import { describeOp } from "../../../reference/org/present";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { TurnChip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import {
  WorklistChain,
  WorklistPadded,
  WorklistSection,
  WorklistSummaryHead,
  type WorklistChainStep,
} from "../../../ui/patterns/worklist-parts";
import { changeQuery } from "../api";
export { OrgChangeInlineRowActions, OrgChangeWorklistDecisionFooter } from "./org-change-worklist-actions";

type Detail = components["schemas"]["OrgChangeDetail"];
type Op = components["schemas"]["OrgProposalOp"];

type UnitSummary = { name: string; headcount: number };

function proposalDiffRows(
  detail: Detail,
  unitById: (id?: string | null) => UnitSummary | undefined,
) {
  const names = {
    unit: (id?: string | null) => unitById(id)?.name,
    region: () => undefined,
    branch: () => undefined,
  };
  const fallback = (id?: string | null) => unitById(id)?.name ?? (id ? id.slice(0, 8) : "—");
  return detail.proposal.map((op: Op, idx: number) => {
    switch (op.op) {
      case "RENAME_ORG_UNIT":
        return {
          id: `op-${idx}`,
          subject: fallback(op.orgUnitId),
          before: fallback(op.orgUnitId),
          after: op.name,
        };
      case "MOVE_ORG_UNIT":
        return {
          id: `op-${idx}`,
          subject: fallback(op.orgUnitId),
          before: detail.target.label || "—",
          after: fallback(op.parentId),
        };
      case "REASSIGN_ORG_UNIT": {
        const fromUnit = unitById(op.fromOrgUnit);
        const toUnit = unitById(op.toOrgUnit);
        const moved = op.employeeIds?.length ?? fromUnit?.headcount ?? detail.headcount;
        if (toUnit && moved > 0) {
          return {
            id: `op-${idx}`,
            subject: toUnit.name,
            before: t("home.worklist.personCount", { count: toUnit.headcount }),
            after: t("home.worklist.personCount", { count: toUnit.headcount + moved }),
          };
        }
        return {
          id: `op-${idx}`,
          subject: fallback(op.fromOrgUnit),
          before: fallback(op.fromOrgUnit),
          after: fallback(op.toOrgUnit),
        };
      }
      case "DISSOLVE_ORG_UNIT": {
        const unit = unitById(op.orgUnitId);
        return {
          id: `op-${idx}`,
          subject: fallback(op.orgUnitId),
          before: unit ? t("home.worklist.personCount", { count: unit.headcount }) : fallback(op.orgUnitId),
          after: t("orgPropose.diff.chip.dissolved"),
        };
      }
      case "CREATE_ORG_UNIT":
        return {
          id: `op-${idx}`,
          subject: op.name,
          before: "—",
          after: fallback(op.parentId),
        };
      default:
        return {
          id: `op-${idx}`,
          subject: label(ORG_CHANGE_KIND, detail.kind),
          before: "—",
          after: describeOp(op, names),
        };
    }
  });
}

/** Console side-pane body for an organization-change inbox item (`KeyValue`, `ChangeRows`, impact, and approval chain). */
export function OrgChangeWorklistBody({
  id,
  dueLabel,
  trailing,
}: {
  id: string;
  dueLabel?: ReactNode;
  trailing?: ReactNode;
}) {
  const detail = freshOnOpen(useQuery({ ...changeQuery(id), refetchOnMount: "always" }));
  const units = useQuery(unitsQuery);
  const unitMap = new Map((units.data?.items ?? []).map(u => [u.id, { name: u.name, headcount: u.headcount }]));

  return (
    <QueryState q={detail}>
      {d => {
        const pendingStep = d.approvalSteps.find(st => st.decision === "PENDING");
        const role = pendingStep ? label(APPROVAL_ROLE, pendingStep.roleKey) : "";
        const diffs = proposalDiffRows(d, uid => (uid ? unitMap.get(uid) : undefined));
        return (
          <div>
            <WorklistSummaryHead
              kicker={`${label(ORG_CHANGE_KIND, d.kind)} · ${d.code}`}
              title={d.target.label || d.reason || d.code}
              status={
                pendingStep || dueLabel ? (
                  <>
                    {pendingStep ? <TurnChip>{t("orgChange.turn", { role })}</TurnChip> : null}
                    {dueLabel}
                  </>
                ) : undefined
              }
            />
            <WorklistSection padded>
              <KeyValue
                items={[
                  ...(d.draftedByName ? [{ key: "drafter", label: t("approvals.field.requester"), value: d.draftedByName }] : []),
                  { key: "created", label: t("approvals.field.requestedAt"), value: fmtDate(d.createdAt.slice(0, 10)) },
                  { key: "effective", label: t("orgChange.date"), value: <strong>{fmtDate(d.effectiveDate)}</strong> },
                  ...(d.reason ? [{ key: "reason", label: t("home.inbox.record.reason"), value: d.reason }] : []),
                ]}
              />
            </WorklistSection>
            {diffs.length > 0 ? (
              <WorklistSection>
                <PaneHead title={t("uiWorklist.changes")} level={3} />
                <ChangeRows items={diffs} />
              </WorklistSection>
            ) : null}
            {d.approvalSteps.length > 0 ? (
              <WorklistSection>
                <PaneHead title={t("uiChainStepper.label")} level={3} />
                <WorklistChain
                  label={t("uiChainStepper.label")}
                  steps={d.approvalSteps.map((step): WorklistChainStep => {
                    const state =
                      step.decision === "APPROVED"
                        ? "done"
                        : step.decision === "REJECTED"
                          ? "failed"
                          : step.id === pendingStep?.id
                            ? "current"
                            : "waiting";
                    const stepDate = shortMonthDay(step.decidedAt);
                    const metaText =
                      state === "done"
                        ? stepDate
                          ? `${t("home.inbox.tab.done")} ${stepDate}`
                          : t("home.inbox.tab.done")
                        : state === "current"
                          ? t("orgChange.chain.current")
                          : state === "failed"
                            ? t("home.inbox.outcome.REJECTED")
                            : t("orgChange.settle.waiting");
                    return {
                      key: step.id,
                      role: `${step.stepOrder} ${label(APPROVAL_ROLE, step.roleKey)}`,
                      actor: step.decidedByName ?? label(APPROVAL_ROLE, step.roleKey),
                      meta: metaText,
                      state,
                    };
                  })}
                />
              </WorklistSection>
            ) : null}
            {d.headcount > 0 || d.preflight ? (
              <WorklistSection>
                <PaneHead title={t("home.worklist.impact.title")} level={3} />
                <WorklistPadded>
                  <KeyValue
                    items={[
                      {
                        key: "headcount",
                        label: t("home.worklist.impact.transfer"),
                        value: t("home.worklist.personCount", { count: d.headcount }),
                      },
                      ...(d.preflight && d.preflight.dependentsTotal > 0
                        ? [
                            {
                              key: "dependents",
                              label: t("home.worklist.impact.dependents"),
                              value: t("home.worklist.impact.dependentCount", { count: d.preflight.dependentsTotal }),
                            },
                          ]
                        : []),
                    ]}
                  />
                </WorklistPadded>
              </WorklistSection>
            ) : null}
            {trailing}
          </div>
        );
      }}
    </QueryState>
  );
}
