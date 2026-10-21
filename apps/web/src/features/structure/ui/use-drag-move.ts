import { useEffect, useRef, useState, type PointerEvent } from "react";
import { collapseSelection, movable, orderVerdicts, reorderedByDrag, verdicts, type Verdict } from "../domain/rules";
import type { ChartNode, Structure } from "../domain/model";

export type DragView = {
  moving: ReadonlySet<string>;
  nodes: ChartNode[];
  verdicts: Map<string, Verdict>;
  /** The box under the pointer. */
  over?: string;
  /** The candidate's siblings: with it, the only boxes marked as targets (D6). */
  siblingsOfOver: ReadonlySet<string>;
  /** Pointer position in client coordinates (the drag ghost follows it). */
  at: { x: number; y: number };
};

const THRESHOLD = 5;

/**
 * Drag a department (or the selected department) onto a new parent (spec S2 *Drag rules*). The drag starts after the pointer
 * moves 5 px, so a click still selects. While dragging, every box carries its verdict; only the candidate under the
 * pointer and its siblings are marked, invalid ones are dimmed and the candidate says why. Esc cancels. The keyboard
 * twin is the move picker (M, SC 2.5.7).
 */
export function useDragMove(s: Structure, sel: ReadonlySet<string>, onDrop: (nodes: ChartNode[], target: ChartNode) => void) {
  const [view, setView] = useState<DragView | null>(null);
  const start = useRef<{ id: string; x: number; y: number; pointer: number } | null>(null);
  const live = useRef<DragView | null>(null);
  const show = (v: DragView | null) => {
    live.current = v;
    setView(v);
  };

  const dragging = view !== null;
  useEffect(() => {
    if (!dragging) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      start.current = null;
      live.current = null;
      setView(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [dragging]);

  const onPointerDown = (e: PointerEvent, id: string) => {
    const n = s.byId.get(id);
    // A department moves to a new parent; a legal entity or a workplace only changes its place among its siblings.
    const site = n && reorderedByDrag(n) ? n : undefined;
    if (e.button !== 0 || !n || (!movable(n) && !site)) return;
    start.current = { id, x: e.clientX, y: e.clientY, pointer: e.pointerId };
    const move = (ev: globalThis.PointerEvent) => {
      const st = start.current;
      if (!st) return;
      if (!live.current && Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < THRESHOLD) return;
      const ids = sel.has(st.id) ? sel : new Set([st.id]);
      const nodes = site ? [site] : collapseSelection(s, ids).top.filter(movable);
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).map((el) => el.closest<HTMLElement>("[data-box][data-id]")).find((el) => el && !nodes.some((m) => m.id === el.dataset.id));
      const over = under?.dataset.id;
      const overNode = over ? s.byId.get(over) : undefined;
      const parent = overNode?.parentId ? s.byId.get(overNode.parentId) : undefined;
      const v = live.current;
      show({
        moving: v?.moving ?? new Set(nodes.map((m) => m.id)),
        nodes: v?.nodes ?? nodes,
        verdicts: v?.verdicts ?? (site ? orderVerdicts(s, site) : verdicts(s, nodes)),
        over,
        siblingsOfOver: new Set(parent?.children.map((c) => c.id) ?? []),
        at: { x: ev.clientX, y: ev.clientY },
      });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const v = live.current;
      start.current = null;
      show(null);
      const target = v?.over ? s.byId.get(v.over) : undefined;
      if (v && target && v.verdicts.get(target.id)?.ok) onDrop(v.nodes, target);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  return { view, onPointerDown, dragging };
}
