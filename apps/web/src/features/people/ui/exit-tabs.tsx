import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { ToggleButton } from "../../../ui/button/button";
import { RecordRows } from "../../../ui/record/rows";
import { voidedQuery } from "../api/record";
import { tx } from "../present";
import { Band } from "../../../ui/band/band";
import s from "./roster.module.css";

export type ExitView = "kept" | "voided";

/** The exited view's two lists (E9-exited): people kept 3 years, and registrations voided (kept apart, never counted). */
export function ExitTabs({ view, kept, onView }: { view: ExitView; kept?: number; onView: (v: ExitView) => void }) {
  const voided = useQuery(voidedQuery).data;
  return (
    <div className={s.exitTabs} role="group" aria-label={t("roster.exitTabs.label")}>
      <ToggleButton pressed={view === "kept"} onClick={() => onView("kept")} count={kept === undefined ? "" : fmtNumber(kept)}>{t("roster.exitTabs.kept")}{" "}</ToggleButton>
      <ToggleButton pressed={view === "voided"} onClick={() => onView("voided")} count={voided ? fmtNumber(voided.length) : ""}>{t("roster.exitTabs.voided")}{" "}</ToggleButton>
    </div>
  );
}

/** Registrations voided (MR-26): who, the number they had (never reused), when, why; nothing to act on here. */
export function VoidedList() {
  const q = useQuery(voidedQuery);
  const rows = q.data ?? [];
  return (
    <Band className={s.voided}>
      {rows.length === 0 ? <p className={s.said}>{q.isPending ? t("common.loading") : t("roster.voided.none")}</p> : (
      <RecordRows
        label={t("roster.exitTabs.voided")}
        rows={rows}
        rowId={(r) => r.employee_id}
        columns={[
          { header: t("people.col.number"), cell: (r) => <span className="code">{r.employee_number ?? "—"}</span> },
          { header: t("people.col.name"), cell: (r) => <b>{r.name}</b> },
          { header: t("roster.voided.at"), cell: (r) => fmtDate(r.voided_at) },
          { header: t("roster.voided.why"), cell: (r) => tx(`empDoc.void.employee.reason.${r.void_reason_code}`) },
          { header: t("roster.voided.pii"), cell: (r) => (r.pii_destroyed_at ? fmtDate(r.pii_destroyed_at) : t("roster.voided.piiKept")) },
        ]}
      />
      )}
    </Band>
  );
}
