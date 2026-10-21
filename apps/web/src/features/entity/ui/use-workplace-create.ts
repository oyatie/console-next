import { useState } from "react";
import { t } from "@console/i18n";
import type { CreateWorkplaceRequest, LegalEntity } from "@console/api/pending";
import { addRegistration, createWorkplace, readVersion, reviseEntity, stepKey } from "../api";
import { krAddress, planRegistration } from "../domain/plan";
import { entityInput, headOfficeSettled, samePlace, unheld, unitRegistration } from "../domain/view";
import { emptyWorkplace, INSURERS, planWorkplace, workplaceProblems, type RegMode, type WorkplaceDraft } from "../domain/workplace";
import { useEntityDraft } from "./use-entity-draft";
import { useCommand } from "../../../lib/react/command";
import { STRUCTURE_READS } from "../../../reference/org/api";

/** The social insurance answer: one of the server's shortcuts, or "reported with another workplace's numbers" (PART_OF). */
export type InsuranceAnswer = WorkplaceDraft["insurance"] | "JOINT";
export type VatUnit = "PER_WORKPLACE" | "CONSOLIDATED_PAYMENT";

/**
 * The workplace add sheet's state and save (S5-create). Nothing is preselected: kind, withholding and social insurance are answered
 * (D7); business registration may stay unanswered (linked later) and opening date may stay empty (recorded as today).
 */
export function useWorkplaceCreate(e: LegalEntity, opts: { kinds: boolean; onSaved: (id: string, another: boolean) => void }) {
  const corp = e.biz_kind === "CORPORATION";
  const free = unheld(e);
  const unit = unitRegistration(e);
  const [w, setW] = useState<WorkplaceDraft>(emptyWorkplace);
  const [kind, setKind] = useState<string | null>(null);
  const [ins, setIns] = useState<InsuranceAnswer>(null);
  const [joint, setJoint] = useState<string | null>(null);
  const [vat, setVat] = useState<VatUnit | null>(null);
  const [addedReg, setAddedReg] = useState<string | null>(null);
  const reg = useEntityDraft({ scope: "registration", bizKind: e.biz_kind ?? null });
  const set = <K extends keyof WorkplaceDraft>(k: K, v: WorkplaceDraft[K]) => setW((x) => ({ ...x, [k]: v }));

  const mode: RegMode = w.regMode ?? "LATER";
  const chosen = free.find((r) => r.id === (free.length === 1 ? free[0]!.id : w.registrationId));
  const place = mode === "EXISTING" ? chosen?.current?.business_address : mode === "NEW" && reg.draft.businessAddress ? krAddress(reg.draft.businessAddress) : w.isAbstract ? null : w.address ? krAddress(w.address) : null;
  const evident = corp && samePlace(place, e.current?.head_office_address);
  const askHeadOffice = !headOfficeSettled(e) && !evident;
  const askVat = mode === "NEW" && e.current?.vat_unit_mode_basis !== "DECLARED" && reg.draft.unitTaxation === false && e.registrations.some((r) => !r.closed_on);
  const draft: WorkplaceDraft = { ...w, regMode: mode, registrationId: chosen?.id ?? null, insurance: ins === "JOINT" ? "ALL_ESTABLISHED_NUMBERS_LATER" : ins };
  // Only what the server needs is required: the opening date may wait (recorded as today); a workplace with no certificate needs its address.
  const problems = Object.fromEntries(Object.entries(workplaceProblems(draft, { askHeadOffice, showRequired: true })).filter(([k]) => k !== "openedOn"));
  const regOk = mode !== "NEW" || planRegistration(reg.draft, { today: reg.today, documentId: reg.doc?.id }).ok;
  const missing = {
    name: !w.name.trim(),
    kind: opts.kinds && kind === null,
    withholding: w.independentAccounts === null,
    insurance: ins === null || (ins === "JOINT" && joint === null),
  };
  const ready = !Object.values(missing).some(Boolean) && Object.keys(problems).length === 0 && regOk && (!askVat || vat !== null);

  const headOffice = headOfficeSettled(e) ? false : evident ? true : w.headOffice;
  const body = (registrationId: string | null, openedOn?: string): CreateWorkplaceRequest & { kind_code?: string | null } => {
    const plan = planWorkplace(draft, { corp, registrationId, openedOn, headOffice });
    const insurance: CreateWorkplaceRequest["insurance"] =
      ins === "JOINT" ? { shortcut: "PER_INSURER", insurers: INSURERS.map((insurer) => partOf(insurer)) } : plan.insurance;
    return { ...plan, opened_on: plan.opened_on || reg.today, insurance, ...(opts.kinds ? { kind_code: kind } : {}) };
  };
  // Reported under the main workplace's relation: its status and number, marked PART_OF (never the BRN, D11).
  const partOf = (insurer: (typeof INSURERS)[number]) => {
    const r = e.workplaces.find((x) => x.id === joint)?.insurance.find((i) => i.insurer === insurer);
    const status = r && r.status !== "ENDED" ? r.status : "NOT_ESTABLISHED";
    const own = status === "ESTABLISHED";
    return { insurer, status, unit_mode: "PART_OF" as const, main_workplace_id: joint, mgmt_no: own ? (r?.mgmt_no?.value ?? null) : null, established_on: own ? (r?.established_on ?? null) : null };
  };
  const save = useCommand({
    run: async (another: boolean, key: string) => {
      let registrationId = mode === "EXISTING" ? (chosen?.id ?? null) : mode === "UNIT_TAXATION_SUB" ? (unit?.id ?? null) : null;
      let openedOn = chosen?.current?.opened_on ?? undefined;
      if (mode === "NEW") {
        const r = planRegistration(reg.draft, { today: reg.today, documentId: reg.doc?.id });
        if (!r.ok) throw new Error("unreachable: planned before submit");
        if (askVat && !addedReg) {
          const base = entityInput(e);
          if (!base) throw new Error(t("workplace.vat.restricted"));
          await reviseEntity(stepKey(key, 0), e.id, { ...base, vat_unit_mode: vat, effective_from: reg.today, reason_code: "VAT_UNIT_DECLARED", expected_version: readVersion(e) });
        }
        registrationId = addedReg ?? (await addRegistration(stepKey(key, 1), e.id, r.body)).record.id;
        setAddedReg(registrationId);
        openedOn = r.body.opened_on;
      }
      const saved = await createWorkplace(stepKey(key, 2), e.id, body(registrationId, openedOn));
      return { id: saved.record.id, another };
    },
    invalidates: STRUCTURE_READS,
    announce: () => t("workplace.new.saved", { name: w.name.trim() }),
    onSuccess: (out) => {
      if (out.another) {
        setW(emptyWorkplace());
        setKind(null);
        setIns(null);
        setJoint(null);
        setAddedReg(null);
      }
      opts.onSaved(out.id, out.another);
    },
  });
  return { w, set, kind, setKind, ins, setIns, joint, setJoint, vat, setVat, reg, mode, free, unit, chosen, corp, askHeadOffice, askVat, evident, problems, missing, ready, save, today: reg.today };
}
export type WorkplaceCreate = ReturnType<typeof useWorkplaceCreate>;
