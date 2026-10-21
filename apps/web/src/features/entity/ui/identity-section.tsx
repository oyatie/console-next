import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { BIZ_KIND, label, REPRESENTATION } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { representativeCount } from "../domain/draft";
import { problemText } from "../present";
import type { EntityDraftState } from "./use-entity-draft";
import { BrnConfirm } from "./brn-confirm";
import { brnWarningText } from "../present";

/** Section 1: who the business is (kind, numbers, name, representatives, opening date). */
export function IdentitySection({ s }: { s: EntityDraftState }) {
  const { draft: d, problems: p } = s;
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => s.set("identity", k, v);
  const corp = d.bizKind === "CORPORATION";
  // A further certificate of an existing entity: the entity's kind, number and representatives are not asked again.
  const own = d.scope === "entity";
  const reps = d.representatives;
  const crnWarn = d.crn.length === FORMATS.corpRegNo.max && FORMATS.corpRegNo.warnings(d.crn, { incorporatedOn: d.incorporatedOn || undefined }).length > 0;
  return (
    <>
      {own && <ChoiceField
        label={t("entity.field.bizKind")}
        required
        options={BIZ_KIND.values.map((v) => ({ value: v, label: label(BIZ_KIND, v), description: t(`entity.bizKind.hint.${v}`) }))}
        value={d.bizKind}
        onChange={(v) => set("bizKind", v as typeof d.bizKind)}
        error={problemText(p.bizKind)}
      />}
      <div className="grid-3">
        <MaskedField
          label={t("entity.field.brn")}
          required
          format={FORMATS.bizRegNo}
          value={d.brn}
          onChange={(v) => set("brn", v)}
          example={t("entity.field.brnExample")}
          error={problemText(p.brn)}
          warning={p.brn ? undefined : brnWarningText(d, s.brnClasses)}
        />
        <Field label={t(corp ? "entity.field.corpName" : "entity.field.tradeName")} required error={problemText(p.name)}>
          {(c) => <TextInput {...c} maxLength={200} value={d.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <DateField label={t("entity.field.openedOn")} required value={d.openedOn} onChange={(v) => set("openedOn", v)} today={s.today} max={s.today} error={problemText(p.openedOn)} />
      </div>
      <BrnConfirm brn={d.brn} confirmed={d.brnConfirmed} onConfirm={(v) => set("brnConfirmed", v)} />
      {own && corp && (
        <div className="grid-3">
          <MaskedField
            label={t("entity.field.crn")}
            required
            format={FORMATS.corpRegNo}
            value={d.crn}
            onChange={(v) => set("crn", v)}
            example={t("entity.field.crnExample")}
            error={problemText(p.crn)}
            warning={crnWarn ? t("entity.field.crnChecksum") : undefined}
          />
        </div>
      )}
      {own && <fieldset className="form__group">
        <legend className="field__label">{t("entity.field.representatives")}</legend>
        <div className="grid-3">
          {reps.map((name, i) => (
            <Field key={i} label={t("entity.field.representative", { n: i + 1 })} required={i === 0} error={i === 0 ? problemText(p["representatives.0"]) : undefined}>
              {(c) => (
                <span className="row">
                  <TextInput {...c} className="grow" value={name} onChange={(e) => set("representatives", reps.map((x, j) => (j === i ? e.target.value : x)))} />
                  {i > 0 && (
                    <Button variant="ghost" aria-label={t("entity.action.removeRepresentative", { n: i + 1 })} onClick={() => set("representatives", reps.filter((_, j) => j !== i))}>
                      <X size={16} aria-hidden />
                    </Button>
                  )}
                </span>
              )}
            </Field>
          ))}
        </div>
        <Button onClick={() => set("representatives", [...reps, ""])}>
          <Plus size={16} aria-hidden /> {t("entity.action.addRepresentative")}
        </Button>
        {representativeCount(d) > 1 && (
          <ChoiceField
            label={t("entity.field.representationMode")}
            required
            options={REPRESENTATION.values.filter((v) => v !== "SINGLE").map((v) => ({ value: v, label: label(REPRESENTATION, v), description: t(`entity.representation.hint.${v}`) }))}
            value={d.representationMode}
            onChange={(v) => set("representationMode", v as typeof d.representationMode)}
            error={problemText(p.representationMode)}
          />
        )}
      </fieldset>}
    </>
  );
}
