// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { COPY } from "../copy";
import { fetchOpsRunbookDoc, fetchOpsRunbooks, OpsApiError, opsQueryKeys } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { useIsPhone } from "../lib/use-is-phone";
import { Badge } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { PageHead } from "../ui/page-head";
import { PaneGrid } from "../ui/pane-grid";
import { SafeMarkdown } from "../ui/safe-markdown";
import { buildRunningTabs } from "./hub-tabs";
import s from "./runbooks-screen.module.css";

type DocMetaRow = { path: string; anchors: { slug: string; kind: "html_id" | "heading"; title?: string | null }[] };

function resolveRelativeRunbook(currentPath: string, target: string): string {
  const clean = target.replace(/^\/+/, "").replace(/^\.\//, "");
  if (target.startsWith("/") || clean.startsWith("docs/") || clean === "RUNBOOK.md") return clean;
  const dir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
  return `${dir}${clean}`;
}

export function RunbooksScreen({
  docParam,
  anchorParam,
  onSelectDoc,
}: {
  docParam?: string;
  anchorParam?: string;
  onSelectDoc: (doc: string | undefined, anchor?: string) => void;
}) {
  const { me, reportEvaluatedAt } = useOpsContext();
  const isPhone = useIsPhone();
  const allowed = hasOpsAction(me, "read.running");

  const listQuery = useQuery({
    queryKey: opsQueryKeys.runbooks,
    queryFn: fetchOpsRunbooks,
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const activePath =
    docParam ??
    (!isPhone
      ? (listQuery.data?.docs.find((d) => d.path === "RUNBOOK.md")?.path ?? listQuery.data?.docs[0]?.path)
      : undefined);

  const docQuery = useQuery({
    queryKey: opsQueryKeys.runbookDoc(activePath ?? ""),
    queryFn: () => fetchOpsRunbookDoc(activePath ?? ""),
    enabled: Boolean(allowed && activePath),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (docQuery.data?.evaluated_at) reportEvaluatedAt(docQuery.data.evaluated_at);
    else if (listQuery.data?.evaluated_at) reportEvaluatedAt(listQuery.data.evaluated_at);
  }, [docQuery.data?.evaluated_at, listQuery.data?.evaluated_at, reportEvaluatedAt]);

  useEffect(() => {
    if (!anchorParam || !docQuery.data) return;
    const el = document.getElementById(anchorParam);
    el?.scrollIntoView({ block: "start" });
  }, [anchorParam, docQuery.data]);

  if (!allowed) {
    return (
      <O0State
        model={classifyOpsError(
          new OpsApiError(403, {
            code: "OPS_ACTION_DENIED",
            message: "Runbooks view requires read.running permission.",
            support_ref: "cedar-running",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (listQuery.isPending) {
    return <div className={s.page}><PageHead title={COPY.running.title} meta={COPY.loading.runbooksTitle} tabs={buildRunningTabs("runbooks")} /></div>;
  }

  if (listQuery.isError || !listQuery.data) {
    return <O0State model={classifyOpsError(listQuery.error)} onRetry={() => void listQuery.refetch()} />;
  }

  const listData = listQuery.data;
  const staleWarning = docQuery.data?.stale_warning ?? listData.stale_warning;
  const bundleSha = docQuery.data?.bundle_sha ?? listData.bundle_sha;
  const deployedSha = docQuery.data?.deployed_sha ?? listData.deployed_sha;

  const cols: readonly TableColumn<DocMetaRow>[] = [
    { id: "path", header: COPY.runbooks.indexTitle, mobileSlot: "title", render: (r) => <code>{r.path}</code> },
    { id: "anchors", header: COPY.runbooks.anchorsTitle, mobileSlot: "badge", nowrap: true, align: "right", render: (r) => <Badge tone="outline">{String(r.anchors.length)}</Badge> },
    {
      id: "action",
      header: COPY.alerts.cols.action,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <button
          type="button"
          className="btn btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            onSelectDoc(r.path);
          }}
        >
          {COPY.alerts.inspect}
        </button>
      ),
    },
  ];

  const centerContent = (
    <div className={s.page}>
      <PageHead
        title={COPY.running.title}
        meta={bundleSha && deployedSha ? <span className={s.metaText}>{fmtJoin(COPY.runbooks.bundleSha, ": ", bundleSha, " · ", COPY.runbooks.deployedSha, ": ", deployedSha)}</span> : undefined}
        tabs={buildRunningTabs("runbooks")}
      />
      {staleWarning ? <div className={s.warnBanner} role="alert">{staleWarning}</div> : null}
      {listData.docs.length > 0 ? (
        <CompactTable
          caption={COPY.runbooks.indexTitle}
          rows={listData.docs}
          rowKey={(r) => r.path}
          columns={cols}
          selectedKey={activePath}
          onSelectRow={(r) => onSelectDoc(r.path)}
        />
      ) : (
        <p className={s.emptyNote}>{COPY.runbooks.empty}</p>
      )}
    </div>
  );

  const recordNode = activePath ? (
    docQuery.isPending ? (
      <p className={s.emptyNote}>{COPY.loading.runbooksTitle}</p>
    ) : docQuery.isError || !docQuery.data ? (
      <O0State model={classifyOpsError(docQuery.error)} onRetry={() => void docQuery.refetch()} />
    ) : (
      <div className={s.readerStack}>
        {isPhone ? (
          <div className={s.mobileBack}>
            <Link to="/runbooks" className="btn btn--sm">
              <ArrowLeft size={12} aria-hidden="true" />
              <span>{COPY.runbooks.back}</span>
            </Link>
          </div>
        ) : null}
        {docQuery.data.doc.anchors.length > 0 ? (
          <nav className={s.anchorNav} aria-label={COPY.runbooks.anchorsTitle}>
            {docQuery.data.doc.anchors.map((a) => (
              <button
                key={`${a.kind}-${a.slug}`}
                type="button"
                className="btn btn--sm"
                onClick={() => onSelectDoc(docQuery.data.doc.path, a.slug)}
              >
                {a.title ?? a.slug}
              </button>
            ))}
          </nav>
        ) : null}
        <SafeMarkdown
          content={docQuery.data.doc.content}
          onNavigateDoc={(rel, anchor) => onSelectDoc(resolveRelativeRunbook(docQuery.data.doc.path, rel), anchor)}
        />
      </div>
    )
  ) : undefined;

  return (
    <PaneGrid
      center={centerContent}
      recordTitle={activePath}
      record={recordNode}
    />
  );
}
