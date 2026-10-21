import { t } from "@console/i18n";
import type { ChartNode, Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";

/** Create and rename as the outline sends them (one batch each, applied at once in setup). */
export function useStructureGesturesBare(s: Structure, cmd: Commands) {
  return {
    setup: !s.readOnly && s.phase === "SETUP",
    create: (parent: ChartNode, name: string, onDone: () => void) =>
      cmd.apply({
        ops: [{ op: "CREATE", name, ...(parent.kind === "site" ? { workplace_id: parent.id } : { parent_org_unit_id: parent.id }) }],
        message: t("structure.receipt.created", { name }),
        onDone,
      }),
    rename: (n: ChartNode, name: string) =>
      cmd.apply({ ops: [{ op: "RENAME", org_unit_id: n.id, expected_version: n.version ?? 1, name }], message: t("structure.receipt.renamed", { from: n.name, name }) }),
  };
}
