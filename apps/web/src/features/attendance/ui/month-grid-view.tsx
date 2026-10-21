import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { PersonDayGrid, type DayColumn } from "../../../ui/person-day-grid/person-day-grid";
import { at, indexOf, rectIn, type Range } from "../../../ui/person-day-grid/range";
import type { GridRow } from "../api";
import { cellShape, toneCounts } from "../domain/day";
import { closed } from "../domain/month-state";
import { baseOf, cellKey, draftState, fill, fillSchedule, readPaste, splitKey, type CellFacts, type Drafts } from "../domain/grid";
import { duration } from "../domain/minutes";
import { weekdayText } from "../present";
import { MarkGlyph } from "./mark-chip";
import type { useDrafts } from "./use-drafts";

const HOLIDAY = new Set(["PUBLIC_HOLIDAY", "SUBSTITUTE_HOLIDAY", "ELECTION_DAY", "LABOR_DAY", "CONTRACTUAL_HOLIDAY"]);
const REST = new Set(["WEEKLY_HOLIDAY", "REST_DAY"]);

/** The open editor: its person-day, the If-Match base seen when typing began, whether its month is closed, and the
 * drafts scope it was typed in. */
type Editing = { value: string; key: string; base: string | null; own: boolean; closed: boolean; name: string; scope: string };

export type GridAct =
  | { kind: "day"; row: GridRow; day: number }
  | { kind: "void"; row: GridRow; day: number }
  | { kind: "save" }
  | { kind: "month"; step: -1 | 1 }
  | { kind: "note"; message: string };

/**
 * The month grid's cells and keys (A3-grid, spec §3): type to edit in the entry grammar, ⌘V paste by employee number,
 * `=` as scheduled over a selection, ⌘D fill down, ⌘↵ the focused draft into every selected cell, ⌘Z / ⌘Y on drafts,
 * Delete clears drafts or asks to void a saved cell, P the day sheet, ⌘S the save sheet, [ ] the month. The own row
 * and a closed month's rows are read-only. All four totals stay, a docked sheet or not (FE-2 restored).
 */
