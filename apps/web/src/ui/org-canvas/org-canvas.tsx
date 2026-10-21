import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { Minimap, type MiniRect } from "./minimap";
import { place } from "./place";
import { barInsets, unzoomOf, useView, ZOOM, type Insets, type Rect } from "./use-view";
import s from "./org-canvas.module.css";

export type CanvasHandle = { fit: () => void; reveal: (r: Rect) => void };
/** Before the bars are measured: their single-row height plus the space kept clear of them. */
const BARS: Insets = { top: 56, bottom: 64 };

/**
 * A pan/zoom canvas for a laid-out chart (spec §2 OrgCanvas): connectors in one SVG, boxes as absolutely positioned
 * children of the stage, the zoom bar and the minimap floating in its corners. Panning drags the background (or
 * scrolls); Ctrl/⌘ + wheel zooms. It decides no content: the caller passes the stage's size, its lines and boxes,
 * and `stage` props (the tree role and its keys). `top` floats along the top edge, `gutter` along the bottom (the
 * key hint or a receipt; never over boxes, D18).
 */
export const OrgCanvas = forwardRef<CanvasHandle, {
  size: { w: number; h: number };
  lines: readonly string[];
  /** Line paths drawn in the drop-target style. */
  okLines?: readonly string[];
  children: ReactNode;
  /**
   * Positioned in stage coordinates over the boxes but outside the stage's role (toolbars, inline fields); given the
   * zoom, so what it places can allow for controls scaled back up to their target size.
   */
  layer?: ReactNode | ((zoom: number, visible: Rect) => ReactNode);
  /** Changes when a different chart is shown: its first view is computed again. */
  resetKey: string;
  stage?: HTMLAttributes<HTMLDivElement>;
  /** The stage element, for the caller's focus handling. */
  stageRef?: (el: HTMLDivElement | null) => void;
  top?: ReactNode;
  gutter?: ReactNode;
  /** The stage rect kept clear of the bars when the canvas changes size (the box the keyboard is on). */
  keep?: Rect;
  /** Extra zoom-bar actions (collapse all). */
  tools?: ReactNode;
  minimap?: { rects: readonly MiniRect[]; userId?: string } | false;
  dimmed?: boolean;
  label: string;
}>(function OrgCanvas(p, ref) {
  const viewport = useRef<HTMLDivElement>(null);
  const topBar = useRef<HTMLDivElement>(null);
  const bottomBar = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLDivElement>(null);
  const [padding, setPadding] = useState(BARS);
  // The bars wrap onto a second row on a narrow canvas: what they cover is measured, never assumed.
  const insets = (): Insets => {
    const v = viewport.current?.getBoundingClientRect();
    if (!v) return BARS;
    const top = topBar.current?.getBoundingClientRect();
    const bottom = bottomBar.current?.getBoundingClientRect();
    const corner = mini.current?.getBoundingClientRect();
    return { ...barInsets(v, top, bottom), corner: corner?.height ? { x: corner.left - v.left, y: corner.top - v.top, w: corner.width, h: corner.height } : undefined };
  };
  const { view, vp, fit, zoomBy, panBy, reveal, centre, relayout } = useView(viewport, p.size, p.resetKey, insets, p.keep);
  const bars = useRef(relayout);
  useLayoutEffect(() => {
    bars.current = () => {
      setPadding(insets());
      relayout();
    };
  });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => bars.current());
    for (const el of [topBar.current, bottomBar.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useImperativeHandle(ref, () => ({ fit, reveal }));
  const drag = useRef<{ x: number; y: number } | null>(null);

  return (
    <section ref={place({ "--unzoom": String(unzoomOf(view.zoom)) })} className={s.canvas} aria-label={p.label} data-dimmed={p.dimmed || undefined}>
      <div
        ref={viewport}
        className={s.viewport}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!el.scrollLeft && !el.scrollTop) return;
          // Native focus/scrollIntoView becomes a pan, keeping the minimap and stage coordinates aligned.
          panBy(-el.scrollLeft, -el.scrollTop);
          el.scrollTo(0, 0);
        }}
        onPointerDown={(e) => {
          // Only the background pans: a box, a button or a field keeps its own pointer.
          if (e.button !== 0 || (e.target as HTMLElement).closest("[data-box], button, input, a, [role=menu]")) return;
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          panBy(e.clientX - drag.current.x, e.clientY - drag.current.y);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => void (drag.current = null)}
        onWheel={(e) => (e.ctrlKey || e.metaKey ? zoomBy(e.deltaY < 0 ? ZOOM.step : -ZOOM.step) : panBy(-e.deltaX, -e.deltaY))}
      >
        <div
          {...p.stage}
          ref={(el) => {
            place({ width: p.size.w, height: p.size.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` })(el);
            p.stageRef?.(el);
          }}
          className={s.stage}
        >
          <svg className={s.lines} width={p.size.w} height={p.size.h} aria-hidden>
            {p.lines.map((d, i) => <path key={i} d={d} />)}
            {p.okLines?.map((d, i) => <path key={`ok${i}`} d={d} className={s.ok} />)}
          </svg>
          {p.children}
        </div>
        {p.layer != null && <div ref={place({ width: p.size.w, height: p.size.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` })} className={`${s.stage} ${s.layer}`}>{typeof p.layer === "function" ? p.layer(view.zoom, { x: -view.x / view.zoom, y: (padding.top - view.y) / view.zoom, w: vp.w / view.zoom, h: Math.max(0, vp.h - padding.top - padding.bottom) / view.zoom }) : p.layer}</div>}
      </div>
      {p.top != null && <div ref={topBar} className={s.top}>{p.top}</div>}
      <div ref={bottomBar} className={s.bottom}>
        <div className={`${s.float} ${s.zoom}`} role="group" aria-label={t("uiOrgCanvas.zoom")}>
          <button type="button" className="btn btn--ghost" aria-label={t("uiOrgCanvas.zoomOut")} onClick={() => zoomBy(-ZOOM.step)}><Minus size={16} aria-hidden /></button>
          <span className={s.zoomValue} aria-live="polite">{t("uiOrgCanvas.percent", { n: Math.round(view.zoom * 100) })}</span>
          <button type="button" className="btn btn--ghost" aria-label={t("uiOrgCanvas.zoomIn")} onClick={() => zoomBy(ZOOM.step)}><Plus size={16} aria-hidden /></button>
          <span className={s.vsep} />
          <button type="button" className="btn btn--ghost" onClick={fit}><Maximize size={16} aria-hidden />{t("uiOrgCanvas.fit")}</button>
          {p.tools}
        </div>
        <div className={s.gutter}>{p.gutter}</div>
      </div>
      {/* The overview only earns its corner when the chart does not fit the screen; it floats on its own, so showing it moves nothing. */}
      {p.minimap && (p.size.w * view.zoom > vp.w || p.size.h * view.zoom > vp.h) && <Minimap key={p.minimap.userId} ref={mini} userId={p.minimap.userId} size={p.size} rects={p.minimap.rects} view={view} vp={vp} onCentre={centre} onFit={fit} />}
    </section>
  );
});
