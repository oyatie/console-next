import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import type { StructureNode } from "@console/api/pending";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { NO_SELECTION, type Selection } from "../../../ui/long-table/selection";
import type { ClosePerson, ClosePlanView } from "../../../reference/close/api";
import { canGoWith, planAll, planned, shared, type Draft, type PersonPlan } from "../../../reference/close/domain/plan";
import { PersonPlanField } from "./close-person-plan";

/**
 * Everyone the close must plan for, one row each (#28: virtualised, so 2,000 rows stay fast; `/` finds a name or employee number,
 * J/K move between rows). Each row has its own plan (a group transfer to another legal entity only here, one person at a time);
 * choosing rows sets one plan for all of them. A row with no plan yet says so.
 */
export function PlanPeople({ view, draft, entity, date, onDraft }: { view: ClosePlanView; draft: Draft; entity: StructureNode; date: string; onDraft: (d: Draft) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  const units = useMemo(() => new Map([...view.units.map((u) => [u.org_unit_id, u.name] as const), ...(view.site_org_unit_id ? [[view.site_org_unit_id, t("workplace.close.direct")] as const] : [])]), [view]);
  const rows = q ? view.people.filter((p) => p.name.includes(q) || p.employee_number?.includes(q)) : view.people;
  const left = view.people.filter((p) => !planned(view, draft, p)).length;
  const closing = view.workplace_id;
  const one = (p: ClosePerson, plan: PersonPlan) => onDraft(planAll(draft, [p], plan));
  const columns: LongColumn<ClosePerson>[] = [
    { id: "name", header: t("workplace.close.col.name"), cell: (p) => p.name, rowHeader: true, width: "1fr" },
    { id: "no", header: t("workplace.close.col.number"), cell: (p) => <span className="code">{p.employee_number ?? "—"}</span>, width: 110 },
    { id: "unit", header: t("workplace.close.col.unit"), cell: (p) => (p.org_unit_id && units.get(p.org_unit_id)) || "—", width: "1fr" },
    {
      id: "plan",
      header: t("workplace.close.col.plan"),
      width: "3fr",
      cell: (p) => (
        <span className="row">
          <PersonPlanField
            label={t("workplace.close.unit.planOf", { name: p.name })}
            whereLabel={t("workplace.close.person.whereOf", { name: p.name })}
            plan={draft.people[p.employee_id]}
            canGoWith={canGoWith(view, draft, p)}
            entity={entity}
            closing={closing}
            onPlan={(plan) => one(p, plan)}
            group={{ name: p.name, fromId: view.legal_entity_id, date }}
          />
          {!planned(view, draft, p) && <Chip tone="warn">{t("workplace.close.unplanned")}</Chip>}
        </span>
      ),
    },
  ];
  const chosen = sel.kind === "ids" ? view.people.filter((p) => sel.ids.has(p.employee_id)) : rows.filter((p) => !sel.excluded.has(p.employee_id));
  return (
    <LongTable
      label={t("workplace.close.people", { count: view.people.length })}
      caption={t("workplace.close.peopleCaption", { count: view.people.length, left })}
      columns={columns}
      rows={rows}
      rowId={(p) => p.employee_id}
      total={rows.length}
      hasMore={false}
      onLoadMore={() => {}}
      empty={t("workplace.close.nobody")}
      density="compact"
      find={{ label: t("workplace.close.find"), onFind: (text) => (setQ(text.trim()), setSel(NO_SELECTION)) }}
      rowKeys={{}}
      selection={sel}
      onSelectionChange={setSel}
      countUnit="person"
      selectionActions={
        chosen.length > 0 && (
          <PersonPlanField
            label={t("workplace.close.selected")}
            whereLabel={t("workplace.close.selected")}
            plan={shared(draft, chosen)}
            canGoWith={chosen.every((p) => canGoWith(view, draft, p))}
            entity={entity}
            closing={closing}
            onPlan={(plan) => (onDraft(planAll(draft, chosen, plan)), plan.kind !== "to" && setSel(NO_SELECTION))}
          />
        )
      }
    />
  );
}
