import { useState } from "react";
import type { StructureNode } from "@console/api/pending";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ChoiceAdd, ChoiceField } from "../../ui/choice/choice-field";
import { Table } from "../../ui/table";
import { deletePlan } from "../../features/org/domain/structure-plans";
import { DiffPair } from "../../features/org/ui/diff-pair";
import { TargetTree } from "../../features/org/ui/target-tree";
import { placesOf } from "../../reference/org/domain/structure";
import { Facts, Stats } from "../../reference/org/ui/panel-shell";
import { Section } from "../Section";

export const order = 84;

const dept = (id: string, name: string, headcount: number, children: StructureNode[] = []): StructureNode => ({ kind: "DEPARTMENT", id, name, version: 1, headcount, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const site = (id: string, name: string, headcount: number, children: StructureNode[]): StructureNode => ({ kind: "WORKPLACE", id, org_unit_id: `${id}-u`, name, headcount, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const team = dept("d", tg("sample.dept"), 12, [dept("t1", tg("sample.team"), 5), dept("t2", tg("sample.teamLong"), 3)]);
const entity: StructureNode = { kind: "LEGAL_ENTITY", id: "e", name: tg("sample.company"), headcount: 40, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [site("s", tg("sample.site"), 30, [team]), site("s2", `${tg("sample.site")} 2`, 10, [dept("d2", tg("sample.dept"), 10)])] };
const places = placesOf({ tenant_name: tg("sample.company"), phase: "SETUP", entities: [entity], unplaced: [] });

/**
 * The editor's building blocks with sample data: answer chips with nothing preselected (D7), described cards with an
 * impossible option and its reason, a valid-only target tree, a row resolved in place, KPI and fact rows, and the
 * before/after tree with text tags (D16).
 */
export default function Structure() {
  const [ins, setIns] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const plan = deletePlan(places.get("d")!, "raise");
  return (
    <Section title={tg("section.structure")}>
      <ChoiceField
        label={t("workplace.field.insurance")}
        note={t("workplace.create.statutoryNote")}
        required
        look="chips"
        options={(["ALL_ESTABLISHED_NUMBERS_LATER", "ALL_ESTABLISHED_NOW", "JOINT", "NONE_YET"] as const).map((v) => ({ value: v, label: t(`workplace.insurance.${v}`) }))}
        value={ins}
        onChange={setIns}
        add={<ChoiceAdd label={t("workplace.create.kindAdd")} onPress={() => undefined} />}
      />
      <ChoiceField
        label={t("workplace.field.regMode")}
        note={t("workplace.create.regNote")}
        required={false}
        columns={2}
        options={(["NEW", "EXISTING", "UNIT_TAXATION_SUB", "LATER"] as const).map((m) => ({ value: m, label: t(`workplace.regMode.${m}`), disabled: m === "UNIT_TAXATION_SUB" ? t("workplace.create.unitOff", { entity: tg("sample.company") }) : undefined }))}
        value={mode}
        onChange={setMode}
      />
      <TargetTree
        label={t("orgUnit.merge.where")}
        entity={entity}
        show={() => true}
        why={(n) => (n.id === "t1" ? t("orgUnit.merge.self") : n.id === "s" ? t("orgUnit.target.here") : undefined)}
        right={(n) => (n.kind === "DEPARTMENT" ? t("orgStructure.peopleCount", { count: n.headcount }) : "")}
        workplaces={false}
        value={to}
        onChange={setTo}
        hint={t("orgUnit.merge.targetsHint")}
      />
      <Table
        label={t("bulkMove.what")}
        rows={[team, dept("d3", tg("sample.team"), 4)]}
        rowId={(r) => r.id}
        tone={(r) => (r.id === "d3" ? "danger" : undefined)}
        detail={(r) => r.id === "d3" && t("bulkMove.clash", { target: tg("sample.site"), name: tg("sample.team"), n: 5 })}
        columns={[
          { header: t("bulkMove.col.group"), cell: (r) => r.name },
          { header: t("bulkMove.col.members"), cell: (r) => t("orgStructure.peopleCount", { count: r.headcount }), fit: true },
        ]}
      />
      <Stats items={[{ label: t("orgUnit.stat.total"), value: 12 }, { label: t("orgUnit.stat.direct"), value: 4 }, { label: t("orgUnit.stat.sub"), value: 2 }]} />
      <Facts rows={[{ label: t("orgUnit.fact.parent"), value: tg("sample.site") }, { label: t("orgUnit.fact.place"), value: tg("sample.company") }]} />
      <DiffPair before={plan.before} after={plan.after} afterLabel={t("orgUnit.delete.after")} legend={["gone", "raised"]} pending={t("orgUnit.delete.previewPending")} />
    </Section>
  );
}