export function MonthGridView({ rows, total, days, store, range, onRange, act }: {
  rows: readonly GridRow[];
  total: number;
  days: readonly string[];
  store: ReturnType<typeof useDrafts>;
  range: Range | null;
  onRange: (r: Range) => void;
  act: (a: GridAct) => void;
}) {
  // The open editor carries its own person-day and the version on screen when typing began (the save's If-Match base):
  // a re-sort, filter or live insert while typing never commits it into another row or against a newer record.
  const [editing, setEditing] = useState<Editing | null>(null);
  const drafts: Drafts = store.drafts;
  const axes = { rows: rows.map((r) => r.employee_id), cols: days };
  const rect = rectIn(range, axes);
  const f = range && indexOf(range.focus, axes);
  const keyAt = (r: number, c: number) => cellKey(rows[r]!.employee_id, days[c]!);
  const facts = (r: number, c: number): CellFacts => {
    const row = rows[r]!;
    const cell = row.cells[c];
    return { key: keyAt(r, c), planKind: cell?.plan_kind ?? "NO_SCHEDULE", entryId: cell?.entry_id ?? null, own: row.own, closed: closed(row.month_state) };
  };
  const selected = () => {
    const out: CellFacts[] = [];
    if (rect) for (let r = rect.top; r <= rect.bottom; r += 1) for (let c = rect.left; c <= rect.right; c += 1) out.push(facts(r, c));
    return out;
  };
  const start = (value: string): Editing | null => {
    if (!f) return null;
    const x = facts(f.r, f.c);
    return { value, key: x.key, base: baseOf(drafts, x.key, x.entryId), own: x.own, closed: x.closed, name: rows[f.r]!.name, scope: store.scope };
  };
  const columns: DayColumn[] = useMemo(() => days.map((d, c) => {
    const kind = rows[0]?.cells[c]?.plan_kind ?? "";
    return { key: d, label: Number(d.slice(8)), sub: HOLIDAY.has(kind) ? t("attendanceRecords.grid.holidayShort") : weekdayText(d), tone: HOLIDAY.has(kind) ? "holiday" : REST.has(kind) ? "rest" : undefined };
  }), [days, rows]);

  const commit = (then: "down" | "right" | "stay") => {
    if (!editing) return;
    const v = editing.value.trim();
    // Closed is read at the commit, not when typing began: a live unlock or re-lock may have landed in between.
    const row = editing.scope === store.scope ? rows.find((x) => x.employee_id === splitKey(editing.key).employee_id) : undefined;
    const shut = row ? closed(row.month_state) : editing.closed;
    const refused = editing.own ? t("attendanceRecords.grid.ownRow") : shut ? t("attendanceRecords.grid.closedRow") : null;
    if (!refused) store.put(editing.key, v ? { value: v, base: editing.base } : null);
    setEditing(null);
    const { employee_id, work_date } = splitKey(editing.key);
    const r = axes.rows.indexOf(employee_id);
    const c = days.indexOf(work_date);
    if (r >= 0 && c >= 0) onRange(at(then === "down" ? (axes.rows[r + 1] ?? employee_id) : employee_id, then === "right" ? (days[c + 1] ?? work_date) : work_date));
    // After the move, which clears the last note: the refusal stays on screen.
    if (refused) act({ kind: "note", message: refused });
  };
  // The editor left without a commit: its row left the view (filtered out, removed), the view moved to another month or
  // unit (back-navigation onto a read already loaded), or the grid itself went (one not loaded yet). What was typed stays
  // its person's draft in the scope it was typed in, never the scope on screen now, and says so.
  const leave = (e: Editing) => {
    const v = e.value.trim();
    if (!v) return;
    if (e.own || e.closed) return act({ kind: "note", message: t(e.own ? "attendanceRecords.grid.editDiscarded" : "attendanceRecords.grid.editDiscardedClosed", { name: e.name }) });
    const problem = store.keep(e.scope, e.key, { value: v, base: e.base });
    act({ kind: "note", message: t(problem ? "attendanceRecords.grid.editNotKept" : "attendanceRecords.grid.editKept", { name: e.name }) });
  };
  const open = useRef({ editing, leave });
  useEffect(() => {
    open.current = { editing, leave };
  });
  useEffect(() => () => {
    const { editing: e, leave: l } = open.current;
    if (e) l(e);
  }, []);
  const { employee_id: editRow, work_date: editDay } = editing ? splitKey(editing.key) : { employee_id: "", work_date: "" };
  const gone = editing && (editing.scope !== store.scope || !axes.rows.includes(editRow) || !days.includes(editDay)) ? editing : null;
  useEffect(() => {
    if (!gone) return;
    let active = true;
    queueMicrotask(() => {
      if (!active || open.current.editing !== gone) return;
      open.current = { ...open.current, editing: null };
      setEditing(null);
      open.current.leave(gone);
    });
    return () => { active = false; };
  }, [gone]);
  const onKey = (e: KeyboardEvent): boolean => {
    const mod = e.metaKey || e.ctrlKey;
    const run = (fn: () => void) => (e.preventDefault(), fn(), true);
    if (mod && e.key.toLowerCase() === "s") return run(() => act({ kind: "save" }));
    if (mod && e.key.toLowerCase() === "z") return run(e.shiftKey ? store.redo : store.undo);
    if (mod && e.key.toLowerCase() === "y") return run(store.redo);
    if ((e.key === "[" || e.key === "]") && !mod) return run(() => act({ kind: "month", step: e.key === "[" ? -1 : 1 }));
    if (!f || !rect) return false;
    if (mod && e.key.toLowerCase() === "d") return run(() => {
      const x = rect;
      const next = { ...drafts };
      for (let c = x.left; c <= x.right; c += 1) {
        const top = drafts[keyAt(x.top, c)];
        if (top) for (let r = x.top + 1; r <= x.bottom; r += 1) if (!facts(r, c).own && !facts(r, c).closed) next[keyAt(r, c)] = { value: top.value, base: baseOf(drafts, keyAt(r, c), facts(r, c).entryId) };
      }
      store.set(next);
    });
    if (mod && e.key === "Enter") return run(() => {
      const d = drafts[keyAt(f.r, f.c)];
      if (d) store.set(fill(selected(), d.value, drafts).drafts);
    });
    if (e.key === "=" && !mod) return run(() => {
      const r = fillSchedule(selected(), drafts);
      store.set(r.drafts);
      act({ kind: "note", message: t("attendanceRecords.fill.done", { filled: r.filled, rest: r.skipped.rest, recorded: r.skipped.recorded, locked: r.skipped.locked }) });
    });
    if (e.key === "Delete" || e.key === "Backspace") return run(() => {
      const cells = selected();
      if (cells.some((c) => drafts[c.key])) store.set(Object.fromEntries(Object.entries(drafts).filter(([k]) => !cells.some((c) => c.key === k))));
      else if (facts(f.r, f.c).entryId && !facts(f.r, f.c).own && !facts(f.r, f.c).closed) act({ kind: "void", row: rows[f.r]!, day: f.c });
    });
    if ((e.key === "p" || e.key === "P") && !mod) return run(() => act({ kind: "day", row: rows[f.r]!, day: f.c }));
    return false;
  };

  // ⌘V while the grid has focus: rows by employee number, one row across from the focused cell.
  const box = useRef({ rows, focus: f, drafts });
  useEffect(() => {
    box.current = { rows, focus: f, drafts };
  });
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (!(document.activeElement as HTMLElement | null)?.matches?.('[role="grid"]')) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const { rows: rs, focus, drafts: ds } = box.current;
      if (!focus) return;
      const p = readPaste(text, rs.map((r) => r.employee_number ?? null), focus);
      if (p.needsNumber) return act({ kind: "note", message: t("attendanceRecords.paste.needsNumber") });
      const next = { ...ds };
      let locked = 0;
      for (const c of p.cells) {
        const row = rs[c.r];
        const day = days[c.c];
        if (!row || !day) continue;
        if (row.own || closed(row.month_state)) locked += 1;
        else next[cellKey(row.employee_id, day)] = { value: c.value, base: baseOf(ds, cellKey(row.employee_id, day), row.cells[c.c]?.entry_id ?? null) };
      }
      store.set(next);
      act({ kind: "note", message: t("attendanceRecords.paste.matched", { rows: p.matched + p.missing.length, matched: p.matched, missing: p.missing.length, locked }) });
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [act, days, store]);

  return (
    <PersonDayGrid<GridRow>
      label={t("attendanceRecords.grid.label")}
      total={total}
      rows={rows}
      rowKey={(r) => r.employee_id}
      lead={[
        { key: "no", header: t("attendanceRecords.grid.number"), cell: (r) => r.employee_number ?? "", width: "code" },
        { key: "name", header: t("attendanceRecords.grid.name"), width: "name", cell: (r) => (
          <>
            <Link from="/attendance" to="." search={(s) => ({ ...s, person: r.employee_id })}>{r.name}</Link>
            {r.own && <span className="muted"> {t("attendanceRecords.grid.ownTag")}</span>}
          </>
        ) },
      ]}
      days={columns}
      tail={[
        { key: "rec", header: t("attendanceRecords.total.recognised"), width: "total", cell: (r) => duration(r.totals.recognised) },
        { key: "prem", header: t("attendanceRecords.total.approved"), width: "total", cell: (r) => (r.totals.approved ? duration(r.totals.approved) : "–") },
        { key: "unrec", header: t("attendanceRecords.total.unrecognised"), width: "total", cell: (r) => (r.totals.unrecognised ? duration(r.totals.unrecognised) : "–") },
        { key: "open", header: t("attendanceRecords.total.open"), width: "total", cell: (r) => (r.totals.blocking || r.totals.decision ? t("attendanceRecords.total.openValue", { blocking: r.totals.blocking, decision: r.totals.decision }) : "–") },
      ]}
      cell={(r, c) => {
        const d = drafts[cellKey(r.employee_id, days[c]!)];
        if (d) return d.value;
        const cell = r.cells[c];
        if (!cell) return null;
        const shape = cellShape(cell);
        const marks = cell.marks ?? [];
        return (
          <>
            {shape.kind === "hours" ? shape.text : shape.kind === "code" ? t(`attendanceRecords.cell.${shape.code}`) : null}
            {marks.length > 0 && <> <MarkGlyph mark={marks[0]!} /></>}
          </>
        );
      }}
      look={(r, c) => {
        const d = drafts[cellKey(r.employee_id, days[c]!)];
        return d ? (draftState(d).ok ? "draft" : "refused") : r.own || closed(r.month_state) ? "locked" : undefined;
      }}
      describe={(r, c) => {
        const d = drafts[cellKey(r.employee_id, days[c]!)];
        const cell = r.cells[c];
        const marks = (cell?.marks ?? []).map((m) => t(`attendanceRecords.mark.${m}`)).join(", ");
        const counts = toneCounts(cell?.marks ?? []);
        return t("attendanceRecords.grid.cellLabel", { name: r.name, date: days[c]!, value: d ? t("attendanceRecords.grid.draftOf", { value: d.value }) : cell?.recognised ? duration(cell.recognised) : "", marks, blocking: counts.blocking });
      }}
      range={range}
      onRange={onRange}
      editing={editing && { value: editing.value, cell: { row: splitKey(editing.key).employee_id, col: splitKey(editing.key).work_date } }}
      onEdit={(v) => setEditing(v === null ? null : editing ? { ...editing, value: v } : start(v))}
      onCommit={commit}
      onKey={onKey}
      rowHeight={32}
      groupOf={(r) => r.unit_name ?? ""}
    />
  );
}
