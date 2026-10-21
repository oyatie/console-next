import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Checks } from "../../../ui/choice/checks";
import { Button } from "../../../ui/button/button";
import { ConflictPanel, type ConflictChoice } from "../../../ui/conflict/field-conflict";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { DockSheet } from "../../../ui/dock-sheet/dock-sheet";
import { ItemList } from "../../../ui/item-list/item-list";
import { conflictsOf, previewEntries, refusedOf, saveEntries, type CellInput, type Conflict, type SaveReceipt } from "../api";
import { confirmationKey } from "../domain/confirmation";
import { parseEntry } from "../domain/grammar";
import { draftState, splitKey, type Drafts } from "../domain/grid";
import { dateText, entryText, monthText, refusalText } from "../present";
import { EMPTY_EVIDENCE, evidenceOf } from "../domain/evidence";
import { EvidenceField } from "./evidence-field";
import { useOnline } from "./use-online";
import { usePreview } from "./use-preview";

/**
 * The save sheet (A3-save), docked beside the grid. evidence starts empty (G7). The server previews every cell: what it
 * saves, what it leaves as a draft and why, and which marks it opens or clears; the groups add up to the toolbar's
 * count. One transaction: if one cell is refused or was changed by someone else meanwhile, nothing is saved, and a
 * 409 shows each conflicting cell with its three values and no choice made (A12-conflict).
 */
