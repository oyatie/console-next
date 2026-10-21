import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { DateField, type DatePreset } from "../../../ui/date/date-field";
import { nextWeekday } from "../../../ui/date/days";
import { firstOfNextMonth, NAME_MAX, nextMonday, type IntentKind } from "../domain/proposal";
import s from "./propose.module.css";

/** A unit name: required, at most 120 characters, the count shown as you type. */
export function NameField({ label, value, onChange, error, hint, example, caution }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: ReactNode;
  hint?: ReactNode;
  example?: string;
  /** A fact worth a second look (a namesake), under the field; it never blocks. */
  caution?: ReactNode;
}) {
  const counter = t("orgPropose.field.name.counter", { n: value.trim().length });
  return (
    <>
      <Field label={label} required error={error} example={example} hint={hint == null ? counter : <>{hint} · {counter}</>}>
        {(p) => <TextInput {...p} maxLength={NAME_MAX} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />}
      </Field>
      {caution != null && <p className={s.caution}>{caution}</p>}
    </>
  );
}

/** Presets, the immediate value last: next month's first working day, next Monday, then today. */
function datePresets(today: string): DatePreset[] {
  const first = firstOfNextMonth(today);
  return [
    { label: t("orgPropose.preset.nextMonth"), date: nextWeekday(first) ?? first },
    { label: t("orgPropose.preset.nextMonday"), date: nextMonday(today) },
    { label: t("orgPropose.preset.today"), date: today },
  ];
}

/**
 * The effective date: empty until picked (it changes the outcome), never before today (the server refuses
 * a past date). No upper bound: the server sets none.
 */
export function EffectiveDate({ value, onChange, today, error }: { value: string; onChange: (v: string) => void; today: string; error?: ReactNode }) {
  return (
    <DateField
      label={t("orgPropose.field.date")}
      required
      value={value}
      onChange={onChange}
      today={today}
      min={today}

      presets={datePresets(today)}
      suggestWeekday
      error={error}
    />
  );
}

/** Why: free text for now. ReasonField slot (reason codes + memo) once BW-07 publishes codes. */
export function ReasonText({ intent, value, onChange, error }: { intent: IntentKind; value: string; onChange: (v: string) => void; error?: ReactNode }) {
  return (
    <Field label={t("orgPropose.field.reason")} required error={error} example={t(`orgPropose.field.reason.example.${intent}`)}>
      {(p) => <TextArea {...p} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}
