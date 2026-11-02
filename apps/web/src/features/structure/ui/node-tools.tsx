import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { UserPlus } from "lucide-react";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { CanvasToolbar } from "../../../ui/org-canvas/node-actions";
import { toolsSpot, type Box, type Layout } from "../domain/layout";

import { DetailLink } from "./detail-link";
import type { Gestures } from "../present";
import { AddUnit } from "./add-unit";

/** Measured full actions, or just add when space is tight, placed clear of every box. */
export function NodeTools({ box, layout, scale, visible, g, canEdit }: {
  box: Box;
  layout: Layout;
  scale: number;
  visible: Pick<Box, "x" | "y" | "w" | "h">;
  g: Gestures;
  canEdit: boolean;
}) {
  const [sizes, setSizes] = useState<Partial<Record<"full" | "compact", { w: number; h: number }>>>({});
  const full = sizes.full && toolsSpot(layout, box, scale, sizes.full.w * scale, sizes.full.h * scale, visible);
  const compact = !!full && full.overlap > 0;
  const size = sizes[compact ? "compact" : "full"];
  const spot = size && toolsSpot(layout, box, scale, size.w * scale, size.h * scale, visible);
  const measure = useCallback((next: { w: number; h: number }) => {
    const key = compact ? "compact" : "full";
    setSizes(before => before[key]?.w === next.w && before[key]?.h === next.h ? before : { ...before, [key]: next });
  }, [compact]);
  const n = box.node;
  return (
    <CanvasToolbar
      anchor={{ left: spot?.x ?? box.x, top: spot?.y ?? box.y }}
      ready={!!spot}
      onSize={measure}
      label={t("structure.tools.label", { name: n.name })}
    >
      {canEdit && <AddUnit n={n} icon={compact} onAdd={() => g.add(n)} />}
      {!compact && <DetailLink n={n} className={buttonClass("ghost")} />}
      {/* Registering people is the other half of setup (#21): straight from the place they work, prefilled. */}
      {!compact && canEdit && (n.kind === "site" || n.kind === "dept") && n.unitId && (
        <Link to="/people/new" search={{ unit: n.unitId }} className={buttonClass("ghost")} aria-label={t("structure.tools.registerLabel", { name: n.name })}>
          <UserPlus size={14} aria-hidden />
          {t("structure.tools.register")}
        </Link>
      )}
    </CanvasToolbar>
  );
}
