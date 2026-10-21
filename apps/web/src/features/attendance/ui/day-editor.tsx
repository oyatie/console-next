import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import type { DayForm } from "../domain/day-form";
import { parseClock } from "../domain/minutes";
import type { DayKind } from "../domain/pattern";
import s from "./attendance.module.css";

const KINDS: readonly DayKind[] = ["WORK", "REST_DAY", "WEEKLY_HOLIDAY"];

/** A day of a work pattern: work (start, end, break) or day off or weekly rest day. `error` is the rule this day breaks. */
export function DayEditor({ label, value, onChange, error }: { label: string; value: DayForm; onChange: (d: DayForm) => void; error?: string }) {
  const clockField = (k: "start" | "end" | "breakStart" | "breakEnd", required: boolean) => {
    const bad = value[k] !== "" && parseClock(value[k]) === null;
    return (
      <Field key={k} label={t(`attendancePatterns.day.${k}`)} required={required} example={k === "start" ? "09:00" : undefined} error={bad ? t("attendancePatterns.day.badClock") : undefined}>
        {(p) => <TextInput {...p} inputMode="numeric" value={value[k]} maxLength={5} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />}
      </Field>
    );
  };
  return (
    <div className={s.dayRow} role="group" aria-label={label}>
      <strong>{label}</strong>
      <div className="form">
        <ChoiceField label={t("attendancePatterns.day.kind", { day: label })} required value={value.kind} onChange={(k) => onChange({ ...value, kind: k as DayKind })} options={KINDS.map((k) => ({ value: k, label: t(`attendance.dayKind.${k}`) }))} error={error} />
        {value.kind === "WORK" && (
          <div className={s.dayInputs}>
            {clockField("start", true)}
            {clockField("end", true)}
            {clockField("breakStart", false)}
            {clockField("breakEnd", false)}
          </div>
        )}
      </div>
    </div>
  );
}
