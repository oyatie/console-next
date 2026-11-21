// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { reasonCodesQuery, reasonOptions, type ReasonDomain } from "../../../lib/reason-codes";
import { readsAreStale, useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ApprovalCard } from "../../../ui/approval-card/approval-card";
import { Banner } from "../../../ui/banner/banner";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { commitLabel } from "../../../ui/composer/actions";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { DocumentDecision } from "../../../ui/patterns/document-decision";
import {
  DocBodyText,
  DocHeader,
  DocRailBody,
  DocRailSection,
  DocSection,
} from "../../../ui/patterns/document-decision-parts";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { approvalDocumentQuery, decideApproval, type ApprovalDecision, type ApprovalDocument } from "../api";
import { approvalRouteSteps, decisionRefusalText, proposalDiffs } from "../present";
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

export function ApprovalFactsContent({ document: d, dense = false, includeDocNo = d.my_actions.kind === "none", includeSource = false }: {
  document: ApprovalDocument;
  dense?: boolean;
  includeDocNo?: boolean;
  includeSource?: boolean;
}) {
  return <>
    {d.decision_refusal && <Banner tone="warn" title={t("approvals.field.verification")}>{decisionRefusalText(d.decision_refusal)}</Banner>}
    <KeyValue density={dense ? "dense" : undefined} readOnly items={[
      ...(d.document_no && includeDocNo ? [{ key: "number", label: t("approvals.field.documentNo"), value: d.document_no }] : []),
      ...(includeSource ? [{ key: "source", label: t("approvals.col.source"), value: d.source.label }] : []),
      { key: "requester", label: t("approvals.field.requester"), value: [d.requester?.name, d.requester?.role].filter(Boolean).join(" · ") || "—" },
      { key: "requested", label: t("approvals.field.requestedAt"), value: fmtDateTime(d.requested_at) },
      ...(d.due_at ? [{ key: "due", label: t("approvals.field.dueAt"), value: fmtDateTime(d.due_at) }] : []),
      ...d.facts,
    ]} />
  </>;
}

function stepProgressLabel(d: ApprovalDocument) {
  if (d.route.length === 0) return d.status.label;
  const idx = d.route.findIndex(step => step.state === "current");
  return idx >= 0 ? t("approvals.console.stepProgress", { status: d.status.label, n: idx + 1, total: d.route.length }) : d.status.label;
}

export function ApprovalViewerPage() {
  const { approvalId } = route.useParams();
  const q = useQuery({ ...approvalDocumentQuery(approvalId), refetchOnMount: "always" });
  const [receiptState, setReceiptState] = useState<{ id: string; text: string }>();
  const d = q.data;
  const receipt = d && receiptState?.id === d.id ? receiptState.text : undefined;
  const showDecision = Boolean(d && (d.my_actions.kind === "approve" || receipt));
  const diffs = d ? proposalDiffs(d) : [];
  const nonProposalBody = d ? d.body.filter(item => !item.key.startsWith("proposal-")) : [];
  const hasSummary = Boolean(d?.summary && d.summary !== d.title);
  const hasBody = Boolean(d && (nonProposalBody.length > 0 || (diffs.length === 0 && d.body.length > 0)));
  const summaryNum = diffs.length > 0 ? 2 : 1;
  const bodyNum = (diffs.length > 0 ? 1 : 0) + (hasSummary ? 1 : 0) + 1;

  return (
    <DocumentDecision
      q={q}
      baseline={() => <Page floorplan="P-02" head={{
        title: q.data?.title ?? t("approvals.document.title"), band: true,
        meta: q.data && <><Chip>{q.data.source.label}</Chip><Chip tone={q.data.status.tone}>{q.data.status.label}</Chip></>,
        tools: q.data && <SourceViewerLink viewer={q.data.viewer} />,
      }} q={q} layout="record" back={{ to: "/approvals", label: t("approvals.title") }}>
        {document => <ApprovalDocumentView document={document} />}
      </Page>}
      head={{
        title: t("approvals.console.title"),
        titleId: "approval-viewer-title",
        meta: d && <>
          {d.document_no && <bdi className="num t-semibold">{d.document_no}</bdi>}
          <bdi>{d.source.label}</bdi>
          <Chip tone={d.status.tone}>{stepProgressLabel(d)}</Chip>
        </>,
        actions: d && <>
          <Link to="/approvals" search={{}} className={buttonClass("secondary", { size: "sm" })}>{t("approvals.title")}</Link>
          <SourceViewerLink viewer={d.viewer} />
        </>,
      }}
      start={d && <>
        <DocRailSection label={t("approvals.preview.facts")}>
          <PaneHead title={t("approvals.preview.facts")} />
          <DocRailBody>
            <ApprovalFactsContent document={d} dense includeDocNo includeSource />
          </DocRailBody>
        </DocRailSection>
        {d.route.length > 0 && <DocRailSection label={t("approvals.preview.route")}>
          <PaneHead title={t("approvals.preview.route")} />
          <DocRailBody>
            <ChainStepper label={t("approvals.preview.route")} steps={approvalRouteSteps(d)} />
          </DocRailBody>
        </DocRailSection>}
      </>}
      document={d && <>
        <DocHeader
          kicker={d.source.label}
          title={d.title}
          meta={[
            d.requester?.name ? `${t("approvals.field.requester")} ${[d.requester.name, d.requester.role].filter(Boolean).join(" ")}` : null,
            `${t("approvals.field.requestedAt")} ${fmtDate(d.requested_at.slice(0, 10))}`,
            d.effective_date ? `${t("approvals.field.effectiveDate")} ${fmtDate(d.effective_date)}` : null,
          ].filter(Boolean).join(" · ")}
        />
        {diffs.length > 0 && <DocSection label={t("approvals.field.proposal")} title={`1. ${t("approvals.field.proposal")}`}>
          <ChangeRows items={diffs} />
        </DocSection>}
        {hasSummary && d && <DocSection label={t("home.inbox.record.reason")} title={`${summaryNum}. ${t("home.inbox.record.reason")}`}>
          <DocBodyText>{d.summary}</DocBodyText>
        </DocSection>}
        {hasBody && d && (
          <DocSection label={t("approvals.viewer.body")} title={`${bodyNum}. ${t("approvals.viewer.body")}`}>
            <KeyValue readOnly items={diffs.length > 0 ? nonProposalBody : d.body} />
          </DocSection>
        )}
      </>}
      decisionLabel={t("approvals.viewer.decision")}
      decision={showDecision && d ? <ApprovalDecisionPanel key={d.id} document={d} receipt={receipt} onReceipt={text => setReceiptState({ id: d.id, text })} showNext /> : null}
      statusSegments={d ? [
        ...(d.document_no ? [{ id: "doc", tone: "strong" as const, content: d.document_no }] : []),
        { id: "status", content: stepProgressLabel(d) },
        ...(d.due_at ? [{ id: "due", tone: "attention" as const, content: t("approvals.console.due", { date: fmtDate(d.due_at.slice(0, 10)) }) }] : []),
      ] : null}
    />
  );
}

