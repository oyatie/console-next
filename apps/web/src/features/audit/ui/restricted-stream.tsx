// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../../lib/code-text";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { streamAccessQuery } from "../../../reference/audit/api";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { restrictedStreamQuery, type StreamKind, type StreamRecord } from "../api";
import { buildSnapDiffRows } from "../present";
import s from "./audit.module.css";

const limit = 25;
const actionText = (row: StreamRecord) => codeText(`audit.log.action.${row.action}`, row.action);

export function RestrictedStream() {
  const access = useQuery({ ...streamAccessQuery, refetchOnMount: false });
  const [chosen, choose] = useState<StreamKind>("events");
  const caps = access.isSuccess ? access.data : undefined;
  const kind = caps?.[chosen] ? chosen : caps?.events ? "events" : "access_events";
  return <Register key={kind} kind={kind} enabled={!!caps?.[kind]} change={caps?.events && caps.access_events ? choose : undefined} />;
}

function Register({ kind, enabled, change }: { kind: StreamKind; enabled: boolean; change?: (kind: StreamKind) => void }) {
  const [offset, setOffset] = useState(0);
  const [selected, select] = useState<string | null>();
  const desktop = useIsDesktop();
  const query = useQuery({ ...restrictedStreamQuery(kind, offset, limit), enabled });
  // A denied refetch removes the page and detail immediately, even if the cache held a response.
  const page = enabled && query.isSuccess ? query.data : undefined;
  const rows = page?.items ?? [];
  const row = selected === undefined && desktop ? rows[0] : rows.find(event => event.id === selected);
  const section = t(kind === "events" ? "audit.restricted.events" : "audit.restricted.reads");
  const turn = (next: number) => { select(undefined); setOffset(next); };
  return <ListRecord q={query.error ? { ...query, data: undefined } : query}
    head={{ title: t("audit.restricted.title"), titleId: "restricted-audit-title" }} tabs={<AuditTabs />}
    views={change && <div className={s.foot} role="group" aria-label={t("audit.restricted.stream")}>
      <Button aria-pressed={kind === "events"} onClick={() => change("events")}>{t("audit.restricted.events")}</Button>
      <Button aria-pressed={kind === "access_events"} onClick={() => change("access_events")}>{t("audit.restricted.reads")}</Button>
    </div>}
    list={rows.length ? <LongTable label={section} rows={rows} rowId={event => event.id} activeRowId={row?.id}
      onRowAction={select} total={rows.length} hasMore={false} onLoadMore={() => {}} density="compact" mobileLayout="compact"
      empty={t("audit.restricted.empty")} columns={[
        { id: "action", header: t("audit.log.col.action"), rowHeader: true, card: "title", width: "2fr", cell: actionText },
        { id: "target", header: t("audit.log.col.target"), card: "fact", width: "1fr", cell: event => event.target_id },
        { id: "time", header: t("audit.log.col.occurredAt"), card: "fact", width: 178, cell: event => fmtDateTime(event.occurred_at) },
      ]} /> : <EmptyState title={t("audit.restricted.empty")} reason={t(kind === "events" ? "audit.restricted.emptyEvents" : "audit.restricted.emptyReads")} />}
    foot={page && <div className={s.foot}>
      <span>{t("audit.restricted.receipt", { id: page.access_audit_id })}</span>
      {(offset > 0 || page.total > limit) && <>
        <Button disabled={offset === 0} onClick={() => turn(Math.max(0, offset - limit))}>{t("audit.log.pagination.prev")}</Button>
        <Button disabled={offset + limit >= page.total} onClick={() => turn(offset + limit)}>{t("audit.log.pagination.next")}</Button>
      </>}
    </div>}
    record={row && { id: row.id, label: section, title: actionText(row), meta: fmtDateTime(row.occurred_at),
      onClose: () => select(null), children: <StreamFacts row={row} /> }} />;
}

function StreamFacts({ row }: { row: StreamRecord }) {
  const changes = buildSnapDiffRows(row.before_snap, row.after_snap);
  return <>
    <KeyValue density="dense" items={[
      { key: "id", label: t("audit.detail.id"), value: row.id },
      { key: "actor", label: t("audit.log.col.actor"), value: row.actor ?? "—" },
      { key: "target", label: t("audit.log.col.target"), value: [row.target_type, row.target_id].join(" · ") },
      { key: "sensitivity", label: t("audit.detail.badges"), value: row.sensitivity },
      { key: "trace", label: t("audit.detail.trace"), value: [row.trace_id, row.span_id].join(" · ") },
    ]} />
    {changes.length > 0 && <RecordPaneSection title={t("audit.detail.diff")}><KeyValue density="dense" items={changes} /></RecordPaneSection>}
  </>;
}
