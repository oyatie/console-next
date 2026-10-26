import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { DateInput } from "../../../ui/date/date-input";
import { fmtLongDay, typedProblem } from "../../../ui/date/date-text";
import { parseTyped } from "../../../ui/date/days";
import type { Draft, Gap } from "../domain/register";
import s from "./register.module.css";

type Set = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

/**
 * Who: name, birth date and employee number. RRN is recorded separately on the personnel card.
 * Errors show only after a commit attempt (`shown`).
 */
export function RegisterPerson({ d, set, shown }: { d: Draft; set: Set; shown: ReadonlySet<Gap> }) {
  const birth = parseTyped(d.birth);
  return (
    <div className={s.personRow}>
      <Field label={t("register.name")} required error={shown.has("name") ? t("register.err.name") : undefined}>
        {(p) => <TextInput {...p} name="name" placeholder={t("register.name.placeholder")} value={d.name} onChange={(e) => set("name", e.target.value)} />}
      </Field>
      <Field
        label={t("register.birth")}
        required={null}
        tag={<span className={s.tag}>{t("register.birth.tag")}</span>}
        hint={"date" in birth ? <span className={s.ok}>{fmtLongDay(birth.date, false)}</span> : shown.has("birth") ? undefined : t("register.birth.hint")}
        error={shown.has("birth") ? (typedProblem(birth) ?? undefined) : undefined}
      >
        {(p) => <DateInput {...p} className="num" value={d.birth} onDraftChange={(v) => set("birth", v)} onChange={(v) => set("birth", v)} />}
      </Field>
      <div className={s.numberCol}>
        <ChoiceField
          label={t("register.number")}
          required={false}
          look="chips"
          options={[{ value: "auto", label: t("register.number.auto") }, { value: "manual", label: t("register.number.manual") }]}
          value={d.numberMode}
          onChange={(v) => set("numberMode", v as Draft["numberMode"])}
          error={shown.has("number") ? t("register.err.number") : undefined}
        />
        {d.numberMode === "manual" && (
          <TextInput className="num" aria-label={t("register.number.manualLabel")} aria-invalid={shown.has("number") || undefined} value={d.number} onChange={(e) => set("number", e.target.value)} />
        )}
      </div>
    </div>
  );
}
