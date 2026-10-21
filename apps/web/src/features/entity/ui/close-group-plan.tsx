import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { SelectField } from "../../../ui/select/select-field";
import { orgStructureRef } from "../../../reference/entity/api";
import { locate, type GroupPlan } from "../../../reference/close/domain/plan";
import { factsMissing, type GroupFacts } from "../../../reference/group-transfer/domain/facts";
import { ConsentFields, ContinuityFields } from "../../../reference/group-transfer/ui/group-facts";
import { TargetPicker } from "./close-target-picker";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * One person's group transfer in a workplace close (decision #30): the receiving legal entity and its workplace or department, then the
 * person's own consent and what carries over (the same facts a group transfer from the employee card takes), dated the closing `date`.
 * The plan records it with the close; until every fact is there the person stays unplanned.
 */
export function GroupPlanDialog({ name, fromId, date, plan, onPlan, onClose }: {
  name: string;
  /** The sending legal entity (never offered as the receiving one). */
  fromId: string;
  /** The closing date ("" until picked): the group transfer's date. */
  date: string;
  plan: GroupPlan;
  onPlan: (plan: GroupPlan) => void;
  onClose: () => void;
}) {
  const today = todayKst();
  const [tried, setTried] = useState(false);
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const others = roots.filter((e) => e.id !== fromId && !e.chips.includes("closed") && e.children.some((w) => w.kind === "WORKPLACE" && !w.chips.includes("closed")));
  const to = others.find((e) => e.id === plan.entity);
  const set = (patch: Partial<GroupFacts>) => onPlan({ ...plan, facts: { ...plan.facts, ...patch } });
  const open = factsMissing(plan.facts, date);
  const show = (k: keyof typeof open) => tried && open[k];
  const where = t("workplace.close.group.where", { name });
  return (
    <Dialog open title={t("workplace.close.group.title", { name })} onClose={onClose}>
      <div className={css.stack}>
        <SelectField
          label={t("workplace.close.group.entity")}
          placeholder={t(others.length ? "workplace.close.person.pick" : "workplace.close.group.none")}
          options={others.map((e) => ({ id: e.id, label: e.name }))}
          value={plan.entity || null}
          onChange={(entity) => onPlan({ ...plan, entity, to: "", workplaceId: "" })}
          error={tried && !plan.to ? t(others.length ? "workplace.close.group.missing" : "workplace.close.group.none") : undefined}
        />
        {to && (
          <TargetPicker
            entity={to}
            closing=""
            title={where}
            label={where}
            value={plan.to || undefined}
            onPick={(unit) => onPlan({ ...plan, to: unit, workplaceId: locate(to, unit)?.workplace.id ?? "" })}
          />
        )}
        <h4 className={css.secH}>{t("groupTransfer.consent")}</h4>
        <ConsentFields v={plan.facts} set={set} today={today} show={show} />
        <h4 className={css.secH}>{t("groupTransfer.continuity")}</h4>
        <ContinuityFields v={plan.facts} set={set} today={today} show={show} date={date} />
        <div className="form__actions">
          <Button variant="primary" onClick={() => (setTried(true), plan.to && !Object.values(open).some(Boolean) && onClose())}>{t("workplace.close.group.done")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
