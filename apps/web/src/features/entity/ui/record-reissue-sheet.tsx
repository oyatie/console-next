import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import type { BusinessRegistration, EntityDocument, LegalEntity, ReissueReason } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import { Button, ToggleButton } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Muted } from "../../../ui/muted/muted";
import { Sheet } from "../../../ui/sheet/sheet";
import { entityName } from "../../../reference/entity/domain/names";
import { ENTITY_READS, entityDocumentsQuery, reissueRegistration } from "../api";
import { entityPartFrom, fromProblem, isNewCertificate, REISSUE_REASONS, reissueBody, reissueFrom, type ItemKey } from "../domain/reissue";
import { CertEvidence } from "./cert-evidence";
import { EntityError } from "./entity-error";
import { entityFields } from "./record-entity-fields";
import { registrationFields } from "./record-registration-fields";
import type { FieldSpec } from "./record-revise-sheet";
import s from "./record.module.css";

// The specs are heterogeneous (each its own value type); the sheet only hands each its own value back.
type AnySpec = FieldSpec<unknown>;
const ARROW = " → ";

/** The facts a new certificate can change, each edited by the record page's own spec (one editor per fact). */
function items(e: LegalEntity, r: BusinessRegistration): { key: ItemKey; spec: AnySpec }[] {
  const ef = entityFields(e);
  const f = registrationFields(r);
  // The entity's part needs its whole state: a reader who may not see representative changes only the certificate's own facts.
  const entity = e.current?.representatives != null;
  const list: [ItemKey, unknown, boolean][] = [
    ["name", e.biz_kind === "INDIVIDUAL" ? f.tradeName : ef.name, e.biz_kind === "INDIVIDUAL" || entity],
    ["representatives", ef.representatives, entity],
    ["businessAddress", f.businessAddress, true],
    ["headOffice", ef.headOffice, entity && e.biz_kind === "CORPORATION"],
    ["businessTypes", f.businessTypes, true],
    ["coOwners", f.coOwners, e.biz_kind === "INDIVIDUAL" && r.current?.co_owners != null],
  ];
  return list.filter(([, , on]) => on).map(([key, spec]) => ({ key, spec: spec as AnySpec }));
}

/**
 * certificate reissue (owner 2026-10-14): a newly issued certificate is attached, why it was issued is chosen, and the facts it
 * changed are edited as one dated change; before saving, every change shows old → new. The earlier certificate stays as
 * superseded evidence. After go-live the change is governed and audited (the foot says which).
 */
