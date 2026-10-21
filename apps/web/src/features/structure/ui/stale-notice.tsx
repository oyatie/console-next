import { Link } from "@tanstack/react-router";
import { History, RefreshCw } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { pathTo, type ChartNode, type Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";
import css from "./chart.module.css";

/**
 * A change refused because another person changed the same unit first (spec S11-stale-move): nothing was changed,
 * the chart has been read again, and where the unit is now is said. A refused move is offered again from there (the
 * same picker); otherwise it is left as it is. Who changed it and when are in the change history (the refusal does not
 * carry them).
 */
export function StaleNotice({ s, cmd, onMoveAgain }: { s: Structure; cmd: Commands; onMoveAgain: (nodes: ChartNode[]) => void }) {
  const ops = cmd.failed?.ops ?? [];
  const units = ops.map((o) => ("org_unit_id" in o && o.org_unit_id ? s.byId.get(o.org_unit_id) : undefined)).filter((n): n is ChartNode => !!n);
  const moves = ops.length > 0 && ops.every((o) => o.op === "MOVE") && units.length === ops.length;
  const first = units[0];
  const where = first && pathTo(s, first.id).slice(1, -1).map((n) => n.name).join(" › ");
  return (
    <div className={`${css.stale} card`} role="alert">
      <p className={css.staleTitle}>{t("structure.stale.title")}</p>
      {first && where && <p className={css.staleLine}>{t("structure.stale.where", { name: first.name, where })}</p>}
      <div className={css.staleActions}>
        {moves && <Button variant="primary" onClick={() => (cmd.reset(), onMoveAgain(units))}><RefreshCw size={16} aria-hidden />{t("structure.stale.retry")}</Button>}
        <Button onClick={cmd.reset}>{t("structure.stale.keep")}</Button>
        <Link to="/org/history" className="btn btn--ghost"><History size={16} aria-hidden />{t("structure.stale.history")}</Link>
      </div>
    </div>
  );
}
