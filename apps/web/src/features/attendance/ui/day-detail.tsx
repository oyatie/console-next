import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Card } from "../../../ui/card/card";
import { LongTable, TableControl, type LongColumn } from "../../../ui/long-table/long-table";
import { Table } from "../../../ui/table";
import { previewEntries, type BoardRow, type DayBoard } from "../api";
import { baseOf, cellKey, draftState, readPaste, splitKey } from "../domain/grid";
import { duration } from "../domain/minutes";
import { entryText, refusalText, shiftText } from "../present";
import css from "./records.module.css";
import { MarkChip } from "./mark-chip";
import type { useDrafts } from "./use-drafts";
import { usePreview } from "./use-preview";
import { usePlanKinds } from "./use-plan-kinds";

/**
 * Day · detailed (A3-entry): one row per person with the input in place. A paste of several rows matches them by
 * employee number (never by name) and says how many matched. The recognition column is the server's preview of the
 * drafts, "computing recognition" while it is on its way, never a guessed number.
 */
export function DayDetail({ board, store, onAssign, onNote }: { board: DayBoard; store: ReturnType<typeof useDrafts>; onAssign: (row: BoardRow) => void; onNote: (message: string) => void }) {
  const rows = useMemo(() => board.groups.flatMap((g) => g.rows), [board.groups]);
  const date = board.date;
  const [query, setQuery] = useState("");
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, []);
  const kindOf = usePlanKinds(rows, date);
  const cells = Object.entries(store.drafts).filter(([k, d]) => draftState(d, kindOf(k)).ok).map(([k, d]) => ({ ...splitKey(k), value: d.value, base_entry_id: d.base ?? undefined }));
  const preview = usePreview(cells.length ? cells : null, previewEntries);
  const after = useMemo(() => new Map(preview.data?.cells.map(c => [c.employee_id, c])), [preview.data]);
  const recognised = (r: BoardRow) => {
    if (!store.drafts[cellKey(r.employee_id, date)]) return duration(r.day.recognition.recognised);
    if (preview.pending) return t("attendanceRecords.detail.computing");
    const a = after.get(r.employee_id);
    return a?.after ? t("attendanceRecords.detail.provisional", { value: duration(a.after.recognition.recognised) }) : a?.code ? refusalText(a.code) : "";
  };
  const groupMeta = (g: DayBoard["groups"][number]) => t("attendanceRecords.board.groupMeta", { people: g.people, normal: g.normal, unscheduled: g.no_schedule, blocking: g.marks.blocking, decision: g.marks.decision });
  const columns: LongColumn<BoardRow>[] = [
    { id: "number", width: 120, header: t("attendanceRecords.grid.number"), cell: (r) => r.employee_number ?? "" },
    { id: "name", width: 160, rowHeader: true, header: t("attendanceRecords.grid.name"), cell: (r) => r.name },
    { id: "plan", width: 240, header: t("attendanceRecords.day.plan"), cell: (r) => <>{r.day.plan.shift ? shiftText(r.day.plan.shift) : t(`attendance.dayKind.${r.day.plan.kind}`)}{r.day.plan.kind === "NO_SCHEDULE" && <> <TableControl><Button size="sm" onKeyDown={e => e.stopPropagation()} onClick={() => onAssign(r)}>{t("attendanceRecords.unscheduled.assign")}</Button></TableControl></>}</> },
    {
      id: "input", width: 320, header: t("attendanceRecords.detail.input"),
      cell: (r) => {
        const k = cellKey(r.employee_id, date);
        const d = store.drafts[k];
        const s = d ? draftState(d, r.day.plan.kind) : null;
        if (r.own) return t("attendanceRecords.grid.ownRow");
        return (
          <Field label={t("attendanceRecords.detail.inputFor", { name: r.name })} required={false} error={s && !s.ok ? refusalText(s.code) : undefined}>
            {(p) => <TableControl><TextInput {...p} value={d?.value ?? ""} placeholder={undefined} maxLength={40} onChange={(e) => store.put(k, e.target.value.trim() ? { value: e.target.value, base: baseOf(store.drafts, k, r.day.entry?.id ?? null) } : null)} /></TableControl>}
          </Field>
        );
      },
    },
    { id: "recorded", width: 160, header: t("attendanceRecords.detail.recorded"), cell: (r) => (r.day.entry ? entryText(r.day.entry.kind, r.day.entry.segments) : "–") },
    { id: "recognised", width: 160, header: t("attendanceRecords.detail.recognised"), cell: recognised },
    { id: "result", width: 160, header: t("attendanceRecords.detail.result"), cell: (r) => r.day.marks.filter(m => m !== "NO_SCHEDULE").map((m) => <MarkChip key={m} mark={m} />) },
    { id: "source", width: 160, header: t("attendanceRecords.detail.source"), cell: (r) => (r.day.entry ? t(`attendanceRecords.source.${r.day.entry.source}`) : "–") },
  ];
  return (
    <div
      className={css.detail}
      onPaste={(e) => {
        if (!(e.target instanceof HTMLElement) || !e.target.closest('[role="grid"], table')) return;
        const text = e.clipboardData.getData("text/plain");
        if (!text.includes("\n")) return;
        e.preventDefault();
        const p = readPaste(text, rows.map((r) => r.employee_number ?? null), { r: 0, c: 0 });
        const next = { ...store.drafts };
        let locked = 0;
        for (const c of p.cells.filter((x) => x.c === 0)) {
          const row = rows[c.r]!;
          if (row.own) locked += 1;
          else next[cellKey(row.employee_id, date)] = { value: c.value, base: baseOf(store.drafts, cellKey(row.employee_id, date), row.day.entry?.id ?? null) };
        }
        store.set(next);
        onNote(t("attendanceRecords.paste.matched", { rows: p.matched + p.missing.length, matched: p.matched, missing: p.missing.length, locked }));
      }}
    >
      {printing ? <Table<BoardRow>
        label={t("attendanceRecords.detail.label")}
        rows={rows}
        rowId={r => r.employee_id}
        columns={columns.map(({ header, cell }) => ({ header, cell }))}
        groups={board.groups.map(g => ({ id: `${g.workplace_id}-${g.unit_id}`, header: <>{g.name} · {groupMeta(g)}</>, rows: g.rows }))}
      /> : <>
        <Field label={t("attendanceSchedule.person.find")} required={null}>
          {p => <TextInput {...p} value={query} onChange={e => setQuery(e.target.value)} />}
        </Field>
        {board.groups.map(g => <DetailGroup key={`${board.date}-${g.workplace_id}-${g.unit_id}`} group={g} columns={columns} query={query} meta={groupMeta(g)} />)}
      </>}

    </div>
  );
}

function DetailGroup({ group, columns, query, meta }: { group: DayBoard["groups"][number]; columns: LongColumn<BoardRow>[]; query: string; meta: string }) {
  const [batch] = useState(() => {
    if (typeof window === "undefined") return Math.max(1, group.rows.length);
    const height = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h"));
    return height > 0 ? Math.max(1, Math.ceil(window.innerHeight / height)) : Math.max(1, group.rows.length);
  });
  const [pages, setPages] = useState(1);
  const q = query.trim().toLocaleLowerCase();
  const matching = q ? group.rows.filter(r => `${r.name} ${r.employee_number ?? ""}`.toLocaleLowerCase().includes(q)) : group.rows;
  const rows = matching.slice(0, batch * pages);
  return <Card title={group.name} meta={meta} flush>
    <LongTable label={`${t("attendanceRecords.detail.label")} · ${group.name}`} columns={columns} rows={rows} rowId={r => r.employee_id} total={matching.length}
      findSlot={null}
      editable hasMore={rows.length < matching.length} onLoadMore={() => setPages(n => n + 1)} empty={t("attendanceSchedule.person.none")} />
  </Card>;
}
