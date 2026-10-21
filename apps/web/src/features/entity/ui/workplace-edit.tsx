import { useState } from "react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { phoneE164, toDomestic, validEmail } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button, Form } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Dialog } from "../../../ui/dialog";
import { ENTITY_READS, reviseInsurance, reviseWorkplace, stepKey, unserved } from "../api";
import { workplaceInput } from "../domain/view";
import { toAddr, toKr } from "../domain/record-values";
import { InfoField, type InfoDraft, type InfoKey } from "./workplace-edit-fields";
import { INFO_LABEL } from "../present";
import { PathNote } from "../../../ui/record-actions/record-actions";
import { emptyWorkplace, insuranceProblems, insurers, type WorkplaceDraft } from "../domain/workplace";
import { InsuranceFields } from "./insurance-fields";

const REASONS = ["RENAME", "CONTACT_CHANGE", "INSURANCE_ESTABLISHED", "INSURANCE_NUMBER", "ENTRY_CORRECTION"] as const;

/**
 * A dated change to one fact of a workplace (record-actions §3: the row's edit edits only that row's value): its name,
 * representative, main product, a contact, the mailing address, the opening date (a correction) or its insurance relations,
 * from a chosen date, with a reason. `clear` opens an optional fact emptied (its row's clear). The workplace revision carries
 * its whole state with the one edit applied; insurance changes go as their own revision.
 */
export function WorkplaceEdit(props: { e: LegalEntity; w: Workplace; field: InfoKey | "insurance"; clear?: boolean; setup: boolean; onClose: () => void }) {
  // What the form was opened on (see EntityEdit): a refetch while it is open never turns typed fields into changes.
  const [{ e, w, field, clear }] = useState(props);
  const { onClose } = props;
  const today = todayKst();
  const base = workplaceInput(e, w);
  const c = w.current;
  const [d, setD] = useState<InfoDraft>(() => ({
    name: base?.name ?? "", representative: base?.representative_name ?? "", product: base?.main_product ?? "",
    phone: base?.phone ? toDomestic(base.phone) : "", fax: base?.fax ? toDomestic(base.fax) : "", email: base?.email ?? "",
    mail: toAddr(c?.mail_address), openedOn: base?.opened_on ?? "",
    ...(clear && field !== "insurance" ? { [field]: field === "mail" ? null : "" } : {}),
  }));
  const set = <K extends keyof InfoDraft>(k: K, v: InfoDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const { name, phone, email } = d;
  const info = base && {
    ...base,
    name: name.trim(),
    representative_name: d.representative.trim() || null,
    main_product: d.product.trim() || null,
    phone: phone ? phoneE164(phone) : null,
    fax: d.fax ? phoneE164(d.fax) : null,
    email: email.trim() || null,
    mail_address: toKr(d.mail, c?.mail_address),
    opened_on: d.openedOn,
  };
  // The opening date is when the place opened: a different one is a correction of what was typed, never a change.
  const openedFixed = Boolean(base) && d.openedOn !== base?.opened_on;
  const before = w.insurance.map((r) => ({ insurer: r.insurer, status: r.status === "ENDED" ? null : r.status, mgmtNo: r.mgmt_no?.value ?? "", establishedOn: r.established_on ?? "" }));
  const [ins, setIns] = useState<Pick<WorkplaceDraft, "insurance" | "rows">>(() => ({ insurance: "PER_INSURER", rows: before.length ? before : emptyWorkplace().rows }));
  const [from, setFrom] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const problems = insuranceProblems(ins, true);
  const contact = Boolean(base && info && JSON.stringify({ ...info, mail_address: info.mail_address ?? null }) !== JSON.stringify({ ...base, mail_address: base.mail_address ?? null }));
  // The insurance revision is a requested path: where the server does not serve it, the numbers are not offered as
  // an edit (they would not be recorded), and the other fields still save on their own.
  const [insuranceUnserved, setInsuranceUnserved] = useState(false);
  const insured = !insuranceUnserved && JSON.stringify(ins.rows) !== JSON.stringify(before);
  const save = useCommand({
    run: async (_: undefined, key: string) => {
      const dated = { effective_from: from, reason_code: reason!, expected_version: w.current?.version ?? 0 };
      // Insurance first: when it cannot be recorded, nothing else is half-saved.
      if (insured)
        await reviseInsurance(stepKey(key, 1), w.id, { ...dated, expected_version: Math.max(0, ...w.insurance.map((r) => r.version)), insurers: insurers(ins) }).catch((x: unknown) => {
          if (unserved(x)) setInsuranceUnserved(true);
          throw x;
        });
      if (contact && info) await reviseWorkplace(key, w.id, { ...info, ...dated });
    },
    invalidates: ENTITY_READS,
    // Closes once the record has re-read (as the suspend and move sheets do): each fact is its own sheet, so the next one is
    // opened on the version this save made, never refused 409 against it.
    settle: true,
    announce: () => t("workplace.edit.saved", { name: name.trim() }),
    onSuccess: onClose,
  });
  const valid = name.trim() !== "" && !(phone && !phoneE164(phone)) && !(d.fax && !phoneE164(d.fax)) && !(email && !validEmail(email)) && d.openedOn !== "" && (field !== "insurance" || insuranceUnserved || Object.keys(problems).length === 0);
  const ready = (contact || insured) && valid && from !== "" && reason !== null && (!openedFixed || reason === "ENTRY_CORRECTION");
  return (
    <Dialog open title={t("uiRecordActions.of", { field: field === "insurance" ? t("workplace.field.insurance") : INFO_LABEL[field](), verb: t(clear ? "uiRecordActions.end.clear" : "uiRecordActions.edit") })} onClose={onClose}>
      <Form className="form" onSubmit={() => ready && save.mutate(undefined)}>
        {field !== "insurance" ? (
          base && <InfoField only={field} d={d} set={set} today={today} openedFrom={c?.opened_on ?? ""} />
        ) : insuranceUnserved ? (
          <p className="alert" role="status">{t("workplace.edit.insuranceNotKept")}</p>
        ) : (
          <InsuranceFields d={ins} set={(k, v) => setIns((x) => ({ ...x, [k]: v }))} problem={(k) => problems[k]} today={today} />
        )}
        <div className="grid-3">
          <DateField label={t("entity.edit.from")} required value={from} onChange={setFrom} today={today}  />
          <ChoiceField label={t("entity.edit.reason")} required options={REASONS.map((r) => ({ value: r, label: t(`workplace.reason.${r}`) }))} value={reason} onChange={setReason} />
        </div>
        {e.biz_kind === "CORPORATION" && <p className="muted">{t("workplace.edit.withholdingNote")}</p>}
        {!(contact || insured) && <p className="muted">{t("entity.edit.nothing")}</p>}
        {openedFixed && reason !== "ENTRY_CORRECTION" && <p className="notice">{t("entityOps.info.openedIsCorrection")}</p>}
        <PathNote path={props.setup ? "setup" : openedFixed ? "correction" : "revision"} />
        {!unserved(save.error) && <EntityError error={save.error} />}
        <div className="form__actions">
          <Button onClick={onClose}>{t("common.back")}</Button>
          {ready ? <Button type="submit" variant="primary" disabled={save.isPending}>{t("entity.edit.save")}</Button> : <DisabledReason layout="inline" reason={t("entity.edit.notReady")} control={(p) => <Button variant="primary" {...p}>{t("entity.edit.save")}</Button>} />}
        </div>
      </Form>
    </Dialog>
  );
}
