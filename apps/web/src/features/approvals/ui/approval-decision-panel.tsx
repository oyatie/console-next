// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { reasonCodesQuery, reasonOptions, type ReasonDomain } from "../../../lib/reason-codes";
import { readsAreStale } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ApprovalCard } from "../../../ui/approval-card/approval-card";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { commitLabel } from "../../../ui/composer/actions";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { docLinkClass } from "../../../ui/patterns/document-decision-link";
import { DocDecisionPad, DocLinkContent, DocLinkList } from "../../../ui/patterns/document-decision-parts";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import type { ApprovalDecision, ApprovalDocument } from "../api";
import { decisionRefusalText, relatedApprovalLinks } from "../present";
import { useApprovalDecisionCommand } from "./use-approval-decision";

const emptyReason = (): Reason => ({ code: null, memo: "" });
/** The longest note a reason takes (the reason catalog's own limit). */
const NOTE_MAX = 1000;
type DecisionForm = "reject" | "return";

/** The words for a consequence key; a key this build does not know stays visible as itself. */
const consequenceText = (key: string) => {
  const id = `approvals.consequence.${key}`;
  return isMessageId(id) ? t(id) : key;
};

/** The reasons of one decision, from the catalog domain the server names. */
function useDecisionReasons(domain: string | undefined) {
  const known = domain as ReasonDomain | undefined;
  const q = useQuery({ ...reasonCodesQuery(known ?? "org_change_reject"), enabled: Boolean(known) });
  const options = known ? reasonOptions(known, q.data?.items) : [];
  // The catalog marks which code needs a written note; the field takes one such code.
  return { codes: options.map(o => ({ code: o.value, label: o.label })), other: options.find(o => o.requiresNote)?.value ?? "OTHER" };
}

