import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { CodePicker } from "../../../ui/code-picker/code-picker";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { FORMATS } from "../../../lib/pure/formats";
import type { BusinessTypeDraft } from "../domain/draft";
import { problemText } from "../present";
import { useCodeSearch } from "./use-ref";
import type { EntityDraftState } from "./use-entity-draft";

/**
 * Section 3: the kinds of business (sector and item) as printed, one row each, the first being the main one. The NTS
 * industry code is picked from the official list, never typed, unless the list is not loaded yet: then a
 * six-digit code may be typed with its format checked, and it is marked as not checked against the list.
 */
export function BusinessSection({ s }: { s: EntityDraftState }) {
  const { draft: d, problems: p } = s;
  const rows = d.businessTypes;
  const setRows = (next: BusinessTypeDraft[]) => s.set("business", "businessTypes", next);
  const setRow = (i: number, patch: Partial<BusinessTypeDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {rows.map((r, i) => (
        <fieldset key={i} className="form__group">
          <legend className="field__label">{i === 0 ? t("entity.business.main") : t("entity.business.row", { n: i + 1 })}</legend>
          <div className="grid-3">
            <Field label={t("entity.field.sector")} required error={i === 0 ? problemText(p.businessTypes) : undefined}>
              {(c) => <TextInput {...c} value={r.sector} onChange={(e) => setRow(i, { sector: e.target.value })} />}
            </Field>
            <Field label={t("entity.field.item")} required>
              {(c) => <TextInput {...c} value={r.item} onChange={(e) => setRow(i, { item: e.target.value })} />}
            </Field>
            <IndustryCode value={r.ntsCode} onChange={(code) => setRow(i, { ntsCode: code })} />
          </div>
          {i > 0 && (
            <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <X size={16} aria-hidden /> {t("entity.action.removeBusinessRow", { n: i + 1 })}
            </Button>
          )}
        </fieldset>
      ))}
      <Button onClick={() => setRows([...rows, { sector: "", item: "", ntsCode: null, ksic: null }])}>
        <Plus size={16} aria-hidden /> {t("entity.action.addBusinessRow")}
      </Button>
      <Field label={t("entity.field.productionFactor")} required={false}>
        {(c) => <TextInput {...c} value={d.productionFactor} onChange={(e) => s.set("business", "productionFactor", e.target.value)} />}
      </Field>
    </>
  );
}

function IndustryCode({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
  const codes = useCodeSearch("nts_industry_code");
  return (
    <CodePicker
      label={t("entity.field.ntsCode")}
      required={false}
      list={codes.list}
      query={codes.query}
      onQueryChange={codes.setQuery}
      options={codes.options}
      value={value}
      onChange={onChange}
      loading={codes.loading}
      fallback={
        <MaskedField
          label={t("entity.field.ntsCodeTyped")}
          required={false}
          format={FORMATS.ntsIndustry}
          value={value ?? ""}
          onChange={(v) => onChange(v || null)}
          hint={t("entity.field.ntsCodeUnchecked")}
        />
      }
    />
  );
}
