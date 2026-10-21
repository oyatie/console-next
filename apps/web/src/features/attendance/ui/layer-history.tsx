import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { layersQuery, type Layer, type ScopeKind } from "../api";
import { dateText } from "../present";

const TONE = { SCHEDULED: "info", IN_EFFECT: "ok", ENDED: "neutral", CANCELLED: "neutral" } as const;

/**
 * Every layer this scope ever held, newest first: scheduled · in effect · past · cancelled, who assigned it and when, and
 * the one verb a layer has — "cancel" until its start date. After that it stays in history and a new layer replaces it.
 */
export function LayerHistory({ kind, id, onCancel }: { kind: ScopeKind; id: string; onCancel: (l: Layer) => void }) {
  const q = useQuery(layersQuery(kind, id));
  const period = (l: Layer) =>
    l.effective_to ? t("attendanceSchedule.history.range", { from: dateText(l.effective_from), to: dateText(l.effective_to) }) : t("attendanceSchedule.history.from", { from: dateText(l.effective_from) });
  return (
    <Card title={t("attendanceSchedule.history.title")} flush meta={t("attendanceSchedule.history.rule")}>
      <QueryState q={q} empty={(d) => (d.items.length ? null : <EmptyState title={t("attendanceSchedule.history.none")} reason={t("attendanceSchedule.history.none.reason")} />)}>
        {(d) => (
          <Table
            label={t("attendanceSchedule.history.title")}
            rows={d.items}
            rowId={(l) => l.id}
            columns={[
              { header: t("attendanceSchedule.history.col.pattern"), cell: (l) => <strong>{l.pattern_name}</strong> },
              { header: t("attendanceSchedule.history.col.period"), cell: (l) => <span className="num">{period(l)}</span> },
              { header: t("attendanceSchedule.history.col.reason"), cell: (l) => <>{t(`attendance.reason.${l.reason}`)}{l.evidence_ref && <><br /><span className="muted">{l.evidence_ref}</span></>}</> },
              { header: t("attendanceSchedule.history.col.state"), cell: (l) => <><Chip tone={TONE[l.state]}>{t(`attendance.state.${l.state}`)}</Chip>{l.cancel_reason && <><br /><span className="muted">{l.cancel_reason}</span></>}</>, fit: true },
              { header: t("attendanceSchedule.history.col.by"), cell: (l) => <span className="muted">{t("attendanceSchedule.history.by", { name: l.created_by_name, at: fmtDateTime(l.created_at), version: l.version })}</span> },
              {
                header: t("attendanceSchedule.history.col.actions"),
                fit: true,
                cell: (l) => (l.state === "SCHEDULED" ? <Button size="sm" variant="ghost-danger" onClick={() => onCancel(l)} aria-label={t("attendanceSchedule.history.cancelOne", { pattern: l.pattern_name })}>{t("attendanceSchedule.history.cancel")}</Button> : null),
              },
            ]}
          />
        )}
      </QueryState>
    </Card>
  );
}
