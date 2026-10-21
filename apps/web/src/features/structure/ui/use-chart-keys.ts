import type { KeyboardEvent } from "react";
import type { ChartNode } from "../domain/model";
import type { ChartState } from "./use-chart-state";
import type { Gestures } from "../present";

/**
 * The chart's keys (spec S1/S2, D14, D15), live only while focus is on a box: never in an input, never page-wide.
 * Arrows walk the drawn tree; Space previews (opens) a collapsed box; Ctrl+Space, Shift+↑↓ and Ctrl+A select (APG
 * multi-select tree); A, F2, M, Del and F are the box verbs; / jumps to find; Shift+F10 opens the ⋯ menu.
 */
export function useChartKeys(c: ChartState, g: Gestures & { open: (n: ChartNode) => void; menu: (n: ChartNode) => void; find: () => void }) {
  return (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, [role=menu], [data-tools]")) return;
    const n = c.order.find((x) => x.id === c.cursor);
    if (!n) return;
    const at = c.order.indexOf(n);
    // A focus moved by the keyboard: the selection bar names it and shows the keys.
    const go = (x?: ChartNode) => x && (c.setByKeys(true), c.setCursor(x.id));
    const parent = n.parentId ? c.order.find((x) => x.id === n.parentId) : undefined;
    const open = c.expanded.has(n.id) || n.id === c.focus.id;
    const ctrl = e.ctrlKey || e.metaKey;
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        // Alt+↑↓ moves the box one place among its siblings (reorder); the focus stays on it.
        if (e.altKey) {
          g.order?.(n, e.key === "ArrowUp" ? -1 : 1)?.();
          return handled();
        }
        const next = c.order[at + (e.key === "ArrowDown" ? 1 : -1)];
        if (e.shiftKey && next) c.select(next.id, "extend", true);
        go(next);
        return handled();
      }
      case "ArrowRight":
        if (n.children.length && !open) c.toggle(n.id, true);
        else go(c.order.find((x) => x.parentId === n.id));
        return handled();
      case "ArrowLeft":
        if (open && n.id !== c.focus.id && n.children.length) c.toggle(n.id, false);
        else go(parent);
        return handled();
      case "Home": return (go(c.order[0]), handled());
      case "End": return (go(c.order[c.order.length - 1]), handled());
      case "Enter": return (g.open(n), handled());
      case " ":
        if (ctrl) c.select(n.id, "toggle", true);
        else if (n.children.length && n.id !== c.focus.id) c.toggle(n.id);
        return handled();
      case "Escape": return c.clear();
      case "F2": return (g.rename(n), handled());
      case "Delete":
      case "Backspace": return (g.remove(n), handled());
      case "F10":
        if (!e.shiftKey) return;
        g.menu(n);
        return handled();
      case "ContextMenu": return (g.menu(n), handled());
      case "/": return (g.find(), handled());
    }
    if (ctrl || e.altKey) {
      if (!ctrl || e.code !== "KeyA" || !parent) return;
      c.setByKeys(true);
      c.setSel(new Set(parent.children.map((x) => x.id)));
      return handled();
    }
    // By physical key, so the Korean layout (2-set Hangul) works too.
    const k = e.code.replace(/^Key/, "").toLowerCase();
    const verb = k === "a" ? g.add : k === "m" ? g.move : k === "f" ? g.focusOn : undefined;
    if (!verb) return;
    verb(n);
    handled();
  };
}
