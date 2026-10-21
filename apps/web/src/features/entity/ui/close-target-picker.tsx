import { useState } from "react";
import { t } from "@console/i18n";
import type { StructureNode } from "@console/api/pending";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { TreeView } from "../../../ui/tree/tree";
import { locate } from "../../../reference/close/domain/plan";

/**
 * Where people or a department go when their workplace closes: the legal entity's open workplaces and their departments in the
 * canonical tree (typeahead searches it), in a dialog. The closing workplace and its departments stay listed, disabled, with
 * why. A workplace itself can be chosen (its own unit: people with no department there). The pick is an org unit id.
 * features/org's TargetTree cannot be imported from here (check-source: features never import features); switch to it
 * once it lives in reference/org/ui (ORGCHANGE ask).
 */
export function TargetPicker({ entity, closing, title, label, value, onPick }: {
  entity: StructureNode;
  /** The workplace that closes (its id). */
  closing: string;
  title: string;
  /** The button's accessible name (whose destination it sets). */
  label: string;
  value?: string;
  onPick: (unit: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const at = value ? locate(entity, value) : undefined;
  const shown = at ? (at.node === at.workplace ? at.workplace.name : `${at.workplace.name} › ${at.node.name}`) : t("workplace.close.target.choose");
  const sites = entity.children.filter((w) => w.kind === "WORKPLACE" && !w.chips.includes("closed"));
  const kids = (n: StructureNode) => (n.kind === "LEGAL_ENTITY" ? sites : n.children.filter((c) => c.kind === "DEPARTMENT"));
  const all = [entity, ...sites.flatMap(function walk(n: StructureNode): StructureNode[] { return [n, ...kids(n).flatMap(walk)]; })];
  const [expanded, setExpanded] = useState(() => new Set(all.map((n) => n.id)));
  // company-26: the closing workplace says so; a department under it is named as one (it was labelled a workplace).
  const why = (n: StructureNode) => (n.id === closing ? t("workplace.close.target.closing") : locate(entity, n.id)?.workplace.id === closing ? t("workplace.close.target.closingDept") : undefined);
  const disabled = new Set(all.filter((n) => n.kind === "LEGAL_ENTITY" || why(n)).map((n) => n.id));
  const right = (n: StructureNode) => why(n) ?? t("orgStructure.peopleCount", { count: n.headcount });
  const pick = (id: string) => {
    const node = locate(entity, id)?.node;
    onPick(node?.kind === "WORKPLACE" ? (node.org_unit_id ?? id) : id);
    setOpen(false);
  };
  return (
    <>
      <Button size="sm" aria-label={label} onClick={() => setOpen(true)}>{shown}</Button>
      {open && (
        <Dialog open title={title} onClose={() => setOpen(false)}>
          <TreeView
            label={title}
            roots={[entity]}
            childrenOf={kids}
            textValue={(n) => [n.name, n.kind === "LEGAL_ENTITY" ? "" : right(n)].filter(Boolean).join(" ")}
            row={(n) => (
              <span className="row" aria-current={at?.node.id === n.id || undefined}>
                <span>{n.name}</span>
                {n.kind !== "LEGAL_ENTITY" && <span>{right(n)}</span>}
              </span>
            )}
            selected={at?.node.id}
            onSelect={(id) => id && !disabled.has(id) && pick(id)}
            expanded={expanded}
            onExpandedChange={setExpanded}
            disabled={disabled}
          />
          <div className="form__actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("orgStructure.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
