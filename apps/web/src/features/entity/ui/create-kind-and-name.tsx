import { latinName, personName } from "../../../reference/entity/domain/names";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { BIZ_KIND, label } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";

/**
 * The two things a entity needs before anything else (spec S4, OM §3.6): which certificate it holds, with nothing
 * preselected, and its name as printed. Shared by the quick sheet and the wizard's first step.
 */
export function KindAndName({ kind, onKind, name, onName, clash, displayName, onDisplayName, englishName, onEnglishName, representatives = [] }: {
  representatives?: string[];
  kind: BizKind | null;
  onKind: (k: BizKind) => void;
  name: string;
  onName: (n: string) => void;
  /** Another open entity of the tenant already has this name (a warning: two may share a name). */
  clash: boolean;
  /** The optional short name (in-house label) and English name, each its own fact. */
  displayName?: string;
  onDisplayName?: (n: string) => void;
  englishName?: string;
  onEnglishName?: (n: string) => void;
}) {
  const typed = name.trim() !== "";
  return (
    <>
      <ChoiceField
        label={t("entityCreate.kind.label")}
        required
        options={BIZ_KIND.values.map((v) => ({ value: v, label: label(BIZ_KIND, v) }))}
        value={kind}
        onChange={(v) => onKind(v as BizKind)}
      />
      <Field
        label={t(kind === "ID_NUMBER_ORG" ? "entityCreate.field.orgName" : kind === "INDIVIDUAL" ? "entityCreate.field.tradeName" : "entityCreate.field.corpName")}
        required
        error={personName(name, representatives) ? t("entity.refusal.legal_name_is_person") : undefined}
        warning={typed && clash ? t("entityCreate.name.clash") : undefined}
      >
        {(c) => <TextInput {...c} maxLength={200} autoComplete="off" value={name} onChange={(e) => onName(e.target.value)} />}
      </Field>
      {onDisplayName && onEnglishName && <OtherNames representatives={representatives} displayName={displayName ?? ""} onDisplayName={onDisplayName} englishName={englishName ?? ""} onEnglishName={onEnglishName} />}
    </>
  );
}

/**
 * The two optional names, each its own fact, right after the legal name and never beside the representative: the
 * short name (in-house label, 40 characters) and the English name (Latin letters only), each with an example in the box.
 */
export function OtherNames({ representatives, displayName, onDisplayName, englishName, onEnglishName }: {
  representatives: string[];
  displayName: string;
  onDisplayName: (n: string) => void;
  englishName: string;
  onEnglishName: (n: string) => void;
}) {
  const alias = displayName.trim();
  const english = englishName.trim();
  return (
    <fieldset className="form__group">
      <legend>{t("entityCreate.otherNames")}</legend>
      <Field label={t("entityCreate.field.displayName")} required={false}
        error={alias && personName(alias, representatives) ? t("entity.refusal.display_name_is_person") : undefined}>
        {(c) => <TextInput {...c} maxLength={40} autoComplete="off" placeholder={t("entityCreate.example.displayName")} value={displayName} onChange={(e) => onDisplayName(e.target.value)} />}
      </Field>
      <Field label={t("entity.name.english")} required={false}
        error={english && !latinName(english) ? t("entity.refusal.english_name_not_latin") : english && personName(english, representatives) ? t("entity.refusal.english_name_is_person") : undefined}>
        {(c) => <TextInput {...c} maxLength={200} autoComplete="off" lang="en" placeholder={t("entityCreate.example.englishName")} value={englishName} onChange={(e) => onEnglishName(e.target.value)} />}
      </Field>
    </fieldset>
  );
}
