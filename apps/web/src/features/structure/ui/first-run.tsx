import { Link } from "@tanstack/react-router";
import { MapPin, Network, Plus } from "lucide-react";
import { t } from "@console/i18n";
import css from "./first-run.module.css";

const STEPS = ["entity", "site", "dept", "people"] as const;

// The account is not an entity, so the chart begins at the first legal entity.
export function FirstRun() {
  return (
    <section className={css.canvas} aria-labelledby="first-run-title">
      <div className={css.slot}>
        <div className={css.slotHead}>
          <h2 id="first-run-title" className={css.title}>{t("structure.first.title")}</h2>
          <ol className={css.stepper} aria-label={t("structure.first.stepsLabel")}>
            {STEPS.map((k, i) => (
              <li key={k} aria-current={i === 0 ? "step" : undefined}><span className={css.n}>{i + 1}</span>{t(`structure.first.step.${k}`)}</li>
            ))}
          </ol>
        </div>
        <p className="muted">{t("structure.first.intro")}</p>
        <div className={css.card}>
          <h3>{t("structure.first.oneTitle")}</h3>
          <p className="muted">{t("structure.first.oneBody")}</p>
          <Link to="/org/entities/new" className="btn btn--primary"><Plus size={16} aria-hidden />{t("structure.first.addEntity")}</Link>
        </div>
      </div>
      <div className={css.ghosts} aria-hidden>
        <p className={css.ghost}><MapPin size={14} />{t("structure.first.ghostSite")}</p>
        <p className={css.ghost}><Network size={14} />{t("structure.first.ghostDept")}</p>
      </div>
      <p className={css.caption}>{t("structure.first.caption")}</p>
    </section>
  );
}
