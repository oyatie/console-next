import { Link } from "@tanstack/react-router";
import { MapPin, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { OrgNode } from "../../../ui/org-canvas/org-node";
import type { Box } from "../domain/layout";
import css from "./chart.module.css";

/**
 * A legal entity with no workplace yet (spec S10-first-entity): its add sheet drawn where the workplace will appear.
 */
export function SiteSlot({ box }: { box: Box }) {
  return (
    <OrgNode level="site" box={box} states={["ghost"]} className={css.slot}>
      <MapPin size={18} aria-hidden className={css.slotIcon} />
      <b className={css.slotTitle}>{t("structure.slot.firstSite")}</b>
      <span className={css.slotText}>{t("structure.slot.what", { name: box.node.name })}</span>
      <span className={css.slotActions}>
        <Link to="/org/entities/$id/workplaces/new" params={{ id: box.node.id }} className="btn btn--primary">
          <Plus size={14} aria-hidden />
          {t("structure.slot.addSite")}
        </Link>
      </span>
    </OrgNode>
  );
}
