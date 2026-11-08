// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { reasonCodesQuery, reasonOptions, type ReasonDomain } from "../../../lib/reason-codes";
import { readsAreStale, useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ApprovalCard } from "../../../ui/approval-card/approval-card";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { commitLabel } from "../../../ui/composer/actions";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { approvalDocumentQuery, decideApproval, type ApprovalDecision, type ApprovalDocument } from "../api";
import { decisionRefusalText } from "../present";
import { SourceViewerLink } from "./source-viewer-link";

const route = getRouteApi("/app/approvals/$approvalId");
const emptyReason = (): Reason => ({ code: null, memo: "" });
/** The longest note a reason takes (the reason catalog's own limit). */
const NOTE_MAX = 1000;
type DecisionForm = "reject" | "return";
type Receipt = Awaited<ReturnType<typeof decideApproval>>;

/** The words for a consequence key; a key this build does not know stays visible as itself. */
const consequenceText = (key: string) => { const id = `approvals.consequence.${key}`; return isMessageId(id) ? t(id) : key; };
/** What was recorded, from the decision and the document's status after it. */
const receiptText = (r: Receipt) =>
  r.decision === "REJECTED" ? t("approvals.receipt.rejected")
  : r.decision === "APPROVED" ? t(r.status === "IN_APPROVAL" ? "approvals.receipt.approvedNext" : "approvals.receipt.approvedFinal")
  : t("approvals.receipt.recorded");

/** The reasons of one decision, from the catalog domain the server names. */
function useDecisionReasons(domain: string | undefined) {
  const known = domain as ReasonDomain | undefined;
  const q = useQuery({ ...reasonCodesQuery(known ?? "org_change_reject"), enabled: Boolean(known) });
  const options = known ? reasonOptions(known, q.data?.items) : [];
  // The catalog marks which code needs a written note; the field takes one such code.
  return { codes: options.map(o => ({ code: o.value, label: o.label })), other: options.find(o => o.requiresNote)?.value ?? "OTHER" };
}

export function ApprovalViewerPage() {
  const { approvalId } = route.useParams();
  const q = useQuery({ ...approvalDocumentQuery(approvalId), refetchOnMount: "always" });
  return <Page floorplan="P-02" head={{
    title: q.data?.title ?? t("approvals.document.title"), band: true,
    meta: q.data && <><Chip>{q.data.source.label}</Chip><Chip tone={q.data.status.tone}>{q.data.status.label}</Chip></>,
    tools: q.data && <SourceViewerLink viewer={q.data.viewer} />,
  }} q={q} layout="record" back={{ to: "/approvals", label: t("approvals.title") }}>
    {document => <ApprovalDocumentView document={document} />}
  </Page>;
}

export function ApprovalDocumentView({ document: d }: { document: ApprovalDocument }) {
  return <div className="form">
    <Card title={t("approvals.preview.route")}>
      <ChainStepper label={t("approvals.preview.route")} steps={d.route.map(step => ({ key: step.id, who: [step.label, step.assignee].filter(Boolean).join(" · "), state: step.state, meta: step.meta }))} />
    </Card>
    <Card title={t("approvals.preview.facts")}>
      <KeyValue readOnly items={[
        ...(d.decision_refusal ? [{ key: "decision-refusal", label: t("approvals.field.verification"),
          value: decisionRefusalText(d.decision_refusal) }] : []),
        ...(d.document_no && d.my_actions.kind === "none" ? [{ key: "number", label: t("approvals.field.documentNo"), value: d.document_no }] : []),
        { key: "requester", label: t("approvals.field.requester"), value: [d.requester?.name, d.requester?.role].filter(Boolean).join(" · ") || "—" },
        { key: "requested", label: t("approvals.field.requestedAt"), value: fmtDateTime(d.requested_at) },
        ...(d.due_at ? [{ key: "due", label: t("approvals.field.dueAt"), value: fmtDateTime(d.due_at) }] : []),
        ...d.facts,
      ]} />
    </Card>
    <Card title={t("approvals.viewer.body")}>
      <p>{d.summary}</p>
      <KeyValue readOnly items={d.body} />
    </Card>
    <ApprovalDecisionPanel key={d.id} document={d} />
  </div>;
}

