import { t } from "@console/i18n";
import { CodePicker } from "../../../ui/code-picker/code-picker";
import { Field, TextInput } from "../../../ui/field/field";
import { useCodeSearch } from "./use-ref";
import type { CreateState } from "./use-create";

/** tax office: picked from the official list once it is loaded; until then taken as printed, its code a to-do. */
export function TaxOffice({ c }: { c: CreateState }) {
  const { draft: d, put } = c;
  const offices = useCodeSearch("tax_office");
  const typed = (
    <Field label={t("entityCreate.field.taxOffice")} required={false}>
      {(f) => <TextInput {...f} value={d.taxOfficePrinted} onChange={(e) => put("taxOfficePrinted", e.target.value)} />}
    </Field>
  );
  if (!offices.list.loaded) return typed;
  return (
    <CodePicker
      label={t("entityCreate.field.taxOffice")}
      required={false}
      list={offices.list}
      query={offices.query}
      onQueryChange={offices.setQuery}
      options={offices.options}
      value={d.taxOfficeCode}
      onChange={(code) => {
        put("taxOfficeCode", code);
        const o = offices.options.find((x) => x.code === code);
        if (o) put("taxOfficePrinted", o.label);
      }}
      loading={offices.loading}
      fallback={typed}
    />
  );
}
