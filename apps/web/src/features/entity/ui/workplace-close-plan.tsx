import { t } from "@console/i18n";
import type { StructureNode } from "@console/api/pending";
import { Button } from "../../../ui/button/button";
import { SelectField } from "../../../ui/select/select-field";
import type { ClosePlanView } from "../../../reference/close/api";
import { allTo, canGoWith, groups, planAll, planUnit, shared, type Draft } from "../../../reference/close/domain/plan";
import { PersonPlanField } from "./close-person-plan";
import { TargetPicker } from "./close-target-picker";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * The department half of a close plan (S5-close, UX-R2 ENDS): one press per other open workplace fills the whole plan
 * ("everyone to the head office"), then each department directly under the closing workplace is moved under another workplace or dissolved, and
 * "all n" sets one plan for everyone in it (people placed with no department are their own group). Each person can then be
 * changed one by one in the table below.
 */
export function ClosePlan({ view, draft, entity, onDraft }: { view: ClosePlanView; draft: Draft; entity: StructureNode; onDraft: (d: Draft) => void }) {
  const closing = view.workplace_id;
  const sites = entity.children.filter((w) => w.kind === "WORKPLACE" && w.id !== closing && !w.chips.includes("closed") && w.org_unit_id);
  if (view.people.length === 0 && view.units.length === 0) return <p className={css.note}>{t("workplace.close.nobody")}</p>;
  return (
    <section className={css.stack} aria-labelledby="close-units">
      {sites.length > 0 ? (
        <div className={css.stack}>
          <span className="row">
            {sites.map((w) => <Button key={w.id} size="sm" onClick={() => onDraft(allTo(view, w.org_unit_id!))}>{t("workplace.close.allTo", { name: w.name })}</Button>)}
          </span>
        </div>
      ) : (
        <p className={css.footWarn}>{t("workplace.close.noTarget")}</p>
      )}
      <h3 id="close-units" className={css.secH}>{t("workplace.close.units", { count: groups(view).filter((g) => g.unit).length })}</h3>
      <ul className={css.list}>
        {groups(view).map((g) => {
          const name = g.unit?.name ?? t("workplace.close.direct");
          const plan = g.unit ? draft.units[g.unit.org_unit_id] : undefined;
          const first = g.people[0];
          return (
            <li key={g.unit?.org_unit_id ?? "direct"}>
              <b>{name}</b>
              <Muted>{t("orgStructure.peopleCount", { count: g.people.length })}</Muted>
              {g.unit && (
                <SelectField
                  label={t("workplace.close.unit.planOf", { name })}
                  hideLabel
                  placeholder={t("workplace.close.person.pick")}
                  options={[{ id: "move", label: t("workplace.close.unit.move") }, { id: "dissolve", label: t("workplace.close.unit.dissolve") }]}
                  value={plan?.kind ?? null}
                  onChange={(v) => onDraft(planUnit(view, draft, g.unit!.org_unit_id, v === "move" ? { kind: "move", to: plan?.kind === "move" ? plan.to : "" } : { kind: "dissolve" }))}
                />
              )}
              {plan?.kind === "move" && (
                <TargetPicker entity={entity} closing={closing} title={t("workplace.close.person.whereOf", { name })} label={t("workplace.close.person.whereOf", { name })} value={plan.to || undefined} onPick={(to) => onDraft(planUnit(view, draft, g.unit!.org_unit_id, { kind: "move", to }))} />
              )}
              {first && (
                <span className={css.right}>
                  <PersonPlanField
                    label={t("workplace.close.unit.allOf", { name, count: g.people.length })}
                    whereLabel={t("workplace.close.unit.allOf", { name, count: g.people.length })}
                    plan={shared(draft, g.people)}
                    canGoWith={canGoWith(view, draft, first)}
                    entity={entity}
                    closing={closing}
                    onPlan={(p) => onDraft(planAll(draft, g.people, p))}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
