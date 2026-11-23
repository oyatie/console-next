// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { COPY } from "../copy";
import {
  fetchOpsAlerts,
  OpsApiError,
  opsQueryKeys,
  readObservedReason,
  readObservedValue,
  type OpsAlertGroup,
  type OpsAlertState,
  type OpsSeverity,
} from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { useIsPhone } from "../lib/use-is-phone";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { PaneGrid } from "../ui/pane-grid";
import { SelectField } from "../ui/select-field";
import { StatRow } from "../ui/stat-row";
import { AlertDetailCloseButton, AlertDetailPane } from "./alert-detail-pane";
import { buildAlertsTabs } from "./hub-tabs";
import s from "./alerts-screen.module.css";

const STATE_OPTIONS = [
  { value: "", label: COPY.alerts.allStates },
  { value: "Firing", label: "Firing" },
  { value: "Acked", label: "Acked" },
  { value: "Silenced", label: "Silenced" },
  { value: "Inhibited", label: "Inhibited" },
  { value: "Resolved", label: "Resolved" },
] as const;

const SEVERITY_OPTIONS = [
  { value: "", label: COPY.alerts.allSeverities },
  { value: "Page", label: "Page" },
  { value: "Ticket", label: "Ticket" },
] as const;

export function AlertsScreen({
  selectedKey,
  initialAction,
  filters,
  onFiltersChange,
}: {
  selectedKey?: string;
  initialAction?: "ack";
  filters: { state?: OpsAlertState; severity?: OpsSeverity; component?: string };
  onFiltersChange: (next: { state?: OpsAlertState; severity?: OpsSeverity; component?: string }) => void;
}) {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const allowed = hasOpsAction(me, "read.alerts");

  const query = useQuery({
    queryKey: opsQueryKeys.alerts(filters),
    queryFn: () => fetchOpsAlerts(filters),
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
            message: "Alerts view requires read.alerts permission.",
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
        <PageHead title={COPY.alerts.title} meta={COPY.loading.alertsTitle} tabs={buildAlertsTabs("groups")} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);
  const deliveryUnverified =
    data.count.state === "Unknown" ||
    data.count.state === "Stale" ||
    data.alert_count.state === "Unknown" ||
    data.alert_count.state === "Stale";
  const deliveryReason =
    readObservedReason(data.count) ?? readObservedReason(data.alert_count) ?? COPY.observed.notInstrumented;

  const cols: readonly TableColumn<OpsAlertGroup>[] = [
    {
      id: "severity",
      header: COPY.alerts.cols.severity,
      mobileSlot: "badge",
      nowrap: true,
      cellTone: (r) => {
        const sev = readObservedValue(r.severity);
        return sev === "Page" ? "danger" : sev === "Ticket" ? "warn" : undefined;
      },
      render: (r) => <ObservedValue observation={r.severity} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "state",
      header: COPY.alerts.cols.state,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.state} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} asBadge />,
    },
    {
      id: "group",
      header: COPY.alerts.cols.group,
      mobileSlot: "title",
      render: (r) => r.alertname,
    },
    {
      id: "component",
      header: COPY.alerts.cols.component,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => <ObservedValue observation={r.component} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
    {
      id: "members",
      header: COPY.alerts.cols.members,
      nowrap: true,
      align: "right",
      render: (r) => (
        <ObservedValue
          observation={r.members_n}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatCount(Number(v))}
        />
      ),
    },
    {
      id: "since",
      header: COPY.alerts.cols.since,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.since}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "action",
      header: COPY.alerts.cols.action,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <Link
          to="/alerts/$key"
          params={{ key: r.key }}
          className="btn btn--sm"
          onClick={(event) => event.stopPropagation()}
        >
          {COPY.alerts.inspect}
        </Link>
      ),
    },
  ];

  const centerContent = (
    <div className={s.page}>
      <PageHead title={COPY.alerts.title} tabs={buildAlertsTabs("groups")} />
      {deliveryUnverified ? (
        <div className={s.banner} role="alert">
          <strong>{COPY.alerts.deliveryUnverifiedTitle}</strong>
          <span>{fmtJoin(COPY.alerts.deliveryUnverifiedSince, evaluatedAt, " · ", deliveryReason)}</span>
        </div>
      ) : null}
      <StatRow
        items={[
          {
            id: "groups",
            label: COPY.alerts.groupsCountLabel,
            value: (
              <ObservedValue
                observation={data.count}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                formatValue={(v) => formatCount(Number(v))}
              />
            ),
          },
          {
            id: "members",
            label: COPY.alerts.membersCountLabel,
            value: (
              <ObservedValue
                observation={data.alert_count}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                formatValue={(v) => formatCount(Number(v))}
              />
            ),
          },
        ]}
      />
      <div className={s.filterBar}>
        <SelectField
          label={COPY.alerts.filterState}
          value={filters.state ?? ""}
          options={STATE_OPTIONS}
          onChange={(v) => onFiltersChange({ ...filters, state: (v || undefined) as OpsAlertState | undefined })}
        />
        <SelectField
          label={COPY.alerts.filterSeverity}
          value={filters.severity ?? ""}
          options={SEVERITY_OPTIONS}
          onChange={(v) => onFiltersChange({ ...filters, severity: (v || undefined) as OpsSeverity | undefined })}
        />
        <input
          type="search"
          className={`field-input ${s.filterInput}`}
          aria-label={COPY.alerts.filterComponent}
          placeholder={COPY.alerts.filterComponentPlaceholder}
          value={filters.component ?? ""}
          onChange={(e) => onFiltersChange({ ...filters, component: e.target.value || undefined })}
        />
        {filters.state || filters.severity || filters.component ? (
          <button type="button" className="btn btn--sm" onClick={() => onFiltersChange({})}>
            {COPY.alerts.clearFilters}
          </button>
        ) : null}
        <span className={s.countNote}>{fmtJoin(COPY.alerts.showingRange, " ", formatCount(data.groups.length), " ", COPY.alerts.groupsNoun)}</span>
      </div>
      {data.groups.length > 0 ? (
        <CompactTable
          caption={COPY.alerts.title}
          rows={data.groups}
          rowKey={(r) => r.key}
          columns={cols}
          selectedKey={selectedKey}
          onSelectRow={(r) => void navigate({ to: "/alerts/$key", params: { key: r.key } })}
          virtualize
          rowHeight={isPhone ? 57 : 34}
        />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.alerts.emptyGroups, evaluatedAt)}</p>
      )}
    </div>
  );

  return (
    <PaneGrid
      center={centerContent}
      recordTitle={selectedKey}
      recordActions={selectedKey ? <AlertDetailCloseButton to="/alerts" /> : undefined}
      record={
        selectedKey ? (
          <AlertDetailPane
            key={`${selectedKey}:${initialAction ?? ""}`}
            groupKey={selectedKey}
            liveStatus={live.status}
            disconnectedAgeS={live.disconnectedAgeS}
            closeHref="/alerts"
            isMobileFull
            initialAction={initialAction}
          />
        ) : undefined
      }
    />
  );
}
