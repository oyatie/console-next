// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsChanges, OpsApiError, opsQueryKeys, readObservedValue, type OpsChangesView } from "../lib/api";
import { readGateStatement } from "../lib/api-types";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtColon, fmtJoin, formatCount, formatDuration, formatPercent, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import { ChangesControls } from "./changes-controls";
import { buildRunningTabs } from "./hub-tabs";
import s from "./changes-screen.module.css";

type ReleaseRow = OpsChangesView["releases"][number];
type TimelineRow = OpsChangesView["timeline"][number];

export function ChangesScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.running");

  const query = useQuery({
    queryKey: opsQueryKeys.changes,
    queryFn: fetchOpsChanges,
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
            message: "Changes view requires read.running permission.",
            support_ref: "cedar-running",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.running.title} meta={COPY.loading.changesTitle} tabs={buildRunningTabs("changes")} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const freezeVal = Boolean(readObservedValue(data.freeze));
  const firstDigest = data.releases[0]?.digest ?? "";

  const releaseCols: readonly TableColumn<ReleaseRow>[] = [
    { id: "digest", header: COPY.running.cols.digest, mobileSlot: "title", render: (r) => <code>{r.digest}</code> },
    {
      id: "state",
      header: COPY.now.cols.state,
      mobileSlot: "badge",
      nowrap: true,
      render: (r) => (
        <Badge tone={r.state === "Verified" ? "ok" : r.state === "Unknown" ? "unknown" : "warn"}>
          {r.state === "Unknown" && r.reason ? `${COPY.observed.unknownPrefix}${r.reason}` : r.state}
        </Badge>
      ),
    },
    {
      id: "gates",
      header: COPY.changes.gatesTitle,
      mobileSlot: "meta",
      render: (r) => {
        const stmt = readGateStatement(r.gates);
        if (!stmt) return <span className={s.mutedText}>{r.reason ?? COPY.changes.gateMissing}</span>;
        return (
          <span className={s.gateChips}>
            <Badge tone="outline">{fmtJoin(stmt.predicate.runner.kind, " · ", stmt.predicate.bake)}</Badge>
            {stmt.predicate.gates.map((g, idx) => (
              <Badge key={`${g.name}-${idx}`} tone={g.result === "pass" ? "ok" : "danger"}>{fmtColon(g.name, g.result)}</Badge>
            ))}
          </span>
        );
      },
    },
  ];

  const timelineCols: readonly TableColumn<TimelineRow>[] = [
    { id: "at", header: COPY.actions.cols.at, mobileSlot: "meta", nowrap: true, render: (r) => formatUtcShort(r.at) },
    { id: "kind", header: COPY.actions.cols.kind, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone="outline">{r.kind}</Badge> },
    { id: "summary", header: COPY.alerts.detail.summary, mobileSlot: "title", render: (r) => r.summary },
    { id: "status", header: COPY.actions.cols.status, nowrap: true, render: (r) => <Badge tone={r.status === "ok" || r.status === "active" ? "ok" : "warn"}>{r.status}</Badge> },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.running.title}
        meta={<span className={s.metaText}>{fmtColon(COPY.status.evaluatedAt, formatUtcTimestamp(data.evaluated_at))}</span>}
        tabs={buildRunningTabs("changes")}
      />

      <StatRow
        items={[
          { id: "freeze", label: COPY.changes.freezeLabel, value: <ObservedValue observation={data.freeze} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge /> },
          {
            id: "canary",
            label: COPY.changes.canaryPercentLabel,
            value: (
              <ObservedValue
                observation={data.canary_percent}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                formatValue={(v) => {
                  const n = Number(v);
                  return Number.isFinite(n) ? `${n}%` : `${COPY.observed.unknownPrefix}${COPY.observed.notInstrumented}`;
                }}
              />
            ),
          },
          { id: "bundle", label: COPY.changes.bundleShaLabel, value: <ObservedValue observation={data.bundle_sha} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
        ]}
      />

      <section className={s.band} aria-labelledby="changes-dora">
        <div className={s.bandHead}>
          <h2 id="changes-dora" className={s.bandTitle}>{COPY.changes.doraTitle}</h2>
          <span className={s.metaText}>{fmtColon(COPY.changes.sampleSize, formatCount(data.dora5.n))}</span>
        </div>
        <StatRow
          items={[
            { id: "freq", label: COPY.changes.dora.deployFreq, value: <ObservedValue observation={data.dora5.deployment_frequency} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
            { id: "lead", label: COPY.changes.dora.leadTime, value: <ObservedValue observation={data.dora5.lead_time_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
            { id: "cfr", label: COPY.changes.dora.failureRate, value: <ObservedValue observation={data.dora5.change_failure_rate} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatPercent(Number(v) * 100)} /> },
            { id: "mttr", label: COPY.changes.dora.mttr, value: <ObservedValue observation={data.dora5.mttr_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
            { id: "rework", label: COPY.changes.dora.reworkRate, value: <ObservedValue observation={data.dora5.rework_rate} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatPercent(Number(v) * 100)} /> },
          ]}
        />
      </section>

      <ChangesControls isFrozen={freezeVal} defaultDigest={firstDigest} />

      <section className={s.band} aria-labelledby="changes-gates">
        <div className={s.bandHead}><h2 id="changes-gates" className={s.bandTitle}>{COPY.changes.gatesTitle}</h2></div>
        {data.releases.length > 0 ? (
          <CompactTable caption={COPY.changes.gatesTitle} rows={data.releases} rowKey={(r) => r.digest} columns={releaseCols} />
        ) : (
          <p className={s.emptyNote}>{COPY.changes.noGates}</p>
        )}
      </section>

      <section className={s.band} aria-labelledby="changes-timeline">
        <div className={s.bandHead}><h2 id="changes-timeline" className={s.bandTitle}>{COPY.changes.timelineTitle}</h2></div>
        {data.timeline.length > 0 ? (
          <CompactTable caption={COPY.changes.timelineTitle} rows={data.timeline} rowKey={(r) => `${r.at}-${r.kind}-${r.summary}`} columns={timelineCols} />
        ) : (
          <p className={s.emptyNote}>{COPY.changes.noTimeline}</p>
        )}
      </section>
    </div>
  );
}
