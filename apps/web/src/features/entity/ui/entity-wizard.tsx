import { useId, useRef } from "react";
import { Check, ChevronRight, Network, TriangleAlert, X } from "lucide-react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { isFounding, registrationGaps, stepsFor, type CreateField, type WizardStep } from "../domain/create";
import { FoundingChoice } from "./create-founding";
import { CertChecklist, NotCollected, OriginalCard } from "./create-cert-aside";
import { NtsPreview } from "./nts-preview";
import { CertForm } from "./create-cert-form";
import { IdOrgForm } from "./create-idorg-form";
import { KindAndName } from "./create-kind-and-name";
import { RegistryForm } from "./create-registry-form";
import { ReviewStep } from "./create-review-step";
import { useCreate, WIZARD_DRAFT, type CreateState, type Then } from "./use-create";
import s from "./entity-create.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * add entity as a full page (spec S4, D9): basics → certificate → (corporations) registry → review, with the certificate
 * typed beside its kept original. Any step can save what is there ("save so far"); only a value that cannot be
 * right holds the save and the next step back, and the foot names those fields.
 */
export function EntityWizard({ kind, name }: { kind?: BizKind; name?: string }) {
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
  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <nav className={s.crumb} aria-label={t("entityCreate.crumb")}>
            <Network size={14} aria-hidden /><Link to="/org">{t("entityCreate.crumbRoot")}</Link><ChevronRight size={14} aria-hidden /><span>{t("entityCreate.title")}</span>
          </nav>
          <h1 className="page__title" tabIndex={-1}>{t("entityCreate.title")}</h1>
        </div>
        <span className={s.vsep} aria-hidden />
        <ol className={s.steps} aria-label={t("entityCreate.steps")}>
          {steps.map((x, i) => (
            <li key={x} data-st={i < at ? "done" : i === at ? "cur" : undefined} aria-current={i === at ? "step" : undefined}>
              <span className={s.n} aria-hidden>{i < at ? <Check size={12} /> : i + 1}</span>
              {t(x === "certificate" && c.draft.bizKind === "ID_NUMBER_ORG" ? "entityCreate.step.idCert" : `entityCreate.step.${x}`)}
            </li>
          ))}
        </ol>
        <span className="grow" />
        <Muted>{t("entityCreate.context", { n: c.ordinal })}</Muted>
        <Link to="/org/entities" className="btn btn--ghost" aria-label={t("entityCreate.close")} onClick={c.forget}><X size={16} aria-hidden /></Link>
      </div>
      <div className={s.body}>
        {step === "basics" && (
          <section className={`card ${s.main}`} aria-labelledby="basics-title">
            <div className={s.cardHead}><h2 id="basics-title" className={s.cardTitle}>{t("entityCreate.step.basics")}</h2></div>
            <div className={s.cardBody}>
              <FoundingChoice c={c} />
              <KindAndName representatives={c.draft.representatives} kind={c.draft.bizKind} onKind={(k) => c.put("bizKind", k)} name={c.draft.name} onName={(n) => c.put("name", n)} clash={c.clash} displayName={c.draft.displayName} onDisplayName={(n) => c.put("displayName", n)} englishName={c.draft.englishName} onEnglishName={(n) => c.put("englishName", n)} />
            </div>
          </section>
        )}
        {step === "certificate" && <CertStep c={c} onKindChange={() => go("basics")} />}
        {step === "registry" && (
          <section className={`card ${s.main}`} aria-labelledby="registry-title">
            <div className={s.cardHead}><h2 id="registry-title" className={s.cardTitle}>{t("entityCreate.step.registry")}</h2></div>
            <div className={s.cardBody}><RegistryForm c={c} /></div>
          </section>
        )}
        {step === "review" && <ReviewStep c={c} goTo={go} />}
      </div>
      <Foot c={c} step={step} steps={steps} go={go} />
    </div>
  );
}

function CertStep({ c, onKindChange }: { c: CreateState; onKindChange: () => void }) {
  const kind = c.draft.bizKind;
  const corp = kind === "CORPORATION";
  return (
    <>
      <section className={`card ${s.main}`} aria-labelledby="cert-title">
        <div className={s.cardHead}>
          <h2 id="cert-title" className={s.cardTitle}>{t(kind === "ID_NUMBER_ORG" ? "entityCreate.step.idCert" : kind === "INDIVIDUAL" ? "entityCreate.cert.titleIndividual" : "entityCreate.step.certificate")}</h2>
          <span className="grow" />
          {!corp && <Button variant="ghost" onClick={onKindChange}>{t("entityCreate.cert.changeKind")}</Button>}
        </div>
        <div className={s.cardBody}>
          {corp && (
            <p className={`notice ${s.picked}`}>
              {t("entityCreate.cert.notice")} <b>{t("entityCreate.cert.picked", { kind: t(`enum.bizKind.${kind}`), name: c.draft.name.trim() })}</b>
              <Button variant="ghost" onClick={onKindChange}>{t("entityCreate.cert.change")}</Button>
            </p>
          )}
          {kind === "ID_NUMBER_ORG" ? <IdOrgForm c={c} /> : <CertForm c={c} />}
        </div>
      </section>
      <aside className={s.aside}>
        {kind !== "ID_NUMBER_ORG" && <OriginalCard c={c} />}
        {corp ? <CertChecklist c={c} /> : <NotCollected c={c} />}
        {kind !== "ID_NUMBER_ORG" && <NtsPreview c={c} />}
      </aside>
    </>
  );
}

