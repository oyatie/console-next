import type { BusinessRegistration, NtsTaxType } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { label, TAX_TYPE } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { validEmail } from "../domain/draft";
import type { BusinessTypeDraft } from "../domain/draft";
import { addressLine } from "../domain/view";
import { BusinessRows } from "./create-business-rows";
import { AddressEdit } from "./record-address-edit";
import type { FieldSpec } from "./record-revise-sheet";
import { toAddr, toKr, type Addr } from "../domain/record-values";


const dash = (s: string | null | undefined) => s || "—";
const TAXES: NtsTaxType[] = ["01", "02", "07", "04", "05", "06"];
const yn = (b: boolean | null | undefined) => (b == null ? "—" : t(b ? "entityRecord.unitTaxation.yes" : "entityRecord.unitTaxation.no"));
/** An issue date before the opening date (the server refuses it: issued_before_opened). */
const issuedBefore = (v: { opened: string; issued: string }) => Boolean(v.issued && v.opened && v.issued < v.opened);
const names = (v: string) => v.split(/[,·]/).map((n) => n.trim()).filter(Boolean);
export const typesText = (rows: readonly { sector: string; item: string }[]) => rows.map((b) => `${b.sector} · ${b.item}`).join(", ") || "—";

/** One certificate's own facts the record page edits (spec S3 items 3, 5, 7, 9, 10, 11, taxpayer type, issue date and tax office). */
export function registrationFields(r: BusinessRegistration) {
  const c = r.current;
  const group = t("entityRecord.group.certificate");
  const owner = { kind: "registration" as const, id: r.id };
  const types: BusinessTypeDraft[] = (c?.business_types ?? []).map((b) => ({ sector: b.sector_as_printed, item: b.item_as_printed, ntsCode: b.nts_code ?? null, ksic: b.ksic ?? null }));
  const text = (lbl: string, key: "liquor_license_no" | "e_invoice_email" | "classification_reason", initial: string, ok: (v: string) => boolean = () => true): FieldSpec<string> => ({
    label: lbl, group, owner, current: dash(initial), initial,
    edit: (v, set) => <Field label={lbl} required={false}>{(f) => <TextInput {...f} value={v} onChange={(x) => set(x.target.value)} />}</Field>,
    show: (v) => dash(v.trim()), patch: (v) => ({ [key]: v.trim() || null }), ready: (v) => v.trim() !== initial && (!v.trim() || ok(v.trim())),
  });
  return {
    tradeName: {
      label: t("entityRecord.field.tradeName"), group, owner, current: dash(c?.trade_name), initial: c?.trade_name ?? "",
      edit: (v, set) => <Field label={t("entityRecord.field.tradeName")} required>{(f) => <TextInput {...f} maxLength={200} value={v} onChange={(x) => set(x.target.value)} />}</Field>,
      show: (v) => dash(v.trim()), patch: (v) => ({ trade_name: v.trim() }),
      ready: (v) => v.trim() !== "" && [...v.trim()].length <= 200 && v.trim() !== c?.trade_name,
    } satisfies FieldSpec<string>,
    classificationReason: text(t("entity.name.classificationReason"), "classification_reason", c?.classification_reason ?? ""),
    taxType: {
      label: t("entityRecord.field.taxType"), group, owner, current: c?.tax_type ? label(TAX_TYPE, c.tax_type) : "—", initial: c?.tax_type ?? null,
      edit: (v, set) => <ChoiceField label={t("entityRecord.field.taxType")} required options={TAXES.map((x) => ({ value: x, label: label(TAX_TYPE, x) }))} value={v} onChange={(x) => set(x as NtsTaxType)} />,
      show: (v) => (v ? label(TAX_TYPE, v) : "—"), patch: (v) => ({ tax_type: v! }), ready: (v) => v !== null && v !== c?.tax_type,
    } satisfies FieldSpec<NtsTaxType | null>,
    // Correct-only. The certificate's issue date rides along: one before the new opening date is refused (issued_before_opened), so
    // the sheet says so before saving and lets both be corrected together instead of dead-ending on the refusal.
    openedOn: {
      label: t("entityRecord.field.openedOn"), group, owner, corOnly: true, current: c?.opened_on ? fmtDate(c.opened_on) : "—", initial: { opened: c?.opened_on ?? "", issued: c?.cert_issued_on ?? "" },
      edit: (v, set) => (
        <>
          <DateField label={t("entityRecord.field.openedOn")} required value={v.opened} onChange={(opened) => set({ ...v, opened })} today={todayKst()} max={todayKst()} />
          {c?.cert_issued_on && (
            <DateField label={t("entityRecord.field.issuedOn")} required={false} value={v.issued} onChange={(issued) => set({ ...v, issued })} today={todayKst()} max={todayKst()} basis={t("entityRecord.revise.issuedHint")}
              error={issuedBefore(v) ? t("entity.problem.issuedBeforeOpened") : undefined} />
          )}
        </>
      ),
      show: (v) => (v.opened ? fmtDate(v.opened) : "—") + (v.issued !== (c?.cert_issued_on ?? "") ? ` · ${t("entityRecord.field.issuedOn")} ${v.issued ? fmtDate(v.issued) : "—"}` : ""),
      patch: (v) => ({ opened_on: v.opened, cert_issued_on: v.issued || null }),
      ready: (v) => v.opened !== "" && v.opened <= todayKst() && (v.opened !== c?.opened_on || v.issued !== (c?.cert_issued_on ?? "")) && !issuedBefore(v),
    } satisfies FieldSpec<{ opened: string; issued: string }>,
    businessAddress: {
      label: t("entityRecord.field.businessAddress"), group, owner, current: dash(addressLine(c?.business_address)), initial: toAddr(c?.business_address),
      edit: (v, set) => <AddressEdit label={t("entityRecord.field.businessAddress")} v={v} set={set} />,
      show: (v) => dash(v?.road), patch: (v) => ({ business_address: toKr(v, c?.business_address)! }),
      ready: (v) => v !== null && (v.road !== (c?.business_address?.road_addr_part1 ?? "") || v.detail !== (c?.business_address?.detail ?? "")),
    } satisfies FieldSpec<Addr | null>,
    businessTypes: {
      label: t("entityRecord.field.businessTypes"), group, owner, current: typesText(types), initial: types,
      edit: (v, set) => <BusinessRows rows={v} onChange={set} />,
      show: typesText,
      patch: (v) => ({ business_types: v.map((b, i) => ({ is_main: i === 0, sector: b.sector.trim(), item: b.item.trim(), nts_code: b.ntsCode, ksic: b.ksic })) }),
      ready: (v) => v.length > 0 && v.every((b) => b.sector.trim() && b.item.trim()) && typesText(v) !== typesText(types),
    } satisfies FieldSpec<BusinessTypeDraft[]>,
    // co-owners of an individual's certificate (restricted personal data: null when the reader may not see it).
    coOwners: {
      label: t("entity.field.coOwners"), group, owner, current: dash(c?.co_owners?.join(", ")), initial: (c?.co_owners ?? []).join(", "),
      edit: (v, set) => <Field label={t("entity.field.coOwners")} required={false}>{(f) => <TextInput {...f} value={v} onChange={(x) => set(x.target.value)} />}</Field>,
      show: (v) => dash(names(v).join(", ")), patch: (v) => ({ co_owners: names(v) }), ready: (v) => names(v).join(",") !== (c?.co_owners ?? []).join(","),
    } satisfies FieldSpec<string>,
    liquor: text(t("entityRecord.field.liquor"), "liquor_license_no", c?.liquor_license_no ?? ""),
    unitTaxation: {
      label: t("entityRecord.field.unitTaxation"), group, owner, current: yn(c?.unit_taxation), initial: c?.unit_taxation == null ? null : c.unit_taxation ? "Y" : "N",
      edit: (v, set) => <ChoiceField label={t("entityRecord.field.unitTaxation")} required options={[{ value: "Y", label: t("entityRecord.unitTaxation.yes") }, { value: "N", label: t("entityRecord.unitTaxation.no") }]} value={v} onChange={set} />,
      show: (v) => yn(v === null ? null : v === "Y"), patch: (v) => ({ unit_taxation: v === "Y" }), ready: (v) => v !== null && (v === "Y") !== c?.unit_taxation,
    } satisfies FieldSpec<string | null>,
    email: text(t("entityRecord.field.email"), "e_invoice_email", c?.e_invoice_email ?? "", validEmail),
    issued: {
      label: t("entityRecord.field.issued"), group, owner, current: `${c?.cert_issued_on ? fmtDate(c.cert_issued_on) : "—"} · ${dash(c?.tax_office_label)}`,
      initial: { on: c?.cert_issued_on ?? "", office: c?.tax_office_label ?? "" },
      edit: (v, set) => (
        <>
          <DateField label={t("entityRecord.field.issuedOn")} required={false} value={v.on} onChange={(on) => set({ ...v, on })} today={todayKst()} max={todayKst()} />
          <Field label={t("entityRecord.field.taxOffice")} required>{(f) => <TextInput {...f} value={v.office} onChange={(x) => set({ ...v, office: x.target.value })} />}</Field>
        </>
      ),
      show: (v) => `${v.on ? fmtDate(v.on) : "—"} · ${dash(v.office.trim())}`,
      patch: (v) => ({ cert_issued_on: v.on || null, tax_office_label: v.office.trim() }),
      ready: (v) => v.office.trim() !== "" && (v.on !== (c?.cert_issued_on ?? "") || v.office.trim() !== (c?.tax_office_label ?? "")),
    } satisfies FieldSpec<{ on: string; office: string }>,
  };
}
