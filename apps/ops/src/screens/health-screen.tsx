// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsHealth, OpsApiError, opsQueryKeys, readObservedValue, type OpsServiceHealth } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtColon, formatBudgetPercent, formatBurn, formatCount, formatDuration, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import { buildNowTabs } from "./hub-tabs";
import s from "./health-screen.module.css";

type SloRow = OpsServiceHealth["internal_slos"][number];
type TruthRow = OpsServiceHealth["evidence_truth"][number];
type TextfileRow = OpsServiceHealth["textfiles"][number];
type PublicCompRow = { name: string; obs: OpsServiceHealth["public_status"]["components"][string] };

export function HealthScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.home");

  const query = useQuery({
    queryKey: opsQueryKeys.health,
    queryFn: fetchOpsHealth,
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
            message: "Service health view requires read.home permission.",
            support_ref: "cedar-health",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.health.title} meta={COPY.loading.healthTitle} tabs={buildNowTabs("health")} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const pub = data.public_status;
  const pubRows: PublicCompRow[] = Object.entries(pub.components).map(([name, obs]) => ({ name, obs }));

  const sloCols: readonly TableColumn<SloRow>[] = [
    {
      id: "key",
      header: COPY.health.cols.slo,
      mobileSlot: "title",
      render: (r) => (
        <span className={s.sloName}>
          <span>{r.key}</span>
          {r.low_sample ? <Badge tone="warn" title={r.low_sample_note ?? undefined}>{COPY.health.lowSampleBadge}</Badge> : null}
          {r.low_sample_note ? <span className={s.lowSampleNote}>{r.low_sample_note}</span> : null}
        </span>
      ),
    },
    {
      id: "remaining",
      header: COPY.health.cols.remaining,
      mobileSlot: "badge",
      nowrap: true,
      align: "right",
      cellTone: (r) => {
        const val = readObservedValue(r.remaining_percent);
        return typeof val === "number" && val <= 0 ? "danger" : undefined;
      },
      render: (r) => (
        <ObservedValue observation={r.remaining_percent} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBudgetPercent(Number(v))} />
      ),
    },
    {
      id: "burn30m",
      header: COPY.health.cols.burn30m,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.burn_30m} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBurn(Number(v))} />,
    },
    {
      id: "burn1h",
      header: COPY.health.cols.burn1h,
      mobileSlot: "meta",
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.burn_1h} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBurn(Number(v))} />,
    },
    {
      id: "burn6h",
      header: COPY.health.cols.burn6h,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.burn_6h} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBurn(Number(v))} />,
    },
    {
      id: "burn3d",
      header: COPY.health.cols.burn3d,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.burn_3d} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBurn(Number(v))} />,
    },
    {
      id: "burn30d",
      header: COPY.health.cols.burn30d,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.burn_30d} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatBurn(Number(v))} />,
    },
    {
      id: "exhaustion",
      header: COPY.health.cols.exhaustion,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.exhaustion_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} />,
    },
    {
      id: "reqs",
      header: COPY.health.cols.reqs30d,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.requests_30d} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} />,
    },
  ];

  const truthCols: readonly TableColumn<TruthRow>[] = [
    { id: "source", header: COPY.health.cols.source, mobileSlot: "title", render: (r) => r.source },
    {
      id: "ok",
      header: COPY.health.cols.status,
      mobileSlot: "badge",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.ok}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          asBadge
          formatValue={(v) => (v ? COPY.health.boolOk : COPY.health.boolFail)}
        />
      ),
    },
  ];

  const textfileCols: readonly TableColumn<TextfileRow>[] = [
    { id: "file", header: COPY.health.cols.file, mobileSlot: "title", render: (r) => r.file },
    { id: "age", header: COPY.health.cols.age, mobileSlot: "meta", nowrap: true, align: "right", render: (r) => <ObservedValue observation={r.age_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
    { id: "maxAge", header: COPY.health.cols.maxAge, nowrap: true, align: "right", render: (r) => <ObservedValue observation={r.max_age_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
  ];

  const publicCols: readonly TableColumn<PublicCompRow>[] = [
    { id: "name", header: COPY.health.cols.component, mobileSlot: "title", render: (r) => r.name },
    { id: "status", header: COPY.health.cols.status, mobileSlot: "badge", nowrap: true, render: (r) => <ObservedValue observation={r.obs} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge /> },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.health.title}
        meta={<span className={s.metaText}>{fmtColon(COPY.status.evaluatedAt, formatUtcTimestamp(data.evaluated_at))}</span>}
        tabs={buildNowTabs("health")}
      />

      <StatRow
        items={[
          {
            id: "errRate",
            label: COPY.health.pageLoadErrorRate,
            value: <ObservedValue observation={data.page_load_error_rate_5m} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
          },
          {
            id: "loadRate",
            label: COPY.health.pageLoadsRate,
            value: <ObservedValue observation={data.page_loads_rate_5m} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
          },
        ]}
      />

      <section className={s.band} aria-labelledby="health-slos">
        <div className={s.bandHead}><h2 id="health-slos" className={s.bandTitle}>{COPY.health.internalSlosTitle}</h2></div>
        {data.internal_slos.length > 0 ? (
          <CompactTable caption={COPY.health.internalSlosTitle} rows={data.internal_slos} rowKey={(r) => r.key} columns={sloCols} />
        ) : (
          <p className={s.emptyNote}>{COPY.health.noSlos}</p>
        )}
      </section>

      <section className={s.band} aria-labelledby="health-public">
        <div className={s.bandHead}><h2 id="health-public" className={s.bandTitle}>{COPY.health.publicStatusTitle}</h2></div>
        <StatRow
          items={[
            {
              id: "feedOk",
              label: COPY.health.publicMeta.feedOk,
              value: (
                <ObservedValue
                  observation={pub.feed_ok}
                  liveStatus={live.status}
                  disconnectedAgeS={live.disconnectedAgeS}
                  asBadge
                  formatValue={(v) => (v ? COPY.health.boolOk : COPY.health.boolFail)}
                />
              ),
            },
            { id: "rev", label: COPY.health.publicMeta.revision, value: <ObservedValue observation={pub.revision} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} /> },
            { id: "published", label: COPY.health.publicMeta.publishedAt, value: <ObservedValue observation={pub.published_at} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatUtcShort(String(v))} /> },
            { id: "unknown", label: COPY.health.publicMeta.unknownCount, value: <ObservedValue observation={pub.unknown_components} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} /> },
          ]}
        />
        {pubRows.length > 0 ? (
          <CompactTable caption={COPY.health.publicStatusTitle} rows={pubRows} rowKey={(r) => r.name} columns={publicCols} />
        ) : (
          <p className={s.emptyNote}>{COPY.health.noPublicComponents}</p>
        )}
      </section>

      <div className={s.splitGrid}>
        <section className={s.splitCell} aria-labelledby="health-truth">
          <div className={s.bandHead}><h2 id="health-truth" className={s.bandTitle}>{COPY.health.evidenceTruthTitle}</h2></div>
          {data.evidence_truth.length > 0 ? (
            <CompactTable caption={COPY.health.evidenceTruthTitle} rows={data.evidence_truth} rowKey={(r) => r.source} columns={truthCols} />
          ) : (
            <p className={s.emptyNote}>{COPY.health.noTruth}</p>
          )}
        </section>
        <section className={s.splitCell} aria-labelledby="health-textfiles">
          <div className={s.bandHead}><h2 id="health-textfiles" className={s.bandTitle}>{COPY.health.textfilesTitle}</h2></div>
          {data.textfiles.length > 0 ? (
            <CompactTable caption={COPY.health.textfilesTitle} rows={data.textfiles} rowKey={(r) => r.file} columns={textfileCols} />
          ) : (
            <p className={s.emptyNote}>{COPY.health.noTextfiles}</p>
          )}
        </section>
      </div>
    </div>
  );
}
