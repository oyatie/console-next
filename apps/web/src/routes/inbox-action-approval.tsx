// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import {
  approvalDocumentQuery,
  decideApproval,
  type ApprovalDecision,
} from "../features/approvals/api";
import { decisionRefusalText } from "../features/approvals/present";
import { InlineApprovalButtons } from "../features/org/ui/org-change-worklist-actions";
import s from "../features/org/ui/org-change-worklist.module.css";
import { freshOnOpen } from "../lib/query";
import { focusSoon } from "../lib/react/announce";
import { useCommand } from "../lib/react/command";
import { CommandError } from "../lib/react/command-error";
import { QueryState } from "../lib/react/query-state";
import { Chip } from "../ui/chip";
import { DecisionPane } from "../ui/decision-pane/decision-pane";
import { KeyValue } from "../ui/key-value/key-value";
import { PaneHead } from "../ui/pane-grid/pane-grid";
import {
  WorklistChain,
  WorklistSection,
  WorklistSummaryHead,
  type WorklistChainStep,
} from "../ui/patterns/worklist-parts";

/** Inline Console row actions for generic approval-run worklist items. */
export function ApprovalRunInlineRowActions({
  id,
  focusAfter = "inbox-title",
  onSelectForReject,
}: {
  id: string;
  focusAfter?: string;
  onSelectForReject: () => void;
}) {
  const detail = freshOnOpen(useQuery({ ...approvalDocumentQuery(id), refetchOnMount: "always" }));
  const doc = detail.data;
  const canApprove = Boolean(doc && doc.my_actions.kind === "approve" && !doc.decision_refusal);
  const approve = useCommand({
    run: (_input: undefined, key: string) =>
      decideApproval(id, { decision: "APPROVE", seen_fingerprint: doc!.fingerprint, opinion: "" }, key),
    invalidates: ["/api/v1/me/action-inbox", "/api/v1/approvals"],
    onSuccess: () => focusSoon(focusAfter),
    announce: res =>
      t(
        res.decision === "APPROVED"
          ? res.status === "IN_APPROVAL"
            ? "approvals.receipt.approvedNext"
            : "approvals.receipt.approvedFinal"
          : "approvals.receipt.recorded",
      ),
  });
  const disabled = !detail.isSuccess || detail.isPending || detail.isFetching || approve.isPending || !canApprove;
  return (
    <InlineApprovalButtons
      disabled={disabled}
      pending={approve.isPending}
      error={approve.error}
      onReject={onSelectForReject}
      onApprove={() => approve.mutate(undefined)}
    />
  );
}

/** Console side-pane body for an approval-run worklist item (`KeyValue`, `WorklistChain`). */
export function ApprovalRunWorklistBody({
  id,
  dueLabel,
  trailing,
}: {
  id: string;
  dueLabel?: ReactNode;
  trailing?: ReactNode;
}) {
  const detail = freshOnOpen(useQuery({ ...approvalDocumentQuery(id), refetchOnMount: "always" }));
  return (
    <QueryState q={detail}>
      {d => {
        const currentStep = d.route.find(step => step.state === "current");
        return (
          <div>
            <WorklistSummaryHead
              kicker={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
              title={d.title || d.summary}
              status={
                currentStep || dueLabel ? (
                  <>
                    {currentStep ? <Chip tone="info">{t("orgChange.turn", { role: currentStep.label })}</Chip> : null}
                    {dueLabel}
                  </>
                ) : undefined
              }
            />
            <WorklistSection padded>
              <KeyValue
                items={[
                  ...(d.requester?.name
                    ? [{ key: "requester", label: t("approvals.field.requester"), value: d.requester.name }]
                    : []),
                  {
                    key: "requested",
                    label: t("approvals.field.requestedAt"),
                    value: fmtDate(d.requested_at.slice(0, 10)),
                  },
                  ...(d.summary ? [{ key: "summary", label: t("approvals.viewer.body"), value: d.summary }] : []),
                  ...d.facts,
                  ...d.body,
                ]}
              />
            </WorklistSection>
            {d.route.length > 0 ? (
              <WorklistSection>
                <PaneHead title={t("approvals.preview.route")} level={3} />
                <WorklistChain
                  label={t("approvals.preview.route")}
                  steps={d.route.map((step, index): WorklistChainStep => ({
                    key: step.id,
                    role: `${index + 1} ${step.label}`,
                    actor: step.assignee ?? step.label,
                    meta:
                      step.meta ??
                      (step.state === "done"
                        ? t("home.inbox.tab.done")
                        : step.state === "current"
                          ? t("orgChange.chain.current")
                          : step.state === "failed"
                            ? t("home.inbox.outcome.REJECTED")
                            : t("orgChange.settle.waiting")),
                    state: step.state,
                  }))}
                />
              </WorklistSection>
            ) : null}
            {trailing}
          </div>
        );
      }}
    </QueryState>
  );
}

/** Pinned side-pane decision footer for an approval-run worklist item. */
export function ApprovalRunWorklistDecisionFooter({
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
  const detail = freshOnOpen(useQuery({ ...approvalDocumentQuery(id), refetchOnMount: "always" }));
  const doc = detail.data;

  const decide = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(id, body, key),
    invalidates: ["/api/v1/me/action-inbox", "/api/v1/approvals"],
    onSuccess: () => {
      setOpinion("");
      onDecided?.();
      focusSoon(focusAfter);
    },
    announce: res =>
      t(
        res.decision === "REJECTED"
          ? "approvals.receipt.rejected"
          : res.decision === "APPROVED"
            ? res.status === "IN_APPROVAL"
              ? "approvals.receipt.approvedNext"
              : "approvals.receipt.approvedFinal"
            : "approvals.receipt.recorded",
      ),
  });

  if (canDecide === false) {
    return <div className="muted t-sm">{cannotReason ?? t("approvals.viewer.unavailable")}</div>;
  }
  if (detail.isError || detail.isPending || !doc) return null;
  if (doc.decision_refusal) {
    return <div className="muted t-sm">{decisionRefusalText(doc.decision_refusal)}</div>;
  }
  if (doc.my_actions.kind !== "approve") return null;

  const submit = (decision: ApprovalDecision["decision"]) => {
    const trimmed = opinion.trim();
    const reasonDomain =
      decision === "REJECT" ? doc.my_actions.reject?.reason_domain : doc.my_actions.return?.reason_domain;
    decide.mutate({
      decision,
      seen_fingerprint: doc.fingerprint,
      opinion: trimmed,
      ...(reasonDomain && trimmed ? { reason_code: "OTHER", note: trimmed } : {}),
    });
  };

  return (
    <div className={s.footerWrap}>
      <CommandError error={decide.error} />
      <DecisionPane
        opinion={opinion}
        onOpinionChange={setOpinion}
        pending={
          decide.isPending
            ? decide.variables?.decision === "REJECT"
              ? "reject"
              : decide.variables?.decision === "RETURN"
                ? "return"
                : "approve"
            : undefined
        }
        onApprove={() => submit("APPROVE")}
        onReject={() => submit("REJECT")}
        onReturn={doc.my_actions.return ? () => submit("RETURN") : undefined}
      />
    </div>
  );
}
