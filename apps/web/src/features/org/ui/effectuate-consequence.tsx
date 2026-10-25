import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { dissolvedName } from "../present";
import { useChangeNames } from "./use-change-names";
import { Muted } from "../../../ui/muted/muted";

type Detail = components["schemas"]["OrgChangeDetail"];

/**
 * What applying does, said before it is done. A dissolution only opens its settlement: the unit closes at
 * archive. A reorganization names the affected people the server computed from its proposal.
 */
export function EffectuateConsequence({ d }: { d: Detail }) {
  const move = d.proposal.find((op) => op.op === "REASSIGN_ORG_UNIT");
  const n = useChangeNames();
  if (d.kind === "DISSOLVE") {
    return <Muted>{t("orgChange.effectuate.dissolve", { code: d.code, name: dissolvedName(d, n) })}</Muted>;
  }
  if (!move) return <Muted>{t("org.change.effectuate.apply", { code: d.code })}</Muted>;
  return (
    <span className="muted">
      {t("org.change.effectuate.reassign", {
        code: d.code,
        from: n.unit(move.fromOrgUnit) ?? "—",
        to: n.unit(move.toOrgUnit) ?? "—",
        count: d.headcount,
      })}
    </span>
  );
}
