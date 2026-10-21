import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { unitsQuery } from "../../../reference/org/api";
import { dissolvedName } from "../present";
import { useChangeNames } from "./use-change-names";
import { Muted } from "../../../ui/muted/muted";

type Detail = components["schemas"]["OrgChangeDetail"];

/**
 * What applying does, said before it is done. A dissolution only opens its settlement: the unit closes at
 * archive. A reorganization that moves a unit's members transfers each of them now and names how many
 * (the unit's live headcount, from a read made on open).
 */
export function EffectuateConsequence({ d }: { d: Detail }) {
  const move = d.proposal.find((op) => op.op === "REASSIGN_ORG_UNIT");
  const units = useQuery({ ...unitsQuery, refetchOnMount: "always", enabled: !!move });
  const n = useChangeNames();
  if (d.kind === "DISSOLVE") {
    return <Muted>{t("orgChange.effectuate.dissolve", { code: d.code, name: dissolvedName(d, n) })}</Muted>;
  }
  if (!move) return <Muted>{t("org.change.effectuate.apply", { code: d.code })}</Muted>;
  return (
    <QueryState q={freshOnOpen(units)}>
      {(u) => (
        <span className="muted">
          {t("org.change.effectuate.reassign", {
            code: d.code,
            from: n.unit(move.fromOrgUnit) ?? "—",
            to: n.unit(move.toOrgUnit) ?? "—",
            count: u.items.find((x) => x.id === move.fromOrgUnit)?.headcount ?? 0,
          })}
        </span>
      )}
    </QueryState>
  );
}
