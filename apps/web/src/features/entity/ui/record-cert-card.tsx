import { useState } from "react";
import { Eye, FilePlus2, FileText, MoreHorizontal } from "lucide-react";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { BIZ_KIND, ISSUE_REASON, label, labeled, RECORD_STATUS, TAX_TYPE } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { MenuButton } from "../../../ui/menu/menu-button";
import { addressLine, samePlace } from "../domain/view";
import { FactRow } from "./record-fact-row";
import { entityFields } from "./record-entity-fields";
import { registrationFields } from "./record-registration-fields";
import type { Act } from "./record-revise-sheet";
import type { FieldSpec } from "./record-revise-sheet";
import { useRecordLock } from "./use-record-lock";
import { VoidRegistration } from "./void-registration";
import { RegistrationStatusSheet } from "./workplace-status";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * A business registration certificate as printed (form 7 (2)): items 1-11 in their numbers, each with its verb. The numbers
 * that identify (the registration number, item 4 the CRN) are set directly in setup and only corrected, with evidence,
 * after going live.
 */
export function CertCard({ e, r, act, operating, onOriginal }: { e: LegalEntity; r: BusinessRegistration; act: Act; operating: boolean; onOriginal?: () => void }) {
  const c = r.current;
  const f = registrationFields(r);
  const ef = entityFields(e);
  const corp = e.biz_kind === "CORPORATION";
  const name = e.biz_kind === "INDIVIDUAL" ? f.tradeName : ef.name;
  const holder = e.workplaces.find((w) => w.id === r.holder_workplace_id);
  const title = t(holder?.is_head_office ? "entityRecord.cert.titleHead" : "entityRecord.cert.title");
  const status = c ? labeled(RECORD_STATUS, c.status) : null;
  const reps = e.current?.representatives;
  // company-06: suspension / resumption of this certificate, offered on an open record only.
  const [statusing, setStatusing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const locked = useRecordLock() !== null;
  const suspended = c?.status === "SUSPENDED";
  const fix = <V,>(spec: FieldSpec<V>) => ({ kind: "fix" as const, onPress: () => act.field(spec) });
  const idAction = (field: "brn" | "crn") => ({ kind: operating ? ("lock" as const) : ("fix" as const), onPress: () => act.identifier(field, r.id) });
  return (
    <section className="card" aria-labelledby={`cert-${r.id}`}>
      <div className={s.cardHead}>
        <FileText size={16} aria-hidden />
        <h2 id={`cert-${r.id}`} className={s.cardTitle}>{title}</h2>
        <span className="code">{r.brn?.display ?? t("entityRecord.cert.noBrn")}</span>
        {holder && <Chip tone="neutral">{holder.current?.name}</Chip>}
        {status && <Chip tone={status.tone}>{status.label}</Chip>}
        {suspended && c?.status_since && <span className="muted num">{c.status_until ? t("entityOps.status.window", { since: fmtDate(c.status_since), until: fmtDate(c.status_until) }) : t("entityOps.status.since", { since: fmtDate(c.status_since) })}</span>}
        <span className="grow" />
        {!locked && c && c.status !== "CLOSED" && (
          <Button variant="ghost" onClick={() => setStatusing(true)} aria-label={t(suspended ? "entityOps.resume.of" : "entityOps.suspend.of", { name: r.brn?.display ?? "" })}>
            {t(suspended ? "entityOps.resume.action" : "entityOps.suspend.action")}
          </Button>
        )}
        {onOriginal && <Button variant="ghost" onClick={onOriginal}><Eye size={16} aria-hidden /> {t("entityRecord.cert.original")}</Button>}
        {/* certificate reissue: where the certificate is shown, the way to record its newer issue (owner 2026-10-14). */}
        {!locked && c && c.status !== "CLOSED" && (
          <Button variant="ghost" onClick={() => act.reissue(r.id)} aria-label={t("entityReissue.actionOf", { brn: r.brn?.display ?? "" })}><FilePlus2 size={16} aria-hidden /> {t("entityReissue.action")}</Button>
        )}
        {!locked && c && c.status !== "CLOSED" && (
          <MenuButton
            label={t("uiRecordActions.more", { field: title })}
            icon={<MoreHorizontal size={16} aria-hidden />}
            caret={false}
            items={[{
              id: "void",
              text: t("uiRecordActions.end.delete"),
              label: t("uiRecordActions.end.delete"),
              why: operating ? t("entity.regVoid.operatingWhy") : undefined,
            }]}
            onAction={(k) => { if (k === "void") setVoiding(true); }}
          />
        )}
      </div>
      <div className={s.facts}>
        <FactRow label={t("entityRecord.field.taxType")} action={fix(f.taxType)}>{[e.biz_kind && label(BIZ_KIND, e.biz_kind), c?.tax_type && label(TAX_TYPE, c.tax_type)].filter(Boolean).join(" · ") || "—"}</FactRow>
        <FactRow label={t("entity.name.classificationReason")} action={fix(f.classificationReason)}>{c?.classification_reason || "—"}</FactRow>
        <FactRow label={t("entityRecord.field.brn")} action={idAction("brn")}>
          <span className={s.line}><span className="code">{r.brn?.display ?? "—"}</span></span>
          <span className={`${s.line} ${s.sub}`}>{t(operating ? "entityRecord.cert.brnLocked" : "entityRecord.cert.brnSetup")}</span>
        </FactRow>
        <FactRow no={1} label={name.label} wide action={fix(name)}>{name.current}</FactRow>
        <FactRow no={2} label={t(corp ? "entityRecord.field.representatives" : "entityRecord.field.owner")} action={fix(ef.representatives)}>{reps ? reps.join(", ") || "—" : t("entity.field.restricted")}</FactRow>
        <FactRow no={3} label={t("entityRecord.field.openedOn")} action={{ kind: "cor", onPress: () => act.field(f.openedOn) }}><span className="num">{c?.opened_on ? fmtDate(c.opened_on) : "—"}</span></FactRow>
        {corp ? (
          <FactRow no={4} label={t("entityRecord.field.crn")} action={idAction("crn")}><span className="code">{e.crn?.display ?? "—"}</span></FactRow>
        ) : (
          <FactRow no={4} label={t("entityRecord.field.birthDate")}><Muted>{t("entityRecord.field.notCollected")}</Muted></FactRow>
        )}
        <FactRow no={5} label={t("entityRecord.field.businessAddress")} action={fix(f.businessAddress)}>{addressLine(c?.business_address) || "—"}</FactRow>
        {corp && (
          <FactRow no={6} label={t("entityRecord.field.headOffice")} action={fix(ef.headOffice)}>
            {addressLine(e.current?.head_office_address) || "—"}
            {samePlace(e.current?.head_office_address, c?.business_address) && <span className={s.sub}> {t("entityRecord.cert.same5")}</span>}
          </FactRow>
        )}
        <FactRow no={corp ? 7 : 6} label={t("entityRecord.field.businessTypes")} wide action={fix(f.businessTypes)}>
          {(c?.business_types ?? []).map((b, i) => (
            <span key={i} className={s.typeLine}>
              <Chip tone="neutral">{t(b.is_main ? "entityCreate.business.main" : "entityCreate.business.sub")}</Chip>
              {t("entityRecord.cert.typeLine", { sector: b.sector_as_printed, item: b.item_as_printed })}
              {b.ksic && <span className={s.sub}>{t("entityRecord.cert.ksic", { code: b.ksic.code, label: b.ksic.label })}</span>}
            </span>
          ))}
          {(c?.business_types ?? []).length === 0 && "—"}
        </FactRow>
        <FactRow no={corp ? 8 : 7} label={t("entityRecord.field.issueReason")}>{c?.issue_reason_kind ? label(ISSUE_REASON, c.issue_reason_kind as never) : "—"}</FactRow>
        <FactRow no={9} label={t("entityRecord.field.liquor")} action={fix(f.liquor)}>{c?.liquor_license_no || <Muted>{t("entityRecord.cert.none")}</Muted>}</FactRow>
        <FactRow no={10} label={t("entityRecord.field.unitTaxation")} action={fix(f.unitTaxation)}>{c?.unit_taxation == null ? "—" : t(c.unit_taxation ? "entityRecord.cert.unitYes" : "entityRecord.cert.unitNo")}</FactRow>
        <FactRow no={11} label={t("entityRecord.field.email")} action={fix(f.email)}>{c?.e_invoice_email || "—"}</FactRow>
        <FactRow label={t("entityRecord.field.issued")} action={fix(f.issued)}><span className="num">{c?.cert_issued_on ? fmtDate(c.cert_issued_on) : "—"}</span> · {c?.tax_office_label || "—"}</FactRow>
      </div>
      {statusing && <RegistrationStatusSheet e={e} r={r} onClose={() => setStatusing(false)} />}
      {voiding && <VoidRegistration r={r} onClose={() => setVoiding(false)} />}
    </section>
  );
}
