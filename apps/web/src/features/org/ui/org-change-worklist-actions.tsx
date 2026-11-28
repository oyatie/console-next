// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { APPROVAL_ROLE, label } from "../../../lib/labels";
import { freshOnOpen } from "../../../lib/query";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { commitLabel } from "../../../ui/composer/actions";
import { DecisionPane } from "../../../ui/decision-pane/decision-pane";
import { changeCommands, changeQuery } from "../api";
import s from "./org-change-worklist.module.css";

/** Shared compact reject/approve button pair for inline worklist rows. */
export function InlineApprovalButtons({
  disabled,
  pending,
  error,
  onReject,
  onApprove,
}: {
  disabled: boolean;
  pending: boolean;
  error: unknown;
  onReject: () => void;
  onApprove: () => void;
}) {
  return (
    <div className={s.rowActions}>
      <Button size="sm" disabled={disabled} onClick={onReject}>
        {t("uiWorklist.reject")}
      </Button>
      <Button variant="primary" size="sm" pending={pending} disabled={disabled} onClick={onApprove}>
        {commitLabel({ kind: "entityRecord", mode: "approve" })}
      </Button>
      <CommandError error={error} />
    </div>
  );
}

/** Inline Console row actions (reject opens the decision pane; approve decides the pending step directly). */
export function OrgChangeInlineRowActions({
  id,
  focusAfter = "inbox-title",
  onSelectForReject,
  onDecided,
}: {
  id: string;
  focusAfter?: string;
  onSelectForReject: () => void;
  onDecided?: () => void;
}) {
  const detail = freshOnOpen(useQuery({ ...changeQuery(id), refetchOnMount: "always" }));
  const step = detail.data?.approvalSteps.find(st => st.decision === "PENDING");
  const role = step ? label(APPROVAL_ROLE, step.roleKey) : "";
  const approve = useCommand({
    run: () => changeCommands(id).decide(step!.id, "APPROVED"),
    invalidates: ["/api/v1/me/action-inbox", ...ORG_READS],
    onSuccess: () => {
      if (onDecided) onDecided();
      else focusSoon(focusAfter);
    },
    announce: () => t("org.change.decided.APPROVED", { role }),
  });
  const disabled = !detail.isSuccess || detail.isPending || detail.isFetching || approve.isPending || !step;
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
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    if (opinion) setOpinion("");
  }
  const detail = freshOnOpen(useQuery({ ...changeQuery(id), refetchOnMount: "always" }));
  const step = detail.data?.approvalSteps.find(st => st.decision === "PENDING");
  const role = step ? label(APPROVAL_ROLE, step.roleKey) : "";

  const decide = useCommand({
    run: (decision: "APPROVED" | "REJECTED") =>
      changeCommands(id).decide(step!.id, decision, opinion.trim() || undefined),
    invalidates: ["/api/v1/me/action-inbox", ...ORG_READS],
    onSuccess: () => {
      setOpinion("");
      if (onDecided) onDecided();
      else focusSoon(focusAfter);
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
        resetKey={id}
        opinion={opinion}
        onOpinionChange={setOpinion}
        pending={decide.isPending ? (decide.variables === "REJECTED" ? "reject" : "approve") : undefined}
        onApprove={() => decide.mutate("APPROVED")}
        onReject={() => decide.mutate("REJECTED")}
      />
    </div>
  );
}
