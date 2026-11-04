// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { commitLabel } from "../../../ui/composer/actions";
import { Composer } from "../../../ui/composer/composer";
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
    tools: <><Link to="/approvals">{t("approvals.title")}</Link>{q.data && <SourceViewerLink viewer={q.data.viewer} />}</>,
  }} q={q} layout="record" back={{ to: "/approvals", label: t("approvals.title") }}>
    {document => <ApprovalDocumentView document={document} />}
  </Page>;
}

export function ApprovalDocumentView({ document: d }: { document: ApprovalDocument }) {
  return <div className="split" data-open="true">
    <div className="form">
      <Card title={t("approvals.viewer.summary")}>
        <KeyValue readOnly items={[
          ...(d.document_no ? [{ key: "number", label: t("approvals.field.documentNo"), value: d.document_no }] : []),
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
      {d.my_actions.kind === "approve" && <ApprovalDecisionPanel document={d} actions={d.my_actions} />}
    </div>
    <Card title={t("approvals.preview.route")}>
      <ChainStepper label={t("approvals.preview.route")} steps={d.route.map(step => ({ key: step.id, who: [step.label, step.assignee].filter(Boolean).join(" · "), state: step.state, meta: step.meta }))} />
    </Card>
  </div>;
}

function ApprovalDecisionPanel({ document: d, actions }: { document: ApprovalDocument; actions: Extract<ApprovalDocument["my_actions"], { kind: "approve" }> }) {
  type DecisionForm = "reject" | "return";
  const [opinion, setOpinion] = useState("");
  const [form, setForm] = useState<DecisionForm>();
  const [reasons, setReasons] = useState<Record<DecisionForm, Reason>>({ reject: emptyReason(), return: emptyReason() });
  const [receipt, setReceipt] = useState<string>();
  const command = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(d.id, body, key),
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
  const reasonAction = form === "reject" ? actions.reject : form === "return" ? actions.return : undefined;
  const complete = !form || Boolean(reasonAction && reasonProblem(reasons[form], reasonAction.reason.other) === null);
  const action = { kind: "entityRecord", mode: form ?? "approve" } as const;
  return <Composer layout="inline" headingLevel={2}
    kicker={d.document_no ?? d.source.label}
    subtitle={`${d.status.label} · ${t("approvals.viewer.revision", { revision: d.revision })}`}
    title={t("approvals.viewer.decision")}
    action={action}
    tone={form === "reject" ? "danger" : "primary"}
    pending={command.isPending}
    consequence={reasonAction?.consequence ?? d.consequence}
    blocked={!complete ? { reason: t("uiApprovalCard.reasonMissing") } : undefined}
    onSubmit={() => submit(form === "reject" ? "REJECT" : form === "return" ? "RETURN" : "APPROVE")}
    onClose={form ? () => setForm(undefined) : undefined}
    secondary={!form && <><Button onClick={() => setForm("reject")}>{commitLabel({ kind: "entityRecord", mode: "reject" })}</Button>
      {actions.return && <Button onClick={() => setForm("return")}>{commitLabel({ kind: "entityRecord", mode: "return" })}</Button>}</>}
    recovery={receipt && <p role="status">{receipt}</p>}
    notice={<CommandError error={command.error} />}
  >
    {form && reasonAction && <ReasonField label={t("approvals.viewer.reason")} codes={reasonAction.reason.codes} other={reasonAction.reason.other} value={reasons[form]}
      onChange={reason => setReasons(current => ({ ...current, [form]: reason }))} memoMax={reasonAction.reason.memo_max} />}
    <Field label={t("approvals.viewer.opinion")} required={false} hint={t("approvals.viewer.opinionHint")}>
      {props => <TextArea {...props} maxLength={d.opinion_max} value={opinion} onChange={event => setOpinion(event.target.value)} />}
    </Field>
  </Composer>;
}
