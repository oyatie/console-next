import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export type Rect = { x: number; y: number; w: number; h: number };
export type View = { zoom: number; x: number; y: number };
/** How much of the viewport the floating bars along the top (crumbs, find) and bottom (zoom, hint) take. */
export type Insets = { top: number; bottom: number; corner?: Rect };
const CLEAR = 8;
/** Floating bars pad content; a corner widget never changes these full-width insets. */
export function barInsets(v: Pick<DOMRect, "top" | "bottom">, top?: Pick<DOMRect, "bottom" | "height">, bottom?: Pick<DOMRect, "top" | "height">): Insets {
  return { top: top?.height ? top.bottom - v.top + CLEAR : 0, bottom: bottom?.height ? v.bottom - bottom.top + CLEAR : 0 };
}
export const ZOOM = { min: 0.4, max: 1.5, step: 0.1 } as const;
/** Controls keep their font size and ≥ 24 px targets when the stage zooms out. */
export const unzoomOf = (zoom: number) => Math.max(1, 1 / zoom);
/** The lowest zoom a first view fits to; a wider chart opens at 100% (D3: type never shrinks to fit). */
const READABLE = 0.8;
const clamp = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));

/** The zoom that shows `w × h` inside the viewport (never above 100%: fitting only ever shrinks). */
export const fitZoom = (vw: number, vh: number, w: number, h: number) => clamp(Math.min(1, vw / w, vh / h));

