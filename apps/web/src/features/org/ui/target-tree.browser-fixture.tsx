// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { i18n, loadCatalog, t } from "@console/i18n";
import type { Node } from "../../../reference/org/domain/structure";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Sheet } from "../../../ui/sheet/sheet";
import { TargetTree } from "./target-tree";
import "../../../app.css";

await loadCatalog("en");
i18n.set("en");
const node = (id: string, kind: Node["kind"], name: string, children: Node[] = []): Node =>
  ({ id, kind, name, children, headcount: 3, direct_headcount: 3, dispatched_headcount: 0, chips: [] });
const ENTITY = node("entity", "LEGAL_ENTITY", "Hanbit Foods", [
  node("seoul", "WORKPLACE", "Seoul office", [node("sales", "DEPARTMENT", "Sales", [node("field", "DEPARTMENT", "Field sales")]), node("support", "DEPARTMENT", "Support")]),
  node("busan", "WORKPLACE", "Busan plant", [node("packing", "DEPARTMENT", "Packing")]),
]);
const people = (n: Node) => (n.kind === "DEPARTMENT" ? t("orgStructure.peopleCount", { count: n.headcount }) : "");

/**
 * The target tree in its two homes. `?in=sheet` is the merge sheet: the pick is kept and shown as chosen (`dirty=1`
 * marks the sheet as holding unsaved input). `?in=dialog` is the add-departments dialog of a bulk move: nothing is
 * ever shown as chosen, and a pick closes it. Workplaces cannot be chosen in either.
 */
export function Fixture() {
  const query = new URLSearchParams(location.search);
  const [open, setOpen] = useState(true);
  const [to, setTo] = useState<string | null>(null);
  const close = () => setOpen(false);
  const cancel = <Button variant="ghost" onClick={close}>Cancel</Button>;
  return (
    <main>
      <p>Target tree fixture</p>
      {query.get("in") === "sheet" ? (
        <Sheet open={open} size="lg" title="Merge Packing" onClose={close} consequence="Nothing is sent." actions={cancel} {...(query.has("dirty") ? { dirty: true } : {})}>
          <TargetTree label="Merge into" entity={ENTITY} show={() => true} why={(n) => (n.id === "packing" ? "This department" : undefined)} right={people} workplaces={false} value={to} onChange={setTo} />
        </Sheet>
      ) : (
        <Dialog open={open} title="Add departments" onClose={close}>
          <TargetTree label="Add departments" entity={ENTITY} show={() => true} why={() => undefined} right={people} workplaces={false} value={null} onChange={(id) => { close(); setTo(id); }} />
        </Dialog>
      )}
      <output id="open">{open ? "open" : "closed"}</output>
      <output id="to">{to ?? "none"}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
