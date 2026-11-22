// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsSources, OpsApiError, opsQueryKeys, readObservedReason, type OpsSource } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { formatCount, formatDuration, formatUtcShort } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import s from "./running-screen.module.css";

function evidenceTone(state: OpsSource["state"]): BadgeTone {
  if (state === "Verified") return "ok";
  if (state === "Monitoring") return "info";
  if (state === "Stale") return "warn";
  return "unknown";
}

export function SourcesScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.sources");

  const query = useQuery({
    queryKey: opsQueryKeys.sources,
    queryFn: fetchOpsSources,
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
            message: "Sources view requires read.sources permission.",
            support_ref: "cedar-sources",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.sources.title} meta={COPY.loading.sourcesTitle} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const sources = query.data.sources;
  const counts = { Verified: 0, Monitoring: 0, Stale: 0, Unknown: 0 };
  for (const src of sources) counts[src.state] += 1;
  const disconnected = live.status === "Reconnecting" || live.status === "Offline";
  const disconnectedAge = live.disconnectedAgeS > 0 ? formatDuration(live.disconnectedAgeS) : "";

  const cols: readonly TableColumn<OpsSource>[] = [
    { id: "name", header: COPY.sources.cols.name, mobileSlot: "title", render: (r) => r.name },
    { id: "kind", header: COPY.sources.cols.kind, nowrap: true, render: (r) => r.kind },
    { id: "producer", header: COPY.sources.cols.producer, nowrap: true, render: (r) => r.producer },
    { id: "interval", header: COPY.sources.cols.interval, nowrap: true, render: (r) => formatDuration(r.interval) },
    {
      id: "observedAt",
      header: COPY.sources.cols.observedAt,
      nowrap: true,
      render: (r) => {
        if (!r.observed_at) return `${COPY.observed.unknownPrefix}${readObservedReason(r) ?? COPY.observed.notInstrumented}`;
        const formatted = formatUtcShort(r.observed_at);
        return disconnected ? <s>{formatted}</s> : formatted;
      },
    },
    { id: "age", header: COPY.sources.cols.age, nowrap: true, render: (r) => formatDuration(r.age) },
    {
      id: "state",
      header: COPY.sources.cols.state,
      mobileSlot: "badge",
      nowrap: true,
      cellTone: (r) => (r.state === "Stale" ? "warn" : undefined),
      render: (r) =>
        disconnected && r.state !== "Unknown" ? (
          <Badge tone="unknown">
            {disconnectedAge ? `${COPY.observed.staleValuePrefix}${disconnectedAge}` : `${COPY.observed.unknownPrefix}${COPY.live.staleClientReason}`}
          </Badge>
        ) : (
          <Badge tone={evidenceTone(r.state)}>{r.state}</Badge>
        ),
    },
    {
      id: "reason",
      header: COPY.sources.cols.reason,
      mobileSlot: "meta",
      render: (r) => readObservedReason(r) ?? COPY.observed.noActiveReason,
    },
  ];

  return (
    <div className={s.page}>
      <PageHead title={COPY.sources.title} />
      <StatRow
        items={[
          { id: "v", label: COPY.now.verifiedLabel, value: formatCount(counts.Verified), tone: counts.Verified > 0 ? "ok" : "default" },
          { id: "m", label: COPY.now.monitoringLabel, value: formatCount(counts.Monitoring), tone: counts.Monitoring > 0 ? "primary" : "default" },
          { id: "s", label: COPY.now.staleLabel, value: formatCount(counts.Stale), tone: counts.Stale > 0 ? "warn" : "default" },
          { id: "u", label: COPY.now.unknownLabel, value: formatCount(counts.Unknown), tone: counts.Unknown > 0 ? "danger" : "default" },
        ]}
      />
      {sources.length > 0 ? (
        <CompactTable caption={COPY.sources.title} rows={sources} rowKey={(r) => r.name} columns={cols} />
      ) : (
        <p className={s.emptyNote}>{COPY.sources.empty}</p>
      )}
    </div>
  );
}