export function fitView(vp: { w: number; h: number }, size: { w: number; h: number }, i: Insets): View {
  const zoom = fitZoom(vp.w, vp.h - i.top - i.bottom, size.w, size.h);
  return { zoom, x: Math.max(0, (vp.w - size.w * zoom) / 2), y: i.top };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Any part of a stage rect inside the viewport. */
const onScreen = (r: Rect, v: View, vp: { w: number; h: number }) =>
  r.x * v.zoom + v.x < vp.w && (r.x + r.w) * v.zoom + v.x > 0 && r.y * v.zoom + v.y < vp.h && (r.y + r.h) * v.zoom + v.y > 0;

/**
 * The view that shows stage rect `r` inside the viewport between the bars (`i`): unchanged when it already is, else
 * centred there (a box brought from under a bar lands well clear of it, its neighbours with it).
 */
export function revealView(v: View, r: Rect, vp: { w: number; h: number }, i: Insets): View {
  const drawn = { x: r.x * v.zoom + v.x, y: r.y * v.zoom + v.y, w: r.w * v.zoom, h: r.h * v.zoom };
  if (drawn.x >= 0 && drawn.y >= i.top && drawn.x + drawn.w <= vp.w && drawn.y + drawn.h <= vp.h - i.bottom && (!i.corner || !overlaps(drawn, i.corner))) return v;
  const next = { ...v, x: vp.w / 2 - (r.x + r.w / 2) * v.zoom, y: (vp.h - i.bottom + i.top) / 2 - (r.y + r.h / 2) * v.zoom };
  const centred = { ...drawn, x: (vp.w - drawn.w) / 2, y: (vp.h - i.bottom + i.top - drawn.h) / 2 };
  if (i.corner && overlaps(centred, i.corner)) {
    // Prefer the full-height space beside the overview; wide boxes can use the space above it.
    if (drawn.w + CLEAR <= i.corner.x) next.x = (i.corner.x - CLEAR - drawn.w) / 2 - r.x * v.zoom;
    else if (drawn.h + CLEAR <= i.corner.y - i.top) next.y = (i.corner.y - CLEAR + i.top - drawn.h) / 2 - r.y * v.zoom;
  }
  return next;
}

/**
 * The first view of a stage `size` wide in a viewport `vw` wide, its top `top` below the viewport's: it fits the width
 * only (a tall chart pans down, as a page scrolls); fitted below what reads comfortably, it opens at 100% from
 * the start of the chart instead (the keyboard's box is then brought into view).
 */
export function firstView(vw: number, size: { w: number; h: number }, top: number): View {
  const fitted = size.w > vw ? fitZoom(vw, Infinity, size.w, size.h) : 1;
  const zoom = fitted < READABLE ? 1 : fitted;
  return { zoom, x: Math.max(0, (vw - size.w * zoom) / 2), y: top };
}

/**
 * Pan and zoom of a stage of `size` inside `viewport`. The first view is computed before the first paint (layout
 * effect), so nothing jumps when the chart arrives: a readable fit or the chart's start, with smaller charts centred
 * along the top. `insets` measures the floating bars (they wrap on a narrow canvas), so a revealed box
 * lands clear of them; until anything moves the view, the bars settling (a font arriving) lays the first view out
 * again. When the viewport changes size (a side panel opens beside it), the view stays; `keep` (the box the keyboard
 * is on) is brought back only if the new edge cut it off entirely.
 */
export function useView(viewport: RefObject<HTMLElement | null>, size: { w: number; h: number }, resetKey: string, insets: () => Insets, keep?: Rect) {
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: insets().top });
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const first = useRef<string | null>(null);
  /** Bars may settle the first view until an interaction or new tree geometry fixes it in place. */
  const auto = useRef(true);
  const was = useRef(vp);
  const padding = useRef<Insets>({ top: 0, bottom: 0 });
  // Read the viewport itself: a handler may run before the measured size reaches state.
  const dims = () => ({ w: viewport.current?.clientWidth ?? 0, h: viewport.current?.clientHeight ?? 0 });
  const initial = (vw: number): View => firstView(vw, size, insets().top);
  const fit = () => {
    auto.current = false;
    setView(fitView(dims(), size, insets()));
  };

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (first.current !== resetKey && size.w > 0) {
      first.current = resetKey;
      auto.current = true;
      setView(initial(el.clientWidth));
      if (keep) reveal(keep);
    } else auto.current = false;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, resetKey, size.w, size.h]);

  /** Brings a stage rect into view (centred) when any part of it is outside the area between the floating bars. */
  const reveal = (r: Rect) => {
    const { w, h } = dims();
    if (!w) return;
    const i = insets();
    setView((v) => {
      const next = revealView(v, r, { w, h }, i);
      if (next !== v) auto.current = false;
      return next;
    });
  };

  // A new viewport size (a panel opened or closed beside the chart, the window resized): the view stays where it is,
  // so nothing near the pointer jumps (the panel opens a moment after the click that chose a box, and a box moved
  // then is one the next click misses); only the keyboard's box, when the new edge cut it off entirely, is brought back.
  useLayoutEffect(() => {
    const before = was.current;
    was.current = vp;
    if (!before.w || (before.w === vp.w && before.h === vp.h) || !size.w) return;
    auto.current = false;
    if (keep && !onScreen(keep, view, vp)) reveal(keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp.w, vp.h]);

  /** Settling bars lay out an untouched view; a taller receipt keeps the cursor clear without resetting a pan. */
  const relayout = () => {
    const d = dims(), i = insets(), before = padding.current;
    padding.current = i;
    // Only bars settling on the same canvas: a canvas that changed size is the resize effect's (it keeps the view).
    if (!d.w || !size.w || d.w !== was.current.w || d.h !== was.current.h) return;
    if (auto.current) setView(initial(d.w));
    else if (keep && (i.top > before.top || i.bottom > before.bottom)) reveal(keep);
  };
  /** Zooms about the viewport centre. */
  const zoomBy = (d: number) => {
    const { w, h } = dims();
    auto.current = false;
    setView((v) => {
      const zoom = clamp(v.zoom + d);
      return { zoom, x: w / 2 - ((w / 2 - v.x) * zoom) / v.zoom, y: h / 2 - ((h / 2 - v.y) * zoom) / v.zoom };
    });
  };
  const panBy = (dx: number, dy: number) => {
    auto.current = false;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  /** Centres the stage point under the viewport (the minimap's click). */
  const centre = (px: number, py: number) => {
    const { w, h } = dims();
    const i = insets();
    auto.current = false;
    setView((v) => ({ ...v, x: w / 2 - px * v.zoom, y: (h - i.bottom + i.top) / 2 - py * v.zoom }));
  };
  return { view, vp, fit, zoomBy, panBy, reveal, centre, relayout };
}
