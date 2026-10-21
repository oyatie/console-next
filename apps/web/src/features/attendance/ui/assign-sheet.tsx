import { useState } from "react";
import { i18n, t } from "@console/i18n";
import { addDays } from "../../../ui/date/days";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Sheet } from "../../../ui/sheet/sheet";
import { assignSchedule, previewAssign, type AssignInput, type Layer, type Pattern, type ScopeKind } from "../api";
import { clock } from "../domain/minutes";
import { dayText, refusalText } from "../present";
import { AssignPreview } from "./assign-preview";
import { useKeys } from "./use-keys";
import { usePreview } from "./use-preview";

export type AssignTarget = { kind: ScopeKind; id: string; name: string };
type Reason = AssignInput["reason"];
type Form = { pattern: string; from: string; to: string; reason: Reason | null; evidence: string; rotation: Record<string, string>; start: string | null };
const EMPTY: Form = { pattern: "", from: "", to: "", reason: null, evidence: "", rotation: {}, start: null };

/**
 * Assign a work schedule (A2-assign, +preview): a pattern for the chosen scope(s) from a date. Nothing is chosen for the person
 * (G7). The server previews who moves, who keeps a nearer layer, closed months and night work before the primary,
 * which names the count and the date. Until its start date the assignment can be cancelled; after it, a new one replaces it.
 */