export function SaveDock({ drafts, rows, month, onClose, onSaved, onFocusCell }: {
  drafts: Drafts;
  /** Who each cell belongs to (names for the lines). */
  rows: readonly { employee_id: string; name: string }[];
  month: string;
  onClose: () => void;
  onSaved: (receipt: SaveReceipt, keys: string[]) => void;
  onFocusCell: (key: string) => void;
}) {
  const online = useOnline();
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [evidence, setEvidence] = useState(EMPTY_EVIDENCE);
  const [choices, setChoices] = useState<Record<string, ConflictChoice | undefined>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const names = useMemo(() => new Map(rows.map((r) => [r.employee_id, r.name])), [rows]);
  const entries = Object.entries(drafts);
  const local = entries.filter(([, d]) => !draftState(d).ok);
  const sendable = entries.filter(([, d]) => draftState(d).ok);
  const cells: CellInput[] = sendable.map(([k, d]) => {
    const c = conflicts.find((x) => `${x.employee_id}|${x.work_date}` === k);
    const base = c && choices[k] === "mine" ? (c.current?.id ?? null) : d.base;
    const cell = { ...splitKey(k), value: d.value, base_entry_id: base ?? undefined };
    return { ...cell, long_span_confirmed: confirmed.includes(confirmationKey(cell)) || undefined };
  }).filter((c) => choices[`${c.employee_id}|${c.work_date}`] !== "theirs");
  const preview = usePreview(cells.length ? cells : null, previewEntries);
  const p = preview.data ?? preview.stale;
  const byKey = new Map(cells.map((cell) => [`${cell.employee_id}|${cell.work_date}`, cell]));
  const longSpans = (p?.cells ?? []).flatMap((c) => {
    const cell = byKey.get(`${c.employee_id}|${c.work_date}`);
    if (!cell || c.long_span_minutes === undefined) return [];
    const parsed = parseEntry(cell.value, c.long_span_minutes);
    return !parsed.ok && parsed.code === "span_too_long" ? [{ cell, threshold: c.long_span_minutes }] : [];
  });
  const refused = (p?.cells ?? []).filter((c) => c.status === "REFUSED");
  const ev = evidenceOf(evidence);
  const run = useCommand({
    run: (_: void, key: string) => saveEntries({ cells, source: cells.length > 1 ? "BULK" : "MANUAL", evidence: ev! }, key),
    invalidates: ["/api/v1/attendance"],
    onSuccess: (r) => onSaved(r, cells.map((c) => `${c.employee_id}|${c.work_date}`).concat(entries.filter(([k]) => choices[k] === "theirs").map(([k]) => k))),
  });
  // A 409 replaces the conflicts shown; they stay while the person chooses and saves again.
  const [seen, setSeen] = useState<unknown>(null);
  if (run.error !== seen) {
    setSeen(run.error);
    const c = conflictsOf(run.error);
    if (c.length) setConflicts(c);
  }
  const serverRefused = refusedOf(run.error);
  const saving = cells.length - refused.length;
  const left = local.length + refused.length;
  const unresolved = conflicts.some((c) => !choices[`${c.employee_id}|${c.work_date}`]);
  const why = !online ? t("attendanceRecords.save.offline")
    : !saving ? t("attendanceRecords.save.nothing")
    : unresolved ? t("attendanceRecords.save.chooseConflict")
    : !ev ? t("attendanceRecords.save.needsEvidence")
    : preview.error ? t("attendanceRecords.save.previewFailed")
    : preview.pending || !preview.data ? t("attendanceRecords.save.previewing")
    : refused.length ? t("attendanceRecords.save.refusedFirst", { count: refused.length })
    : null;
  const label = left ? t("attendanceRecords.save.commitSome", { left, count: saving }) : t("attendanceRecords.save.commit", { count: saving });
  const who = (k: string) => {
    const { employee_id, work_date } = splitKey(k);
    return t("attendanceRecords.save.cellOf", { name: names.get(employee_id) ?? "", date: dateText(work_date) });
  };

  return (
    <DockSheet
      open
      kicker={monthText(month)}
      title={t("attendanceRecords.save.title", { count: entries.length })}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={preview.error ?? (conflictsOf(run.error).length ? null : run.error)} own={refusalText} />}
      consequence={t("attendanceRecords.save.consequence", { month: monthText(month) })}
      actions={
        <>
          <Button onClick={onClose} disabled={run.isPending}>{t("attendance.close")}</Button>
          {why ? (
            <DisabledReason reason={why} control={(dp) => <Button {...dp} variant="primary">{run.isPending ? t("attendanceRecords.save.saving") : label}</Button>} />
          ) : (
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? t("attendanceRecords.save.saving") : label}</Button>
          )}
        </>
      }
    >
      {conflicts.length > 0 && (
        <ConflictPanel
          kind="field_conflict"
          conflicts={conflicts.map((c) => {
            const k = `${c.employee_id}|${c.work_date}`;
            return {
              field: k,
              label: who(k),
              base: c.base_entry_id ? t("attendanceRecords.conflict.baseSaved") : t("attendanceRecords.conflict.baseEmpty"),
              current: c.current ? t("attendanceRecords.conflict.current", { value: entryText(c.current.kind, c.current.segments), evidence: t(`attendanceRecords.evidence.${c.current.evidence_kind}`) }) : t("attendanceRecords.conflict.baseEmpty"),
              mine: c.mine,
              actor: c.current?.created_by_name,
              at: c.current ? fmtDateTime(c.current.created_at) : "",
            };
          })}
          choices={choices}
          onChoose={(field, choice) => setChoices({ ...choices, [field]: choice })}
        />
      )}
      {longSpans.length > 0 && <Checks label={t("attendanceRecords.longSpan.title")}
        items={longSpans.map(({ cell, threshold }) => ({ id: confirmationKey(cell), label: t("attendanceRecords.longSpan.confirm", { cell: who(`${cell.employee_id}|${cell.work_date}`), value: cell.value, minutes: threshold }) }))}
        value={confirmed} onChange={setConfirmed} isDisabled={run.isPending} />}
      <EvidenceField value={evidence} onChange={setEvidence} disabled={run.isPending} />
      {p && (
        <ItemList
          label={t("attendanceRecords.save.groups", { total: cells.length })}
          items={[
            { key: "ok", text: t("attendanceRecords.save.groupOk", { count: p.ok }) },
            { key: "unchanged", text: t("attendanceRecords.save.groupUnchanged", { count: p.unchanged }) },
            { key: "opens", text: t("attendanceRecords.save.opens", { blocking: p.opens.blocking, decision: p.opens.decision }) },
            { key: "closes", text: t("attendanceRecords.save.closes", { blocking: p.closes.blocking, decision: p.closes.decision }) },
          ]}
        />
      )}
      {preview.pending && !p && <p className="muted" role="status">{t("attendanceRecords.save.previewing")}</p>}
      {(left > 0 || serverRefused.length > 0) && (
        <ItemList
          label={t("attendanceRecords.save.left", { count: left + serverRefused.length })}
          items={[
            ...local.map(([k, d]) => {
              const s = draftState(d);
              return { key: k, text: <>{who(k)} · {d.value} · {!s.ok && refusalText(s.code)}</>, end: <Button size="sm" onClick={() => onFocusCell(k)}>{t("attendanceRecords.save.goTo")}</Button> };
            }),
            ...refused.concat(serverRefused).map((c) => {
              const k = `${c.employee_id}|${c.work_date}`;
              return { key: k, text: <>{who(k)} · {drafts[k]?.value} · {c.code && refusalText(c.code)}</>, end: <Button size="sm" onClick={() => onFocusCell(k)}>{t("attendanceRecords.save.goTo")}</Button> };
            }),
          ]}
        />
      )}
    </DockSheet>
  );
}
