import { Info } from "lucide-react";
import { t } from "@console/i18n";
import { FORMATS } from "../../../lib/pure/formats";
import { AddressField } from "../../../ui/address-field/address-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { DistrictPick } from "./district-pick";
import { useAddressSearch } from "./use-ref";
import type { CreateState } from "./use-create";
import s from "./entity-create.module.css";

/**
 * unique number certificate: only the five items every certificate shares, because no verified source lists the unique number certificate's own
 * boxes (spec S4); the original is kept as the record. the server records a certificate only with sector and item,
 * taxpayer type and tax office, which a unique number certificate does not print, so its number, date and place are typed here but not sent
 * yet; the entity saves with its name and representative (CS-BE: a registration shape for unique number certificate).
 */
export function IdOrgForm({ c }: { c: CreateState }) {
  const { draft: d, put } = c;
  const place = useAddressSearch();
  return (
    <div className={s.grid}>
      <p className={`notice ${s.span}`}><Info size={14} aria-hidden /> {t("entityCreate.idorg.notice")}</p>
      <MaskedField label={t("entityCreate.field.idNumber")} required={false} format={FORMATS.bizRegNo} value={d.brn} onChange={(v) => put("brn", v)} hint={t("entityCreate.idorg.numberHint")} />
      <Field label={t("entityCreate.field.orgName")} required={false}>
        {(f) => <TextInput {...f} maxLength={200} value={d.name} onChange={(e) => put("name", e.target.value)} />}
      </Field>
      <Field label={t("entityCreate.field.representative")} required={false}>
        {(f) => <TextInput {...f} maxLength={100} value={d.representatives[0] ?? ""} onChange={(e) => put("representatives", [e.target.value])} />}
      </Field>
      <DateField label={t("entityCreate.field.idOpenedOn")} required={false} value={d.openedOn} onChange={(v) => put("openedOn", v)} today={c.today} />
      <div className={s.span}>
        <AddressField label={t("entityCreate.field.idAddress")} required={false} value={d.businessAddress} onChange={(v) => put("businessAddress", v && place.withCodes(v))} query={place.query} onQueryChange={place.setQuery} hits={place.hits} loading={place.loading} problem={place.problem} />
        <DistrictPick a={d.businessAddress} onChange={(a) => put("businessAddress", a)} />
      </div>
      <p className={`muted ${s.span}`}>{t("entityCreate.idorg.notSent")}</p>
    </div>
  );
}
