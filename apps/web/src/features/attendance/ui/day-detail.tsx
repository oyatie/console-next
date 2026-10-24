import { useState } from "react";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import { previewEntries, type BoardRow, type DayBoard } from "../api";
import { baseOf, cellKey, draftState, readPaste, splitKey } from "../domain/grid";
import { duration } from "../domain/minutes";
import { entryText, refusalText, shiftText } from "../present";
import { MarkChip } from "./mark-chip";
import type { useDrafts } from "./use-drafts";
import { usePreview } from "./use-preview";

/**
 * Day · detailed (A3-entry): one row per person with the input in place. A paste of several rows matches them by
 * employee number (never by name) and says how many matched. The recognition column is the server's preview of the
 * drafts, "computing recognition" while it is on its way, never a guessed number.
 */
export function DayDetail({ board, store, onAssign }: { board: DayBoard; store: ReturnType<typeof useDrafts>; onAssign: (row: BoardRow) => void }) {
  const rows = board.groups.flatMap((g) => g.rows);
  const date = board.date;
  const [pasted, setPasted] = useState<string | null>(null);
  const kindOf = (key: string) => {
    const { employee_id, work_date } = splitKey(key);
    return work_date === date ? rows.find((r) => r.employee_id === employee_id)?.day.plan.kind : undefined;
  };
  const cells = Object.entries(store.drafts).filter(([k, d]) => draftState(d, kindOf(k)).ok).map(([k, d]) => ({ ...splitKey(k), value: d.value, base_entry_id: d.base ?? undefined }));
  const preview = usePreview(cells.length ? cells : null, previewEntries);
  const after = (r: BoardRow) => preview.data?.cells.find((c) => c.employee_id === r.employee_id);
  const recognised = (r: BoardRow) => {
    if (!store.drafts[cellKey(r.employee_id, date)]) return duration(r.day.recognition.recognised);
    if (preview.pending) return t("attendanceRecords.detail.computing");
    const a = after(r);
    return a?.after ? t("attendanceRecords.detail.provisional", { value: duration(a.after.recognition.recognised) }) : a?.code ? refusalText(a.code) : "";
  };
  return (
    <div
      onPaste={(e) => {
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
        setPasted(t("attendanceRecords.paste.matched", { rows: p.matched + p.missing.length, matched: p.matched, missing: p.missing.length, locked }));
      }}
    >
      {pasted && <Banner tone="ok">{pasted}</Banner>}
      <Table<BoardRow>
        label={t("attendanceRecords.detail.label")}
        rows={rows}
        rowId={(r) => r.employee_id}
        columns={[
          { header: t("attendanceRecords.grid.number"), cell: (r) => r.employee_number ?? "", fit: true },
          { header: t("attendanceRecords.grid.name"), cell: (r) => r.name },
          { header: t("attendanceRecords.day.plan"), cell: (r) => <>{r.day.plan.shift ? shiftText(r.day.plan.shift) : t(`attendance.dayKind.${r.day.plan.kind}`)}{r.day.plan.kind === "NO_SCHEDULE" && <> <Button size="sm" onClick={() => onAssign(r)}>{t("attendanceRecords.unscheduled.assign")}</Button></>}</> },
          {
            header: t("attendanceRecords.detail.input"),
            cell: (r) => {
              const k = cellKey(r.employee_id, date);
              const d = store.drafts[k];
              const s = d ? draftState(d, r.day.plan.kind) : null;
              if (r.own) return <span className="muted">{t("attendanceRecords.grid.ownRow")}</span>;
              return (
                <Field label={t("attendanceRecords.detail.inputFor", { name: r.name })} required={false} error={s && !s.ok ? refusalText(s.code) : undefined}>
                  {(p) => <TextInput {...p} value={d?.value ?? ""} placeholder={undefined} maxLength={40} onChange={(e) => store.put(k, e.target.value.trim() ? { value: e.target.value, base: baseOf(store.drafts, k, r.day.entry?.id ?? null) } : null)} />}
                </Field>
              );
            },
          },
          { header: t("attendanceRecords.detail.recorded"), cell: (r) => (r.day.entry ? entryText(r.day.entry.kind, r.day.entry.segments) : "–") },
          { header: t("attendanceRecords.detail.recognised"), cell: recognised },
          { header: t("attendanceRecords.detail.result"), cell: (r) => r.day.marks.map((m) => <MarkChip key={m} mark={m} />) },
          { header: t("attendanceRecords.detail.source"), cell: (r) => (r.day.entry ? t(`attendanceRecords.source.${r.day.entry.source}`) : "–") },
        ]}
      />
    </div>
  );
}