export function ReissueSheet({ e: opened, r: openedReg, phase, onClose }: { e: LegalEntity; r: BusinessRegistration; phase?: string; onClose: () => void }) {
  // The record as the sheet opened on it: a refetch while it is open never moves the change onto a newer version unseen
  // (a save against a stale one is refused and says so).
  const [e] = useState(opened);
  const [r] = useState(openedReg);
  const today = todayKst();
  const inForce = r.current?.effective_from ?? today;
  const [doc, setDoc] = useState<EntityDocument | null>(null);
  const [reason, setReason] = useState<ReissueReason | null>(null);
  const [issued, setIssued] = useState("");
  const [changedOn, setChangedOn] = useState("");
  const [changed, setChanged] = useState<ItemKey[]>([]);
  const [values, setValues] = useState<Partial<Record<ItemKey, unknown>>>({});
  const effectiveFromRef = useRef<HTMLInputElement>(null);
  const all = items(e, r);
  const docs = useQuery({ ...entityDocumentsQuery(e.id), retry: false }).data?.items ?? [];
  const before = docs.find((d) => d.registration_id === r.id && !d.superseded_at);
  const picked = all.filter((i) => changed.includes(i.key));
  const value = (k: ItemKey, spec: AnySpec) => (k in values ? values[k] : spec.initial);
  const from = reason ? reissueFrom(reason, issued, changedOn || issued, inForce) : "";
  const problem = reason ? fromProblem(reason, changedOn || issued, inForce, today) : null;
  const needsFacts = reason !== null && reason !== "CERT_REISSUE";
  const notNew = doc !== null && !isNewCertificate(doc, r.id);
  const part = needsFacts && picked.some((i) => i.spec.owner.kind === "entity") ? entityPartFrom(e, from) : null;
  const entityScheduled = part && "scheduled" in part ? part.scheduled : null;
  const entityFrom = part && "from" in part ? part.from : from;
  const effectiveFromProblem = reason === "CERT_CHANGE_REPORT" && entityScheduled
    ? t("entityReissue.problem.entityScheduled", { date: fmtDate(entityScheduled) })
    : problem ? t(`entityReissue.problem.${problem}`, { date: fmtDate(inForce) }) : undefined;
  const dateBlocked = Boolean(problem || (reason === "CERT_CHANGE_REPORT" && entityScheduled));
  const need = entityScheduled ? "entityReissue.problem.entityScheduled" : !doc ? "entityReissue.need.doc" : notNew ? "entityReissue.need.newDoc" : !reason ? "entityReissue.need.reason" : !issued ? "entityReissue.need.issued" : needsFacts && picked.length === 0 ? "entityReissue.need.facts" : "entityReissue.need.values";
  const ready = doc !== null && !notNew && reason !== null && issued !== "" && issued <= today && from !== "" && !problem && !entityScheduled && (!needsFacts || picked.length > 0) && picked.every((i) => i.spec.ready(value(i.key, i.spec)));
  const patches = (owner: "entity" | "registration") => Object.assign({}, ...picked.filter((i) => i.spec.owner.kind === owner).map((i) => i.spec.patch(value(i.key, i.spec))));
  const save = useCommand({
    run: (_: undefined, key: string) => {
      const body = reissueBody(e, r.id, { docId: doc!.id, reason: reason!, from, issued, changed: needsFacts ? changed : [], reg: needsFacts ? patches("registration") : {}, entity: needsFacts ? patches("entity") : {} });
      if (!body) throw new Error("restricted: the record cannot be read whole");
      return reissueRegistration(key, r.id, body);
    },
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t("entityReissue.saved", { brn: r.brn?.display ?? "" }),
    onSuccess: onClose,
  });
  const brn = r.brn?.display ?? t("entityRecord.cert.noBrn");
  return (
    <Sheet
      open
      wide
      onClose={onClose}
      pending={save.isPending}
      kicker={<><FileText size={14} aria-hidden /> {entityName(e)} · {brn} · {t("entityReissue.issuedOn", { date: r.current?.cert_issued_on ? fmtDate(r.current.cert_issued_on) : "—" })}</>}
      title={t("entityReissue.title")}
      notice={<EntityError error={save.error} historyHref={`/org/entities/${encodeURIComponent(e.id)}?tab=history#history`} />}
      consequence={ready ? <>{t(reason === "CERT_ERROR_CORRECTION" ? "entityReissue.consequenceCor" : "entityReissue.consequence", { date: fmtDate(from) })} <Muted>{t(phase === "SETUP" ? "entityRecord.revise.setupNote" : "entityRecord.revise.operatingNote")}</Muted></> : dateBlocked ? undefined : <div id="reissue-why">{t(need, { date: entityScheduled ? fmtDate(entityScheduled) : "" })}</div>}
      actions={
        <>
          <Button onClick={onClose}>{t("entityRecord.cancel")}</Button>
          <Button variant="primary" aria-disabled={!ready || undefined} aria-describedby={ready || dateBlocked ? undefined : "reissue-why"} disabled={save.isPending} onClick={() => {
            if (ready) save.mutate(undefined);
            else if (dateBlocked) effectiveFromRef.current?.focus();
          }}>{t("entityReissue.save")}</Button>
        </>
      }
    >
      <CertEvidence entityId={e.id} doc={doc} onDoc={setDoc} />
      <ChoiceField
        label={t("entityReissue.reason")}
        required
        options={REISSUE_REASONS.map((x) => ({ value: x, label: t(`entityReissue.reason.${x}`) }))}
        value={reason}
        onChange={(x) => setReason(x as ReissueReason)}
      />
      <div className="grid-3">
        <DateField label={t("entityRecord.field.issuedOn")} required value={issued} onChange={setIssued} today={today} max={today} maxReason={t("entityReissue.problem.future")} />
        {reason === "CERT_CHANGE_REPORT" && (
          <DateField label={t("entityReissue.effectiveFrom")} required value={changedOn || issued} onChange={setChangedOn} today={today} max={today} maxReason={t("entityReissue.problem.future")}
            error={effectiveFromProblem} inputRef={effectiveFromRef} />
        )}
      </div>
      {needsFacts && (
        <div role="group" aria-label={t("entityReissue.facts")} className={s.editor}>
          <h3 className={s.subhead}>{t("entityReissue.facts")}</h3>
          <div className="row">
            {all.map((i) => (
              <ToggleButton key={i.key} look="chip" pressed={changed.includes(i.key)} onClick={() => setChanged((x) => (x.includes(i.key) ? x.filter((k) => k !== i.key) : [...x, i.key]))}>
                {i.spec.label} · {i.spec.current}
              </ToggleButton>
            ))}
          </div>
        </div>
      )}
      {needsFacts && picked.map((i) => (
        <section key={i.key} className={s.editor} aria-label={t("entityRecord.revise.newValue", { field: i.spec.label })}>
          <h3 className={s.subhead}>{t("entityRecord.revise.newValue", { field: i.spec.label })}</h3>
          {i.spec.edit(value(i.key, i.spec), (v) => setValues((x) => ({ ...x, [i.key]: v })))}
        </section>
      ))}
      {ready && (
        <section aria-labelledby="reissue-diff">
          <h3 id="reissue-diff" className={s.subhead}>{t("entityReissue.diff")}</h3>
          <ul className={s.periods}>
            <li><b>{t("entityReissue.evidence.title")}</b><div><del className={s.old}>{before?.file_name ?? t("entityReissue.noBefore")}</del>{ARROW}<b>{doc?.file_name}</b></div><Muted>{t("entityReissue.superseded")}</Muted></li>
            <li><b>{t("entityRecord.field.issuedOn")}</b><div><del className={s.old}>{r.current?.cert_issued_on ? fmtDate(r.current.cert_issued_on) : "—"}</del>{ARROW}<b className="num">{fmtDate(issued)}</b></div><div /></li>
            {needsFacts && picked.map((i) => (
              <li key={i.key}><b>{i.spec.label}</b><div><del className={s.old}>{i.spec.current}</del>{ARROW}<b>{i.spec.show(value(i.key, i.spec))}</b></div><Muted>{t("entityReissue.fromDate", { date: fmtDate(i.spec.owner.kind === "entity" ? entityFrom : from) })}</Muted></li>
            ))}
          </ul>
        </section>
      )}
    </Sheet>
  );
}
