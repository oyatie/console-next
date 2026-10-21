import { useState } from "react";
import { i18n, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { createPattern, type PatternInput } from "../api";
import { blankDay, blankSlot, toSpec, type DayForm, type SlotForm } from "../domain/day-form";
import { parseClock } from "../domain/minutes";
import { emptyWeek, patternProblems, shiftProblems, type DaySpec, type PatternDraft, type PatternKind } from "../domain/pattern";
import { refusalText } from "../present";
import { DayEditor } from "./day-editor";
import { PatternChecks } from "./pattern-checks";
import { SlotEditor } from "./slot-editor";

type Form = { name: string; kind: PatternKind | null; holidayRule: "OFF" | "WORK" | null; days: DayForm[]; slots: SlotForm[]; starts: string };
const fresh = (): Form => ({ name: "", kind: null, holidayRule: null, days: emptyWeek().map((d) => blankDay(d.kind)), slots: [blankSlot(), blankSlot()], starts: "" });
// flexible · selective · deemed · discretionary are listed, not chosen: each waits for its written agreement on record (after the pilot).
const KINDS = ["WEEKLY", "STAGGERED", "ROTATION", "FLEXIBLE", "SELECTIVE", "DEEMED", "DISCRETIONARY"] as const;
const BUILT = new Set<string>(["WEEKLY", "STAGGERED", "ROTATION"]);

/**
 * Add a work pattern (A2-types): a week (fixed · staggered hours) or a rotation (shift rotation) with break inside each working day. The rules
 * of Labor Standards Act §50 · §54 · §55 are checked as it is typed and again by the server, whose answer wins.
 */
function PatternSheetOpen({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (name: string) => void }) {
  const [f, setF] = useState<Form>(fresh);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const rotation = f.kind === "ROTATION";
  const forms: DayForm[] = rotation ? f.slots : f.days;
  const specs = forms.map(toSpec);
  const starts = f.starts.split(/[,\s]+/).filter(Boolean).map(parseClock);
  const complete = f.kind && specs.every((d): d is DaySpec => d !== null) && (!rotation || f.slots.every((x) => x.code.trim()));
  const draft: PatternDraft | null = complete ? { kind: f.kind!, days: specs as DaySpec[], slots: f.slots.map((x, i) => ({ code: x.code.trim(), day: specs[i]! })), startOptions: starts.filter((n): n is number => n !== null) } : null;
  const problems = draft ? patternProblems(draft) : [];
  const dayError = (i: number) => {
    const d = specs[i];
    const p = d?.kind === "WORK" && d.shift ? shiftProblems(d.shift)[0] : undefined;
    return p && refusalText(p);
  };

  const missing = [
    !f.name.trim() && t("attendancePatterns.pattern.name"),
    !f.kind && t("attendancePatterns.pattern.kind"),
    !f.holidayRule && t("attendancePatterns.pattern.holidayRule"),
    f.kind && !complete && t(rotation ? "attendancePatterns.pattern.slotsIncomplete" : "attendancePatterns.pattern.daysIncomplete"),
    f.kind === "STAGGERED" && (starts.length < 2 || starts.includes(null)) && t("attendancePatterns.pattern.starts"),
  ].filter((x): x is string => !!x);
  const body: PatternInput | null =
    draft && !missing.length && !problems.length
      ? {
          name: f.name.trim(),
          kind: draft.kind,
          holiday_rule: f.holidayRule!,
          ...(rotation ? { slots: draft.slots } : { days: draft.days }),
          ...(draft.kind === "STAGGERED" ? { start_choices: draft.startOptions } : {}),
        }
      : null;
  const run = useCommand({ run: (b: PatternInput, key: string) => createPattern(b, key), invalidates: ["/api/v1/attendance"], onSuccess: (p) => onAdded(p.name) });
  const label = f.name.trim() ? t("attendancePatterns.pattern.commit", { name: f.name.trim() }) : t("attendancePatterns.types.add");
  const why = missing.length
    ? t("attendanceSchedule.assign.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) })
    : refusalText(problems[0]!) ?? "";

  return (
    <Sheet
      open={open}
      title={t("attendancePatterns.types.add")}
      wide
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={t("attendancePatterns.pattern.consequence")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {body ? <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(body)}>{label}</Button> : <DisabledReason reason={why} control={(p) => <Button {...p} variant="primary">{label}</Button>} />}
        </>
      }
    >
      <div className="form">
        <Field label={t("attendancePatterns.pattern.name")} required example={t("attendancePatterns.pattern.name.example")}>
          {(p) => <TextInput {...p} value={f.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <ChoiceField
          label={t("attendancePatterns.pattern.kind")}
          required
          value={f.kind}
          onChange={(k) => set({ kind: k as PatternKind })}
          options={KINDS.map((k) => ({ value: k, label: t(`attendancePatterns.kind.${k}`), description: t(`attendancePatterns.kind.${k}.hint`), disabled: BUILT.has(k) ? undefined : t("attendancePatterns.regime.disabled", { condition: t(`attendancePatterns.regime.${k}`) }) }))}
        />
        <ChoiceField
          label={t("attendancePatterns.pattern.holidayRule")}
          required
          value={f.holidayRule}
          onChange={(v) => set({ holidayRule: v as Form["holidayRule"] })}
          options={(["OFF", "WORK"] as const).map((v) => ({ value: v, label: t(`attendancePatterns.holidayRule.${v}`), description: t(`attendancePatterns.holidayRule.${v}.hint`) }))}
        />
        {f.kind === "STAGGERED" && (
          <Field label={t("attendancePatterns.pattern.starts")} required hint={t("attendancePatterns.pattern.starts.hint")} example="08:00, 09:00, 10:00">
            {(p) => <TextInput {...p} value={f.starts} onChange={(e) => set({ starts: e.target.value })} />}
          </Field>
        )}
        {f.kind && !rotation && f.days.map((d, i) => (
          <DayEditor key={i} label={t(`attendancePatterns.weekday.${i as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)} value={d} onChange={(v) => set({ days: f.days.map((x, j) => (j === i ? v : x)) })} error={dayError(i)} />
        ))}
        {rotation && <SlotEditor slots={f.slots} onChange={(slots) => set({ slots })} errors={dayError} />}
        {draft && <PatternChecks draft={draft} problems={problems} />}
      </div>
    </Sheet>
  );
}

export function PatternSheet(p: { open: boolean; onClose: () => void; onAdded: (name: string) => void }) {
  return p.open ? <PatternSheetOpen {...p} /> : null;
}
