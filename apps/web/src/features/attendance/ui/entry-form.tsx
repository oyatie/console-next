import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Checks } from "../../../ui/choice/checks";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { DockSheet } from "../../../ui/dock-sheet/dock-sheet";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { correctEntry, previewEntries, voidEntry, type Entry } from "../api";
import { parseDraft, recordedMinutes } from "../domain/grammar";
import { dateText, entryText, refusalText } from "../present";
import { EMPTY_EVIDENCE, evidenceOf } from "../domain/evidence";
import { usePreview } from "./use-preview";
import { EvidenceField } from "./evidence-field";

/**
 * correction (A3-correct) or void (A3-void) of one saved entry, docked where the day sheet was. reason and evidence start
 * empty; a correction that lowers what was recorded needs its evidence (the server says so too). Both keep the old value in
 * the history; a void is undone by recording the day again (record again).
 */
export function EntryForm({ mode, entry, employeeId, name, date, onClose, onDone }: {
  mode: "correct" | "void";
  entry: Entry;
  employeeId: string;
  name: string;
  date: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState(EMPTY_EVIDENCE);
  const syntax = value.trim() ? parseDraft(value) : null;
  const preview = usePreview(mode === "correct" && syntax?.ok ? [{ employee_id: employeeId, work_date: date, value: value.trim(), base_entry_id: entry.id, long_span_confirmed: confirmed || undefined }] : null, previewEntries);
  const cell = preview.data?.cells[0] ?? preview.stale?.cells[0];
  const parsed = value.trim() ? parseDraft(value, cell?.long_span_minutes, confirmed) : null;
  const unconfirmed = cell?.long_span_minutes === undefined ? null : parseDraft(value, cell.long_span_minutes);
  const needsConfirmation = unconfirmed && !unconfirmed.ok && unconfirmed.code === "span_too_long";
  const before = entryText(entry.kind, entry.segments);
  const ev = evidenceOf(evidence);
  const lowers = parsed?.ok && entry.kind === "TIMES" && recordedMinutes(parsed.entry) < entry.segments.reduce((n, w) => n + w.end - w.start, 0);
  const run = useCommand({
    run: (_: void, key: string) =>
      mode === "correct" ? correctEntry(entry.id, { value: value.trim(), long_span_confirmed: confirmed || undefined, reason: reason.trim(), evidence: ev! }, key) : voidEntry(entry.id, { reason: reason.trim(), evidence: ev! }, key),
    invalidates: ["/api/v1/attendance"],
    settle: true,
    onSuccess: () => onDone(t(mode === "correct" ? "attendanceRecords.correct.done" : "attendanceRecords.void.done", { name, date: dateText(date) })),
  });
  const why =
    mode === "correct" && !parsed ? t("attendanceRecords.correct.needsValue")
    : parsed && !parsed.ok ? (refusalText(parsed.code) ?? t("attendanceRecords.correct.needsValue"))
    : mode === "correct" && preview.error ? t("attendanceRecords.save.previewFailed")
    : mode === "correct" && (preview.pending || !preview.data) ? t("attendanceRecords.save.previewing")
    : mode === "correct" && cell?.status === "REFUSED" ? refusalText(cell.code ?? "")
    : !reason.trim() ? t("attendanceRecords.correct.needsReason")
    : !ev ? t("attendanceRecords.save.needsEvidence")
    : null;
  const label = t(mode === "correct" ? "attendanceRecords.correct.commit" : "attendanceRecords.void.commit");
  return (
    <DockSheet
      open
      kicker={`${name} · ${dateText(date)}`}
      title={t(mode === "correct" ? "attendanceRecords.correct.title" : "attendanceRecords.void.title")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={preview.error ?? run.error} own={refusalText} />}
      consequence={t(mode === "correct" ? "attendanceRecords.correct.consequence" : "attendanceRecords.void.consequence")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendanceRecords.back")}</Button>
          {why ? <DisabledReason reason={why} control={(p) => <Button {...p} variant="primary">{label}</Button>} /> : <Button variant={mode === "void" ? "danger" : "primary"} disabled={run.isPending} onClick={() => run.mutate()}>{label}</Button>}
        </>
      }
    >
      <p>{t("attendanceRecords.correct.before", { value: before })}</p>
      {mode === "correct" && (
        <Field label={t("attendanceRecords.correct.after")} required hint={t("attendanceRecords.grammar.hint")} error={parsed && !parsed.ok ? refusalText(parsed.code) : undefined}>
          {(p) => <TextInput {...p} value={value} maxLength={40} onChange={(e) => { setValue(e.target.value); setConfirmed(false); }} />}
        </Field>
      )}
      {mode === "correct" && needsConfirmation && <Checks label={t("attendanceRecords.longSpan.title")}
        items={[{ id: "value", label: t("attendanceRecords.longSpan.confirm", { cell: `${name} · ${dateText(date)}`, value, minutes: cell!.long_span_minutes! }) }]}
        value={confirmed ? ["value"] : []} onChange={(v) => setConfirmed(v.includes("value"))} isDisabled={run.isPending} />}
      {lowers && <p className="muted">{t("attendanceRecords.correct.lowerNeedsEvidence")}</p>}
      <Field label={t("attendanceRecords.correct.reason")} required>
        {(p) => <TextArea {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <EvidenceField value={evidence} onChange={setEvidence} disabled={run.isPending} />
    </DockSheet>
  );
}
