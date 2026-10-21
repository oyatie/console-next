import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { emptyAnswers, type SiteAnswers } from "../domain/ops";
import { parseOutline } from "../domain/outline";
import { planOutline } from "../domain/plan";
import { BulkLinks } from "../../../reference/org/ui/bulk-links";
import { PlanList } from "./plan-list";
import { SiteCard } from "./site-card";

export const order = 400;

const node = (kind: Node["kind"], id: string, name: string, children: Node[] = []): Node => ({ kind, id, name, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });

/** The paste plan in every row state (linked, new, a clash being renamed, a skipped level) and a new workplace's questions. */
export default function OrgPasteGallery() {
  const entity = node("LEGAL_ENTITY", "E", tg("orgBulk.entity"), [node("WORKPLACE", "W", tg("orgBulk.main"), [node("DEPARTMENT", "D", tg("orgBulk.dept"))])]);
  const rows = planOutline({ kind: "entity", node: entity }, parseOutline(tg("orgBulk.outline")).rows);
  const [answers, setAnswers] = useState<SiteAnswers>(emptyAnswers());
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.orgPaste")}</h2>
      <BulkLinks entity="E" />
      <PlanList rows={rows} names={{}} onRename={() => undefined} rootName={entity.name} levelOffset={0} />
      <SiteCard name={tg("orgBulk.site")} value={answers} onChange={setAnswers} mains={[{ id: "W", name: tg("orgBulk.main") }]} />
    </section>
  );
}
