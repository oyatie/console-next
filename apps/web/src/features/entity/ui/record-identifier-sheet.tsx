import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, FileText, Info } from "lucide-react";
import type { EntityDocument, IdentifierCorrectionReason, LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { FORMATS } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { entitiesRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { CERT_FILES, CERT_MAX_BYTES, correctIdentifier, correctRegistrationNumber, ENTITY_READS, uploadDocument } from "../api";
import { takenBrn } from "../domain/create";
import { entityName } from "../../../reference/entity/domain/names";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

const ARROW = " → ";
const REASONS: IdentifierCorrectionReason[] = ["TYPO_AT_ENTRY", "REGISTRY_DIFFERS", "OTHER_EVIDENCED"];

/**
 * Identifier correction (spec S3-correct-brn, MR-17): an identifier never "changes", so the change verb stays visible
 * but disabled with why; the only verb is a correction, always with its evidence uploaded first (the server's correction
 * route requires it in setup too). In setup it applies at once; after going live the tenant ops account makes it with its
 * passkey (decisions #26 item d, entity api) and anyone else is told to ask ops. What follows the number and what does not (social insurance workplace
 * numbers) is listed before saving.
 */
export function IdentifierSheet({ e: opened, field, registrationId, operating, onClose }: { e: LegalEntity; field: "brn" | "crn"; registrationId?: string; operating: boolean; onClose: () => void }) {
  const [e] = useState(opened);
  const reg = e.registrations.find((r) => r.id === registrationId);
  const holder = e.workplaces.find((w) => w.id === reg?.holder_workplace_id);
  const fmt = field === "brn" ? FORMATS.bizRegNo : FORMATS.corpRegNo;
  const old = field === "brn" ? reg?.brn : e.crn;
  const [value, setValue] = useState(old?.value ?? "");
  const [reason, setReason] = useState<IdentifierCorrectionReason | null>(null);
  const [doc, setDoc] = useState<EntityDocument | null>(null);
  const all = useQuery(entitiesRef).data?.items ?? [];
  const taken = field === "brn" && value !== old?.value ? takenBrn(value, all) : null;
  const complete = value.length === fmt.max && value !== old?.value && !taken;
  const [pendingException, setPendingException] = useState<string | null>(null);
  const ready = complete && reason !== null && doc !== null && pendingException === null;
  const upload = useCommand({ run: (f: File) => uploadDocument(f, field === "brn" ? "BIZ_REG_CERT" : "CORP_REGISTRY_EXTRACT"), onSuccess: setDoc });
  const save = useCommand({
    run: async (_: undefined, key: string) => {
      const body = { value, document_id: doc!.id, reason_code: reason! };
      return field === "brn" ? correctRegistrationNumber(key, reg!.id, body) : correctIdentifier(key, e.id, { field: "crn", ...body });
    },
    invalidates: ENTITY_READS,
    announce: (out) => "status" in out && out.status === "PENDING" ? t("entityRecord.id.pending", { id: out.exception_id }) : t("entityRecord.id.saved", { field: t(`entityRecord.id.field.${field}`) }),
    onSuccess: (out) => {
      if ("status" in out && out.status === "PENDING") setPendingException(out.exception_id);
      else onClose();
    },
  });
  const where = field === "brn" ? `${entityName(e)} › ${holder?.current?.name ?? t("entityRecord.id.certificate")}` : entityName(e);
  return (
    <Sheet
      open
      onClose={onClose}
      pending={save.isPending}
      wide
      title={t("entityRecord.id.title", { field: t(`entityRecord.id.field.${field}`) })}
      subtitle={<><span className={s.kicker}><FileText size={14} aria-hidden /> {where}</span>{t("entityRecord.id.now", { value: old?.display ?? "—" })}</>}
      notice={<>{pendingException && <p role="status">{t("entityRecord.id.pending", { id: pendingException })}</p>}<EntityError error={upload.error ?? save.error} historyHref={`/org/entities/${encodeURIComponent(e.id)}?tab=history#history`} own={(code) => (code === "identifier_correction_needs_exception" ? t("entityRecord.id.needsOps") : undefined)} /></>}
      consequence={
        complete ? (
          <span><span className={s.old}>{old?.display}</span>{ARROW}<b>{fmt.display(value)}</b> {t(operating ? "entityRecord.id.consequenceOperating" : "entityRecord.id.consequenceSetup")}</span>
        ) : (
          <Muted>{t("entityRecord.id.typeFirst")}</Muted>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("entityRecord.cancel")}</Button>
          <Button variant="primary" aria-disabled={!ready || undefined} disabled={save.isPending} onClick={() => ready && save.mutate(undefined)}>{t("entityRecord.id.save")}</Button>
        </>
      }
    >
      <p className="notice"><Info size={14} aria-hidden /> {t(operating ? "entityRecord.id.noticeOperating" : "entityRecord.id.noticeSetup")}</p>
      <MaskedField
        label={t("entityRecord.id.right")}
        required
        format={fmt}
        value={value}
        onChange={setValue}
        hint={t("entityRecord.id.hint", { shape: fmt.display("0".repeat(fmt.max)) })}
        error={taken ? t("entityCreate.problem.brnTaken", { where: taken.holder ? `${taken.entity} › ${taken.holder}` : taken.entity }) : undefined}
        warning={complete && field === "brn" && fmt.warnings(value).length ? t("entityRecord.id.checksum") : undefined}
      />
      {complete && <p className={s.okLine}><Check size={14} aria-hidden /> {t("entityRecord.id.ok")}</p>}
      <div className={s.verbs} role="group" aria-label={t("entityRecord.id.how")}>
        <span className="field__label">{t("entityRecord.id.how")}</span>
        <div className={s.verbGrid}>
          <div className={s.verbOff} aria-disabled="true"><b>{t("entityRecord.id.rev")}</b><span>{t(field === "brn" ? "entityRecord.id.revWhyBrn" : "entityRecord.id.revWhyCrn")}</span></div>
          <div className={s.verbOn}><b>{t("entityRecord.id.cor")}</b><span>{t("entityRecord.id.corWhat")}</span></div>
        </div>
      </div>
      <ChoiceField
        label={t("entityRecord.id.reason")}
        required
        options={REASONS.map((r) => ({ value: r, label: t(`entityRecord.id.reason.${r}`) }))}
        value={reason}
        onChange={(r) => setReason(r as IdentifierCorrectionReason)}
      />
      <FileDrop label={t("entityRecord.id.evidence")} hint={t("entityRecord.id.evidenceHint")} accept={CERT_FILES} maxBytes={CERT_MAX_BYTES} onFiles={([f]) => f && upload.mutate(f)} busy={upload.isPending ? t("entityCreate.original.uploading") : undefined}>
        {doc && <Muted>{t("entityRecord.id.attached", { name: doc.file_name })}</Muted>}
      </FileDrop>
      <section aria-labelledby="uses-title">
        <h3 id="uses-title" className={s.subhead}>{t("entityRecord.id.uses")}</h3>
        <ul className={`${s.periods} ${s.uses}`}>
          <li><span>{t(field === "brn" ? "entityRecord.id.useChart" : "entityRecord.id.useChartCrn", { name: holder?.current?.name ?? entityName(e) })}</span><Muted>{t("entityRecord.id.follows")}</Muted></li>
          <li><span>{t("entityRecord.id.useSearch")}</span><Muted>{t("entityRecord.id.follows")}</Muted></li>
          {field === "brn" && <li><span>{t("entityRecord.id.useInsurance", { count: holder?.insurance.filter((i) => i.mgmt_no).length ?? 0 })}</span><Muted>{t("entityRecord.id.untouched")}</Muted></li>}
        </ul>
        {field === "brn" && <p className="muted">{t("entityRecord.id.insuranceWhy")}</p>}
      </section>
    </Sheet>
  );
}
