// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { APPROVAL_ROLE, ORG_CHANGE_KIND, label } from "../../../lib/labels";
import { freshOnOpen } from "../../../lib/query";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ORG_READS, unitsQuery } from "../../../reference/org/api";
import { describeOp } from "../../../reference/org/present";
import { Button } from "../../../ui/button/button";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { Chip } from "../../../ui/chip";
import { commitLabel } from "../../../ui/composer/actions";
import { DecisionPane } from "../../../ui/decision-pane/decision-pane";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import {
  WorklistChain,
  WorklistPadded,
  WorklistSection,
  WorklistSummaryHead,
  type WorklistChainStep,
} from "../../../ui/patterns/worklist-parts";
import { shortMonthDay } from "../../../lib/pure/today";
import { changeCommands, changeQuery } from "../api";
import s from "./org-change-worklist.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Op = components["schemas"]["OrgProposalOp"];

function proposalDiffRows(
  detail: Detail,
  unitName: (id?: string | null) => string | undefined,
) {
  const names = {
    unit: unitName,
    region: () => undefined,
    branch: () => undefined,
  };
  const fallback = (id?: string | null) => unitName(id) ?? (id ? id.slice(0, 8) : "—");
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
      case "REASSIGN_ORG_UNIT":
        return {
          id: `op-${idx}`,
          subject: fallback(op.fromOrgUnit),
          before: fallback(op.fromOrgUnit),
          after: fallback(op.toOrgUnit),
        };
      case "DISSOLVE_ORG_UNIT":
        return {
          id: `op-${idx}`,
          subject: fallback(op.orgUnitId),
          before: fallback(op.orgUnitId),
          after: op.mergedInto ? fallback(op.mergedInto) : t("orgPropose.diff.chip.dissolved"),
        };
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

/** Inline Console row actions (reject opens the decision pane; approve decides the pending step directly). */
export function OrgChangeInlineRowActions({
  id,
  focusAfter = "inbox-title",
  onSelectForReject,
}: {
  id: string;
  focusAfter?: string;
  onSelectForReject: () => void;
}) {
  const detail = freshOnOpen(useQuery({ ...changeQuery(id), refetchOnMount: "always" }));
  const step = detail.data?.approvalSteps.find(st => st.decision === "PENDING");
  const role = step ? label(APPROVAL_ROLE, step.roleKey) : "";
  const approve = useCommand({
    run: () => changeCommands(id).decide(step!.id, "APPROVED"),
    invalidates: ["/api/v1/me/action-inbox", ...ORG_READS],
    onSuccess: () => focusSoon(focusAfter),
    announce: () => t("org.change.decided.APPROVED", { role }),
  });
  const disabled = !detail.isSuccess || detail.isPending || detail.isFetching || approve.isPending || !step;
  return (
    <div className={s.rowActions}>
      <Button size="sm" disabled={disabled} onClick={onSelectForReject}>
        {t("uiWorklist.reject")}
      </Button>
      <Button
        variant="primary"
        size="sm"
        pending={approve.isPending}
        disabled={disabled}
        onClick={() => approve.mutate(undefined)}
      >
        {commitLabel({ kind: "orgChange", mode: "approve" })}
      </Button>
      <CommandError error={approve.error} />
    </div>
  );
}

/** Console side-pane body for an organization-change inbox item (`KeyValue`, `ChangeRows`, and approval chain). */
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
  const unitMap = new Map((units.data?.items ?? []).map(u => [u.id, u.name]));

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
                    {pendingStep ? <Chip tone="info">{t("orgChange.turn", { role })}</Chip> : null}
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
            {trailing ? <WorklistPadded>{trailing}</WorklistPadded> : null}
          </div>
        );
      }}
    </QueryState>
  );
}

/** Pinned side-pane decision footer for an organization-change approval item. */
export function OrgChangeWorklistDecisionFooter({
  id,
  canDecide = true,
  cannotReason,
  focusAfter = "inbox-title",
  onDecided,
}: {
  id: string;
  canDecide?: boolean;
  cannotReason?: string | null;
  focusAfter?: string;
  onDecided?: () => void;
}) {
  const [opinion, setOpinion] = useState("");
  const detail = freshOnOpen(useQuery({ ...changeQuery(id), refetchOnMount: "always" }));
  const step = detail.data?.approvalSteps.find(st => st.decision === "PENDING");
  const role = step ? label(APPROVAL_ROLE, step.roleKey) : "";

  const decide = useCommand({
    run: (decision: "APPROVED" | "REJECTED") =>
      changeCommands(id).decide(step!.id, decision, opinion.trim() || undefined),
    invalidates: ["/api/v1/me/action-inbox", ...ORG_READS],
    onSuccess: () => {
      setOpinion("");
      onDecided?.();
      focusSoon(focusAfter);
    },
    announce: (_out, decision) =>
      t(decision === "APPROVED" ? "orgChange.decided.APPROVED" : "orgChange.decided.REJECTED", {
        role,
        code: detail.data?.code ?? id,
      }),
  });

  if (canDecide === false) {
    return (
      <div className="muted t-sm">
        {cannotReason ?? t("org.change.approvals.drafterCannot")}
      </div>
    );
  }

  if (detail.isError || detail.isPending || !step) {
    return null;
  }

  return (
    <div className={s.footerWrap}>
      <CommandError error={decide.error} />
      <DecisionPane
        opinion={opinion}
        onOpinionChange={setOpinion}
        pending={decide.isPending ? (decide.variables === "REJECTED" ? "reject" : "approve") : undefined}
        onApprove={() => decide.mutate("APPROVED")}
        onReject={() => decide.mutate("REJECTED")}
      />
    </div>
  );
}
