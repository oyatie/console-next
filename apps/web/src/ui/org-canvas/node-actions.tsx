import type { PointerEvent, ReactNode } from "react";
import { place } from "./place";
import css from "./node-actions.module.css";

/** Readable actions anchored to a chart box, independent of canvas zoom. */
export function CanvasToolbar({ anchor, side, label, onPointerDown, children }: { anchor: { left: number; top: number }; side: "above" | "below" | "left" | "right" | "inside"; label: string; onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void; children: ReactNode }) {
  return <div ref={place(anchor)} className={`${css.tools} card`} data-side={side} role="toolbar" aria-label={label} data-tools onPointerDown={onPointerDown}>{children}</div>;
}

/** A selected box's visible menu, with a readable pointer target. */
export function NodeActions({ children }: { children: ReactNode }) {
  return <div className={css.corner}>{children}</div>;
}
