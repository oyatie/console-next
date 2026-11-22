import { entityNameText } from "../../../reference/entity/present";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { entitiesRef } from "../../../reference/entity/api";
import { ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import type { ImportRow } from "../domain/contract";
import { filterRows, needsLook, OUTCOMES, tally, type RowFilter } from "../domain/steps";
import { filterTriageRows, type TriageBucket } from "../domain/triage";
import { employeeStatusLabel, idTypeLabel, matchedLabel, numberSourceLabel, outcomeLabel } from "../present";
import { IMPORT_OUTCOME } from "../../../lib/labels";
import { EnumValue } from "../../../ui/enum-value";
import { RowDetail } from "./row-detail";
import s from "./import.module.css";

const ATTENTION_FIRST: readonly ImportRow["outcome"][] = ["refused", "unresolved_identity"];

/**
 * Every row's outcome as the server computed it, virtualised for rosters of thousands: the employee number it gets (or "no employee number") and where that came from, the employment status a new person comes in with (leave included), where they are placed
 * and how a person on file was found. Choosing a row shows its detail below. Answers live in the needs-review queue.
 */
export function DryRows({
  rows,
  consoleMode = false,
  triage,
  selectedKey,
  onSelectRow,
  inlineDetail = true,
}: {
  rows: readonly ImportRow[];
  consoleMode?: boolean;
  triage?: TriageBucket;
  selectedKey?: string | null;
  onSelectRow?: (key: string) => void;
  inlineDetail?: boolean;
}) {
  const n = tally(rows);
  const attention = rows.filter(needsLook).length;
  const onLeave = rows.filter((r) => r.new_person?.status === "ON_LEAVE").length;
  const [filter, setFilter] = useState<RowFilter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const activeKey = selectedKey !== undefined ? selectedKey : sel;
  const entities = useQuery(entitiesRef);
  const triagedRows = triage ? filterTriageRows(rows, triage) : rows;
  const shownRows = [...filterRows(triagedRows, filter)];
  const current = activeKey ? rows.find((r) => r.source_key === activeKey) : undefined;
  const place = (r: ImportRow) => {
    const id = r.new_person?.workplace_id;
    if (!id) return r.new_person ? t(r.new_person.status === "EXITED" ? "import.rows.entityUndecided" : "import.rows.unplaced") : "—";
    for (const e of entities.data?.items ?? []) {
      const w = e.workplaces.find((x) => x.id === id);
      if (w) return `${entityNameText(e)} · ${w.current?.name ?? ""}`;
    }
    return "—";
  };
  const number = (r: ImportRow) => {
    const np = r.new_person;
    if (!np) return <bdi className="code">{r.employee_number ?? "—"}</bdi>;
    if (np.employee_number == null) return <Chip tone="warn">{t("import.number.none")}</Chip>;
    return <span className={s.cellLine}><bdi className="code">{np.employee_number}</bdi>{np.employee_number_source && np.employee_number_source !== "file" && <Chip tone="info">{numberSourceLabel(np.employee_number_source)}</Chip>}</span>;
  };
  const columns: LongColumn<ImportRow>[] = [
    { id: "at", header: t("import.col.sheetRow"), card: "title", cell: (r) => <bdi className="num">{r.sheet} · {r.row}</bdi>, width: 112 },
    { id: "number", header: t("import.rows.col.number"), card: "fact", cell: number, width: 136 },
    { id: "name", header: t("import.rows.col.name"), card: "title", cell: (r) => r.name, rowHeader: true, width: "1fr" },
    {
      id: "status",
      header: t("import.rows.col.status"),
      card: "fact",
      cell: (r) =>
        r.new_person
          ? r.new_person.id_type
            ? `${employeeStatusLabel(r.new_person.status)} · ${idTypeLabel(r.new_person.id_type)}`
            : employeeStatusLabel(r.new_person.status)
          : "—",
      width: 205,
    },
    { id: "place", header: t("import.rows.col.place"), card: "fact", cell: place, width: "1.5fr" },
    { id: "outcome", header: t("import.rows.col.outcome"), card: "status", cell: (r) => <EnumValue e={IMPORT_OUTCOME} value={r.outcome} />, width: 110 },
    { id: "matched", header: t("import.rows.col.matched"), card: "omit", cell: (r) => (r.matched_by ? matchedLabel(r.matched_by) : "—"), width: 96 },
  ];
  const title = t("import.rows.title");
  return (
    <section className="card" aria-labelledby="import-rows">
      <div className="toolbar">
        <h2 id="import-rows" className="toolbar__title">{title}</h2>
        {!consoleMode && (
          <div className={s.filters} role="group" aria-label={title}>
            <ToggleButton pressed={filter === "all"} onClick={() => setFilter("all")}>{t("import.rows.filter.all", { count: rows.length })}</ToggleButton>
            {attention > 0 && <ToggleButton pressed={filter === "attention"} onClick={() => setFilter("attention")}>{t("import.rows.filter.attention", { count: attention })}</ToggleButton>}
            {onLeave > 0 && <ToggleButton pressed={filter === "on_leave"} onClick={() => setFilter("on_leave")}>{t("import.rows.filter.onLeave", { count: onLeave })}</ToggleButton>}
            {OUTCOMES.filter((o) => n[o] > 0 && !ATTENTION_FIRST.includes(o)).map((o) => (
              <ToggleButton key={o} pressed={filter === o} onClick={() => setFilter(o)}>{t("import.rows.filter.outcome", { label: outcomeLabel(o), count: n[o] })}</ToggleButton>
            ))}
          </div>
        )}
      </div>
      <LongTable
        label={title}
        caption={t("import.rows.caption", { shown: shownRows.length, count: rows.length })}
        columns={columns}
        rows={shownRows}
        rowId={(r) => r.source_key}
        activeRowId={activeKey ?? undefined}
        hasMore={false}
        onLoadMore={() => undefined}
        empty={t("import.rows.none")}
        density="compact"
        mobileLayout={consoleMode ? "compact" : "cards"}
        onRowAction={(id) => (setSel(id), onSelectRow?.(id))}
      />
      {inlineDetail && (current ? <RowDetail r={current} /> : <p className={`muted ${s.inset}`}>{t("import.rows.pick")}</p>)}
    </section>
  );
}
