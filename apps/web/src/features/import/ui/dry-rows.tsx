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
import { employeeStatusLabel, matchedLabel, numberSourceLabel, OUTCOME_TONE, outcomeLabel } from "../present";
import { RowDetail } from "./row-detail";
import s from "./import.module.css";

const ATTENTION_FIRST: readonly ImportRow["outcome"][] = ["refused", "unresolved_identity"];

/**
 * Every row's outcome as the server computed it, virtualised for rosters of thousands: the employee number it gets (or "no employee number") and where that came from, the employment status a new person comes in with (leave included), where they are placed
 * and how a person on file was found. Choosing a row shows its detail below. Answers live in the needs-review queue.
 */
export function DryRows({ rows }: { rows: readonly ImportRow[] }) {
  const n = tally(rows);
  const attention = rows.filter(needsLook).length;
  const onLeave = rows.filter((r) => r.new_person?.status === "ON_LEAVE").length;
  const [filter, setFilter] = useState<RowFilter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const entities = useQuery(entitiesRef);
  const shownRows = [...filterRows(rows, filter)];
  const current = sel ? rows.find((r) => r.source_key === sel) : undefined;
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
    if (!np) return <span className="code">{r.employee_number ?? "—"}</span>;
    if (np.employee_number == null) return <Chip tone="warn">{t("import.number.none")}</Chip>;
    return <span className={s.cellLine}><span className="code">{np.employee_number}</span>{np.employee_number_source && np.employee_number_source !== "file" && <Chip tone="info">{numberSourceLabel(np.employee_number_source)}</Chip>}</span>;
  };
  const columns: LongColumn<ImportRow>[] = [
    { id: "at", header: t("import.col.sheetRow"), cell: (r) => <span className="num">{r.sheet} · {r.row}</span>, width: 120 },
    { id: "number", header: t("import.rows.col.number"), cell: number, width: 150 },
    { id: "name", header: t("import.rows.col.name"), cell: (r) => r.name, rowHeader: true, width: "1fr" },
    { id: "status", header: t("import.rows.col.status"), cell: (r) => (r.new_person ? employeeStatusLabel(r.new_person.status) : "—"), width: 96 },
    { id: "place", header: t("import.rows.col.place"), cell: place, width: "2fr" },
    { id: "outcome", header: t("import.rows.col.outcome"), cell: (r) => <Chip tone={OUTCOME_TONE[r.outcome]}>{outcomeLabel(r.outcome)}</Chip>, width: 120 },
    { id: "matched", header: t("import.rows.col.matched"), cell: (r) => (r.matched_by ? matchedLabel(r.matched_by) : "—"), width: 110 },
  ];
  const title = t("import.rows.title");
  return (
    <section className="card" aria-labelledby="import-rows">
      <div className="toolbar">
        <h2 id="import-rows" className="toolbar__title">{title}</h2>
        <div className={s.filters} role="group" aria-label={title}>
          <ToggleButton pressed={filter === "all"} onClick={() => setFilter("all")}>{t("import.rows.filter.all", { count: rows.length })}</ToggleButton>
          {attention > 0 && <ToggleButton pressed={filter === "attention"} onClick={() => setFilter("attention")}>{t("import.rows.filter.attention", { count: attention })}</ToggleButton>}
          {onLeave > 0 && <ToggleButton pressed={filter === "on_leave"} onClick={() => setFilter("on_leave")}>{t("import.rows.filter.onLeave", { count: onLeave })}</ToggleButton>}
          {OUTCOMES.filter((o) => n[o] > 0 && !ATTENTION_FIRST.includes(o)).map((o) => (
            <ToggleButton key={o} pressed={filter === o} onClick={() => setFilter(o)}>{t("import.rows.filter.outcome", { label: outcomeLabel(o), count: n[o] })}</ToggleButton>
          ))}
        </div>
      </div>
      <LongTable
        label={title}
        caption={t("import.rows.caption", { shown: shownRows.length, count: rows.length })}
        columns={columns}
        rows={shownRows}
        rowId={(r) => r.source_key}
        hasMore={false}
        onLoadMore={() => undefined}
        empty={t("import.rows.none")}
        density="compact"
        onRowAction={setSel}
      />
      {current ? <RowDetail r={current} /> : <p className={`muted ${s.inset}`}>{t("import.rows.pick")}</p>}
    </section>
  );
}
