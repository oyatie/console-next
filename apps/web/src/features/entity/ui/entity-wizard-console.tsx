// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { Muted } from "../../../ui/muted/muted";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { StepLine } from "../../../ui/step-line/step-line";
import { EntityError } from "./entity-error";
import {
  WizardActions,
  WizardBasicsCard,
  WizardCertAside,
  WizardCertMain,
  WizardCloseLink,
  WizardConsequence,
  WizardRegistryCard,
  WizardReviewAside,
  WizardReviewMain,
} from "./entity-wizard-parts";
import { useEntityWizardController } from "./use-entity-wizard";
import s from "./entity-create.module.css";

export function EntityWizardConsole({ kind, name }: { kind?: BizKind; name?: string }) {
  const w = useEntityWizardController(kind, name);
  const steps = w.steps.map((x, i) => ({
    key: x,
    label: w.stepLabel(x),
    state: (i < w.at ? "done" : i === w.at ? "current" : "waiting") as "done" | "current" | "waiting",
  }));
  const body = (
    w.step === "basics" ? <WizardBasicsCard c={w.c} flat /> :
    w.step === "certificate" ? <WizardCertMain c={w.c} onKindChange={() => w.go("basics")} flat /> :
    w.step === "registry" ? <WizardRegistryCard c={w.c} flat /> :
    <WizardReviewMain c={w.c} go={w.go} flat />
  );
  const aside = (
    w.step === "certificate" ? <div className={s.aside}><WizardCertAside c={w.c} flat /></div> :
    w.step === "review" ? <WizardReviewAside c={w.c} flat /> :
    undefined
  );
  const asideLabel = (
    w.step === "certificate" ? t("entityCreate.original.title") :
    w.step === "review" ? t("entityCreate.review.next") :
    undefined
  );
  return (
    <WizardPattern
      q={w.c.q}
      head={{
        title: t("entityCreate.title"),
        crumbs: <Crumbs items={[<Link key="org" to="/org">{t("entityCreate.crumbRoot")}</Link>]} current={t("entityCreate.title")} />,
        actions: (
          <>
            <Muted>{t("entityCreate.context", { n: w.c.ordinal })}</Muted>
            <WizardCloseLink onForget={w.c.forget} />
          </>
        ),
      }}
      steps={<StepLine steps={steps} label={t("entityCreate.steps")} />}
      body={body}
      aside={aside}
      asideLabel={asideLabel}
      notice={<EntityError error={w.c.save.error} />}
      consequence={<WizardConsequence w={w} />}
      actions={<WizardActions w={w} />}
    />
  );
}
