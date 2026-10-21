import { useState } from "react";
import { Landmark } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { FORMATS } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { ENTITY_READS, readVersion, reviseEntity } from "../api";
import { entityInput } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { EntityError } from "./entity-error";
import { useRecordLock } from "./use-record-lock";
import s from "./record.module.css";

/** A entity being founded (company-08): what it still waits for, and the one entry that ends the founding. */
export function FoundingCard({ e }: { e: LegalEntity }) {
  const [open, setOpen] = useState(false);
  const locked = useRecordLock() !== null;
  return (
    <section className="card" aria-labelledby="founding-title">
      <div className={s.cardHead}><Landmark size={16} aria-hidden /><h2 id="founding-title" className={s.cardTitle}>{t("entityOps.founding.chip")}</h2></div>
      <div className={s.cardBody}>
        <p>{t("entityOps.founding.waiting")}</p>
        {!locked && <Button variant="primary" onClick={() => setOpen(true)}>{t("entityOps.founding.enter")}</Button>}
      </div>
      {open && <FoundedSheet e={e} onClose={() => setOpen(false)} />}
    </section>
  );
}

const FOOT = "founded-reason";

/** Enter the incorporation: the corporate registration number and incorporation date the registry assigned. The record's founding ends with it. */
function FoundedSheet({ e, onClose }: { e: LegalEntity; onClose: () => void }) {
  const today = todayKst();
  const [crn, setCrn] = useState("");
  const [on, setOn] = useState("");
  const base = entityInput(e);
  const since = e.current?.effective_from;
  const ready = crn.length === FORMATS.corpRegNo.max && on !== "" && on <= today && base !== null;
  const save = useCommand({
    // company-05: dated no earlier than the revision in force, or the record (read as of today) keeps showing the one before it.
    run: (_: undefined, key: string) => reviseEntity(key, e.id, { ...base!, crn, incorporated_on: on, effective_from: since && since > on ? since : on, reason_code: "INCORPORATION_REGISTERED", expected_version: readVersion(e) }),
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t("entityOps.founding.done", { name: entityName(e) }),
    onSuccess: onClose,
  });
  return (
    <Sheet
      open
      title={t("entityOps.founding.enter")}
      subtitle={t("entityOps.founding.enterWhy", { name: entityName(e) })}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={ready ? <span>{t("entityOps.founding.consequence", { name: entityName(e), date: fmtDate(on) })}</span> : <span id={FOOT}>{t("entityOps.founding.hold")}</span>}
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? <Button variant="primary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{t("entityOps.founding.save")}</Button> : <Button variant="primary" aria-disabled aria-describedby={FOOT} onClick={() => undefined}>{t("entityOps.founding.save")}</Button>}
        </>
      }
    >
      <MaskedField label={t("entityCreate.field.crn")} required format={FORMATS.corpRegNo} value={crn} onChange={setCrn} />
      <DateField label={t("entityOps.founding.on")} required value={on} onChange={setOn} today={today} max={today} />
    </Sheet>
  );
}
