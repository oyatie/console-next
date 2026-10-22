import { useState } from "react";
import { t } from "@console/i18n";
import type { CodeRef, LegalEntity, Workplace } from "@console/api/pending";
import { FORMATS } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { addRegistration, changeRegistration, ENTITY_READS, readVersion, reviseEntity, reviseWorkplace, stepKey } from "../api";
import { planRegistration } from "../domain/plan";
import { entityInput, unheld, unitRegistration, workplaceInput, workplaceName } from "../domain/view";
import type { RegMode } from "../domain/workplace";
import { useEntityDraft } from "./use-entity-draft";
import type { VatUnit } from "./use-workplace-create";

/** Resolve an unanswered workplace with a registration or a not-required answer. */
export const ATTACH_MODES: readonly RegMode[] = ["NEW", "EXISTING", "UNIT_TAXATION_SUB", "NOT_REQUIRED"];
type Fields = { regMode: RegMode | null; registrationId: string | null; subSerial: string; notRegisteredReason?: CodeRef | null; isAbstract?: boolean };

/**
 * Attach a certificate to a workplace added without one (org-03, catalog company-18). The certificate is typed (nothing is
 * read from an upload), recorded, then linked from a date (its opening date by default) with its own step key, so a retry after a
 * failed link does not record the certificate twice.
 */
export function useWorkplaceAttach(e: LegalEntity, wp: Workplace, onDone: () => void) {
  const free = unheld(e);
  const unit = unitRegistration(e);
  const reg = useEntityDraft({ scope: "registration", bizKind: e.biz_kind ?? null });
  const [w, setW] = useState<Fields>({ regMode: null, registrationId: null, subSerial: "", notRegisteredReason: null, isAbstract: false });
  const [vat, setVat] = useState<VatUnit | null>(null);
  const [from, setFrom] = useState("");
  const [addedReg, setAddedReg] = useState<string | null>(null);
  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setW((x) => ({ ...x, [k]: v }));
  const mode = w.regMode;
  const chosen = free.find((r) => r.id === (free.length === 1 ? free[0]!.id : w.registrationId));
  const askVat = mode === "NEW" && e.current?.vat_unit_mode_basis !== "DECLARED" && reg.draft.unitTaxation === false && e.registrations.some((r) => !r.closed_on);
  // From when it files under the certificate: what was chosen, else the certificate's own opening date.
  const since = from || (mode === "NEW" ? reg.draft.openedOn : mode === "EXISTING" ? (chosen?.current?.opened_on ?? "") : (wp.current?.opened_on ?? ""));
  const problems: { subSerial?: "subSerial" } = mode === "UNIT_TAXATION_SUB" && w.subSerial.length !== FORMATS.subSerial.max ? { subSerial: "subSerial" } : {};
  const planned = mode === "NEW" ? planRegistration(reg.draft, { today: reg.today, documentId: reg.doc?.id }) : null;
  const ready =
    mode !== null &&
    (mode !== "NEW" || planned?.ok === true) &&
    (mode !== "EXISTING" || chosen !== undefined) &&
    (mode !== "UNIT_TAXATION_SUB" || (unit !== undefined && !problems.subSerial)) &&
    (mode !== "NOT_REQUIRED" || (Boolean(w.notRegisteredReason) && workplaceInput(e, wp) !== null)) &&
    (!askVat || vat !== null) &&
    since !== "" &&
    since <= reg.today;
  const save = useCommand({
    run: async (_: undefined, key: string) => {
      if (mode === "NOT_REQUIRED") {
        const base = workplaceInput(e, wp);
        if (!base || !w.notRegisteredReason) throw new Error(t("entityOps.status.restricted"));
        return reviseWorkplace(key, wp.id, {
          ...base, reg_mode: "NOT_REQUIRED", not_registered_reason: { code: w.notRegisteredReason.code, version: w.notRegisteredReason.version },
          is_abstract: w.isAbstract ?? false, address: w.isAbstract ? null : base.address,
          same_address_as_registration: false, effective_from: since,
          reason_code: "REGISTRATION_ANSWER_CHANGED", expected_version: readVersion(wp),
        });
      }
      let registrationId = mode === "EXISTING" ? (chosen?.id ?? null) : (unit?.id ?? null);
      if (mode === "NEW") {
        if (!planned?.ok) throw new Error("unreachable: planned before submit");
        if (askVat && !addedReg) {
          const base = entityInput(e);
          if (!base) throw new Error(t("workplace.vat.restricted"));
          await reviseEntity(stepKey(key, 0), e.id, { ...base, vat_unit_mode: vat, effective_from: reg.today, reason_code: "VAT_UNIT_DECLARED", expected_version: readVersion(e) });
        }
        registrationId = addedReg ?? (await addRegistration(stepKey(key, 1), e.id, { ...planned.body, ...(reg.doc ? { document_id: reg.doc.id } : {}) })).record.id;
        setAddedReg(registrationId);
      }
      await changeRegistration(stepKey(key, 2), wp.id, {
        registration_id: registrationId,
        sub_serial: mode === "UNIT_TAXATION_SUB" ? w.subSerial : null,
        effective_from: since,
        reason_code: "FIRST_ATTACH",
      });
    },
    invalidates: ENTITY_READS,
    settle: true,
    announce: () => t(mode === "NOT_REQUIRED" ? "workplace.edit.saved" : "entityOps.attach.saved", { name: workplaceName(wp) }),
    onSuccess: onDone,
  });
  return { w, set, mode, free, unit, chosen, reg, askVat, vat, setVat, problems, since, from, setFrom, ready, save, today: reg.today };
}
export type WorkplaceAttach = ReturnType<typeof useWorkplaceAttach>;
