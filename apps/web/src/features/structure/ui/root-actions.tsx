import { getRouteApi, Link } from "@tanstack/react-router";
import { ClipboardPaste, Plus, Upload } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { place } from "../../../ui/org-canvas/place";
import { unzoomOf, type Rect } from "../../../ui/org-canvas/use-view";
import type { Box } from "../domain/layout";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");

/**
 * The root header's own entries (spec S1, S2-chart-scale, D8): one by one and in bulk at the same weight, drawn along
 * the box's foot in the canvas layer. A list pasted during setup goes to the outline beside the chart; once operating,
 * to the paste page (a workplace or a department there is a recorded change).
 */
export function RootActions({ box, setup, zoom, visible }: { box: Box; setup: boolean; zoom: number; visible: Rect }) {
  const navigate = route.useNavigate();
  const top = box.y + box.h - 40;
  const foot = top + 28;
  // The row scales upward from its foot; covered controls return with the header, never as tiny targets.
  if (foot - 28 * unzoomOf(zoom) < visible.y || foot > visible.y + visible.h) return null;
  return (
    <div ref={place({ left: box.x, top })} className={css.rootActions} role="group" aria-label={t("structure.root.label")}>
      <Link to="/org/entities/new" className="btn"><Plus size={14} aria-hidden />{t("structure.tools.addEntity")}</Link>
      {setup ? (
        <Button onClick={() => void navigate({ search: (q) => ({ ...q, view: "outline" }) })}><ClipboardPaste size={14} aria-hidden />{t("structure.setup.paste")}</Button>
      ) : (
        <Link to="/org/paste" className="btn"><ClipboardPaste size={14} aria-hidden />{t("orgBulk.links.paste")}</Link>
      )}
      <Link to="/org/import" className="btn"><Upload size={14} aria-hidden />{t("orgBulk.links.import")}</Link>
    </div>
  );
}
