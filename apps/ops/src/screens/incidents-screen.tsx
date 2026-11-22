// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { COPY } from "../copy";
import {
  fetchOpsIncidents,
  OpsApiError,
  opsQueryKeys,
  type OpsIncidentSeverity,
  type OpsIncidentSummary,
  type OpsPersonalDataImpact,
} from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatDuration, formatLegalClockKind, formatUtcTimestamp } from "../lib/format";
import { useDeclareIncidentMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { PaneGrid } from "../ui/pane-grid";
import { SelectField } from "../ui/select-field";
import { StatRow } from "../ui/stat-row";
import { IncidentCloseButton, IncidentDetailPane } from "./incident-detail-pane";
import s from "./incidents-screen.module.css";

const SEV_OPTIONS = [
  { value: "SEV1", label: "SEV1" },
  { value: "SEV2", label: "SEV2" },
  { value: "SEV3", label: "SEV3" },
  { value: "SEV4", label: "SEV4" },
] as const;

const PDATA_OPTIONS = [
  { value: "no", label: "No" },
  { value: "unknown", label: "Unknown" },
  { value: "yes", label: "Yes" },
] as const;

function sevTone(sev: string): BadgeTone {
  if (sev === "SEV1") return "danger";
  if (sev === "SEV2") return "warn";
  return "info";
}

function nowUtcZ(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function IncidentsScreen({ selectedId }: { selectedId?: string }) {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const navigate = useNavigate();
  const allowed = hasOpsAction(me, "read.home");
  const canWrite = hasOpsAction(me, "incident.write");
  const declareMut = useDeclareIncidentMutation();

  const [declareOpen, setDeclareOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [sev, setSev] = useState<OpsIncidentSeverity>("SEV2");
  const [lead, setLead] = useState("");
  const [componentsCsv, setComponentsCsv] = useState("");
  const [pdata, setPdata] = useState<OpsPersonalDataImpact>("unknown");
  const [intrusion, setIntrusion] = useState(false);
  const [discoveredAt, setDiscoveredAt] = useState(nowUtcZ);
  const [publicId, setPublicId] = useState("");

  const query = useQuery({
    queryKey: opsQueryKeys.incidents,
    queryFn: fetchOpsIncidents,
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
            message: "Incidents view requires read.home permission.",
            support_ref: "cedar-incidents",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.incidents.title} meta={COPY.loading.incidentsTitle} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);

  const submitDeclare = (ev: React.FormEvent) => {
    ev.preventDefault();
    declareMut.mutate(
      {
        title: title.trim(),
        sev,
        lead: lead.trim() || null,
        affected_components: componentsCsv.split(",").map((c) => c.trim()).filter(Boolean),
        personal_data_impact: pdata,
        intrusion,
        discovered_at: discoveredAt.trim(),
        public_incident_id: publicId.trim() || null,
      },
      {
        onSuccess: (res) => {
          setTitle("");
          setDeclareOpen(false);
          void navigate({ to: "/incidents/$id", params: { id: res.incident.id } });
        },
      },
    );
  };

  const cols: readonly TableColumn<OpsIncidentSummary>[] = [
    { id: "sev", header: COPY.incidents.cols.sev, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone={sevTone(r.sev)}>{r.sev}</Badge> },
    { id: "title", header: COPY.incidents.cols.title, mobileSlot: "title", render: (r) => r.title },
    { id: "status", header: COPY.incidents.cols.status, nowrap: true, render: (r) => <Badge tone={r.status === "Resolved" ? "ok" : "warn"}>{r.status}</Badge> },
    {
      id: "clocks",
      header: COPY.incidents.cols.clocks,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) =>
        r.legal_clocks.length > 0
          ? r.legal_clocks.map((c) => `${formatLegalClockKind(c.kind)}: ${c.overdue ? COPY.incidents.sections.overdue : formatDuration(c.remaining_s)}`).join(" · ")
          : `${r.id} · ${r.lead ?? COPY.now.unassigned}`,
    },
    {
      id: "action",
      header: COPY.incidents.cols.action,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <Link to="/incidents/$id" params={{ id: r.id }} className="btn btn--sm" onClick={(e) => e.stopPropagation()}>
          {COPY.alerts.inspect}
        </Link>
      ),
    },
  ];

  const centerContent = (
    <div className={s.page}>
      <PageHead
        title={COPY.incidents.title}
        tools={
          <div className={s.toolRow}>
            <button type="button" className="btn btn--sm btn--primary" disabled={!canWrite} onClick={() => setDeclareOpen((p) => !p)}>
              {declareOpen ? COPY.incidents.cancelDeclare : COPY.incidents.declareButton}
            </button>
            {!canWrite ? <DisabledReason reason={COPY.incidents.requiresWriteGrant} /> : null}
          </div>
        }
      />
      {declareOpen ? (
        <form className={s.createPanel} onSubmit={submitDeclare}>
          <label className={s.fieldLabel}>
            <span>{COPY.incidents.fields.title}</span>
            <input type="text" className="field-input--form" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className={s.formGrid}>
            <SelectField label={COPY.incidents.fields.sev} value={sev} options={SEV_OPTIONS} onChange={(v) => setSev(v as OpsIncidentSeverity)} />
            <SelectField label={COPY.incidents.fields.personalDataImpact} value={pdata} options={PDATA_OPTIONS} onChange={(v) => setPdata(v as OpsPersonalDataImpact)} />
          </div>
          <div className={s.formGrid}>
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.lead}</span>
              <input type="text" className="field-input--form" value={lead} onChange={(e) => setLead(e.target.value)} />
            </label>
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.components}</span>
              <input type="text" className="field-input--form" value={componentsCsv} onChange={(e) => setComponentsCsv(e.target.value)} />
            </label>
          </div>
          <div className={s.formGrid}>
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.discoveredAt}</span>
              <input type="text" className="field-input--form" value={discoveredAt} onChange={(e) => setDiscoveredAt(e.target.value)} />
            </label>
            <label className={s.fieldLabel}>
              <span>{COPY.incidents.fields.publicIncidentId}</span>
              <input type="text" className="field-input--form" value={publicId} onChange={(e) => setPublicId(e.target.value)} />
            </label>
          </div>
          <label className={s.checkRow}>
            <input type="checkbox" className="field-checkbox" checked={intrusion} onChange={(e) => setIntrusion(e.target.checked)} />
            <span>{COPY.incidents.fields.intrusion}</span>
          </label>
          {declareMut.error ? <InlineError error={declareMut.error} /> : null}
          <div>
            <button type="submit" className="btn btn--sm btn--primary" disabled={declareMut.isPending || !canWrite}>
              {COPY.incidents.declareSubmit}
            </button>
          </div>
        </form>
      ) : null}
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.incidents.countLabel,
            value: <ObservedValue observation={data.count} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} />,
          },
        ]}
      />
      {data.incidents.length > 0 ? (
        <CompactTable caption={COPY.incidents.title} rows={data.incidents} rowKey={(r) => r.id} columns={cols} selectedKey={selectedId} onSelectRow={(r) => void navigate({ to: "/incidents/$id", params: { id: r.id } })} />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.incidents.empty, evaluatedAt)}</p>
      )}
    </div>
  );

  return (
    <PaneGrid
      center={centerContent}
      recordTitle={selectedId}
      recordActions={selectedId ? <IncidentCloseButton /> : undefined}
      record={selectedId ? <IncidentDetailPane key={selectedId} id={selectedId} isMobileFull /> : undefined}
    />
  );
}
