import type { LegalEntity, LegalEntityInput } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { label, REPRESENTATION } from "../../../lib/labels";
import { FORMATS, phoneE164, toDomestic } from "../../../lib/pure/formats";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { todayKst } from "../../../lib/pure/today";
import type { DirectorDraft } from "../domain/draft";
import { addressLine } from "../domain/view";
import { AddressEdit } from "./record-address-edit";
import { DirectorsEditor } from "./record-directors-editor";
import { RepsEditor } from "./record-reps-editor";
import { repsAfter, repsReady, toAddr, toKr, type Addr, type Reps } from "../domain/record-values";
import { directorsText, repsText } from "../present";
import { latinName, personName } from "../../../reference/entity/domain/names";
import type { FieldSpec } from "./record-revise-sheet";

const dash = (s: string | null | undefined) => s || "—";
const won = (n: number | null | undefined) => (n == null ? "—" : t("entity.won", { amount: fmtNumber(n) }));
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/** The entity-level facts the record page edits (spec S3 registry and entity basics and the certificate's ①②⑥). */
export function entityFields(e: LegalEntity) {
  const c = e.current;
  const registry = t("entityRecord.group.registry");
  const cert = t("entityRecord.group.certificate");
  const reps = c?.representatives ?? [];
  // The server's guards, said before saving: person data in any name, Korean in the English name.
  const problem = (key: "name" | "display_name" | "english_name", v: string) =>
    !v ? undefined : key === "english_name" && !latinName(v) ? t("entity.refusal.english_name_not_latin")
      : personName(v, reps) ? t(key === "name" ? "entity.refusal.legal_name_is_person" : `entity.refusal.${key}_is_person`) : undefined;
  const text = (lbl: string, group: string, key: "name" | "display_name" | "english_name", initial: string, reissue = false): FieldSpec<string> => ({
    label: lbl, group, owner: { kind: "entity" }, current: dash(initial), initial, reissue,
    edit: (v, set) => <Field label={lbl} required={key === "name"} error={problem(key, v.trim())}>{(f) => <TextInput {...f} maxLength={key === "display_name" ? 40 : 200} value={v} onChange={(x) => set(x.target.value)} />}</Field>,
    show: (v) => dash(v.trim()), patch: (v) => ({ [key]: v.trim() || null }) as Partial<LegalEntityInput>,
    ready: (v) => v.trim() !== initial && (key !== "name" || v.trim() !== "") && !problem(key, v.trim()),
  });
  return {
    displayName: text(t("entityCreate.field.displayName"), registry, "display_name", c?.display_name ?? ""),
    englishName: text(t("entity.name.english"), registry, "english_name", c?.english_name ?? ""),
    name: text(t(e.biz_kind === "CORPORATION" ? "entityRecord.field.corpName" : e.biz_kind === "INDIVIDUAL" ? "entityCreate.field.orgName" : "entityRecord.field.tradeName"), e.biz_kind === "INDIVIDUAL" ? t("entityRecord.registry.titleOther") : cert, "name", c?.name ?? "", e.biz_kind !== "INDIVIDUAL"),
    representatives: {
      label: t("entityRecord.field.representatives"), group: registry, owner: { kind: "entity" }, reissue: true,
      current: reps.join(", ") + (reps.length > 1 && c?.representation_mode ? ` (${label(REPRESENTATION, c.representation_mode)})` : ""),
      initial: { names: reps, leaving: reps.map(() => false), added: [], mode: c?.representation_mode === "SINGLE" ? null : (c?.representation_mode ?? null) },
      edit: (v, set) => <RepsEditor v={v} set={set} />,
      show: repsText,
      patch: (v) => { const after = repsAfter(v); return { representatives: after, representation_mode: after.length > 1 ? v.mode! : "SINGLE" }; },
      ready: (v) => repsReady(v, reps, c?.representation_mode),
      dateHint: t("entityRecord.field.repsDateHint"),
    } satisfies FieldSpec<Reps>,
    headOffice: {
      label: t("entityRecord.field.headOffice"), group: cert, owner: { kind: "entity" }, reissue: true,
      current: dash(addressLine(c?.head_office_address)), initial: toAddr(c?.head_office_address),
      edit: (v, set) => <AddressEdit label={t("entityRecord.field.headOffice")} v={v} set={set} />,
      show: (v) => dash(v?.road), patch: (v) => ({ head_office_address: toKr(v, c?.head_office_address) }), ready: (v) => v !== null && v.road !== (c?.head_office_address?.road_addr_part1 ?? "") || (v?.detail ?? "") !== (c?.head_office_address?.detail ?? ""),
    } satisfies FieldSpec<Addr | null>,
    capital: {
      label: t("entityRecord.field.capital"), group: registry, owner: { kind: "entity" }, current: won(c?.capital_won), initial: c?.capital_won != null ? String(c.capital_won) : "",
      edit: (v, set) => <Field label={t("entityRecord.field.capital")} required={false} unit={t("entity.unit.won")}>{(f) => <TextInput {...f} className="num" inputMode="numeric" value={v ? fmtNumber(Number(v)) : ""} onChange={(x) => set(x.target.value.replace(/\D/g, ""))} />}</Field>,
      show: (v) => won(v ? Number(v) : null), patch: (v) => ({ capital_won: v ? Number(v) : null }), ready: (v) => (v ? Number(v) : null) !== (c?.capital_won ?? null),
    } satisfies FieldSpec<string>,
    fiscalMonth: {
      label: t("entityRecord.field.fiscalMonth"), group: registry, owner: { kind: "entity" }, current: c?.fiscal_year_end_month ? t("entity.month", { m: c.fiscal_year_end_month }) : "—", initial: c?.fiscal_year_end_month ? String(c.fiscal_year_end_month) : null,
      edit: (v, set) => <ChoiceField label={t("entityRecord.field.fiscalMonth")} required options={MONTHS.map((m) => ({ value: m, label: t("entity.month", { m: Number(m) }) }))} value={v} onChange={set} />,
      show: (v) => (v ? t("entity.month", { m: Number(v) }) : "—"), patch: (v) => ({ fiscal_year_end_month: v ? Number(v) : null }), ready: (v) => v !== null && Number(v) !== c?.fiscal_year_end_month,
    } satisfies FieldSpec<string | null>,
    mainPhone: {
      label: t("entityRecord.field.mainPhone"), group: registry, owner: { kind: "entity" }, current: dash(c?.main_phone?.display), initial: c?.main_phone ? toDomestic(c.main_phone.value) : "",
      edit: (v, set) => <MaskedField label={t("entityRecord.field.mainPhone")} required={false} format={FORMATS.phone} value={v} onChange={set} />,
      show: (v) => dash(v && FORMATS.phone.display(v)), patch: (v) => ({ main_phone: v ? phoneE164(v) : null }), ready: (v) => (v ? phoneE164(v) : null) !== (c?.main_phone?.value ?? null) && (!v || Boolean(phoneE164(v))),
    } satisfies FieldSpec<string>,
    // company-15/-19: the main industry as its KSIC code, typed as printed (no bundled list; the server marks it unchecked).
    mainKsic: {
      label: t("entityRecord.vat.mainKsic"), group: registry, owner: { kind: "entity" }, current: c?.main_ksic ? `${c.main_ksic.code} · ${c.main_ksic.label}` : "—", initial: c?.main_ksic?.code ?? "",
      edit: (v, set) => <Field label={t("entityRecord.vat.mainKsic")} required={false} hint={t("entityOps.code.typed")}>{(f) => <TextInput {...f} className="code" maxLength={6} value={v} onChange={(x) => set(x.target.value.trim().toUpperCase())} />}</Field>,
      show: (v) => dash(v), patch: (v) => ({ main_ksic: v ? { code: v } : null }), ready: (v) => v !== (c?.main_ksic?.code ?? "") && (v === "" || /^[A-U]?\d{2,5}$/.test(v)),
    } satisfies FieldSpec<string>,
    incorporatedOn: {
      label: t("entityRecord.field.incorporatedOn"), group: registry, owner: { kind: "entity" }, corOnly: true, current: c?.incorporated_on ? fmtDate(c.incorporated_on) : "—", initial: c?.incorporated_on ?? "",
      edit: (v, set) => <DateField label={t("entityRecord.field.incorporatedOn")} required value={v} onChange={set} today={todayKst()} max={todayKst()} />,
      show: (v) => (v ? fmtDate(v) : "—"), patch: (v) => ({ incorporated_on: v || null }), ready: (v) => v !== "" && v !== c?.incorporated_on && v <= todayKst(),
    } satisfies FieldSpec<string>,
    directors: {
      label: t("entityRecord.field.directors"), group: registry, owner: { kind: "entity" }, current: directorsText(c?.directors ?? []),
      // company-31: no officers recorded yet is a first entry, never a change or a correction.
      empty: (c?.directors ?? []).length === 0,
      initial: (c?.directors ?? []).map((d) => ({ role: d.role, name: d.name, appointedOn: d.appointed_on ?? "" })),
      edit: (v, set) => <DirectorsEditor v={v} set={set} />,
      show: (v) => directorsText(v.map((d) => ({ role: d.role!, name: d.name, appointed_on: d.appointedOn || null }))),
      patch: (v) => ({ directors: v.filter((d) => d.role && d.name.trim()).map((d) => ({ role: d.role!, name: d.name.trim(), appointed_on: d.appointedOn || null })) }),
      ready: (v) => v.every((d) => d.role && d.name.trim()) && JSON.stringify(v) !== JSON.stringify((c?.directors ?? []).map((d) => ({ role: d.role, name: d.name, appointedOn: d.appointed_on ?? "" }))),
      dateHint: t("entityRecord.field.repsDateHint"),
    } satisfies FieldSpec<DirectorDraft[]>,
    largeGroup: {
      label: t("entityRecord.field.largeGroup"), group: t("entityRecord.group.vat"), owner: { kind: "entity" }, current: c?.large_group_member == null ? "—" : t(c.large_group_member ? "entityRecord.largeGroup.yes" : "entityRecord.largeGroup.no"),
      initial: c?.large_group_member == null ? null : c.large_group_member ? "Y" : "N",
      edit: (v, set) => <ChoiceField label={t("entityRecord.field.largeGroup")} required options={[{ value: "Y", label: t("entityRecord.largeGroup.yes") }, { value: "N", label: t("entityRecord.largeGroup.no") }]} value={v} onChange={set} />,
      show: (v) => (v ? t(v === "Y" ? "entityRecord.largeGroup.yes" : "entityRecord.largeGroup.no") : "—"), patch: (v) => ({ large_group_member: v === "Y" }), ready: (v) => v !== null && (v === "Y") !== c?.large_group_member,
    } satisfies FieldSpec<string | null>,
  };
}
