import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ConflictPanel, type Conflict, type ConflictChoice } from "./field-conflict";

export const order = 140;

const EDIT: Conflict[] = [
  { field: "/org_unit", label: tg("col.unit"), base: tg("sample.dept"), mine: tg("sample.team"), current: tg("sample.teamLong"), actor: tg("conflict.actor"), at: tg("conflict.at") },
  { field: "/position", label: tg("col.position"), mine: tg("sample.position"), current: tg("sample.longPosition"), at: tg("conflict.at") },
];
const FACTS: Conflict[] = [
  { field: "/status", label: tg("col.status"), mine: t("enum.employeeStatus.ACTIVE"), current: t("enum.employeeStatus.ON_LEAVE"), actor: tg("conflict.actor"), at: tg("conflict.at") },
];

function Demo({ kind, conflicts, initial = {} }: { kind: "field_conflict" | "stale_facts"; conflicts: Conflict[]; initial?: Record<string, ConflictChoice> }) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>(initial);
  return <ConflictPanel kind={kind} conflicts={conflicts} choices={choices} onChoose={(f, c) => setChoices((x) => ({ ...x, [f]: c }))} />;
}

export default function ConflictGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.conflict")}</h2>
      <Demo kind="field_conflict" conflicts={EDIT} initial={{ "/position": "mine" }} />
      <Demo kind="stale_facts" conflicts={FACTS} />
    </section>
  );
}
