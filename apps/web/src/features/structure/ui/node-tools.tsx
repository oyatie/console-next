import { Link } from "@tanstack/react-router";
import type { PointerEvent } from "react";
import { UserPlus } from "lucide-react";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { CanvasToolbar } from "../../../ui/org-canvas/node-actions";
import type { Box, Spot } from "../domain/layout";

/** The toolbar's anchor per spot; CSS shifts it by its own size where the anchor is its far edge. */
const ANCHOR: Record<Spot, (b: Box) => { left: number; top: number }> = {
  above: (b) => ({ left: b.x + b.w, top: b.y }),
  below: (b) => ({ left: b.x + b.w, top: b.y + b.h + 14 }),
  right: (b) => ({ left: b.x + b.w + 8, top: b.y }),
  left: (b) => ({ left: b.x - 8, top: b.y }),
  inside: (b) => ({ left: b.x + b.w - 4, top: b.y }),
};
import { DetailLink } from "./detail-link";
import type { Gestures } from "../present";
import { AddUnit } from "./add-unit";

/**
 * The toolbar prefers a clear outside edge, then keeps the add action on its own corner.
 * The box itself holds the ⋯ menu, including right-click and Shift+F10.
 */
export function NodeTools({ box, spot, g, canEdit, onPointerDown }: {
  box: Box;
  /** A clear outside spot, or the box's own corner (domain/layout toolsSpot). */
  spot: Spot;
  g: Gestures;
  canEdit: boolean;
  onPointerDown: (e: PointerEvent<HTMLDivElement>, id: string) => void;
}) {
  const n = box.node;
  return (
    <CanvasToolbar
      anchor={ANCHOR[spot](box)}
      side={spot}
      label={t("structure.tools.label", { name: n.name })}
      onPointerDown={spot === "inside" ? (e) => onPointerDown(e, n.id) : undefined}
    >
      {canEdit && <AddUnit n={n} onAdd={() => g.add(n)} />}
      {spot !== "inside" && <DetailLink n={n} className={buttonClass("ghost")} />}
      {/* Registering people is the other half of setup (#21): straight from the place they work, prefilled. */}
      {spot !== "inside" && canEdit && (n.kind === "site" || n.kind === "dept") && n.unitId && (
        <Link to="/people/new" search={{ unit: n.unitId }} className={buttonClass("ghost")} aria-label={t("structure.tools.registerLabel", { name: n.name })}>
          <UserPlus size={14} aria-hidden />
          {t("structure.tools.register")}
        </Link>
      )}
    </CanvasToolbar>
  );
}
