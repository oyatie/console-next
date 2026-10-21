import { EntityName } from "../../../reference/entity/ui/entity-name";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, label, labeled } from "../../../lib/labels";
import { entitiesRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { daysBetween, nextItems, retentionEnd } from "../domain/roster";
import type { ColumnId } from "../domain/columns";
import { Meter } from "../../../ui/meter/meter";
import { nextText } from "../present";
import { SOON_DAYS } from "./use-roster";
import s from "./roster.module.css";
import { Muted } from "../../../ui/muted/muted";

type Employee = components["schemas"]["Employee"];

export function StatusChip({ status }: { status?: string | null }) {
  const st = labeled(EMPLOYEE_STATUS, status ?? "UNKNOWN");
  // active is the quiet default (plain text); every other state stands out as a chip.
  return status === "ACTIVE" ? <span className={s.steel}>{st.label}</span> : <Chip tone={st.tone}>{st.label}</Chip>;
}

/** The most urgent next item, with "+n" when there are more (all of them in the tooltip and in the panel). */
function Next({ e, today }: { e: Employee; today: string }) {
  const items = nextItems(e, today, SOON_DAYS).map(nextText);
  const [first] = items;
  if (!first) return <span className={s.steel}>{"—"}</span>;
  return (
    <span className="num" title={items.map((i) => i.text).join("\n")}>
      {first.tone ? <Chip tone={first.tone}>{first.text}</Chip> : first.text}
      {items.length > 1 && <> <Muted>{t("roster.next.more", { count: items.length - 1 })}</Muted></>}
    </span>
  );
}

/**
 * The roster's columns (E1): employee number, name (a shared name gets nothing added: same-name people are told apart by employee number and placement on the
 * same row), company, placement (workplace › department), position, employment type, hire date, status, next. One line each, the full text in the title.
 */
function useColumns(today: string, exited: boolean, shown: readonly ColumnId[]): LongColumn<Employee>[] {
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const entity = (e: Employee) => entities.find((x) => x.id === e.legal_entity_id);
  const place = (e: Employee) => {
    const u = units.find((x) => x.id === e.org_unit_id);
    if (!u) return e.org_unit ?? t("roster.unplaced");
    const path = unitPath(units, u);
    return u.kind === "SITE" ? t("roster.siteDirect", { site: path }) : path;
  };
  const kept: LongColumn<Employee>[] = [
    { id: "last", header: t("roster.col.lastDay"), cell: (e) => <span className="num">{e.exit_date ? fmtDate(e.exit_date) : "—"}</span>, width: 120 },
    { id: "keep", header: t("roster.col.keepUntil"), cell: (e) => <span className="num">{e.exit_date ? fmtDate(retentionEnd(e.exit_date)) : "—"}</span>, width: 120 },
    { id: "left", header: t("roster.col.keepLeft"), cell: (e) => <Keep e={e} today={today} />, width: "1.4fr" },
  ];
  const base: LongColumn<Employee>[] = [
    { id: "number", header: t("people.col.number"), cell: (e) => <span className="code">{e.employee_number ?? t("people.number.none")}</span>, rowHeader: true, width: 84 },
    { id: "name", header: t("people.col.name"), cell: (e) => <span className={s.nm} title={e.name}>{e.name}</span>, rowHeader: true, width: 100 },
    { id: "entity", header: t("roster.col.entity"), cell: (e) => <EntityName entity={entity(e)} alias={entity(e) ? undefined : e.company} />, width: 104 },
    { id: "unit", header: t("roster.col.place"), cell: (e) => <span title={place(e)}>{place(e)}</span>, width: "2.2fr" },
    { id: "position", header: t("people.col.position"), cell: (e) => <span title={e.position ?? undefined}>{e.position ?? "—"}</span>, width: 72 },
    { id: "type", header: t("roster.col.type"), cell: (e) => (e.employment_type ? label(EMPLOYMENT_TYPE, e.employment_type) : <span className={s.warnText}>{t("roster.type.missing")}</span>), width: 92 },
    { id: "hired", header: t("people.col.hired"), cell: (e) => <span className="num">{e.hire_date ? fmtDate(e.hire_date) : "—"}</span>, width: 112 },
    {
      id: "status",
      header: t("people.col.status"),
      cell: (e) => (
        <>
          <StatusChip status={e.status} />
          {e.register_review_required && <> <Chip tone="warn">{t("roster.review.register")}</Chip></>}
          {e.identity_review_required && <> <Chip tone="warn">{t("people.identityReview")}</Chip></>}
        </>
      ),
      width: 96,
    },
    { id: "next", header: t("roster.col.next"), cell: (e) => <Next e={e} today={today} />, width: "1.6fr" },
  ];
  // Exited people (E9-exited): the 3-year retention replaces placement details and what comes next.
  if (exited) return [...base.slice(0, 4), ...kept];
  return [...base.slice(0, 2), ...shown.flatMap((id) => base.filter((c) => c.id === id))];
}

/** What remains of the 3-year retention: a bar and the days; overdue rows say so and are never deleted on their own. */
function Keep({ e, today }: { e: Employee; today: string }) {
  if (!e.exit_date) return <span className={s.steel}>{"—"}</span>;
  const left = daysBetween(today, retentionEnd(e.exit_date));
  const total = daysBetween(e.exit_date, retentionEnd(e.exit_date));
  return (
    <span className={s.keep}>
      <Meter value={Math.max(0, left)} max={total} label={t("roster.keep.meter")} warn={left <= 90} />
      <span className={left <= 90 ? s.warnText : s.steel}>{left >= 0 ? t("roster.keep.left", { days: left }) : t("roster.keep.over", { days: -left })}</span>
    </span>
  );
}

type TableProps = Parameters<typeof LongTable<Employee>>[0];

/** The people table: compact rows of the roster's columns, everything else as LongTable takes it. */
export function RosterTable({ today, exited = false, shown, density, ...p }: Omit<TableProps, "columns" | "density" | "rowId"> & { today: string; exited?: boolean; shown: readonly ColumnId[]; density: "compact" | "regular" }) {
  return <LongTable {...p} density={density} columns={useColumns(today, exited, shown)} rowId={(e) => e.id} />;
}
