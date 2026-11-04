// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
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
import { SourceViewerLink } from "./source-viewer-link";

const route = getRouteApi("/app/approvals/$approvalId");
const emptyReason = (): Reason => ({ code: null, memo: "" });

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
  type DecisionForm = "reject" | "return";
  const [opinion, setOpinion] = useState("");
  const [reasons, setReasons] = useState<Record<DecisionForm, Reason>>({ reject: emptyReason(), return: emptyReason() });
  const [receipt, setReceipt] = useState<string>();
  const command = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(d.id, body, key),
    invalidates: ["/api/v1/approvals"], settle: true,
    onSuccess: result => setReceipt(result.message),
    announce: result => result.message,
  });
  const submit = (decision: ApprovalDecision["decision"]) => {
    const decisionForm = decision === "REJECT" ? "reject" : decision === "RETURN" ? "return" : undefined;
    const reason = decisionForm ? reasons[decisionForm] : undefined;
    command.mutate({
      decision, seen_fingerprint: d.fingerprint, opinion: opinion.trim(),
      ...(reason?.code ? { reason_code: reason.code, ...(reason.memo.trim() ? { note: reason.memo.trim() } : {}) } : {}),
    });
  };
  const actions = d.my_actions;
  if (actions.kind === "none") return receipt ? <Card><p role="status">{receipt}</p></Card> : null;
  const reasonAction = (form: DecisionForm) => form === "reject" ? actions.reject : actions.return;
  const stale = readsAreStale(command.error) && command.variables?.seen_fingerprint === d.fingerprint;
  return <ApprovalCard
    eyebrow={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
    step={d.route.find(step => step.state === "current")?.label}
    title={t("approvals.viewer.decision")}
    consequence={d.consequence}
    rejectConsequence={actions.reject.consequence}
    approveLabel={commitLabel({ kind: "entityRecord", mode: "approve" })}
    rejectLabel={t("uiApprovalCard.reject")}
    {...(actions.return ? { returnLabel: t("uiApprovalCard.return"), returnConsequence: actions.return.consequence, onReturn: () => submit("RETURN") } : { returnLabel: undefined, returnConsequence: undefined, onReturn: undefined })}
    reason={form => {
      const action = reasonAction(form);
      return action && <ReasonField label={t("approvals.viewer.reason")} codes={action.reason.codes} other={action.reason.other} value={reasons[form]}
        onChange={reason => setReasons(current => ({ ...current, [form]: reason }))} memoMax={action.reason.memo_max} />;
    }}
    reasonComplete={form => {
      const action = reasonAction(form);
      return Boolean(action && reasonProblem(reasons[form], action.reason.other) === null);
    }}
    onApprove={() => submit("APPROVE")}
    onReject={() => submit("REJECT")}
    pending={command.isPending ? command.variables?.decision === "REJECT" ? "reject" : command.variables?.decision === "RETURN" ? "return" : "approve" : undefined}
    approveBlocked={stale ? t("approvals.viewer.changed") : undefined}
    meta={t("approvals.viewer.revision", { revision: d.revision })}
    receipt={receipt && <p role="status">{receipt}</p>}
  >
    <CommandError error={command.error} own={code => code === "approval_document_changed" ? t("approvals.viewer.changed") : undefined} />
    <Field label={t("approvals.viewer.opinion")} required={false} hint={t("approvals.viewer.opinionHint")}>
      {props => <TextArea {...props} maxLength={d.opinion_max} value={opinion} onChange={event => setOpinion(event.target.value)} />}
    </Field>
  </ApprovalCard>;
}
