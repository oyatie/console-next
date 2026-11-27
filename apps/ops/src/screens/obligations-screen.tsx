// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { COPY } from "../copy";
import {
  fetchOpsObligations,
  OpsApiError,
  opsQueryKeys,
  type OpsHealth,
  type OpsObligationItem,
  type OpsObligationKind,
  type OpsObligationReviewerRole,
  type OpsObligationState,
} from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatObligationKind, formatObligationRole, formatObligationState, formatUtcTimestamp } from "../lib/format";
import { useOpenObligationMutation } from "../lib/mutations";
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
import { ObligationCloseButton, ObligationDetailPane } from "./obligation-detail-pane";
import s from "./obligations-screen.module.css";

function getKindOptions() {
  return [
    { value: "", label: COPY.obligations.allKinds },
    { value: "launch-gate", label: formatObligationKind("launch-gate") },
    { value: "professional-review", label: formatObligationKind("professional-review") },
    { value: "credential-rotation", label: formatObligationKind("credential-rotation") },
    { value: "escrow", label: formatObligationKind("escrow") },
    { value: "drill", label: formatObligationKind("drill") },
    { value: "owner-decision", label: formatObligationKind("owner-decision") },
    { value: "regulatory-watch", label: formatObligationKind("regulatory-watch") },
  ] as const;
}

function getStateOptions() {
  return [
    { value: "", label: COPY.obligations.allStates },
    { value: "open", label: formatObligationState("open") },
    { value: "in-review", label: formatObligationState("in-review") },
    { value: "done", label: formatObligationState("done") },
    { value: "waived", label: formatObligationState("waived") },
  ] as const;
}

function getRoleOptions() {
  return [
    { value: "owner", label: formatObligationRole("owner") },
    { value: "labor-attorney", label: formatObligationRole("labor-attorney") },
    { value: "lawyer", label: formatObligationRole("lawyer") },
    { value: "tax-accountant", label: formatObligationRole("tax-accountant") },
  ] as const;
}

function verdictTone(w: OpsHealth): BadgeTone {
  if (w === "Healthy") return "ok";
  if (w === "Degraded") return "warn";
  if (w === "Missing") return "danger";
  return "unknown";
}

function stateTone(state: string): BadgeTone {
  if (state === "done" || state === "waived") return "ok";
  if (state === "in-review") return "info";
  return "warn";
}

