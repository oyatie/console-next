// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Check, ChevronRight, Network } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Muted } from "../../../ui/muted/muted";
import { EntityError } from "./entity-error";
import {
  WizardActions,
  WizardBasicsCard,
  WizardCertAside,
  WizardCertMain,
  WizardCloseLink,
  WizardConsequence,
  WizardRegistryCard,
  WizardReviewMain,
} from "./entity-wizard-parts";
import { useEntityWizardController } from "./use-entity-wizard";
import s from "./entity-create.module.css";

/**
 * add entity as a full page (spec S4, D9): basics -> certificate -> (corporations) registry -> review, with the certificate
 * typed beside its kept original. Any step can save what is there ("save so far"); only a value that cannot be
 * right holds the save and the next step back, and the foot names those fields.
 */
export function EntityWizardBaseline({ kind, name, title }: { kind?: BizKind; name?: string; title: ReactNode }) {
  const w = useEntityWizardController(kind, name);
  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <nav className={s.crumb} aria-label={t("entityCreate.crumb")}>
            <Network size={14} aria-hidden /><Link to="/org">{t("entityCreate.crumbRoot")}</Link><ChevronRight size={14} aria-hidden /><bdi>{t("entityCreate.title")}</bdi>
          </nav>
          {title}
        </div>
        <span className={s.vsep} aria-hidden />
        <ol className={s.steps} aria-label={t("entityCreate.steps")}>
          {w.steps.map((x, i) => (
            <li key={x} data-st={i < w.at ? "done" : i === w.at ? "cur" : undefined} aria-current={i === w.at ? "step" : undefined}>
              <div className={s.n} aria-hidden>{i < w.at ? <Check size={12} /> : i + 1}</div>
              {w.stepLabel(x)}
            </li>
          ))}
        </ol>
        <span className="grow" />
        <Muted>{t("entityCreate.context", { n: w.c.ordinal })}</Muted>
        <WizardCloseLink onForget={w.c.forget} />
      </div>
      <QueryState q={w.c.q} layout="form">{() => <>
        <div className={s.body}>
          {w.step === "basics" && <WizardBasicsCard c={w.c} />}
          {w.step === "certificate" && (
            <>
              <WizardCertMain c={w.c} onKindChange={() => w.go("basics")} />
              <aside className={s.aside}>
                <WizardCertAside c={w.c} />
              </aside>
            </>
          )}
          {w.step === "registry" && <WizardRegistryCard c={w.c} />}
          {w.step === "review" && <WizardReviewMain c={w.c} go={w.go} />}
        </div>
        <div className={s.foot}>
          <EntityError error={w.c.save.error} />
          <WizardConsequence w={w} />
          <span className="grow" />
          <WizardActions w={w} />
        </div>
      </>}</QueryState>
    </div>
  );
}
