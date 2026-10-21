import { t } from "@console/i18n";
import { CORRECTION, ISSUE_REASON, label, TAX_TYPE } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { CodePicker } from "../../../ui/code-picker/code-picker";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { problemText } from "../present";
import { useCodeSearch } from "./use-ref";
import type { EntityDraftState } from "./use-entity-draft";

/** Section 4: what the certificate itself says (tax type, unit taxation, issue reason and date, tax office, extras). */
export function CertificateSection({ s }: { s: EntityDraftState }) {
  const { draft: d, problems: p } = s;
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => s.set("certificate", k, v);
  const offices = useCodeSearch("tax_office");
  return (
    <>
      <div className="grid-3">
        <ChoiceField
          label={t("entity.field.taxType")}
          required
          options={TAX_TYPE.values.map((v) => ({ value: v, label: label(TAX_TYPE, v) }))}
          value={d.taxType}
          onChange={(v) => set("taxType", v as typeof d.taxType)}
          error={problemText(p.taxType)}
        />
        <ChoiceField
          label={t("entity.field.unitTaxation")}
          required
          options={[
            { value: "Y", label: t("entity.unitTaxation.yes") },
            { value: "N", label: t("entity.unitTaxation.no") },
          ]}
          value={d.unitTaxation === null ? null : d.unitTaxation ? "Y" : "N"}
          onChange={(v) => set("unitTaxation", v === "Y")}
          error={problemText(p.unitTaxation)}
        />
        <CodePicker
          label={t("entity.field.taxOffice")}
          required
          list={offices.list}
          query={offices.query}
          onQueryChange={offices.setQuery}
          options={offices.options}
          value={d.taxOfficeCode}
          onChange={(code) => {
            set("taxOfficeCode", code);
            const o = offices.options.find((x) => x.code === code);
            if (o) set("taxOfficePrinted", o.label);
          }}
          loading={offices.loading}
          error={problemText(p.taxOfficePrinted)}
          fallback={
            <Field label={t("entity.field.taxOfficePrinted")} required error={problemText(p.taxOfficePrinted)} example={t("entity.field.taxOfficeExample")}>
              {(c) => <TextInput {...c} value={d.taxOfficePrinted} onChange={(e) => set("taxOfficePrinted", e.target.value)} />}
            </Field>
          }
        />
      </div>
      <div className="grid-3">
        <ChoiceField
          label={t("entity.field.issueReason")}
          required={Boolean(s.doc)}
          options={ISSUE_REASON.values.map((v) => ({ value: v, label: label(ISSUE_REASON, v) }))}
          value={d.issueReason}
          onChange={(v) => set("issueReason", v as typeof d.issueReason)}
          error={problemText(p.issueReason)}
        />
        {d.issueReason === "OTHER_AS_PRINTED" && (
          <Field label={t("entity.field.issueReasonPrinted")} required error={problemText(p.issueReasonPrinted)}>
            {(c) => <TextInput {...c} maxLength={200} value={d.issueReasonPrinted} onChange={(e) => set("issueReasonPrinted", e.target.value)} />}
          </Field>
        )}
        {d.issueReason === "CORRECTION" && (
          <ChoiceField
            label={t("entity.field.correction")}
            required={false}
            options={CORRECTION.values.map((v) => ({ value: v, label: label(CORRECTION, v) }))}
            value={d.correction}
            onChange={(v) => set("correction", v as typeof d.correction)}
          />
        )}
        <DateField label={t("entity.field.certIssuedOn")} required={Boolean(s.doc)} value={d.certIssuedOn} onChange={(v) => set("certIssuedOn", v)} today={s.today} max={s.today} min={d.openedOn || undefined} error={problemText(p.certIssuedOn)} />
      </div>
      <div className="grid-3">
        {d.bizKind === "INDIVIDUAL" && (
          <Field label={t("entity.field.coOwners")} required={false} hint={t("entity.field.coOwnersHint")}>
            {(c) => <TextInput {...c} value={d.coOwners.join(", ")} onChange={(e) => set("coOwners", e.target.value.split(/[,·]/).map((x) => x.trimStart()))} />}
          </Field>
        )}
        <Field label={t("entity.field.eInvoiceEmail")} required={false} error={problemText(p.eInvoiceEmail)}>
          {(c) => <TextInput {...c} type="email" autoComplete="off" value={d.eInvoiceEmail} onChange={(e) => set("eInvoiceEmail", e.target.value)} />}
        </Field>
        <Field label={t("entity.field.liquorLicenseNo")} required={false}>
          {(c) => <TextInput {...c} value={d.liquorLicenseNo} onChange={(e) => set("liquorLicenseNo", e.target.value)} />}
        </Field>
      </div>
    </>
  );
}
