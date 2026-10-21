import { useState } from "react";
import { t } from "@console/i18n";
import type { StructureNode } from "@console/api/pending";
import { Button } from "../../../ui/button/button";
import { SelectField } from "../../../ui/select/select-field";
import type { ExitReason, GroupPlan, PersonPlan } from "../../../reference/close/domain/plan";
import { EMPTY_FACTS } from "../../../reference/group-transfer/domain/facts";
import { GroupPlanDialog } from "./close-group-plan";
import { TargetPicker } from "./close-target-picker";

const valueOf = (p: PersonPlan | undefined) => (!p ? "" : p.kind === "exit" ? `exit:${p.reason}` : p.kind);

/** What a group transfer line needs from the row: whose it is, the sending legal entity and the closing date. */
type GroupContext = { name: string; fromId: string; date: string };

/**
 * One person's plan (or one plan for many: a department's "all", a selection): with their department (only while it moves),
 * transfer with its destination, exit with its reason, or (one person at a time, since each consents for themself) a group transfer
 * to another legal entity with its facts in a dialog. The canonical SelectField (move-29), option-first: no free text, and nothing
 * is preselected.
 */
export function PersonPlanField({ label, whereLabel, plan, canGoWith, entity, closing, onPlan, group }: {
  label: string;
  whereLabel: string;
  plan: PersonPlan | undefined;
  canGoWith: boolean;
  entity: StructureNode;
  closing: string;
  onPlan: (p: PersonPlan) => void;
  /** Present for a single person: a group transfer is offered. */
  group?: GroupContext;
}) {
  const [editing, setEditing] = useState(false);
  const blank: GroupPlan = { kind: "group", entity: "", to: "", workplaceId: "", facts: EMPTY_FACTS };
  const choose = (v: string) => {
    if (v === "with") onPlan({ kind: "with" });
    else if (v === "to") onPlan({ kind: "to", to: plan?.kind === "to" ? plan.to : "" });
    else if (v === "group") {
      onPlan(plan?.kind === "group" ? plan : blank);
      setEditing(true);
    }
    else if (v.startsWith("exit:")) onPlan({ kind: "exit", reason: v.slice(5) as ExitReason });
  };
  return (
    <span className="row">
      <SelectField
        label={label}
        hideLabel
        placeholder={t("workplace.close.person.pick")}
        options={[
          ...(canGoWith ? [{ id: "with", label: t("workplace.close.person.with") }] : []),
          { id: "to", label: t("workplace.close.person.to") },
          { id: "exit:CLOSURE", label: t("workplace.close.person.exitClosure") },
          { id: "exit:INSOLVENCY", label: t("workplace.close.person.exitInsolvency") },
          ...(group ? [{ id: "group", label: t("workplace.close.person.group") }] : []),
        ]}
        value={(plan?.kind === "with" && !canGoWith ? "" : valueOf(plan)) || null}
        onChange={choose}
      />
      {plan?.kind === "to" && (
        <TargetPicker entity={entity} closing={closing} title={whereLabel} label={whereLabel} value={plan.to || undefined} onPick={(to) => onPlan({ kind: "to", to })} />
      )}
      {plan?.kind === "group" && group && (
        <>
          <Button size="sm" aria-label={t("workplace.close.group.title", { name: group.name })} onClick={() => setEditing(true)}>{t("workplace.close.group.edit")}</Button>
          {editing && <GroupPlanDialog {...group} plan={plan} onPlan={onPlan} onClose={() => setEditing(false)} />}
        </>
      )}
    </span>
  );
}
