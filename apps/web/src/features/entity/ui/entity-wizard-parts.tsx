// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { TriangleAlert, X } from "lucide-react";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import type { WizardStep } from "../domain/create";
import { FoundingChoice } from "./create-founding";
import { CertChecklist, NotCollected, OriginalCard } from "./create-cert-aside";
import { NtsPreview } from "./nts-preview";
import { CertForm } from "./create-cert-form";
import { IdOrgForm } from "./create-idorg-form";
import { KindAndName } from "./create-kind-and-name";
import { RegistryForm } from "./create-registry-form";
import { ReviewNextAside, ReviewStep } from "./create-review-step";
import type { CreateState } from "./use-create";
import type { useEntityWizardController } from "./use-entity-wizard";
import s from "./entity-create.module.css";

type WizardController = ReturnType<typeof useEntityWizardController>;

export function WizardCloseLink({ onForget }: { onForget: () => void }) {
  return <Link to="/org/entities" className={buttonClass("ghost", { icon: true })} aria-label={t("entityCreate.close")} onClick={onForget}><X size={16} aria-hidden /></Link>;
}

export function WizardBasicsCard({ c, flat }: { c: CreateState; flat?: boolean }) {
  const inner = (
    <>
      <FoundingChoice c={c} />
      <KindAndName representatives={c.draft.representatives} kind={c.draft.bizKind} onKind={(k) => c.put("bizKind", k)} name={c.draft.name} onName={(n) => c.put("name", n)} clash={c.clash} displayName={c.draft.displayName} onDisplayName={(n) => c.put("displayName", n)} englishName={c.draft.englishName} onEnglishName={(n) => c.put("englishName", n)} />
    </>
  );
  if (!flat) return <div className={s.main}><Card title={t("entityCreate.step.basics")} titleId="basics-title">{inner}</Card></div>;
  return (
    <section className={s.main} aria-labelledby="basics-title">
      <div className={s.cardHead}><h2 id="basics-title" className={s.cardTitle}>{t("entityCreate.step.basics")}</h2></div>
      <div className={s.cardBody}>{inner}</div>
    </section>
  );
}

export function WizardCertMain({ c, onKindChange, flat }: { c: CreateState; onKindChange: () => void; flat?: boolean }) {
  const kind = c.draft.bizKind;
  const corp = kind === "CORPORATION";
  const title = t(kind === "ID_NUMBER_ORG" ? "entityCreate.step.idCert" : kind === "INDIVIDUAL" ? "entityCreate.cert.titleIndividual" : "entityCreate.step.certificate");
  const changeBtn = !corp ? <Button variant="ghost" onClick={onKindChange}>{t("entityCreate.cert.changeKind")}</Button> : null;
  const body = (
    <>
      {corp && (
        <Banner tone="info">
          <div className={s.picked}>
            {t("entityCreate.cert.notice")} <b>{t("entityCreate.cert.picked", { kind: t(`enum.bizKind.${kind}`), name: c.draft.name.trim() })}</b>
            <Button variant="ghost" onClick={onKindChange}>{t("entityCreate.cert.change")}</Button>
          </div>
        </Banner>
      )}
      {kind === "ID_NUMBER_ORG" ? <IdOrgForm c={c} /> : <CertForm c={c} />}
    </>
  );
  if (!flat) return <div className={s.main}><Card title={title} titleId="cert-title" tools={changeBtn}>{body}</Card></div>;
  return (
    <section className={s.main} aria-labelledby="cert-title">
      <div className={s.cardHead}>
        <h2 id="cert-title" className={s.cardTitle}>{title}</h2>
        <span className="grow" />
        {changeBtn}
      </div>
      <div className={s.cardBody}>{body}</div>
    </section>
  );
}

export function WizardCertAside({ c, flat }: { c: CreateState; flat?: boolean }) {
  const kind = c.draft.bizKind;
  const corp = kind === "CORPORATION";
  return (
    <>
      {kind !== "ID_NUMBER_ORG" && <OriginalCard c={c} flat={flat} />}
      {corp ? <CertChecklist c={c} flat={flat} /> : <NotCollected c={c} flat={flat} />}
      {kind !== "ID_NUMBER_ORG" && <NtsPreview c={c} flat={flat} />}
    </>
  );
}

export function WizardRegistryCard({ c, flat }: { c: CreateState; flat?: boolean }) {
  if (!flat) return <div className={s.main}><Card title={t("entityCreate.step.registry")} titleId="registry-title"><RegistryForm c={c} /></Card></div>;
  return (
    <section className={s.main} aria-labelledby="registry-title">
      <div className={s.cardHead}><h2 id="registry-title" className={s.cardTitle}>{t("entityCreate.step.registry")}</h2></div>
      <div className={s.cardBody}><RegistryForm c={c} /></div>
    </section>
  );
}

export function WizardReviewAside({ c, flat }: { c: CreateState; flat?: boolean }) {
  return <ReviewNextAside c={c} flat={flat} />;
}

export function WizardReviewMain({ c, go, flat }: { c: CreateState; go: (s: WizardStep) => void; flat?: boolean }) {
  return <ReviewStep c={c} goTo={go} flat={flat} />;
}

export function WizardConsequence({ w }: { w: WizardController }) {
  return (
    <>
      <output id={w.why} className={w.hold && w.bad.length ? s.footBad : s.footText}>
        {w.hold
          ? <>{w.bad.length > 0 && <TriangleAlert size={14} aria-hidden />} {w.hold}</>
          : w.registrationNote ?? (w.step === "review"
            ? t("entityCreate.foot.review", { name: w.entityName })
            : t(w.c.registers ? "entityCreate.foot.saveFull" : "entityCreate.foot.save", { name: w.entityName }))}
      </output>
      {/* company-04/32: each flagged field is one press away, on whichever step shows it. */}
      {w.bad.map((f) => (
        <Button key={f} variant="ghost" size="sm" onClick={() => w.jump(f)}>{t("entityCreate.foot.goFix", { field: w.fieldName(f) })}</Button>
      ))}
    </>
  );
}

export function WizardActions({ w }: { w: WizardController }) {
  return (
    <>
      {w.at > 0 && <Button onClick={() => w.go(w.steps[w.at - 1]!)}>{t("entityCreate.foot.prev")}</Button>}
      {w.step === "review" ? (
        <>
          {/* company-30: a entity takes nobody until it has a workplace, so creating it with its first one is the primary. */}
          <Button variant="ghost" {...w.off(w.hold)} onClick={() => w.save("record")} disabled={w.c.save.isPending}>{t("entityOps.wizard.createOnly")}</Button>
          <Button variant="primary" {...w.off(w.hold)} onClick={() => w.save("workplace")} disabled={w.c.save.isPending}>{t("entityCreate.foot.createAndWorkplace")}</Button>
        </>
      ) : (
        <>
          {w.step !== "basics" && <Button {...w.off(w.hold)} onClick={() => w.save("record")} disabled={w.c.save.isPending}>{t("entityCreate.foot.saveHere")}</Button>}
          <Button variant="primary" {...w.off(w.nextHold)} onClick={() => !w.nextHold && w.go(w.steps[w.at + 1]!)}>
            {w.steps[w.at + 1] === "review" || w.step === "basics" ? t("entityCreate.foot.next") : t("entityCreate.foot.nextTo", { step: w.stepLabel(w.steps[w.at + 1] ?? "review") })}
          </Button>
        </>
      )}
    </>
  );
}