const FIELD_ORDER: CreateField[] = ["brn", "crn", "openedOn", "incorporatedOn", "eInvoiceEmail", "mainPhone", "certIssuedOn"];
/** The step that shows a field (company-04: the foot sends the user to it). */
const stepOf = (f: CreateField): WizardStep => (f === "incorporatedOn" || f === "mainPhone" ? "registry" : "certificate");
/** After the step renders, the first flagged input takes focus. */
const focusFlagged = () => requestAnimationFrame(() => document.querySelector<HTMLElement>("main [aria-invalid='true']")?.focus());

/** The sticky foot: what saving does now, or which fields hold it, then back · save so far · next (or the two saves). */
function Foot({ c, step, steps, go }: { c: CreateState; step: WizardStep; steps: WizardStep[]; go: (s: WizardStep) => void }) {
  const why = useId();
  const at = steps.indexOf(step);
  // A field on a step this kind of entity does not take (founding skips the certificate) never holds anything.
  const bad = FIELD_ORDER.filter((f) => c.problems[f] && steps.includes(stepOf(f)));
  const basicsOpen = !c.draft.bizKind || c.draft.name.trim() === "";
  // Why nothing can be saved yet: a refused value, or what the server still needs (spec wants kind + name only: CS-BE).
  const fieldName = (f: CreateField) => t(`entityCreate.items.${f === "certIssuedOn" ? "issued" : f}`);
  const checkHold = c.registers && c.preview && ["SUSPENDED", "CLOSED"].includes(c.preview.answer.reported_status ?? "") && (!c.preview.acknowledged || (c.preview.answer.reported_status === "SUSPENDED" && !c.preview.status_since));
  const hold = checkHold ? t("nts.preview.ack") : bad.length ? t("entityCreate.foot.fix", { count: bad.length, fields: bad.map(fieldName).join(", ") })
    : c.gaps.length ? t("entityCreate.foot.gaps", { fields: c.gaps.map((g) => t(`entityCreate.gap.${g}`)).join(", ") })
    : null;
  // company-04: a flagged field on a later step never holds the way to it; only one on this step or before does.
  const nextHold = basicsOpen || bad.some((f) => steps.indexOf(stepOf(f)) <= at);
  const jump = (f: CreateField) => {
    if (stepOf(f) !== step) go(stepOf(f));
    focusFlagged();
  };
  const missingRegistration = registrationGaps(c.draft);
  const registrationNote = !isFounding(c.draft) && missingRegistration.length ? t("nts.preview.missing", { fields: missingRegistration.map((field) => field === "taxOfficePrinted" ? t("entityCreate.field.taxOffice") : t(`entityCreate.items.${field}`)).join(", ") }) : null;
  const name = c.draft.name.trim();
  const off = (held: unknown) => (held ? { "aria-disabled": true as const, "aria-describedby": why, onClick: undefined } : {});
  // worst-case-29: the first press latches until the save settles, so a double press never sends a second create.
  const latch = useRef(false);
  const save = (then: Then) => {
    if (hold || latch.current || c.save.isPending) return;
    latch.current = true;
    c.save.mutate(then, { onSettled: () => void (latch.current = false) });
  };
  return (
    <div className={s.foot}>
      <EntityError error={c.save.error} />
      <span id={why} className={hold && bad.length ? s.footBad : s.footText}>
        {hold ? <>{bad.length > 0 && <TriangleAlert size={14} aria-hidden />} {hold}</> : registrationNote ?? (step === "review" ? t("entityCreate.foot.review", { name }) : t(c.registers ? "entityCreate.foot.saveFull" : "entityCreate.foot.save", { name }))}
      </span>
      {/* company-04/32: each flagged field is one press away, on whichever step shows it. */}
      {bad.map((f) => (
        <Button key={f} variant="ghost" size="sm" onClick={() => jump(f)}>{t("entityCreate.foot.goFix", { field: fieldName(f) })}</Button>
      ))}
      <span className="grow" />
      {at > 0 && <Button onClick={() => go(steps[at - 1]!)}>{t("entityCreate.foot.prev")}</Button>}
      {step === "review" ? (
        <>
          {/* company-30: a entity takes nobody until it has a workplace, so creating it with its first one is the primary. */}
          <Button variant="ghost" {...off(hold)} onClick={() => save("record")} disabled={c.save.isPending}>{t("entityOps.wizard.createOnly")}</Button>
          <Button variant="primary" {...off(hold)} onClick={() => save("workplace")} disabled={c.save.isPending}>{t("entityCreate.foot.createAndWorkplace")}</Button>
        </>
      ) : (
        <>
          {step !== "basics" && <Button {...off(hold)} onClick={() => save("record")} disabled={c.save.isPending}>{t("entityCreate.foot.saveHere")}</Button>}
          <Button variant="primary" {...off(nextHold)} onClick={() => !nextHold && go(steps[at + 1]!)}>
            {steps[at + 1] === "review" || step === "basics" ? t("entityCreate.foot.next") : t("entityCreate.foot.nextTo", { step: t(`entityCreate.step.${steps[at + 1] ?? "review"}`) })}
          </Button>
        </>
      )}
    </div>
  );
}
