import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { place } from "../../../ui/org-canvas/place";
import { unzoomOf, type Rect } from "../../../ui/org-canvas/use-view";
import type { Box } from "../domain/layout";
import css from "./chart.module.css";


/**
 * The root header adds one legal entity; bulk entry belongs to the page toolbar.
 */
export function RootActions({ box, zoom, visible }: { box: Box; setup: boolean; zoom: number; visible: Rect }) {
  const top = box.y + box.h - 40;
  const foot = top + 28;
  // The row scales upward from its foot; covered controls return with the header, never as tiny targets.
  if (foot - 28 * unzoomOf(zoom) < visible.y || foot > visible.y + visible.h) return null;
  return (
    <div ref={place({ left: box.x, top })} className={css.rootActions} role="group" aria-label={t("structure.root.label")}>
      <Link to="/org/entities/new" className="btn"><Plus size={14} aria-hidden />{t("structure.tools.addEntity")}</Link>

    </div>
  );
}
