// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { i18n, loadCatalog } from "@console/i18n";
import type { StructureNode } from "@console/api/pending";
import { TargetPicker } from "./close-target-picker";
import "../../../app.css";

await loadCatalog("en");
i18n.set("en");
const node = (id: string, kind: StructureNode["kind"], name: string, children: StructureNode[] = []): StructureNode =>
  ({ id, kind, name, children, headcount: 3, direct_headcount: 3, dispatched_headcount: 0, chips: [] });
const ENTITY = node("entity", "LEGAL_ENTITY", "Hanbit Foods", [
  node("closing", "WORKPLACE", "Busan plant", [node("packing", "DEPARTMENT", "Packing")]),
  node("open", "WORKPLACE", "Seoul office", [node("sales", "DEPARTMENT", "Sales", [node("field", "DEPARTMENT", "Field sales")]), node("support", "DEPARTMENT", "Support")]),
]);

/** The destination picker as the plan step of a workplace close draws it: the plan keeps the pick. */
export function Fixture() {
  const [to, setTo] = useState<string>();
  return (
    <main>
      <TargetPicker entity={ENTITY} closing="closing" title="Where Packing goes" label="Destination of Packing" value={to} onPick={setTo} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
