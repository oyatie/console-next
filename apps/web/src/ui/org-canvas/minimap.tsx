import { useId, useState, type Ref } from "react";
import { ChevronDown, ChevronUp, Maximize } from "lucide-react";
import { t } from "@console/i18n";
import type { View } from "./use-view";
import s from "./org-canvas.module.css";

/** A box on the minimap: its level picks the edge colour (D5); `hit` fills it (search hits, the selection). */
export type MiniRect = { x: number; y: number; w: number; h: number; level: "tenant" | "entity" | "site" | "dept"; hit?: boolean };

/**
 * The whole chart in miniature (spec D5): surface boxes with level edges on --muted, --primary only for the
 * viewport and hits. A click centres the chart there. Pointer only: the keyboard walks the tree itself, and the
 * fit button beside it is the keyboard's way to the whole picture.
 */
export function Minimap({ ref, userId, size, rects, view, vp, onCentre, onFit }: {
  ref?: Ref<HTMLDivElement>;
  userId?: string;
  size: { w: number; h: number };
  rects: readonly MiniRect[];
  view: View;
  vp: { w: number; h: number };
  onCentre: (x: number, y: number) => void;
  onFit: () => void;
}) {
  const id = useId();
  const key = userId ? `console.orgCanvas.minimap.${userId}` : undefined;
  const [collapsed, setCollapsed] = useState(() => {
    try { return key ? localStorage.getItem(key) === "collapsed" : false; }
    catch { return false; }
  });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { if (key) localStorage.setItem(key, next ? "collapsed" : "expanded"); }
    catch { /* Blocked browser storage leaves the control usable for this visit. */ }
  };
  return (
    <div ref={ref} className={`${s.float} ${s.mini}`} data-collapsed={collapsed || undefined}>
      <div className={s.miniHead}>
        <button type="button" className={`btn btn--ghost ${s.miniToggle}`} aria-label={t(collapsed ? "uiOrgCanvas.expandMinimap" : "uiOrgCanvas.collapseMinimap")} aria-expanded={!collapsed} aria-controls={id} onClick={toggle}>
          {t("uiOrgCanvas.minimap")}{collapsed ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
        <button type="button" className={`btn btn--ghost ${s.miniFit}`} aria-label={t("uiOrgCanvas.fit")} onClick={onFit}><Maximize size={14} aria-hidden /></button>
      </div>
      <svg
        id={id}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
        onClick={(e) => {
          const svg = e.currentTarget;
          const pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const m = svg.getScreenCTM();
          if (!m) return;
          const p = pt.matrixTransform(m.inverse());
          onCentre(p.x, p.y);
        }}
      >
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={4} data-level={r.level} data-hit={r.hit || undefined} />)}
        <rect className={s.vp} x={-view.x / view.zoom} y={-view.y / view.zoom} width={vp.w / view.zoom} height={vp.h / view.zoom} />
      </svg>
    </div>
  );
}
