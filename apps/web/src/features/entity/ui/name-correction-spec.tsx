import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { type FieldSpec } from "./record-revise-sheet";

type Correction = { name: string; keep: "display_name" | "english_name" | null };
/**
 * A legal-name correction to `name` (a review's certificate trade name): the old name is never lost, the person picks
 * whether it becomes the short name or the English name (Latin letters only; an over-long short name does not fit).
 */
export function nameCorrection(e: LegalEntity, name: string): FieldSpec<Correction> {
  const old = e.current!.name;
  const latin = /^[A-Za-z0-9 &.,'()-]+$/.test(old);
  return {
    label: t(e.biz_kind === "CORPORATION" ? "entityRecord.field.corpName" : "entityRecord.field.tradeName"), group: t("entityRecord.group.certificate"), owner: { kind: "entity" }, corOnly: true,
    current: old, initial: { name, keep: null },
    edit: (v, set) => <>
      <Field label={t(e.biz_kind === "CORPORATION" ? "entityRecord.field.corpName" : "entityRecord.field.tradeName")} required>{(f) => <TextInput {...f} maxLength={200} value={v.name} readOnly />}</Field>
      <ChoiceField label={t("entity.name.keepOld", { name: old })} required options={[
        { value: "display_name", label: t("entityCreate.field.displayName"), disabled: old.length > 40 ? t("entity.name.aliasTooLong") : undefined },
        { value: "english_name", label: t("entity.name.english"), disabled: latin ? undefined : t("entity.name.notLatin") },
      ]} value={v.keep} onChange={(keep) => set({ ...v, keep: keep as Correction["keep"] })} />
    </>,
    show: (v) => v.name,
    patch: (v) => ({ name: v.name.trim(), [v.keep!]: old }),
    ready: (v) => Boolean(v.name.trim() && v.name.trim() !== old && v.keep && (v.keep !== "display_name" || old.length <= 40) && (v.keep !== "english_name" || latin)),
  };
}
