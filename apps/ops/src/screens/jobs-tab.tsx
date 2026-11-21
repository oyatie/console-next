// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsJobs, OpsApiError, opsQueryKeys, readObservedValue, type OpsJob } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatDuration, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import s from "./running-screen.module.css";

export function JobsTab() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.running");

  const query = useQuery({
    queryKey: opsQueryKeys.jobs,
    queryFn: fetchOpsJobs,
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
            message: "Jobs view requires read.running permission.",
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
        <PageHead title={COPY.running.title} meta={COPY.loading.jobsTitle} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);

  const cols: readonly TableColumn<OpsJob>[] = [
    { id: "name", header: COPY.running.jobs.name, mobileSlot: "title", render: (r) => r.name },
    {
      id: "state",
      header: COPY.running.jobs.state,
      mobileSlot: "badge",
      nowrap: true,
      cellTone: (r) => {
        const st = readObservedValue(r.state);
        return st === "Failed" ? "danger" : st === "Late" ? "warn" : undefined;
      },
      render: (r) => <ObservedValue observation={r.state} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "lastRun",
      header: COPY.running.jobs.lastRun,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.last_run}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "lastExit",
      header: COPY.running.jobs.lastExit,
      nowrap: true,
      align: "right",
      render: (r) => <ObservedValue observation={r.last_exit} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
    {
      id: "budget",
      header: COPY.running.jobs.budget,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.budget}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatDuration(Number(v))}
        />
      ),
    },
    {
      id: "nextRun",
      header: COPY.running.jobs.nextRun,
      nowrap: true,
      render: (r) =>
        r.next_run ? (
          <ObservedValue
            observation={r.next_run}
            liveStatus={live.status}
            disconnectedAgeS={live.disconnectedAgeS}
            formatValue={(v) => formatUtcShort(String(v))}
          />
        ) : (
          <span>{COPY.running.jobs.notScheduled}</span>
        ),
    },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.running.title}
        tabs={[
          { id: "components", to: "/running", label: COPY.running.componentsTab, active: false },
          { id: "jobs", to: "/running/jobs", label: COPY.running.jobsTab, active: true },
        ]}
      />
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.running.jobs.countLabel,
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
      {data.jobs.length > 0 ? (
        <CompactTable caption={COPY.running.jobsTab} rows={data.jobs} rowKey={(r) => r.name} columns={cols} />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.running.jobs.empty, evaluatedAt)}</p>
      )}
    </div>
  );
}
