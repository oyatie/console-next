import { useLayoutEffect, useRef, type ReactNode } from "react";
import { place } from "./place";
import css from "./node-actions.module.css";

/** Readable actions anchored to a chart box, independent of canvas zoom. */
export function CanvasToolbar({ anchor, label, ready, onSize, children }: { anchor: { left: number; top: number }; label: string; ready: boolean; onSize: (size: { w: number; h: number }) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => onSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSize]);
  return <div ref={el => { ref.current = el; place(anchor)(el); }} className={`${css.tools} card`} data-ready={ready} role="toolbar" aria-label={label} data-tools>{children}</div>;
}

/** A selected box's visible menu, with a readable pointer target. */
export function NodeActions({ children }: { children: ReactNode }) {
  return <div className={css.corner}>{children}</div>;
}
