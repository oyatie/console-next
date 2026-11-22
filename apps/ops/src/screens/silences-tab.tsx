// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsSilences, OpsApiError, opsQueryKeys, type OpsSilences } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import s from "./alerts-screen.module.css";

type SilenceRow = OpsSilences["silences"][number];

export function SilencesTab() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.alerts");

  const query = useQuery({
    queryKey: opsQueryKeys.silences,
    queryFn: fetchOpsSilences,
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
            message: "Silences view requires read.alerts permission.",
            support_ref: "cedar-alerts",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.alerts.title} meta={COPY.loading.silencesTitle} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);

  const cols: readonly TableColumn<SilenceRow>[] = [
    { id: "id", header: COPY.alerts.silences.id, mobileSlot: "badge", nowrap: true, render: (r) => <code>{r.id}</code> },
    {
      id: "matchers",
      header: COPY.alerts.silences.matchers,
      mobileSlot: "title",
      render: (r) => r.matchers.map((m) => `${m.name}${m.is_equal ? (m.is_regex ? "=~" : "=") : (m.is_regex ? "!~" : "!=")}${m.value}`).join(", "),
    },
    {
      id: "ends",
      header: COPY.alerts.silences.ends,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.ends}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "author",
      header: COPY.alerts.silences.author,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.author} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
    {
      id: "comment",
      header: COPY.alerts.silences.comment,
      render: (r) => <ObservedValue observation={r.comment} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.alerts.title}
        tabs={[
          { id: "groups", to: "/alerts", label: COPY.alerts.groupsTab, active: false },
          { id: "silences", to: "/alerts/silences", label: COPY.alerts.silencesTab, active: true },
        ]}
      />
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.alerts.silences.countLabel,
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
      {data.silences.length > 0 ? (
        <CompactTable caption={COPY.alerts.silencesTab} rows={data.silences} rowKey={(r) => r.id} columns={cols} />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.alerts.silences.empty, evaluatedAt)}</p>
      )}
    </div>
  );
}
