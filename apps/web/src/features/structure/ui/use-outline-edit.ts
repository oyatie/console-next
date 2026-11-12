import { useNavigate } from "@tanstack/react-router";
import { useUnitEdit } from "../../../reference/org/ui/use-unit-edit";
import type { InlineUnitValues } from "../../../reference/org/api";
import { t } from "@console/i18n";
import type { ChartNode, Structure } from "../domain/model";
import { parentOf, placeAfter, reorderedByDrag, transfers } from "../domain/rules";
import { moveEffect } from "../present";
import type { Commands } from "./use-structure-commands";

const pin = (n: ChartNode) => ({ org_unit_id: n.id, expected_version: n.version ?? 1 });

/** Create, rename and move as the tree views send them (one batch each, applied at once in setup). */
export function useStructureGesturesBare(s: Structure, cmd: Commands) {
  const navigate = useNavigate();
  const setup = s.phase === "SETUP";
  const readOnly = s.readOnly || cmd.readOnly;
  const canEdit = useUnitEdit(setup, readOnly);
  return {
    setup,
    canEdit,
    /**
     * A drop, or a place picked with the keyboard. A legal entity or a workplace only changes its order (at once in
     * either phase): it lands right after the sibling it is dropped on. A department moves at once in setup; after
     * go-live the move page asks for the date and reason.
     */
    moveTo: (nodes: ChartNode[], target: ChartNode) => {
      const first = nodes[0];
      if (readOnly || !first) return;
      if (reorderedByDrag(first)) {
        const body = placeAfter(s, first, target);
        return body && cmd.order(body, t("structureChart.drop.siteDone", { name: first.name, target: target.name }));
      }
      if (!setup) return void navigate({ to: "/org/move", search: { ids: first.id } });
      const moved = nodes.reduce((k, n) => k + transfers(n, target), 0);
      const name = nodes.length === 1 ? first.name : t("structure.move.many", { count: nodes.length });
      const sub = nodes.reduce((k, n) => k + n.children.length, 0);
      // Each moved unit says where it came from until the receipt goes (S2-chart-moved).
      const from = new Map(nodes.map((n) => [n.id, (n.parentId && s.byId.get(n.parentId)?.name) || ""]));
      cmd.apply({ ops: nodes.map((n) => ({ op: "MOVE", ...pin(n), ...parentOf(target) })), message: t("structure.receipt.moved", { name, target: target.name, sub, moved }), moved: from });
    },
    /** What dropping `nodes` on `overId` does, in one sentence. */
    effect: (nodes: ChartNode[], overId: string) => {
      const target = s.byId.get(overId);
      if (target && nodes[0] && reorderedByDrag(nodes[0])) return t(nodes[0].kind === "entity" ? "structureChart.drop.entityAfter" : "structureChart.drop.siteAfter", { name: nodes[0].name, target: target.name });
      return target ? moveEffect(nodes, target) : "";
    },
    create: (parent: ChartNode, name: string, values: InlineUnitValues, onDone: () => void) =>
      !canEdit ? undefined : setup
        ? cmd.apply({ ops: [{ op: "CREATE", name, ...(parent.kind === "site" ? { workplace_id: parent.id } : { parent_org_unit_id: parent.id }) }], message: t("structure.receipt.created", { name }), onDone: () => onDone() })
        : cmd.propose({ kind: "create", parentUnitId: parent.unitId ?? parent.id, name, ...values, onDone: () => onDone() }),
    rename: (n: ChartNode, name: string, values: InlineUnitValues, onDone?: () => void) =>
      !canEdit ? undefined : setup
        ? cmd.apply({ ops: [{ op: "RENAME", org_unit_id: n.id, expected_version: n.version ?? 1, name }], message: t("structure.receipt.renamed", { from: n.name, name }), onDone: () => onDone?.() })
        : cmd.propose({ kind: "rename", orgUnitId: n.id, fromName: n.name, name, ...values, onDone }),
  };
}
