// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCachedInfinitePages } from "../../../lib/react/cached-pages";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { DocumentDecision } from "../../../ui/patterns/document-decision";
import {
  DocBodyText,
  DocHeader,
  DocQueueStepper,
  DocRailBody,
  DocRailSection,
  DocSection,
} from "../../../ui/patterns/document-decision-parts";
import type { ApprovalPage } from "@console/api/pending";
import { approvalDocumentQuery, type ApprovalDocument } from "../api";
import { approvalRouteSteps, decisionRefusalText, proposalDiffs } from "../present";
import { ApprovalDecisionPanel } from "./approval-decision-panel";
export { ApprovalDecisionPanel };
import { useApprovalDecisionCommand } from "./use-approval-decision";
import { SourceViewerLink } from "./source-viewer-link";

const route = getRouteApi("/app/approvals/$approvalId");

export function ApprovalFactsContent({ document: d, dense = false, includeDocNo = d.my_actions.kind === "none", includeSource = false }: {
  document: ApprovalDocument;
  dense?: boolean;
  includeDocNo?: boolean;
  includeSource?: boolean;
}) {
  const formatFactDate = (iso: string) => (dense ? fmtDate(iso.slice(0, 10)) : fmtDateTime(iso));
  const extraFacts = dense ? d.facts.filter(fact => fact.key !== "source") : d.facts;
  return <>
    {d.decision_refusal && <Banner tone="warn" title={t("approvals.field.verification")}>{decisionRefusalText(d.decision_refusal)}</Banner>}
    <KeyValue density={dense ? "dense" : undefined} readOnly items={[
      ...(d.document_no && includeDocNo ? [{ key: "number", label: t("approvals.field.documentNo"), value: d.document_no }] : []),
      ...(includeSource ? [{ key: "source", label: t("approvals.col.source"), value: d.source.label }] : []),
      { key: "requester", label: t("approvals.field.requester"), value: [d.requester?.name, d.requester?.role].filter(Boolean).join(" · ") || "—" },
      { key: "requested", label: t("approvals.field.requestedAt"), value: formatFactDate(d.requested_at) },
      ...(d.due_at ? [{ key: "due", label: t("approvals.field.dueAt"), value: formatFactDate(d.due_at) }] : []),
      ...extraFacts,
    ]} />
  </>;
}

function stepProgressLabel(d: ApprovalDocument) {
  if (d.route.length === 0) return d.status.label;
  const idx = d.route.findIndex(step => step.state === "current");
  return idx >= 0 ? t("approvals.console.stepProgress", { status: d.status.label, n: idx + 1, total: d.route.length }) : d.status.label;
}

function useApprovalQueueContext(approvalId: string) {
  const pages = useCachedInfinitePages<ApprovalPage>("/api/v1/approvals");
  if (pages.length === 0) return null;
  const items = pages.flatMap(page => page.items);
  const idx = items.findIndex(item => item.id === approvalId);
  if (idx < 0) return null;
  const box = items[idx]!.box;
  const total = Math.max(items.length, pages[0]?.counts[box] ?? items.length);
  return {
    index: idx + 1,
    total,
    prevId: idx > 0 ? items[idx - 1]!.id : undefined,
    nextId: idx + 1 < items.length ? items[idx + 1]!.id : undefined,
  };
}

export function ApprovalViewerPage() {
  const { approvalId } = route.useParams();
  const q = useQuery({ ...approvalDocumentQuery(approvalId), refetchOnMount: "always" });
  const [receiptState, setReceiptState] = useState<{ id: string; text: string }>();
  const decision = useApprovalDecisionCommand(approvalId, text => setReceiptState({ id: approvalId, text }));
  const queueCtx = useApprovalQueueContext(approvalId);
  const d = q.data;
  const receipt = d && receiptState?.id === d.id ? receiptState.text : undefined;
  const showDecision = Boolean(
    d && ((d.my_actions.kind === "approve" && d.my_actions.reject) || receipt || decision.command.isPending || decision.command.error),
  );
  const diffs = d ? proposalDiffs(d) : [];
  const nonProposalBody = d ? d.body.filter(item => !item.key.startsWith("proposal-")) : [];
  const hasSummary = Boolean(d?.summary && d.summary !== d.title);
  const hasBody = Boolean(d && (nonProposalBody.length > 0 || (diffs.length === 0 && d.body.length > 0)));
  const summaryNum = diffs.length > 0 ? 2 : 1;
  const bodyNum = (diffs.length > 0 ? 1 : 0) + (hasSummary ? 1 : 0) + 1;
  const dueText = d?.due_at ? fmtDate(d.due_at.slice(0, 10)) : d?.facts.find(fact => fact.key === "due")?.value;

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
          {queueCtx ? (
            <DocQueueStepper
              prev={
                queueCtx.prevId ? (
                  <Link
                    to="/approvals/$approvalId"
                    params={{ approvalId: queueCtx.prevId }}
                    className={buttonClass("secondary", { size: "sm", icon: true })}
                    aria-label={t("approvals.console.prevDoc")}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </Link>
                ) : (
                  <Button size="sm" icon disabled aria-label={t("approvals.console.prevDoc")}>
                    <ChevronLeft size={14} aria-hidden="true" />
                  </Button>
                )
              }
              label={t("approvals.console.queuePos", { n: queueCtx.index, total: queueCtx.total })}
              next={
                queueCtx.nextId ? (
                  <Link
                    to="/approvals/$approvalId"
                    params={{ approvalId: queueCtx.nextId }}
                    className={buttonClass("secondary", { size: "sm", icon: true })}
                    aria-label={t("approvals.console.nextDoc")}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                ) : (
                  <Button size="sm" icon disabled aria-label={t("approvals.console.nextDoc")}>
                    <ChevronRight size={14} aria-hidden="true" />
                  </Button>
                )
              }
            />
          ) : null}
          {d.document_no && <bdi className="num t-semibold">{d.document_no}</bdi>}
          <bdi>{d.source.label}</bdi>
          <Chip tone={d.status.tone}>{stepProgressLabel(d)}</Chip>
        </>,
        actions: d && <>
          <Link to="/approvals" search={{}} className={buttonClass("secondary", { size: "sm" })}>{t("approvals.title")}</Link>
          <SourceViewerLink viewer={d.viewer} size="sm" />
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
      decisionLabel={t("approvals.console.myDecision")}
      decision={
        showDecision && d ? (
          <ApprovalDecisionPanel
            key={d.id}
            document={d}
            receipt={receipt}
            onReceipt={text => setReceiptState({ id: d.id, text })}
            showNext
            docked
            showRelated
            controller={decision}
          />
        ) : null
      }
      statusSegments={d ? [
        ...(d.document_no ? [{ id: "doc", tone: "strong" as const, content: d.document_no }] : []),
        { id: "status", content: stepProgressLabel(d) },
        ...(dueText ? [{ id: "due", tone: "attention" as const, content: t("approvals.console.due", { date: dueText }) }] : []),
        ...(queueCtx ? [{ id: "queue", content: t("approvals.console.queuePos", { n: queueCtx.index, total: queueCtx.total }) }] : []),
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
