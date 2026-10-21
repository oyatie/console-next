import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateChips } from "../../../ui/date/date-chips";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { FORMATS } from "../../../lib/pure/formats";
import { label } from "../../../lib/labels";
import { EMPLOYMENT_TYPES, type Draft, type EmploymentType, type Gap } from "../domain/register";
import s from "./register.module.css";

type Set = <K extends keyof Draft>(k: K, v: Draft[K]) => void;
const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };

/**
 * When and how: start date chips (no default, weekday echo, what the date makes the person), the nine employment type chips (no
 * default), and the fields the server still needs today (phone, title, base pay).
 */
export function RegisterTerms({ d, set, shown, today, tried }: { d: Draft; set: Set; shown: ReadonlySet<Gap>; today: string; tried: boolean }) {
  return (
    <>
      <div className={s.termsRow}>
        <DateChips
          label={t("register.hire")}
          required
          presets={datePresets(today, ["today", "nextMonday"])}
          value={d.hire}
          onChange={(v) => set("hire", v)}
          echo={d.hire ? t(d.hire > today ? "register.hire.future" : "register.hire.past") : undefined}
          error={shown.has("hire") ? t("register.err.hire") : undefined}
          showErrors={tried}
        />
        <ChoiceField
          label={t("register.type")} required={false}
          look="chips"
          options={EMPLOYMENT_TYPES.map((v) => ({ value: v, label: label(TYPE, v) }))}
          value={d.type}
          onChange={(v) => set("type", v as EmploymentType)}
          error={shown.has("type") ? t("register.err.type") : undefined}
        />
      </div>
      {d.type === "CONTRACT" && (
        <DateField label={t("register.contractEnd")} required={false} today={today} min={d.hire || undefined} value={d.contractEnd} onChange={(v) => set("contractEnd", v)} error={shown.has("contractEnd") ? t("register.err.contractEnd") : undefined} />
      )}
      <fieldset className={s.extra}>
        <legend className={s.flabel}>{t("register.extra.title")}</legend>
        <div className={s.extraRow}>
          <MaskedField label={t("register.phone")} required={false} format={FORMATS.phone} value={d.phone} onChange={(v) => set("phone", v)} error={shown.has("phone") ? t("register.err.phone") : undefined} />
          <Field label={t("register.position")} required={false} error={shown.has("position") ? t("register.err.position") : undefined}>
            {(p) => <TextInput {...p} value={d.position} onChange={(e) => set("position", e.target.value)} />}
          </Field>
          <Field label={t("register.pay")} required={false} error={shown.has("pay") ? t("register.err.pay") : undefined}>
            {(p) => <TextInput {...p} className="num" inputMode="numeric" value={d.pay ? fmtNumber(Number(d.pay)) : ""} onChange={(e) => set("pay", e.target.value.replace(/[^\d]/g, ""))} />}
          </Field>
        </div>
      </fieldset>
    </>
  );
}
