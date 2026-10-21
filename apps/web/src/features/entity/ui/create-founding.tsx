import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { AddressField } from "../../../ui/address-field/address-field";
import { Button, Check as Checkbox } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { isFounding } from "../domain/create";
import { DistrictPick } from "./district-pick";
import { useAddressSearch } from "./use-ref";
import type { CreateState } from "./use-create";

/**
 * A corporation recorded while it is being founded (company-08, catalog company-04): no registration number and no
 * certificate yet, so the certificate step is skipped and both are typed when they arrive.
 */
export function FoundingChoice({ c }: { c: CreateState }) {
  if (c.draft.bizKind !== "CORPORATION") return null;
  return (
    <Checkbox checked={c.draft.founding} onChange={(on) => c.put("founding", on)}>
      {t("entityOps.founding.choice")}
    </Checkbox>
  );
}

/** What a founding corporation already knows from its articles: its representatives and its head office. */
export function FoundingFields({ c }: { c: CreateState }) {
  const head = useAddressSearch();
  if (!isFounding(c.draft)) return null;
  const { draft: d, put } = c;
  const reps = d.representatives;
  return (
    <>
      <p className="notice">{t("entityOps.founding.notice")}</p>
      {reps.map((n, i) => (
        <Field key={i} label={t(i === 0 ? "entityCreate.field.representative" : "entityCreate.field.representativeN", { n: i + 1 })} required={i === 0} >
          {(f) => (
            <span className="row">
              <TextInput {...f} className="grow" maxLength={100} value={n} onChange={(e) => put("representatives", reps.map((x, j) => (j === i ? e.target.value : x)))} />
              {i > 0 && <Button variant="ghost" aria-label={t("entityCreate.field.removeRepresentative", { n: i + 1 })} onClick={() => put("representatives", reps.filter((_, j) => j !== i))}><X size={16} aria-hidden /></Button>}
              {i === reps.length - 1 && <Button onClick={() => put("representatives", [...reps, ""])}><Plus size={16} aria-hidden /> {t("entityCreate.field.addRepresentative")}</Button>}
            </span>
          )}
        </Field>
      ))}
      <AddressField
        label={t("entityCreate.field.headOfficeAddress")}
        required
        value={d.headOfficeAddress}
        onChange={(v) => {
          put("headOffice", "OTHER");
          put("headOfficeAddress", v && head.withCodes(v));
        }}
        query={head.query}
        onQueryChange={head.setQuery}
        hits={head.hits}
        loading={head.loading}
        problem={head.problem}
      />
      <DistrictPick a={d.headOfficeAddress} onChange={(a) => put("headOfficeAddress", a)} />
    </>
  );
}