function AssignSheetOpen({ targets, patterns, onClose, onAssigned }: { targets: AssignTarget[] | null; patterns: readonly Pattern[]; onClose: () => void; onAssigned: (layers: Layer[], message: string) => void }) {
  const [f, setF] = useState<Form>(EMPTY);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const today = todayKst();
  const pattern = patterns.find((p) => p.id === f.pattern);
  const person = targets?.length === 1 && targets[0]!.kind === "PERSON";
  const rotation = pattern?.kind === "ROTATION";
  const staggered = pattern?.kind === "STAGGERED" && person;
  const to = f.reason === "SUBSTITUTE" && f.from ? addDays(f.from, 1) : f.to;

  const missing = [
    !f.pattern && t("attendanceSchedule.assign.pattern"),
    !f.from && t("attendanceSchedule.assign.from"),
    !f.reason && t("attendanceSchedule.assign.reason"),
    f.reason === "REDUCTION" && !f.evidence.trim() && t("attendanceSchedule.assign.evidence"),
    rotation && targets?.some((x) => !f.rotation[x.id]) && t("attendanceSchedule.assign.rotation"),
    staggered && f.start === null && t("attendanceSchedule.assign.start"),
  ].filter((x): x is string => !!x);
  const input: AssignInput | null =
    targets && !missing.length
      ? {
          targets: targets.map((x) => ({ scope_kind: x.kind, scope_id: x.id, rotation_start: rotation ? f.rotation[x.id] : undefined, start_choice: staggered ? Number(f.start) : undefined })),
          pattern_id: f.pattern,
          effective_from: f.from,
          effective_to: to || undefined,
          reason: f.reason!,
          evidence_ref: f.evidence.trim() || undefined,
        }
      : null;
  const preview = usePreview(input, previewAssign);
  const refused = preview.data?.refusals.length ? preview.data.refusals : null;

  const run = useCommand({
    run: (body: AssignInput, key: string) => assignSchedule(body, key),
    invalidates: ["/api/v1/attendance"],
    onSuccess: (r) => onAssigned(r.layers, t("attendanceSchedule.assign.done", { count: r.people_changed, date: dayText(f.from), pattern: pattern?.name ?? "" })),
  });
  const ready = input && preview.data && !refused && !preview.pending;
  const submit = () => ready && !run.isPending && run.mutate(input);
  const keys = useKeys<HTMLDivElement>((e) => ((e.metaKey || e.ctrlKey) && e.key === "Enter" ? (submit(), true) : false));
  const where = targets?.map((x) => x.name).join(" · ") ?? "";
  const label = preview.data && f.from ? t("attendanceSchedule.assign.commit", { count: preview.data.people_changed, date: dayText(f.from) }) : t("attendanceSchedule.assign.commitPlain");
  const why = missing.length
    ? t("attendanceSchedule.assign.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) })
    : refused
      ? (refusalText(refused[0]!.code) ?? t("attendanceSchedule.assign.refused"))
      : t("attendanceSchedule.assign.previewing");

  return (
    <Sheet
      open={!!targets}
      kicker={t("attendanceSchedule.assign.kicker", { where })}
      title={t("attendanceSchedule.assign.title")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={input ? t("attendanceSchedule.assign.consequence", { where, date: dayText(f.from) }) : t("attendanceSchedule.assign.consequenceEmpty")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {ready ? <Button variant="primary" onClick={submit} disabled={run.isPending}>{label}</Button> : <DisabledReason reason={why} control={(p) => <Button {...p} variant="primary">{label}</Button>} />}
        </>
      }
    >
      <div ref={keys} className="form">
        <Field label={t("attendanceSchedule.assign.pattern")} required>
          {(p) => (
            <SelectInput {...p} value={f.pattern} onChange={(e) => set({ pattern: e.target.value, rotation: {}, start: null })}>
              <option value="">{t("attendanceSchedule.assign.patternPick")}</option>
              {patterns.filter((x) => x.status === "ACTIVE").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </SelectInput>
          )}
        </Field>
        <DateField label={t("attendanceSchedule.assign.from")} required value={f.from} onChange={(from) => set({ from })} today={today}  />
        <ChoiceField
          label={t("attendanceSchedule.assign.reason")}
          required
          value={f.reason}
          onChange={(r) => set({ reason: r as Reason })}
          options={(["STANDARD", "TEMPORARY", "REDUCTION", "SUBSTITUTE"] as const).map((r) => ({
            value: r,
            label: t(`attendance.reason.${r}`),
            description: t(`attendance.reason.${r}.hint`),
            disabled: (r === "REDUCTION" || r === "SUBSTITUTE") && !person ? t("attendance.reason.personOnly") : undefined,
          }))}
        />
        {f.reason === "SUBSTITUTE" ? (
          f.from && <p className="muted">{t("attendanceSchedule.assign.oneDay", { date: dayText(f.from) })}</p>
        ) : (
          <DateField label={t("attendanceSchedule.assign.to")} required={false} value={f.to} onChange={(v) => set({ to: v })} today={today} min={f.from ? addDays(f.from, 1) : undefined} basis={t("attendanceSchedule.assign.toHint")} />
        )}
        {f.reason === "REDUCTION" && (
          <Field label={t("attendanceSchedule.assign.evidence")} required example={t("attendanceSchedule.assign.evidence.example")}>
            {(p) => <TextInput {...p} value={f.evidence} maxLength={200} onChange={(e) => set({ evidence: e.target.value })} />}
          </Field>
        )}
        {rotation && targets?.map((x) => (
          <DateField key={x.id} label={t("attendanceSchedule.assign.rotationFor", { name: x.name })} required value={f.rotation[x.id] ?? ""} onChange={(v) => set({ rotation: { ...f.rotation, [x.id]: v } })} today={today}  />
        ))}
        {staggered && (
          <ChoiceField label={t("attendanceSchedule.assign.start")} required value={f.start} onChange={(v) => set({ start: v })} options={(pattern!.start_choices ?? []).map((c) => ({ value: String(c), label: clock(c) }))} />
        )}
        <AssignPreview preview={preview.data ?? preview.stale} pending={preview.pending} error={preview.error} ready={!!input} pattern={pattern} />
      </div>
    </Sheet>
  );
}

export function AssignSheet(p: { targets: AssignTarget[] | null; patterns: readonly Pattern[]; onClose: () => void; onAssigned: (layers: Layer[], message: string) => void }) {
  return p.targets ? <AssignSheetOpen {...p} /> : null;
}