function ApprovalDecisionPanel({ document: d }: { document: ApprovalDocument }) {
  const [opinion, setOpinion] = useState("");
  const [reasons, setReasons] = useState<Record<DecisionForm, Reason>>({ reject: emptyReason(), return: emptyReason() });
  const [receipt, setReceipt] = useState<string>();
  const command = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(d.id, body, key),
    invalidates: ["/api/v1/approvals"], settle: true,
    onSuccess: result => setReceipt(receiptText(result)),
    announce: receiptText,
  });
  const actions = d.my_actions;
  const catalog = { reject: useDecisionReasons(actions.reject?.reason_domain), return: useDecisionReasons(actions.return?.reason_domain) };
  const submit = (decision: ApprovalDecision["decision"]) => {
    const decisionForm = decision === "REJECT" ? "reject" : decision === "RETURN" ? "return" : undefined;
    const reason = decisionForm ? reasons[decisionForm] : undefined;
    command.mutate({
      decision, seen_fingerprint: d.fingerprint, opinion: opinion.trim(),
      ...(reason?.code ? { reason_code: reason.code, ...(reason.memo.trim() ? { note: reason.memo.trim() } : {}) } : {}),
    });
  };
  // Only the action the server offers is drawn; nothing is inferred from the document's status.
  const reject = actions.kind === "approve" ? actions.reject : undefined;
  if (!reject) return receipt ? <Card><p role="status">{receipt}</p></Card> : null;
  const stale = readsAreStale(command.error) && command.variables?.seen_fingerprint === d.fingerprint;
  return <ApprovalCard
    eyebrow={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
    step={d.route.find(step => step.state === "current")?.label}
    title={t("approvals.viewer.decision")}
    consequence={consequenceText(d.consequence)}
    rejectConsequence={consequenceText(reject.consequence)}
    approveLabel={commitLabel({ kind: "entityRecord", mode: "approve" })}
    rejectLabel={t("uiApprovalCard.reject")}
    {...(actions.return ? { returnLabel: t("uiApprovalCard.return"), returnConsequence: consequenceText(actions.return.consequence), onReturn: () => submit("RETURN") } : { returnLabel: undefined, returnConsequence: undefined, onReturn: undefined })}
    reason={form => (form === "reject" || actions.return) && <ReasonField label={t("approvals.viewer.reason")} codes={catalog[form].codes} other={catalog[form].other} value={reasons[form]}
      onChange={reason => setReasons(current => ({ ...current, [form]: reason }))} memoMax={NOTE_MAX} />}
    reasonComplete={form => catalog[form].codes.length > 0 && reasonProblem(reasons[form], catalog[form].other) === null}
    onApprove={() => submit("APPROVE")}
    onReject={() => submit("REJECT")}
    pending={command.isPending ? command.variables?.decision === "REJECT" ? "reject" : command.variables?.decision === "RETURN" ? "return" : "approve" : undefined}
    approveBlocked={stale ? t("approvals.viewer.changed") : undefined}
    meta={t("approvals.viewer.revision", { revision: d.revision })}
    receipt={receipt && <p role="status">{receipt}</p>}
  >
    <CommandError error={command.error} own={code => code === "approval_document_changed" ? t("approvals.viewer.changed") : code === "approval_decision_unavailable" ? t("approvals.viewer.unavailable") : undefined} />
    <Field label={t("approvals.viewer.opinion")} required={false} hint={t("approvals.viewer.opinionHint")}>
      {props => <TextArea {...props} maxLength={d.opinion_max} value={opinion} onChange={event => setOpinion(event.target.value)} />}
    </Field>
  </ApprovalCard>;
}
