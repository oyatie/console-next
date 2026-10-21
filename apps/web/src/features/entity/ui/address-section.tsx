import { t } from "@console/i18n";
import { AddressField, type AddressValue } from "../../../ui/address-field/address-field";
import { ChoiceField } from "../../../ui/choice/choice-field";
import type { AddrDraft } from "../domain/draft";
import { problemText } from "../present";
import { DistrictPick } from "./district-pick";
import { useAddressSearch } from "./use-ref";
import type { EntityDraftState } from "./use-entity-draft";

const toValue = (a: AddrDraft | null): AddressValue | null => a && { ...a };

/**
 * Section 2: where the business is (the certificate's item 5) and, for a corporation, its head office
 * (item 6). When they differ the certificate is a branch's, so the head office is offered as a workplace
 * of its own: withholding tax is filed there (Income Tax Act s7(1)3).
 */
export function AddressSection({ s }: { s: EntityDraftState }) {
  const { draft: d, problems: p } = s;
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => s.set("address", k, v);
  const place = useAddressSearch();
  const head = useAddressSearch();
  return (
    <>
      <AddressField
        label={t("entity.field.businessAddress")}
        required
        value={toValue(d.businessAddress)}
        onChange={(v) => set("businessAddress", v && place.withCodes(v))}
        query={place.query}
        onQueryChange={place.setQuery}
        hits={place.hits}
        loading={place.loading}
        problem={place.problem}
        error={problemText(p.businessAddress)}
      >
        <DistrictPick a={d.businessAddress} onChange={(a) => set("businessAddress", a)} />
      </AddressField>
      {d.scope === "entity" && d.bizKind === "CORPORATION" && (
        <>
          <ChoiceField
            label={t("entity.field.headOffice")}
            required
            options={[
              { value: "SAME", label: t("entity.headOffice.same") },
              { value: "OTHER", label: t("entity.headOffice.other") },
            ]}
            value={d.headOffice}
            onChange={(v) => set("headOffice", v as "SAME" | "OTHER")}
            error={problemText(p.headOffice)}
          />
          {d.headOffice === "OTHER" && (
            <>
              <AddressField
                label={t("entity.field.headOfficeAddress")}
                required
                value={toValue(d.headOfficeAddress)}
                onChange={(v) => set("headOfficeAddress", v && head.withCodes(v))}
                query={head.query}
                onQueryChange={head.setQuery}
                hits={head.hits}
                loading={head.loading}
                problem={head.problem}
                error={problemText(p.headOfficeAddress)}
              >
                <DistrictPick a={d.headOfficeAddress} onChange={(a) => set("headOfficeAddress", a)} />
              </AddressField>
              <ChoiceField
                label={t("entity.field.headOfficeWorkplace")}
                required
                options={[
                  { value: "CREATE_WORKPLACE", label: t("entity.headOfficeWorkplace.create"), description: t("entity.headOfficeWorkplace.createHint") },
                  { value: "OFFICE_ONLY", label: t("entity.headOfficeWorkplace.office"), description: t("entity.headOfficeWorkplace.officeHint") },
                ]}
                value={d.headOfficeWorkplace}
                onChange={(v) => set("headOfficeWorkplace", v as "CREATE_WORKPLACE" | "OFFICE_ONLY")}
                error={problemText(p.headOfficeWorkplace)}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