export function ApprovalDecisionPanel({
  document: d,
  receipt: controlledReceipt,
  onReceipt,
  showNext = false,
  docked = false,
  showRelated = false,
  controller,
}: {
  document: ApprovalDocument;
  receipt?: string;
  onReceipt?: (text: string) => void;
  showNext?: boolean;
  docked?: boolean;
  showRelated?: boolean;
  controller?: ReturnType<typeof useApprovalDecisionCommand>;
}) {
  const [opinion, setOpinion] = useState("");
  const [reasons, setReasons] = useState<Record<DecisionForm, Reason>>({ reject: emptyReason(), return: emptyReason() });
  const internal = useApprovalDecisionCommand(d.id, onReceipt);
  const { command, localReceipt } = controller ?? internal;
  const receipt = controlledReceipt ?? localReceipt;
  const actions = d.my_actions;
  const catalog = { reject: useDecisionReasons(actions.reject?.reason_domain), return: useDecisionReasons(actions.return?.reason_domain) };
  const submit = (decision: ApprovalDecision["decision"]) => {
    const decisionForm = decision === "REJECT" ? "reject" : decision === "RETURN" ? "return" : undefined;
    const reason = decisionForm ? reasons[decisionForm] : undefined;
    command.mutate({
      decision,
      seen_fingerprint: d.fingerprint,
      opinion: opinion.trim(),
      ...(reason?.code ? { reason_code: reason.code, ...(reason.memo.trim() ? { note: reason.memo.trim() } : {}) } : {}),
    });
  };
  const ownError = (code: string) =>
    code === "approval_document_changed"
      ? t("approvals.viewer.changed")
      : code === "approval_decision_unavailable"
        ? decisionRefusalText(code)
        : undefined;
  // Only the action the server offers is drawn; nothing is inferred from the document's status.
  const reject = actions.kind === "approve" ? actions.reject : undefined;
  const receiptMessage = receipt && <p role="status">{receipt}</p>;
  if (!reject && !receipt && !command.isPending) {
    if (command.error) {
      return docked ? (
        <DocDecisionPad>
          <CommandError error={command.error} own={ownError} />
        </DocDecisionPad>
      ) : (
        <Card title={t("approvals.viewer.decision")}>
          <CommandError error={command.error} own={ownError} />
        </Card>
      );
    }
    return null;
  }
  const stale = readsAreStale(command.error) && command.variables?.seen_fingerprint === d.fingerprint;
  const currentStepIdx = d.route.findIndex(step => step.state === "current");
  const currentStep = currentStepIdx >= 0 ? d.route[currentStepIdx] : undefined;
  const stepMeta = currentStep
    ? [
        `${currentStepIdx + 1} ${currentStep.label}`,
        currentStep.assignee,
        d.revision > 1 ? t("approvals.viewer.revision", { revision: d.revision }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : d.revision > 1
      ? t("approvals.viewer.revision", { revision: d.revision })
      : undefined;
  const dueDate = d.due_at ? fmtDate(d.due_at.slice(0, 10)) : d.facts.find(fact => fact.key === "due")?.value;
  const relatedLinks = docked && showRelated ? relatedApprovalLinks(d) : [];

  return (
    <>
      <ApprovalCard
        docked={docked}
        eyebrow={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
        step={currentStep ? t("orgChange.turn", { role: currentStep.label }) : undefined}
        due={docked && dueDate ? t("approvals.console.due", { date: dueDate }) : undefined}
        title={docked ? t("approvals.console.myDecision") : t("approvals.viewer.decision")}
        consequence={consequenceText(d.consequence)}
        rejectConsequence={reject ? consequenceText(reject.consequence) : ""}
        approveLabel={commitLabel({ kind: "entityRecord", mode: "approve" })}
        rejectLabel={t("uiApprovalCard.reject")}
        {...(reject && actions.return
          ? {
              returnLabel: t("uiApprovalCard.return"),
              returnConsequence: consequenceText(actions.return.consequence),
              onReturn: () => submit("RETURN"),
            }
          : { returnLabel: undefined, returnConsequence: undefined, onReturn: undefined })}
        reason={form =>
          reject && (form === "reject" || actions.return) ? (
            <ReasonField
              label={t("approvals.viewer.reason")}
              codes={catalog[form].codes}
              other={catalog[form].other}
              value={reasons[form]}
              onChange={reason => setReasons(current => ({ ...current, [form]: reason }))}
              memoMax={NOTE_MAX}
            />
          ) : null
        }
        reasonComplete={form => Boolean(reject) && catalog[form].codes.length > 0 && reasonProblem(reasons[form], catalog[form].other) === null}
        onApprove={() => submit("APPROVE")}
        onReject={() => submit("REJECT")}
        pending={
          command.isPending
            ? command.variables?.decision === "REJECT"
              ? "reject"
              : command.variables?.decision === "RETURN"
                ? "return"
                : "approve"
            : undefined
        }
        approveBlocked={stale ? t("approvals.viewer.changed") : undefined}
        staleBlocked={stale ? t("approvals.viewer.changed") : undefined}
        meta={docked ? stepMeta : t("approvals.viewer.revision", { revision: d.revision })}
        receipt={receiptMessage}
        next={
          receipt && showNext ? (
            <Link to="/approvals" search={{}} className={buttonClass("secondary", { size: "sm" })}>
              {t("approvals.title")}
            </Link>
          ) : undefined
        }
      >
        <CommandError error={command.error} own={ownError} />
        <Field label={t("approvals.viewer.opinion")} required={false} hint={docked ? undefined : t("approvals.viewer.opinionHint")}>
          {props => <TextArea {...props} maxLength={d.opinion_max} value={opinion} onChange={event => setOpinion(event.target.value)} />}
        </Field>
      </ApprovalCard>
      {relatedLinks.length > 0 ? (
        <>
          <PaneHead title={t("approvals.related.title")} meta={t("approvals.related.meta")} level={3} />
          <DocLinkList>
            {relatedLinks.map(link => (
              <Link
                key={link.key}
                to={link.to as never}
                params={("params" in link ? link.params : undefined) as never}
                search={("search" in link ? link.search : undefined) as never}
                target="_blank"
                rel="noopener noreferrer"
                className={docLinkClass}
              >
                <DocLinkContent kind={link.kind} label={link.label} />
              </Link>
            ))}
          </DocLinkList>
        </>
      ) : null}
    </>
  );
}
