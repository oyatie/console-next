// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import {
  WorklistMoreBar,
  WorklistPadded,
  WorklistSection,
  WorklistSummaryHead,
} from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import type { ApprovalDocument, ApprovalItem } from "../api";
import { approvalRouteSteps, proposalDiffs } from "../present";
import { ApprovalDecisionPanel, ApprovalFactsContent } from "./approval-viewer";
import s from "./approvals-page.module.css";

export function ConsoleApprovalsTable({ items, sel, onSelect, hasNext, loadingMore, onMore, emptyTitle }: {
  items: ApprovalItem[];
  sel?: string;
  onSelect: (id: string) => void;
  hasNext?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  emptyTitle: string;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} reason={t("approvals.empty.reason")} />;
  }
  return (
    <div className={s.consoleTable}>
      <Table
        label={t("approvals.list")}
        density="compact"
        mobileLayout="compact"
        rows={items}
        rowId={item => item.id}
        selected={sel}
        onSelect={onSelect}
        columns={[
          {
            header: t("approvals.col.status"),
            card: "status",
            fit: true,
            cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip>,
          },
          {
            header: t("approvals.field.documentNo"),
            card: "omit",
            fit: true,
            wide: true,
            cell: item => <bdi className="num muted" title={item.document_no ?? "—"}>{item.document_no ?? "—"}</bdi>,
          },
          {
            header: t("approvals.col.title"),
            card: "fact",
            cell: item => <bdi className={s.consoleTitle} title={item.title}>{item.title}</bdi>,
          },
          {
            header: t("approvals.col.source"),
            card: "title",
            fit: true,
            cell: item => {
              const phoneMeta = [
                item.document_no,
                item.source.label,
                item.requester?.name,
                item.effective_date ? fmtDate(item.effective_date) : null,
              ].filter(Boolean).join(" · ");
              return <>
                <bdi className={s.consoleDesktopSource}>{item.source.label}</bdi>
                <bdi className={s.consolePhoneMeta} title={phoneMeta}>{phoneMeta}</bdi>
              </>;
            },
          },
          {
            header: t("approvals.preview.route"),
            card: "omit",
            fit: true,
            wide: true,
            cell: item => item.route.length
              ? <div className={s.route}><ChainStepper variant="chips" label={t("approvals.preview.route")} steps={item.route.map(step => ({ key: step.id, state: step.state, who: step.state === "current" ? [step.label, step.assignee].filter(Boolean).join(" · ") : step.assignee ?? step.label }))} /></div>
              : "—",
          },
          {
            header: t("approvals.col.requester"),
            card: "omit",
            fit: true,
            wide: true,
            cell: item => item.requester?.name ?? "—",
          },
          {
            header: t("approvals.col.requestedAt"),
            card: "omit",
            fit: true,
            wide: true,
            cell: item => <time className="num muted" dateTime={item.requested_at}>{fmtDate(item.requested_at.slice(0, 10))}</time>,
          },
          {
            header: t("home.worklist.col.action"),
            card: "action",
            fit: true,
            cell: item => (
              <div role="presentation" onClick={e => e.stopPropagation()}>
                <Link to="/approvals/$approvalId" params={{ approvalId: item.id }} className={buttonClass("secondary", { size: "sm" })}>
                  {t("home.inbox.open")}
                </Link>
              </div>
            ),
          },
        ]}
      />
      {hasNext && (
        <WorklistMoreBar>
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={onMore}>
            <ChevronDown size={14} aria-hidden="true" />
            {t("approvals.more")}
          </Button>
        </WorklistMoreBar>
      )}
    </div>
  );
}

export function ConsoleApprovalSideView({ document: d }: { document: ApprovalDocument }) {
  const diffs = proposalDiffs(d);
  const nonProposalBody = d.body.filter(item => !item.key.startsWith("proposal-"));
  return (
    <div className={s.consoleBody}>
      <WorklistSummaryHead
        kicker={[d.source.label, d.document_no].filter(Boolean).join(" · ")}
        title={d.title}
        status={<Chip tone={d.status.tone}>{d.status.label}</Chip>}
      />
      <WorklistSection padded>
        <ApprovalFactsContent document={d} dense includeDocNo />
      </WorklistSection>
      {diffs.length > 0 && (
        <WorklistSection>
          <PaneHead title={t("approvals.field.proposal")} level={3} />
          <ChangeRows items={diffs} />
        </WorklistSection>
      )}
      {d.route.length > 0 && (
        <WorklistSection>
          <PaneHead title={t("approvals.preview.route")} level={3} />
          <WorklistPadded>
            <ChainStepper label={t("approvals.preview.route")} steps={approvalRouteSteps(d)} />
          </WorklistPadded>
        </WorklistSection>
      )}
      {(d.summary && d.summary !== d.title) || nonProposalBody.length > 0 || (diffs.length === 0 && d.body.length > 0) ? (
        <WorklistSection>
          <PaneHead title={t("approvals.viewer.body")} level={3} />
          <WorklistPadded>
            {d.summary && d.summary !== d.title ? <div>{d.summary}</div> : null}
            <KeyValue readOnly items={diffs.length > 0 ? nonProposalBody : d.body} />
          </WorklistPadded>
        </WorklistSection>
      ) : null}
      <ApprovalDecisionPanel key={d.id} document={d} />
    </div>
  );
}
