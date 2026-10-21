import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { DIRECTOR_ROLE, label, REPRESENTATION } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import type { DirectorDraft } from "../domain/draft";
import { problem } from "../present";
import { RefPick } from "./ref-pick";
import { useCodeListsKnown } from "./use-ref";
import type { CreateState } from "./use-create";
import { FoundingFields } from "./create-founding";
import s from "./entity-create.module.css";

const REGISTRY_LISTS = ["ksic"] as const;
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/**
 * registry and representatives (corporations only): what the corporate registry extract says. Every item may stay empty; the dates are the
 * ones printed (appointment date, incorporation date), not the dates they were registered. Resident registration numbers and addresses are never asked.
 */
export function RegistryForm({ c }: { c: CreateState }) {
  const { draft: d, put, problems: p } = c;
  const named = d.representatives.filter((n) => n.trim()).length;
  const dirs = d.directors;
  const setDir = (i: number, patch: Partial<DirectorDraft>) => put("directors", dirs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // The main industry code: its shape waits for the list's answer.
  const listsKnown = useCodeListsKnown(REGISTRY_LISTS);
  if (!listsKnown) return <Skeleton bones={["row", "row", "row"]} label={t("common.loading")} />;
  return (
    <div className={s.grid}>
      <div className={s.span}><FoundingFields c={c} /></div>
      <Field label={t("entity.name.english")} required={false}>{(f) => <TextInput {...f} maxLength={200} value={d.englishName} onChange={(e) => put("englishName", e.target.value)} />}</Field>
      {named > 1 && (
        <div className={s.span}>
          <ChoiceField
            label={t("entityCreate.field.representationMode")}
            required
            options={REPRESENTATION.values.filter((v) => v !== "SINGLE").map((v) => ({ value: v, label: label(REPRESENTATION, v) }))}
            value={d.representationMode}
            onChange={(v) => put("representationMode", v as typeof d.representationMode)}
          />
        </div>
      )}
      <DateField label={t("entityCreate.field.incorporatedOn")} required={false} value={d.incorporatedOn} onChange={(v) => put("incorporatedOn", v)} today={c.today}  error={problem(p.incorporatedOn)} />
      <Field label={t("entityCreate.field.capital")} required={false} unit={t("entity.unit.won")}>
        {(f) => <TextInput {...f} className="num" inputMode="numeric" value={d.capitalWon ? fmtNumber(Number(d.capitalWon)) : ""} onChange={(e) => put("capitalWon", e.target.value.replace(/\D/g, ""))} />}
      </Field>
      <ChoiceField
        label={t("entityCreate.field.fiscalYearEnd")}
        required={false}
        options={MONTHS.map((m) => ({ value: m, label: t("entity.month", { m: Number(m) }) }))}
        value={d.fiscalYearEndMonth === null ? null : String(d.fiscalYearEndMonth)}
        onChange={(v) => put("fiscalYearEndMonth", Number(v))}
      />
      <RefPick listKey="ksic" label={t("entityCreate.field.mainKsic")} required={false} value={d.mainKsic} onChange={(v) => put("mainKsic", v)} />
      <MaskedField label={t("entityCreate.field.mainPhone")} required={false} format={FORMATS.phone} value={d.mainPhone} onChange={(v) => put("mainPhone", v)} error={problem(p.mainPhone)} />
      <fieldset className={`${s.span} ${s.directors}`}>
        <legend className="field__label">{t("entityCreate.field.directors")}</legend>
        {dirs.map((x, i) => (
          <div key={i} className={s.director}>
            <ChoiceField
              label={t("entityCreate.director.role", { n: i + 1 })}
              required={false}
              options={DIRECTOR_ROLE.values.map((v) => ({ value: v, label: label(DIRECTOR_ROLE, v) }))}
              value={x.role}
              onChange={(v) => setDir(i, { role: v as DirectorDraft["role"] })}
            />
            <Field label={t("entityCreate.director.name", { n: i + 1 })} required={false}>
              {(f) => <TextInput {...f} maxLength={100} value={x.name} onChange={(e) => setDir(i, { name: e.target.value })} />}
            </Field>
            <DateField label={t("entityCreate.director.appointedOn", { n: i + 1 })} required={false} value={x.appointedOn} onChange={(v) => setDir(i, { appointedOn: v })} today={c.today} />
            <Button variant="ghost" aria-label={t("entityCreate.director.remove", { n: i + 1 })} onClick={() => put("directors", dirs.filter((_, j) => j !== i))}><X size={16} aria-hidden /></Button>
          </div>
        ))}
        <Button onClick={() => put("directors", [...dirs, { role: null, name: "", appointedOn: "" }])}><Plus size={16} aria-hidden /> {t("entityCreate.director.add")}</Button>
      </fieldset>
    </div>
  );
}
