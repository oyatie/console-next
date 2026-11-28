// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { auditAttestationQuery, auditLogQuery, type AuditRecord } from "../api";
import { AuditDetailPane } from "./audit-detail-pane";
import s from "./audit.module.css";

const PAGE_LIMIT = 50;

function recordKey(row: AuditRecord, index: number): string {
  return row.id ?? `${row.occurred_at}-${row.trace_id ?? index}`;
}

export function AuditPage() {
  const isDesktop = useIsDesktop();
  const [targetTypeInput, setTargetTypeInput] = useState("");
  const [targetIdInput, setTargetIdInput] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [traceIdInput, setTraceIdInput] = useState("");
  const [applied, setApplied] = useState<{ target_type?: string; target_id?: string; actor?: string; trace_id?: string }>({});
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dismissedAuto, setDismissedAuto] = useState(false);

  const q = useQuery({
    ...auditLogQuery({ limit: PAGE_LIMIT, offset, ...applied }),
    placeholderData: keepPreviousData,
  });
  const attestation = useQuery(auditAttestationQuery);

  const rows = useMemo(
    () => (q.data?.items ?? []).map((item, index) => ({ ...item, rowKey: recordKey(item, index) })),
    [q.data?.items],
  );
  const effectiveSelectedId = selectedId ?? (isDesktop && !dismissedAuto ? (rows[0]?.rowKey ?? null) : null);
  const anomalyCount = useMemo(() => rows.filter(item => Boolean(item.anomaly)).length, [rows]);
  const selected = useMemo(
    () => rows.find(item => item.rowKey === effectiveSelectedId) ?? null,
    [rows, effectiveSelectedId],
  );

  const actionTitle = (action?: string | null) => (action ? codeText(`audit.log.action.${action}`, action) : "—");
  const sourceLabel = (source?: string | null, mode?: string | null) => {
    const raw = source ?? mode;
    return raw ? codeText(`audit.log.source.${raw}`, raw) : "—";
  };
  const outcomeLabel = (row: AuditRecord) =>
    row.outcome ? codeText(`audit.log.outcome.${row.outcome}`, row.outcome) : row.anomaly ? "!" : t("audit.log.outcome.ALLOWED");

  const applyFilters = () => {
    setOffset(0);
    setSelectedId(null);
    setDismissedAuto(false);
    setApplied({
      target_type: targetTypeInput.trim() || undefined,
      target_id: targetIdInput.trim() || undefined,
      actor: actorInput.trim() || undefined,
      trace_id: traceIdInput.trim() || undefined,
    });
  };

  const resetFilters = () => {
    setTargetTypeInput("");
    setTargetIdInput("");
    setActorInput("");
    setTraceIdInput("");
    setOffset(0);
    setSelectedId(null);
    setDismissedAuto(false);
    setApplied({});
  };

  const attestationBanner = attestation.data ? (
    attestation.data.ok ? (
      <Banner
        tone={attestation.data.unsealed_tail ? "warn" : "ok"}
        title={t(attestation.data.unsealed_tail ? "audit.attestation.unsealed" : "audit.attestation.ok")}
      />
    ) : (
      <Banner tone="danger" title={t("audit.attestation.tampered", { kind: attestation.data.kind })}>
        {attestation.data.first_bad_seq != null
          ? t("audit.attestation.seq", { seq: attestation.data.first_bad_seq })
          : undefined}
      </Banner>
    )
  ) : undefined;

  return (
    <ListRecord
      q={q}
      tabs={<AuditTabs />}
      head={{
        title: t("audit.log.title"),
        titleId: "audit-log-title",
      }}
      filters={
        <div className={s.filters}>
          <div className={s.filterField}>
            <Field label={t("audit.log.filter.targetType")} required={null}>
              {p => <TextInput {...p} value={targetTypeInput} onChange={e => setTargetTypeInput(e.target.value)} />}
            </Field>
          </div>
          <div className={s.filterField}>
            <Field label={t("audit.log.filter.targetId")} required={null}>
              {p => <TextInput {...p} value={targetIdInput} onChange={e => setTargetIdInput(e.target.value)} />}
            </Field>
          </div>
          <div className={s.filterField}>
            <Field label={t("audit.log.filter.actor")} required={null}>
              {p => <TextInput {...p} value={actorInput} onChange={e => setActorInput(e.target.value)} />}
            </Field>
          </div>
          <div className={s.filterField}>
            <Field label={t("audit.log.filter.traceId")} required={null}>
              {p => <TextInput {...p} value={traceIdInput} onChange={e => setTraceIdInput(e.target.value)} />}
            </Field>
          </div>
          <Button variant="primary" onClick={applyFilters}>
            {t("audit.log.filter.apply")}
          </Button>
          {(applied.target_type || applied.target_id || applied.actor || applied.trace_id) && (
            <Button onClick={resetFilters}>{t("audit.log.filter.reset")}</Button>
          )}
        </div>
      }
      notes={attestationBanner}
      stats={
        <StatRow
          label={t("audit.log.title")}
          items={[
            { key: "rows", label: t("audit.log.stat.pageRows"), value: fmtNumber(rows.length) },
            { key: "anomalies", label: t("audit.log.stat.anomalies"), value: fmtNumber(anomalyCount) },
          ]}
        />
      }
      list={
        rows.length === 0 ? (
          <EmptyState title={t("audit.log.empty")} reason={t("audit.log.emptyReason")} />
        ) : (
          <LongTable
            label={t("audit.log.table")}
            rows={rows}
            rowId={row => row.rowKey}
            activeRowId={effectiveSelectedId ?? undefined}
            onRowAction={id => {
              setDismissedAuto(false);
              setSelectedId(id);
            }}
            total={rows.length}
            hasMore={false}
            onLoadMore={() => {}}
            density="compact"
            mobileLayout="compact"
            empty={t("audit.log.empty")}
            columns={[
              {
                id: "occurred",
                header: t("audit.log.col.occurredAt"),
                card: "fact",
                type: "date",
                width: 184,
                cell: row => fmtDateTime(row.occurred_at),
              },
              {
                id: "actor",
                header: t("audit.log.col.actor"),
                card: "title",
                rowHeader: true,
                width: 112,
                cell: row => row.actor_display ?? row.actor ?? "—",
              },
              {
                id: "action",
                header: t("audit.log.col.action"),
                card: "fact",
                width: "1.6fr",
                cell: row => {
                  const title = actionTitle(row.action);
                  return (
                    <div className={s.actionCell}>
                      <span>{title}</span>
                      {row.action && title !== row.action && <code translate="no" className="mono t-xs muted">{row.action}</code>}
                    </div>
                  );
                },
              },
              {
                id: "target",
                header: t("audit.log.col.target"),
                card: "omit",
                width: "1fr",
                cell: row => [row.target_type, row.target_id].filter(Boolean).join(" · ") || "—",
              },
              {
                id: "source",
                header: t("audit.log.col.source"),
                card: "omit",
                width: 72,
                cell: row => sourceLabel(row.source, row.change_mode),
              },
              {
                id: "outcome",
                header: t("audit.log.col.outcome"),
                card: "status",
                width: 84,
                cell: row => (
                  <Chip tone={row.anomaly ? "warn" : row.outcome === "DENIED" ? "danger" : "ok"}>
                    {outcomeLabel(row)}
                  </Chip>
                ),
              },
            ]}
          />
        )
      }
      foot={
        <div className={s.foot}>
          <span>{t("audit.log.pagination.range", { offset, count: rows.length })}</span>
          <div className={s.footActions}>
            <Button disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE_LIMIT))}>
              {t("audit.log.pagination.prev")}
            </Button>
            <Button disabled={rows.length < PAGE_LIMIT} onClick={() => setOffset(o => o + PAGE_LIMIT)}>
              {t("audit.log.pagination.next")}
            </Button>
          </div>
        </div>
      }
      record={
        selected
          ? {
              id: selected.rowKey,
              label: t("audit.detail.title"),
              title: actionTitle(selected.action),
              meta: selected.action ? <code translate="no">{selected.action}</code> : undefined,
              onClose: () => {
                setSelectedId(null);
                setDismissedAuto(true);
              },
              children: (
                <AuditDetailPane
                  selected={selected}
                  attestation={attestation.data}
                  outcomeLabel={outcomeLabel(selected)}
                  sourceLabel={sourceLabel(selected.source, selected.change_mode)}
                />
              ),
            }
          : undefined
      }
    />
  );
}
