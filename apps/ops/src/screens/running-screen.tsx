// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsRunning, OpsApiError, opsQueryKeys, readObservedValue, type OpsComponent, type OpsHealth, type OpsRunning } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatDuration, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { useIsPhone } from "../lib/use-is-phone";
import { Badge } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { ExternalUrl } from "../ui/external-url";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { SelectField } from "../ui/select-field";
import { StatRow } from "../ui/stat-row";
import { buildRunningTabs } from "./hub-tabs";
import s from "./running-screen.module.css";

type RollupRow = OpsRunning["hosts"][number];

const HEALTH_OPTIONS = [
  { value: "", label: COPY.running.allStates },
  { value: "Healthy", label: "Healthy" },
  { value: "Progressing", label: "Progressing" },
  { value: "Suspended", label: "Suspended" },
  { value: "Degraded", label: "Degraded" },
  { value: "Missing", label: "Missing" },
  { value: "Unknown", label: "Unknown" },
] as const;

export function RunningScreen({
  filters,
  onFiltersChange,
}: {
  filters: { group?: string; state?: OpsHealth };
  onFiltersChange: (next: { group?: string; state?: OpsHealth }) => void;
}) {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const isPhone = useIsPhone();
  const allowed = hasOpsAction(me, "read.running");

  const query = useQuery({
    queryKey: opsQueryKeys.running(filters),
    queryFn: () => fetchOpsRunning(filters),
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
            message: "Running view requires read.running permission.",
            support_ref: "cedar-running",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.running.title} meta={COPY.loading.runningTitle} tabs={buildRunningTabs("components")} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);

  const rollupCols: readonly TableColumn<RollupRow>[] = [
    { id: "key", header: COPY.now.cols.key, mobileSlot: "title", render: (r) => r.key },
    {
      id: "health",
      header: COPY.running.cols.health,
      mobileSlot: "badge",
      nowrap: true,
      render: (r) => <ObservedValue observation={r.health} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "drift",
      header: COPY.running.cols.drift,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) =>
        isPhone ? (
          <span>
            {fmtJoin(COPY.running.cols.drift, ": ")}
            <ObservedValue observation={r.drift} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />
          </span>
        ) : (
          <ObservedValue observation={r.drift} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />
        ),
    },
  ];

  const compCols: readonly TableColumn<OpsComponent>[] = [
    { id: "key", header: COPY.running.cols.key, mobileSlot: "title", render: (r) => r.key },
    { id: "group", header: COPY.running.cols.group, nowrap: true, render: (r) => r.group },
    { id: "host", header: COPY.running.cols.host, mobileSlot: "meta", nowrap: true, render: (r) => r.host },
    {
      id: "health",
      header: COPY.running.cols.health,
      mobileSlot: "badge",
      nowrap: true,
      cellTone: (r) => {
        const h = readObservedValue(r.health);
        return h === "Missing" ? "danger" : h === "Degraded" ? "warn" : undefined;
      },
      render: (r) => <ObservedValue observation={r.health} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "drift",
      header: COPY.running.cols.drift,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.drift} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "membership",
      header: COPY.running.cols.membership,
      nowrap: true,
      render: (r) => <Badge tone={r.membership === "Extra" ? "warn" : "outline"}>{r.membership}</Badge>,
    },
    {
      id: "observedAt",
      header: COPY.running.cols.observedAt,
      nowrap: true,
      render: (r) => (r.observed_at ? formatUtcShort(r.observed_at) : fmtJoin(COPY.observed.unknownPrefix, COPY.observed.notInstrumented)),
    },
    { id: "age", header: COPY.running.cols.age, nowrap: true, render: (r) => formatDuration(r.age) },
    {
      id: "runbook",
      header: COPY.running.cols.runbook,
      render: (r) => {
        const runbookVal = readObservedValue(r.runbook);
        return typeof runbookVal === "string" && r.runbook.state !== "Unknown" ? (
          <ExternalUrl value={runbookVal} />
        ) : (
          <ObservedValue observation={r.runbook} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />
        );
      },
    },
  ];

  return (
    <div className={s.page}>
      <PageHead title={COPY.running.title} tabs={buildRunningTabs("components")} />
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.running.countLabel,
            value: (
              <ObservedValue
                observation={data.count}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                formatValue={(v) => formatCount(Number(v))}
              />
            ),
          },
        ]}
      />
      <div className={s.filterBar}>
        <input
          type="search"
          className={`field-input ${s.filterInput}`}
          aria-label={COPY.running.filterGroup}
          placeholder={COPY.running.allGroups}
          value={filters.group ?? ""}
          onChange={(e) => onFiltersChange({ ...filters, group: e.target.value || undefined })}
        />
        <SelectField
          label={COPY.running.filterState}
          value={filters.state ?? ""}
          options={HEALTH_OPTIONS}
          onChange={(v) => onFiltersChange({ ...filters, state: (v || undefined) as OpsHealth | undefined })}
        />
        {filters.group || filters.state ? (
          <button type="button" className="btn btn--sm" onClick={() => onFiltersChange({})}>
            {COPY.running.clearFilters}
          </button>
        ) : null}
      </div>

      <div className={s.rollupGrid}>
        <section className={s.rollupPane} aria-labelledby="running-hosts">
          <div className={s.bandHead}>
            <h2 id="running-hosts" className={s.bandTitle}>{COPY.running.hostsTitle}</h2>
          </div>
          <CompactTable caption={COPY.running.hostsTitle} rows={data.hosts} rowKey={(r) => r.key} columns={rollupCols} />
        </section>
        <section className={s.rollupPane} aria-labelledby="running-groups">
          <div className={s.bandHead}>
            <h2 id="running-groups" className={s.bandTitle}>{COPY.running.groupsTitle}</h2>
          </div>
          <CompactTable caption={COPY.running.groupsTitle} rows={data.groups} rowKey={(r) => r.key} columns={rollupCols} />
        </section>
      </div>

      <section aria-labelledby="running-components">
        <div className={s.bandHead}>
          <h2 id="running-components" className={s.bandTitle}>{COPY.running.componentsTitle}</h2>
        </div>
        {data.components.length > 0 ? (
          <CompactTable caption={COPY.running.componentsTitle} rows={data.components} rowKey={(r) => r.key} columns={compCols} />
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.running.emptyComponents, evaluatedAt)}</p>
        )}
      </section>
    </div>
  );
}
