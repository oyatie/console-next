// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { auditAttestationQuery, auditLogQuery, type AuditRecord } from "../api";
import s from "./audit.module.css";

const PAGE_LIMIT = 50;

function formatSnapValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function buildSnapDiffRows(beforeSnap: unknown, afterSnap: unknown) {
  const beforeObj = beforeSnap && typeof beforeSnap === "object" && !Array.isArray(beforeSnap)
    ? (beforeSnap as Record<string, unknown>)
    : null;
  const afterObj = afterSnap && typeof afterSnap === "object" && !Array.isArray(afterSnap)
    ? (afterSnap as Record<string, unknown>)
    : null;
  if (!beforeObj && !afterObj) {
    if (beforeSnap === undefined && afterSnap === undefined) return [];
    return [{
      key: "payload",
      label: t("audit.detail.diff"),
      value: `${formatSnapValue(beforeSnap)} → ${formatSnapValue(afterSnap)}`,
    }];
  }
  const keys = [...new Set([...Object.keys(beforeObj ?? {}), ...Object.keys(afterObj ?? {})])];
  return keys.map(key => ({
    key,
    label: key,
    value: `${t("audit.detail.before")}: ${formatSnapValue(beforeObj?.[key])} · ${t("audit.detail.after")}: ${formatSnapValue(afterObj?.[key])}`,
  }));
}

function recordKey(row: AuditRecord, index: number): string {
  return row.id ?? `${row.occurred_at}-${row.trace_id ?? index}`;
}

export function AuditPage() {
  const [targetTypeInput, setTargetTypeInput] = useState("");
  const [targetIdInput, setTargetIdInput] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [traceIdInput, setTraceIdInput] = useState("");
  const [applied, setApplied] = useState<{ target_type?: string; target_id?: string; actor?: string; trace_id?: string }>({});
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = useQuery({
    ...auditLogQuery({ limit: PAGE_LIMIT, offset, ...applied }),
    placeholderData: keepPreviousData,
  });
  const attestation = useQuery(auditAttestationQuery);

  const rows = useMemo(
    () => (q.data?.items ?? []).map((item, index) => ({ ...item, _rowKey: recordKey(item, index) })),
    [q.data?.items],
  );
  const anomalyCount = useMemo(() => rows.filter(item => Boolean(item.anomaly)).length, [rows]);
  const selected = useMemo(
    () => rows.find(item => item._rowKey === selectedId) ?? null,
    [rows, selectedId],
  );
  const diffRows = useMemo(
    () => (selected ? buildSnapDiffRows(selected.before_snap, selected.after_snap) : []),
    [selected],
  );

  const applyFilters = () => {
    setOffset(0);
    setSelectedId(null);
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
        <Card title={t("audit.log.title")} flush>
          {rows.length === 0 ? (
            <EmptyState title={t("audit.log.empty")} reason={t("audit.log.emptyReason")} />
          ) : (
            <LongTable
              label={t("audit.log.table")}
              rows={rows}
              rowId={row => row._rowKey}
              activeRowId={selectedId ?? undefined}
              onRowAction={id => setSelectedId(id)}
              total={rows.length}
              hasMore={false}
              onLoadMore={() => {}}
              empty={t("audit.log.empty")}
              columns={[
                {
                  id: "occurred",
                  header: t("audit.log.col.occurredAt"),
                  card: "fact",
                  type: "date",
                  width: 200,
                  cell: row => fmtDateTime(row.occurred_at),
                },
                {
                  id: "actor",
                  header: t("audit.log.col.actor"),
                  card: "title",
                  rowHeader: true,
                  cell: row => row.actor_display ?? row.actor ?? "—",
                },
                {
                  id: "action",
                  header: t("audit.log.col.action"),
                  card: "fact",
                  cell: row => row.action ?? "—",
                },
                {
                  id: "target",
                  header: t("audit.log.col.target"),
                  card: "fact",
                  cell: row => [row.target_type, row.target_id].filter(Boolean).join(" · ") || "—",
                },
                {
                  id: "source",
                  header: t("audit.log.col.source"),
                  card: "fact",
                  cell: row => row.source ?? row.change_mode ?? "—",
                },
                {
                  id: "outcome",
                  header: t("audit.log.col.outcome"),
                  card: "status",
                  cell: row => (
                    <Chip tone={row.anomaly ? "warn" : row.outcome === "DENIED" ? "danger" : "neutral"}>
                      {row.outcome ?? (row.anomaly ? "!" : "OK")}
                    </Chip>
                  ),
                },
              ]}
            />
          )}
        </Card>
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
              id: selected._rowKey,
              label: t("audit.detail.title"),
              title: selected.action ?? t("audit.detail.title"),
              onClose: () => setSelectedId(null),
              children: (
                <div className={s.paneDetail}>
                  <Card title={t("audit.detail.title")}>
                    <KeyValue
                      density="dense"
                      items={[
                        { key: "id", label: t("audit.detail.id"), value: selected.id ?? "—" },
                        { key: "actor", label: t("audit.log.col.actor"), value: selected.actor_display ?? selected.actor ?? "—" },
                        { key: "at", label: t("audit.log.col.occurredAt"), value: fmtDateTime(selected.occurred_at) },
                        {
                          key: "target",
                          label: t("audit.log.col.target"),
                          value: [selected.target_type, selected.target_id].filter(Boolean).join(" · ") || "—",
                        },
                        {
                          key: "trace",
                          label: t("audit.detail.trace"),
                          value: [selected.trace_id, selected.span_id].filter(Boolean).join(" / ") || "—",
                        },
                        { key: "branch", label: t("audit.detail.branch"), value: selected.branch_id ?? "—" },
                        {
                          key: "auth",
                          label: t("audit.detail.auth"),
                          value: [selected.auth_method, selected.device].filter(Boolean).join(" · ") || "—",
                        },
                        { key: "ip", label: t("audit.detail.ip"), value: selected.ip ?? "—" },
                        {
                          key: "reason",
                          label: t("audit.detail.reason"),
                          value: [selected.reason_code, selected.reason].filter(Boolean).join(" · ") || "—",
                        },
                        {
                          key: "badges",
                          label: t("audit.detail.badges"),
                          value: selected.classification_badges?.length ? selected.classification_badges.join(" · ") : "—",
                        },
                      ]}
                    />
                  </Card>
                  <Card title={t("audit.detail.diff")}>
                    {diffRows.length ? (
                      <KeyValue density="dense" items={diffRows} />
                    ) : (
                      <EmptyState title={t("audit.detail.noSnap")} reason={null} />
                    )}
                  </Card>
                </div>
              ),
            }
          : undefined
      }
    />
  );
}
