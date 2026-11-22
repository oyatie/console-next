// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChangeRows } from "../../../ui/change-rows/change-rows";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { docLinkClass } from "../../../ui/patterns/document-decision-link";
import { DocLinkContent, DocLinkList } from "../../../ui/patterns/document-decision-parts";
import {
  WorklistChain,
  WorklistMoreBar,
  WorklistPadded,
  WorklistSection,
  WorklistSummaryHead,
  type WorklistChainStep,
} from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import type { ApprovalDocument, ApprovalItem } from "../api";
import { approvalRouteSteps, proposalDiffs, relatedApprovalLinks } from "../present";
import { ApprovalFactsContent } from "./approval-viewer";
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
            cell: item => {
              if (!item.route.length) return "—";
              const fullRoute = item.route
                .map(step => `${t(`uiChainStepper.state.${step.state}`)} ${[step.label, step.assignee].filter(Boolean).join(" · ")}`.trim())
                .join(" → ");
              const idx = item.route.findIndex(step => step.state === "current" || step.state === "failed");
              const summary =
                idx >= 0
                  ? t("approvals.console.routeStep", {
                      n: idx + 1,
                      total: item.route.length,
                      who: item.route[idx]!.assignee?.split(" · ")[0] ?? item.route[idx]!.label,
                      state: item.route[idx]!.state === "failed" ? t("home.inbox.outcome.REJECTED") : t("orgChange.chain.current"),
                    })
                  : t("approvals.console.routeDone", { total: item.route.length });
              return (
                <bdi className={`${s.consoleRoute} muted`} title={fullRoute}>
                  {summary}
                </bdi>
              );
            },
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
  const proposalNames = Object.values(d.proposal_names ?? {}).filter(Boolean);
  const hasSummary = Boolean(d.summary && d.summary !== d.title);
  const bodyItems = d.body.filter(item => {
    if (item.key.startsWith("proposal-")) return false;
    if (hasSummary && item.value === d.summary) return false;
    if (diffs.length > 0 && proposalNames.some(name => item.label.includes(name) || item.value.includes(name))) {
      return false;
    }
    return true;
  });
  const detailItems = [
    ...(hasSummary ? [{ key: "reason", label: t("home.inbox.record.reason"), value: d.summary! }] : []),
    ...bodyItems,
  ];
  const routeSteps = approvalRouteSteps(d);
  const chainSteps: WorklistChainStep[] = d.route.map((step, index) => ({
    key: step.id,
    role: `${index + 1} ${step.label}`,
    actor: step.assignee ?? step.label,
    meta: routeSteps[index]?.meta ?? "",
    state: step.state,
  }));
  const relatedLinks = relatedApprovalLinks(d);
  return (
    <div className={s.consoleBody}>
      <WorklistSummaryHead
        kicker={
          <div className={s.consoleKicker}>
            <bdi>{d.source.label}</bdi>
            <Chip tone={d.status.tone}>{d.status.label}</Chip>
          </div>
        }
        title={d.title}
      />
      <WorklistSection padded>
        <ApprovalFactsContent document={d} dense includeDocNo={false} columns={2} />
      </WorklistSection>
      {diffs.length > 0 && (
        <WorklistSection>
          <PaneHead title={t("approvals.field.proposal")} level={3} />
          <ChangeRows items={diffs} />
        </WorklistSection>
      )}
      {chainSteps.length > 0 && (
        <WorklistSection>
          <PaneHead title={t("approvals.preview.route")} level={3} />
          <WorklistChain label={t("approvals.preview.route")} steps={chainSteps} />
        </WorklistSection>
      )}
      {detailItems.length > 0 ? (
        <WorklistSection>
          <PaneHead title={t("approvals.viewer.body")} level={3} />
          <WorklistPadded>
            <KeyValue density="dense" readOnly items={detailItems} />
          </WorklistPadded>
        </WorklistSection>
      ) : null}
      {relatedLinks.length > 0 ? (
        <WorklistSection>
          <PaneHead title={t("approvals.related.title")} meta={t("approvals.related.meta")} level={3} />
          <DocLinkList columns={2}>
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
        </WorklistSection>
      ) : null}
    </div>
  );
}
