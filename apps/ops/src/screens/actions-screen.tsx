// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsActions, OpsApiError, opsQueryKeys, type OpsActionRecord } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { CmdReceipt } from "../ui/cmd-receipt";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { KeyValue } from "../ui/key-value";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { PaneGrid } from "../ui/pane-grid";
import { StatRow } from "../ui/stat-row";
import { buildRunningTabs } from "./hub-tabs";
import s from "./actions-screen.module.css";

function statusTone(st: OpsActionRecord["status"]): BadgeTone {
  if (st === "executed") return "ok";
  if (st === "pending") return "warn";
  return "neutral";
}

export function ActionsScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.running");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey: opsQueryKeys.actions,
    queryFn: fetchOpsActions,
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data?.evaluated_at) reportEvaluatedAt(query.data.evaluated_at);
  }, [query.data?.evaluated_at, reportEvaluatedAt]);

  if (!allowed) {
    return (
      <O0State
        model={classifyOpsError(
          new OpsApiError(403, {
            code: "OPS_ACTION_DENIED",
            message: "Actions view requires read.running permission.",
            support_ref: "cedar-running",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.running.title} meta={COPY.loading.actionsTitle} tabs={buildRunningTabs("actions")} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);
  const selected = data.actions.find((a) => a.action_id === selectedId) ?? data.actions[0];

  const cols: readonly TableColumn<OpsActionRecord>[] = [
    { id: "status", header: COPY.actions.cols.status, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
    { id: "id", header: COPY.actions.cols.id, mobileSlot: "title", render: (r) => `${r.action_id} · ${r.kind}` },
    { id: "target", header: COPY.actions.cols.target, mobileSlot: "meta", render: (r) => `${r.target} · ${formatUtcShort(r.at)}` },
    { id: "operator", header: COPY.actions.cols.operator, nowrap: true, render: (r) => r.operator },
  ];

  const center = (
    <div className={s.page}>
      <PageHead title={COPY.running.title} tabs={buildRunningTabs("actions")} />
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.actions.countLabel,
            value: <ObservedValue observation={data.count} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} />,
          },
        ]}
      />
      {data.actions.length > 0 ? (
        <CompactTable
          caption={COPY.actions.title}
          rows={data.actions}
          rowKey={(r) => r.action_id}
          columns={cols}
          selectedKey={selected?.action_id}
          onSelectRow={(r) => setSelectedId(r.action_id)}
        />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.actions.empty, evaluatedAt)}</p>
      )}
    </div>
  );

  return (
    <PaneGrid
      center={center}
      recordTitle={selected?.action_id}
      record={
        selected ? (
          <div className={s.detailStack}>
            <CmdReceipt action={selected} showActionsLink={false} />
            <KeyValue
              items={[
                { id: "status", label: COPY.actions.cols.status, value: <Badge tone={statusTone(selected.status)}>{selected.status}</Badge> },
                { id: "ref", label: COPY.actions.fields.supportRef, value: <code>{selected.support_ref}</code> },
                { id: "hash", label: COPY.actions.fields.hash, value: <code>{selected.hash}</code> },
              ]}
            />
          </div>
        ) : undefined
      }
    />
  );
}
