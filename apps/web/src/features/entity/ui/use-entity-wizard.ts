// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { isFounding, registrationGaps, stepsFor, type CreateField, type WizardStep } from "../domain/create";
import { useCreate, WIZARD_DRAFT, type Then } from "./use-create";

const FIELD_ORDER: CreateField[] = ["brn", "crn", "openedOn", "incorporatedOn", "eInvoiceEmail", "mainPhone", "certIssuedOn"];
/** The step that shows a field (company-04: the foot sends the user to it). */
const stepOf = (f: CreateField): WizardStep => (f === "incorporatedOn" || f === "mainPhone" ? "registry" : "certificate");
/** After the step renders, the first flagged input takes focus. */
const focusFlagged = () => requestAnimationFrame(() => document.querySelector<HTMLElement>("main [aria-invalid='true']")?.focus());

export function useEntityWizardController(kind?: BizKind, name?: string) {
  // A wizard opened from the quick sheet starts from what it chose, never from an older kept draft.
  const entry = useLocation({ select: (l) => l.state.key });
  const c = useCreate({ bizKind: kind ?? null, name: name ?? "" }, kind && name ? undefined : { key: WIZARD_DRAFT, entry });
  const steps = stepsFor(c.draft.bizKind, c.draft.founding);
  // worst-case-30: each step is a history entry (browser back returns to the previous step, a reload keeps it).
  const nav = useNavigate();
  const kept = useLocation({ select: (l) => (l.state as { wizardStep?: WizardStep }).wizardStep });
  const first: WizardStep = kind && name ? (isFounding(c.draft) ? "registry" : "certificate") : "basics";
  const step: WizardStep = kept && steps.includes(kept) ? kept : first;
  const at = Math.max(0, steps.indexOf(step));
  const go = (to: WizardStep) => void nav({ to: ".", search: true, state: (prev) => ({ ...prev, wizardStep: to }) as typeof prev });

  const why = useId();
  // A field on a step this kind of entity does not take (founding skips the certificate) never holds anything.
  const bad = FIELD_ORDER.filter((f) => c.problems[f] && steps.includes(stepOf(f)));
  const basicsOpen = !c.draft.bizKind || c.draft.name.trim() === "";
  const fieldName = (f: CreateField) => t(`entityCreate.items.${f === "certIssuedOn" ? "issued" : f}`);
  const checkHold = c.registers && c.preview && ["SUSPENDED", "CLOSED"].includes(c.preview.answer.reported_status ?? "") && (!c.preview.acknowledged || (c.preview.answer.reported_status === "SUSPENDED" && !c.preview.status_since));
  const hold = checkHold
    ? t("nts.preview.ack")
    : bad.length
      ? t("entityCreate.foot.fix", { count: bad.length, fields: bad.map(fieldName).join(", ") })
      : c.gaps.length
        ? t("entityCreate.foot.gaps", { fields: c.gaps.map((g) => t(`entityCreate.gap.${g}`)).join(", ") })
        : null;
  // company-04: a flagged field on a later step never holds the way to it; only one on this step or before does.
  const nextHold = basicsOpen || bad.some((f) => steps.indexOf(stepOf(f)) <= at);
  const jump = (f: CreateField) => {
    if (stepOf(f) !== step) go(stepOf(f));
    focusFlagged();
  };
  const missingRegistration = registrationGaps(c.draft);
  const registrationNote = !isFounding(c.draft) && missingRegistration.length
    ? t("nts.preview.missing", { fields: missingRegistration.map((field) => field === "taxOfficePrinted" ? t("entityCreate.field.taxOffice") : t(`entityCreate.items.${field}`)).join(", ") })
    : null;
  const entityName = c.draft.name.trim();
  const off = (held: unknown) => (held ? { "aria-disabled": true as const, "aria-describedby": why, onClick: undefined } : {});
  // worst-case-29: the first press latches until the save settles, so a double press never sends a second create.
  const latch = useRef(false);
  const save = (then: Then) => {
    if (hold || latch.current || c.save.isPending) return;
    latch.current = true;
    c.save.mutate(then, { onSettled: () => void (latch.current = false) });
  };
  const stepLabel = (x: WizardStep) => t(x === "certificate" && c.draft.bizKind === "ID_NUMBER_ORG" ? "entityCreate.step.idCert" : `entityCreate.step.${x}`);
  return { c, steps, step, at, go, why, bad, hold, nextHold, jump, fieldName, registrationNote, entityName, off, save, stepLabel };
}