export function ObligationsScreen({
  selectedId,
  filters,
  onFiltersChange,
}: {
  selectedId?: string;
  filters: { kind?: OpsObligationKind; state?: OpsObligationState };
  onFiltersChange: (next: { kind?: OpsObligationKind; state?: OpsObligationState }) => void;
}) {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const navigate = useNavigate();
  const allowed = hasOpsAction(me, "obligation.read");
  const canWrite = hasOpsAction(me, "obligation.write");
  const openMut = useOpenObligationMutation();

  const [createOpen, setCreateOpen] = useState(false);
  const [newKind, setNewKind] = useState<OpsObligationKind>("launch-gate");
  const [newRole, setNewRole] = useState<OpsObligationReviewerRole>("owner");
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newEvidence, setNewEvidence] = useState("");

  const query = useQuery({
    queryKey: opsQueryKeys.obligations(filters),
    queryFn: () => fetchOpsObligations(filters),
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
            message: "Obligations view requires obligation.read permission.",
            support_ref: "cedar-obligations",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.obligations.title} meta={COPY.loading.obligationsTitle} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);
  const chainBroken = data.verdict.worst === "Unknown" && data.sources.some((src) => src.state === "Unknown");

  const submitNew = (ev: React.FormEvent) => {
    ev.preventDefault();
    openMut.mutate(
      {
        kind: newKind,
        reviewer_role: newRole,
        title: newTitle.trim(),
        due: newDue.trim() || null,
        evidence_ref: newEvidence.trim() || null,
      },
      {
        onSuccess: (res) => {
          setNewTitle("");
          setNewDue("");
          setNewEvidence("");
          setCreateOpen(false);
          void navigate({ to: "/obligations/$id", params: { id: res.id } });
        },
      },
    );
  };

  const cols: readonly TableColumn<OpsObligationItem>[] = [
    { id: "state", header: COPY.obligations.cols.state, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone={stateTone(r.state)}>{formatObligationState(r.state)}</Badge> },
    { id: "title", header: COPY.obligations.cols.title, mobileSlot: "title", render: (r) => r.title },
    { id: "kind", header: COPY.obligations.cols.kind, nowrap: true, render: (r) => formatObligationKind(r.kind) },
    { id: "role", header: COPY.obligations.cols.role, mobileSlot: "meta", nowrap: true, render: (r) => `${formatObligationRole(r.reviewer_role)} · ${r.deadline}` },
    {
      id: "deadline",
      header: COPY.obligations.cols.deadline,
      nowrap: true,
      cellTone: (r) => {
        if (r.state !== "open" && r.state !== "in-review") return undefined;
        return r.deadline.startsWith("D+") || r.deadline === "D-day" ? "danger" : r.deadline.startsWith("D-") ? "warn" : undefined;
      },
      render: (r) => r.deadline,
    },
    {
      id: "action",
      header: COPY.obligations.cols.action,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <Link to="/obligations/$id" params={{ id: r.id }} className="btn btn--sm" onClick={(e) => e.stopPropagation()}>
          {COPY.alerts.inspect}
        </Link>
      ),
    },
  ];

  const centerContent = (
    <div className={s.page}>
      <PageHead
        title={COPY.obligations.title}
        meta={<Badge tone={verdictTone(data.launch_readiness.worst)}>{data.launch_readiness.text}</Badge>}
        tools={
          <div className={s.toolRow}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canWrite || chainBroken}
              onClick={() => setCreateOpen((p) => !p)}
            >
              {createOpen ? COPY.obligations.closeNew : COPY.obligations.newButton}
            </button>
            {!canWrite ? <DisabledReason reason={COPY.obligations.detail.requiresWriteGrant} /> : null}
          </div>
        }
      />
      {chainBroken ? <div className={s.warnBanner} role="alert">{COPY.obligations.chainBrokenBanner}</div> : null}
      {createOpen ? (
        <form className={s.createPanel} onSubmit={submitNew}>
          <div className={s.formGrid}>
            <SelectField label={COPY.obligations.fields.kind} value={newKind} options={getKindOptions().slice(1)} onChange={(v) => setNewKind(v as OpsObligationKind)} />
            <SelectField label={COPY.obligations.fields.reviewerRole} value={newRole} options={getRoleOptions()} onChange={(v) => setNewRole(v as OpsObligationReviewerRole)} />
          </div>
          <label className={s.fieldLabel}>
            <span>{COPY.obligations.fields.title}</span>
            <input type="text" className="field-input--form" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          </label>
          <div className={s.formGrid}>
            <label className={s.fieldLabel}>
              <span>{COPY.obligations.fields.due}</span>
              <input type="text" className="field-input--form" value={newDue} onChange={(e) => setNewDue(e.target.value)} />
            </label>
            <label className={s.fieldLabel}>
              <span>{COPY.obligations.fields.evidenceRef}</span>
              <input type="text" className="field-input--form" value={newEvidence} onChange={(e) => setNewEvidence(e.target.value)} />
            </label>
          </div>
          {openMut.error ? <InlineError error={openMut.error} /> : null}
          <div>
            <button type="submit" className="btn btn--sm btn--primary" disabled={openMut.isPending || !canWrite}>
              {COPY.obligations.createSubmit}
            </button>
          </div>
        </form>
      ) : null}
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.obligations.countLabel,
            value: <ObservedValue observation={data.count} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatCount(Number(v))} />,
          },
          {
            id: "readiness",
            label: COPY.obligations.launchReadiness,
            value: <Badge tone={verdictTone(data.launch_readiness.worst)}>{data.launch_readiness.worst}</Badge>,
          },
        ]}
      />
      <div className={s.filterBar}>
        <SelectField label={COPY.obligations.filterKind} value={filters.kind ?? ""} options={getKindOptions()} onChange={(v) => onFiltersChange({ ...filters, kind: (v || undefined) as OpsObligationKind | undefined })} />
        <SelectField label={COPY.obligations.filterState} value={filters.state ?? ""} options={getStateOptions()} onChange={(v) => onFiltersChange({ ...filters, state: (v || undefined) as OpsObligationState | undefined })} />
        {filters.kind || filters.state ? (
          <button type="button" className="btn btn--sm" onClick={() => onFiltersChange({})}>{COPY.obligations.clearFilters}</button>
        ) : null}
      </div>
      {data.items.length > 0 ? (
        <CompactTable caption={COPY.obligations.title} rows={data.items} rowKey={(r) => r.id} columns={cols} selectedKey={selectedId} onSelectRow={(r) => void navigate({ to: "/obligations/$id", params: { id: r.id } })} />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.obligations.empty, evaluatedAt)}</p>
      )}
    </div>
  );

  return (
    <PaneGrid
      center={centerContent}
      recordTitle={selectedId}
      recordActions={selectedId ? <ObligationCloseButton /> : undefined}
      record={selectedId ? <ObligationDetailPane key={selectedId} id={selectedId} chainBroken={chainBroken} isMobileFull /> : undefined}
    />
  );
}
