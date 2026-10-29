import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Pencil } from "lucide-react";
import { ID_TYPE, label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { FieldMark, FieldRow } from "../../../ui/record/field-row";
import { RecordSection } from "../../../ui/record/record-section";
import { maskedAddress, maskedBirth, maskedEmail, maskedPhone } from "../domain/card";
import { rrnStatusQuery } from "../api/record";
import { InlineField } from "./inline-field";
import { FieldValue } from "./field-value";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import s from "./card.module.css";
import { RrnField } from "./rrn-field";
import { EmergencyContacts } from "./emergency-contacts";
import { PhotoRow } from "./photo-row";
import { Muted } from "../../../ui/muted/muted";

const SEX = { MALE: "empCard.sex.MALE", FEMALE: "empCard.sex.FEMALE" } as const;

/**
 * 1 personal (E2): name, Hanja and English, sex, birth date, resident registration number, address, contacts, nationality, the items never collected, photo.
 * Each field carries its class's mark: edit (change or correction), correction only, correction only, two people, quick edit.
 */
export function SecPersonal({ c, quick, onFix }: { c: Card; quick: Quick; onFix: (field: string) => void }) {
  const rrnRead = useQuery({ ...rrnStatusQuery(c.e.id), enabled: c.readable, retry: false });
  const { e, d } = c;
  const p = c.personal.data;
  const r = c.register.data;
  const f = c.facts.data;
  const who = `${e.name} ${e.employee_number ?? ""}`.trim();
  const sending = (k: string) => (quick.pending?.changes && k in quick.pending.changes ? String(quick.pending.changes[k as keyof typeof quick.pending.changes] ?? "") : undefined);
  const none = <Muted>{t("empCard.none")}</Muted>;
  const nameEn = p?.name_en;
  const phone = (d.employment ?? d.pending_employment)?.phone_e164;
  return (
    <RecordSection
      id="s1"
      no={1}
      title={t("empCard.sec.personal")}
      meta={t("empCard.personal.basis")}
      two
      tools={c.editable && <Button variant="ghost" onClick={() => onFix("multi")}><Pencil size={14} aria-hidden /> {t("empCard.multi")}</Button>}
    >
      <FieldRow id="f-name" no="1" label={t("empCard.f.name")} mark={c.editable && <FieldMark kind="rc" field={t("empCard.f.name")} onPress={() => onFix("name")} />}>{e.name}</FieldRow>
      <InlineField
        manage={c.editable}
        conflict={quick.conflictFor(t("empCard.f.nameEn"))}
        label={t("empCard.f.nameAlt")}
        raw={nameEn ?? ""}
        sending={sending("name_en")}
        placeholder={t("empCard.f.nameEn.hint")}
        onSave={(v) => quick.save(t("empCard.f.nameEn"), { name_en: v || null }, { name_en: nameEn ?? null })}
      >
        {[p?.name_hanja, nameEn].filter(Boolean).join(" · ") || none}
      </InlineField>
      <FieldRow id="f-sex" no="2" label={t("empCard.f.sex")} mark={c.editable && <FieldMark kind="cor" field={t("empCard.f.sex")} onPress={() => onFix("sex")} />}>
        {r?.sex ? t(SEX[r.sex]) : <span className={s.warn}>{t("empCard.missing")}</span>}
      </FieldRow>
      <FieldRow id="f-birth_date" no="3" label={t("empCard.f.birth")}  mark={c.editable && <FieldMark kind="corTwo" field={t("empCard.f.birth")} onPress={() => onFix("birth_date")} />}>
        {f?.birth_date ? <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="BIRTH_DATE" masked={maskedBirth()} field={t("empCard.f.birth")} who={who} /> : <span className={s.warn}>{t("empCard.missing")}</span>}
      </FieldRow>
      <RrnField employeeId={e.id} employeeStatus={e.status} who={who} q={rrnRead} readable={c.readable} editable={c.editable}>
        {c.readable && <Link className={s.link} to="/people/$id/identifiers" params={{ id: e.id }}>{t("empCard.rrn.open")}</Link>}
      </RrnField>
      <FieldRow id="f-address" no="4" label={t("empCard.f.address")} mark={c.editable && <FieldMark kind="rc" field={t("empCard.f.address")} onPress={() => onFix("address")} />}>
        {r?.address ? <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="ADDRESS" masked={maskedAddress(r.address)} field={t("empCard.f.address")} who={who} /> : <span className={s.warn}>{t("empCard.missing")}</span>}
      </FieldRow>
      <InlineField manage={c.editable} conflict={quick.conflictFor(t("empCard.f.phone"))} label={t("empCard.f.phone")} raw={phone ?? ""} sending={sending("phone")} onSave={(v) => quick.save(t("empCard.f.phone"), { phone: v }, { phone: phone ?? "" })}>
        {phone ? <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="PHONE" masked={maskedPhone(phone)} field={t("empCard.f.phone")} who={who} /> : none}
      </InlineField>
      <InlineField manage={c.editable} conflict={quick.conflictFor(t("empCard.f.workEmail"))} label={t("empCard.f.workEmail")} raw={e.work_email ?? ""} sending={sending("work_email")} onSave={(v) => quick.save(t("empCard.f.workEmail"), { work_email: v || null }, { work_email: e.work_email ?? null })}>
        {e.work_email ?? none}
      </InlineField>
      <InlineField manage={c.editable} conflict={quick.conflictFor(t("empCard.f.personalEmail"))} label={t("empCard.f.personalEmail")} raw={p?.personal_email ?? ""} sending={sending("personal_email")} onSave={(v) => quick.save(t("empCard.f.personalEmail"), { personal_email: v || null }, { personal_email: p?.personal_email ?? null })}>
        {p?.personal_email ? <FieldValue employeeId={e.id} allowed={c.readable} fieldCode="PERSONAL_EMAIL" masked={maskedEmail(p.personal_email)} field={t("empCard.f.personalEmail")} who={who} /> : none}
      </InlineField>
      <EmergencyContacts c={c} quick={quick} />
      <InlineField manage={c.editable} conflict={quick.conflictFor(t("empCard.f.registerNote"))} label={t("empCard.f.registerNote")} raw={r?.register_note ?? ""} sending={sending("register_note")} placeholder={t("empCard.f.registerNote.hint")} onSave={(v) => quick.save(t("empCard.f.registerNote"), { register_note: v || null }, { register_note: r?.register_note ?? null })}>
        {r?.register_note ?? none}
      </InlineField>
      <InlineField manage={c.editable} conflict={quick.conflictFor(t("empCard.f.nationality"))} label={t("empCard.f.nationality")} raw={p?.nationality ?? ""} sending={sending("nationality")} placeholder={t("empCard.f.nationality.hint")} onSave={(v) => quick.save(t("empCard.f.nationality"), { nationality: v.toUpperCase() || null }, { nationality: p?.nationality ?? null })}>
        {[p?.nationality && t("empCard.nationality", { code: p.nationality }), f?.id_type && label(ID_TYPE, f.id_type)].filter(Boolean).join(" · ") || none}
      </InlineField>
      <FieldRow label={t("empCard.f.notCollected")} >
        <Muted>{t("empCard.notCollected")}</Muted>
      </FieldRow>
      <PhotoRow c={c} quick={quick} />
    </RecordSection>
  );
}
