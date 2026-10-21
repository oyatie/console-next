import { t } from "@console/i18n";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import { AddressField } from "../../../ui/address-field/address-field";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { DateInput } from "../../../ui/date/date-input";
import { TextInput } from "../../../ui/field/field";
import { useAddressSearch } from "../../../reference/entity/ui/use-address-search";
import { maskedAddress } from "../domain/card";
import { CATALOG_FIELD, CATALOG_KIND, type FixField } from "../domain/fix";
import type { Draft } from "./use-fix-draft";
import { focusOnce } from "../../../lib/react/focus-once";
import type { Card } from "./use-card";
import { CatalogPicker } from "./catalog-picker";

const TYPES = ["REGULAR", "CONTRACT", "PART_TIME", "INTERN"] as const;

/** The editor of one field's new value: text, a date, a pick (sex, employment type) or the address search. */
export function FixValue({ c, field, value, onChange, focus }: { c: Card; field: FixField; value: Draft; onChange: (v: Draft) => void; focus?: boolean }) {
  const search = useAddressSearch();
  const name = t(`empFix.field.${field}`);
  if (field in CATALOG_FIELD) {
    const catalogField = field as keyof typeof CATALOG_FIELD;
    return <CatalogPicker kind={CATALOG_KIND[catalogField]} label={name} currentId={c.d.classification[CATALOG_FIELD[catalogField]]} value={typeof value === "string" ? value : null} onChange={onChange} />;
  }
  if (field === "sex")
    return <ChipChoice label={name} options={[{ value: "MALE", label: t("empCard.sex.MALE") }, { value: "FEMALE", label: t("empCard.sex.FEMALE") }].filter((o) => o.value !== c.register.data?.sex)} value={typeof value === "string" ? value : null} onChange={onChange} />;
  if (field === "employment_type")
    return <ChipChoice label={name} options={TYPES.filter((x) => x !== c.d.employment?.employment_type).map((x) => ({ value: x, label: label(EMPLOYMENT_TYPE, x) }))} value={typeof value === "string" ? value : null} onChange={onChange} />;
  if (field === "address")
    return (
      <AddressField
        label={name}
        required
        value={value && typeof value !== "string" ? value : null}
        onChange={(x) => onChange(x)}
        query={search.query}
        onQueryChange={search.setQuery}
        hits={search.hits}
        loading={search.loading}
        problem={search.problem}
        printed={c.register.data?.address ? maskedAddress(c.register.data.address) : undefined}
      />
    );
  if (field.endsWith("date")) return <DateInput label={name} required value={typeof value === "string" ? value : ""} onDraftChange={onChange} onChange={onChange} inputRef={focus ? focusOnce : undefined} />;
  return <TextInput aria-label={name} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} ref={focus ? focusOnce : undefined} />;
}
