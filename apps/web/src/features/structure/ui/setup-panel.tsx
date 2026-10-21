import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ClipboardPaste, Eye, Upload } from "lucide-react";
import type { ChecklistStep } from "@console/api/pending";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { checklistRef } from "../api";
import type { Structure } from "../domain/model";
import css from "./setup-panel.module.css";

const route = getRouteApi("/app/org");

/**
 * The setup panel beside the chart (spec S1 setup progress, S10 getting started): the server's steps in order (numbered,
 * done, or with something to look at), the counts the structure serves, the go-live preview, and the bulk entries at
 * the same weight as one-by-one (D8). It decides nothing: each step's state and remedy are the server's.
 */
export function SetupPanel({ s, first, fixLink }: { s: Structure; first?: boolean; fixLink: (code: string) => ReactNode }) {
  const q = useQuery(checklistRef);
  const navigate = route.useNavigate();
  const steps = q.data?.steps ?? [];
  const done = steps.filter((x) => x.state === "done" || x.state === "attention").length;
  const current = steps.find((x) => x.state !== "done" && x.state !== "attention")?.key;
  const mark = (x: ChecklistStep, i: number) =>
    x.state === "done" ? <Check size={16} aria-hidden className={css.ok} />
    : x.state === "attention" || x.state === "blocked" ? <AlertTriangle size={16} aria-hidden className={css.warn} />
    : <span className={css.n} aria-hidden>{i + 1}</span>;
  return (
    <aside className={css.panel} aria-labelledby="setup-panel-title">
      <div className={css.head}>
        <h2 id="setup-panel-title" className="panel__title">{t(first ? "structure.setup.firstTitle" : "structure.setup.title")}</h2>
        <span className="chip chip--ok">{t("structure.phase.setupChip")}</span>
      </div>
      <progress className={css.bar} max={steps.length || 1} value={done} aria-label={t("structure.setup.progress", { done, total: steps.length })} />
      <p className={css.summary}>{t("structure.setup.progress", { done, total: steps.length })} · {t("structure.setup.summary")}</p>
      {!first && (
        <dl className={css.kpis}>
          {([["people", s.root.headcount], ["entities", s.counts.entities], ["sites", s.counts.sites], ["depts", s.counts.depts]] as const).map(([k, v]) => (
            <div key={k} className={css.kpi}><dt>{t(`structure.setup.kpi.${k}`)}</dt><dd className="num">{v.toLocaleString()}</dd></div>
          ))}
        </dl>
      )}
      <ol className={css.steps}>
        {steps.map((x, i) => (
          <li key={x.key} className={css.step} data-state={x.state} aria-current={x.key === current ? "step" : undefined}>
            {mark(x, i)}
            <span className={css.title}>
              {codeText(`setup.step.${x.key}`, x.key)}
              <span className="sr-only">{t(`uiSetupRail.state.${x.state}`)}</span>
            </span>
            <span className={css.detail}>{x.remedy ? codeText(`setup.remedy.${x.remedy}`, x.remedy, { count: x.count ?? 0 }) : x.key === "roles" ? t("setup.roles.prepared") : codeText(`structure.setup.stepHint.${x.key}`, x.key)}</span>
            {x.state !== "done" && x.remedy && <span className={css.fix}>{fixLink(x.remedy)}</span>}
          </li>
        ))}
      </ol>
      {first ? (
        <p className={css.tip}>{t("structure.setup.tip")}</p>
      ) : (
        <Link to="/setup/go-live" className={`btn btn--primary ${css.golive}`}><Eye size={16} aria-hidden />{t("structure.setup.golive")}</Link>
      )}
      <h3 className={css.bulkTitle}>{t("structure.setup.bulk")}</h3>
      <div className={css.bulk}>
        <Button onClick={() => void navigate({ search: (p) => ({ ...p, view: "outline" }) })}><ClipboardPaste size={16} aria-hidden />{t("structure.setup.paste")}</Button>
        <Link to="/people/import" className="btn"><Upload size={16} aria-hidden />{t("structure.setup.roster")}</Link>
      </div>
    </aside>
  );
}