export function ApprovalDocumentView({ document: d }: { document: ApprovalDocument }) {
  return <div className="form">
    {d.route.length > 0 && <Card title={t("approvals.preview.route")}>
      <ChainStepper label={t("approvals.preview.route")} steps={approvalRouteSteps(d)} />
    </Card>}
    <Card title={t("approvals.preview.facts")}>
      <ApprovalFactsContent document={d} />
    </Card>
    <Card title={t("approvals.viewer.body")}>
      <p>{d.summary}</p>
      <KeyValue readOnly items={d.body} />
    </Card>
    <ApprovalDecisionPanel key={d.id} document={d} />
  </div>;
}

export function ApprovalDecisionPanel({ document: d, receipt: controlledReceipt, onReceipt, showNext = false }: {
  document: ApprovalDocument;
  receipt?: string;
  onReceipt?: (text: string) => void;
  showNext?: boolean;
}) {
  const [opinion, setOpinion] = useState("");
  const [reasons, setReasons] = useState<Record<DecisionForm, Reason>>({ reject: emptyReason(), return: emptyReason() });
  const [localReceipt, setLocalReceipt] = useState<string>();
  const receipt = controlledReceipt ?? localReceipt;
  const command = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(d.id, body, key),
    invalidates: ["/api/v1/approvals"], settle: true,
    onSuccess: result => {
      const text = receiptText(result);
      setLocalReceipt(text);
      onReceipt?.(text);
    },
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
  const receiptMessage = receipt && <p role="status">{receipt}</p>;
  if (!reject && !receipt) return null;
  const stale = readsAreStale(command.error) && command.variables?.seen_fingerprint === d.fingerprint;
  const currentStep = d.route.find(step => step.state === "current");
  return <ApprovalCard
    eyebrow={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
    step={currentStep ? t("orgChange.turn", { role: currentStep.label }) : undefined}
    title={t("approvals.viewer.decision")}
    consequence={consequenceText(d.consequence)}
    rejectConsequence={reject ? consequenceText(reject.consequence) : ""}
    approveLabel={commitLabel({ kind: "entityRecord", mode: "approve" })}
    rejectLabel={t("uiApprovalCard.reject")}
    {...(reject && actions.return ? { returnLabel: t("uiApprovalCard.return"), returnConsequence: consequenceText(actions.return.consequence), onReturn: () => submit("RETURN") } : { returnLabel: undefined, returnConsequence: undefined, onReturn: undefined })}
    reason={form => reject && (form === "reject" || actions.return) ? <ReasonField label={t("approvals.viewer.reason")} codes={catalog[form].codes} other={catalog[form].other} value={reasons[form]}
      onChange={reason => setReasons(current => ({ ...current, [form]: reason }))} memoMax={NOTE_MAX} /> : null}
    reasonComplete={form => Boolean(reject) && catalog[form].codes.length > 0 && reasonProblem(reasons[form], catalog[form].other) === null}
    onApprove={() => submit("APPROVE")}
    onReject={() => submit("REJECT")}
    pending={command.isPending ? command.variables?.decision === "REJECT" ? "reject" : command.variables?.decision === "RETURN" ? "return" : "approve" : undefined}
    approveBlocked={stale ? t("approvals.viewer.changed") : undefined}
    meta={t("approvals.viewer.revision", { revision: d.revision })}
    receipt={receiptMessage}
    next={receipt && showNext ? <Link to="/approvals" search={{}} className={buttonClass("secondary", { size: "sm" })}>{t("approvals.title")}</Link> : undefined}
  >
    <CommandError error={command.error} own={code => code === "approval_document_changed" ? t("approvals.viewer.changed") : code === "approval_decision_unavailable" ? decisionRefusalText(code) : undefined} />
    <Field label={t("approvals.viewer.opinion")} required={false} hint={t("approvals.viewer.opinionHint")}>
      {props => <TextArea {...props} maxLength={d.opinion_max} value={opinion} onChange={event => setOpinion(event.target.value)} />}
    </Field>
  </ApprovalCard>;
}
