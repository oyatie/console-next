import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Card } from "../../../ui/card/card";
import { LongTable, TableControl, type LongColumn } from "../../../ui/long-table/long-table";
import { Table } from "../../../ui/table";
import { previewEntries, type BoardRow, type DayBoard } from "../api";
import { baseOf, cellKey, draftState, readPaste, splitKey, type PasteResult } from "../domain/grid";
import { closed } from "../domain/month-state";
import { duration } from "../domain/minutes";
import { entryText, refusalText, shiftText } from "../present";
import css from "./records.module.css";
import { MarkChip } from "./mark-chip";
import { PastePreviewSheet, type PastePerson } from "./paste-preview";
import type { useDrafts } from "./use-drafts";
import { usePreview } from "./use-preview";
import { usePlanKinds } from "./use-plan-kinds";

type PendingPaste = { scope: string; date: string; people: PastePerson[]; plan: PasteResult; bases: (string | null)[] };

/**
 * Day · detailed (A3-entry): one row per person with the input in place. A paste of several rows matches them by
 * employee number (never by name) and says how many matched. The recognition column is the server's preview of the
 * drafts, "computing recognition" while it is on its way, never a guessed number.
 */
export function DayDetail({ board, store, onAssign }: { board: DayBoard; store: ReturnType<typeof useDrafts>; onAssign: (row: BoardRow) => void }) {
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
  const [pasted, setPasted] = useState<{ message: string; tone: "ok" | "warn" } | null>(null);
  const [pasting, setPasting] = useState<PendingPaste | null>(null);
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
  const acceptPaste = () => {
    if (!pasting) return;
    if (pasting.scope !== store.scope || pasting.date !== date || pasting.plan.cells.some((cell) => {
      const person = pasting.people[cell.r];
      const row = person && rows.find((candidate) => candidate.employee_id === person.employee_id);
      return cell.date !== date || !row || row.own !== person.own || closed(row.month_state) !== person.closed;
    })) {
      setPasting(null);
      setPasted({ message: t("attendanceRecords.paste.preview.stale"), tone: "warn" });
      return;
    }
    const currentRows = new Map(rows.map((row) => [row.employee_id, row] as const));
    const next = { ...store.drafts };
    let locked = 0;
    for (const [i, cell] of pasting.plan.cells.entries()) {
      const person = pasting.people[cell.r]!;
      const row = currentRows.get(person.employee_id)!;
      if (row.own || closed(row.month_state)) {
        locked += 1;
        continue;
      }
      const key = cellKey(person.employee_id, date);
      next[key] = { value: cell.value, base: baseOf(store.drafts, key, pasting.bases[i] === undefined ? row.day.entry?.id ?? null : pasting.bases[i]!) };
    }
    store.set(next);
    setPasting(null);
    setPasted({ message: t("attendanceRecords.paste.matched", { rows: pasting.plan.matched + pasting.plan.missing.length, matched: pasting.plan.matched, missing: pasting.plan.missing.length, locked }), tone: "ok" });
  };
  return (
    <div
      className={css.detail}
      onPaste={(e) => {
        if (!(e.target instanceof HTMLElement) || !e.target.closest('[role="grid"], table')) return;
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        const row = e.target.closest<HTMLElement>('tr[data-id], [role="row"][data-key]');
        const rowId = row?.dataset.id ?? row?.dataset.key;
        const anchorRow = rows.findIndex((row) => row.employee_id === rowId);
        const plan = readPaste(text, rows.map((r) => r.employee_number ?? null), [date], { r: Math.max(0, anchorRow), c: 0 });
        const people = rows.map((row) => ({ employee_id: row.employee_id, employee_number: row.employee_number ?? null, name: row.name, own: row.own, closed: closed(row.month_state) }));
        const bases = plan.cells.map((cell) => {
          const row = rows[cell.r]!;
          const key = cellKey(row.employee_id, date);
          return baseOf(store.drafts, key, row.day.entry?.id ?? null);
        });
        setPasting({ scope: store.scope, date, people, plan, bases });
      }}
    >
      {pasted && <Banner tone={pasted.tone}>{pasted.message}</Banner>}
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

      {pasting && <PastePreviewSheet plan={pasting.plan} people={pasting.people} month={pasting.date.slice(0, 7)} onClose={() => setPasting(null)} onAccept={acceptPaste} />}
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
