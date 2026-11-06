import { useUnitEdit } from "../../../reference/org/ui/use-unit-edit";
import type { InlineUnitValues } from "../../../reference/org/api";
import { t } from "@console/i18n";
import type { ChartNode, Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";

/** Create and rename as the outline sends them (one batch each, applied at once in setup). */
export function useStructureGesturesBare(s: Structure, cmd: Commands) {
  const setup = s.phase === "SETUP";
  const canEdit = useUnitEdit(setup, s.readOnly || cmd.readOnly);
  return {
    setup,
    canEdit,
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
