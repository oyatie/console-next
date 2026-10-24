import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { retirementDate } from "../../people/domain/employment";
import type { StructureNode } from "@console/api/pending";
import type { ClosePlanView } from "../../../reference/close/api";
import { preview, settleBy, type Draft } from "../../../reference/close/domain/plan";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * Before the one confirm: exact counts per destination workplace and per exit reason, the department moved or dissolved, the open
 * exit cases of people still here with their final-settlement deadline (each linked), and what else changes on the closing date.
 */
export function ClosePreview({ view, draft, entity, date, insurance }: { view: ClosePlanView; draft: Draft; entity: StructureNode; date: string; insurance: number }) {
  const p = preview(view, draft, entity);
  const exits = p.exits.CLOSURE + p.exits.INSOLVENCY;
  const named = new Map(view.people.map((x) => [x.employee_id, x.name]));
  return (
    <>
      <section className={css.stack} aria-labelledby="close-preview">
        <h3 id="close-preview" className={css.secH}>{t("workplace.close.preview")}</h3>
        <ul className={css.list}>
          {p.to.map(([name, count]) => <li key={name}>{t("workplace.close.preview.to", { name, count })}</li>)}
          {exits > 0 && <li>{t("workplace.close.preview.exit", { count: exits, closure: p.exits.CLOSURE, insolvency: p.exits.INSOLVENCY })}</li>}
          {p.groups > 0 && <li>{t("workplace.close.preview.group", { count: p.groups })}</li>}
          <li>{t("workplace.close.preview.units", { moved: p.moved, dissolved: p.dissolved })}</li>
        </ul>
        {exits > 0 && <p className={css.note}>{t("workplace.close.exitNote")}</p>}
      </section>
      {view.exit_cases.length > 0 && (
        <section className={css.stack} aria-labelledby="close-cases">
          <h3 id="close-cases" className={css.secH}>{t("workplace.close.openCases", { count: view.exit_cases.length })}</h3>
          <ul className={css.list}>
            {view.exit_cases.map((c) => (
              <li key={c.case_id}>
                <Link to="/people/exits/$id" params={{ id: c.case_id }}>
                  {t("workplace.close.openCase", { name: named.get(c.employee_id) ?? "", date: fmtDate(retirementDate(c.effective_exit_date)), due: fmtDate(settleBy(c.effective_exit_date)) })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={css.stack} aria-labelledby="close-effects">
        <h3 id="close-effects" className={css.secH}>{t("workplace.close.effects")}</h3>
        <ul className={css.list}>
          <li>{t("workplace.close.registration")}</li>
          <li>{t("workplace.close.register", { date })}</li>
          <li>{t("workplace.close.insurance", { count: insurance })}</li>
          <li>{t("workplace.close.chart", { date })}</li>
        </ul>
      </section>
    </>
  );
}
