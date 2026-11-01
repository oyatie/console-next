import type { KeyboardEvent } from "react";
import type { ChartNode } from "../domain/model";
import type { ChartState } from "./use-chart-state";
import type { Gestures } from "../present";

// The handler and shortcut sheet read the same bindings; physical letter keys also work in Hangul layouts.
export const CHART_KEYS = [
  ["navigate", ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]],
  ["select", ["Ctrl Space", "Shift ArrowUp", "Shift ArrowDown", "Ctrl A"]],
  ["reorder", ["Alt ArrowUp", "Alt ArrowDown"]],
  ["add", ["A"]], ["rename", ["F2"]], ["move", ["M"]], ["end", ["Delete", "Backspace"]],
  ["focus", ["F"]], ["expand", ["Space"]], ["open", ["Enter"]], ["find", ["/"]],
  ["menu", ["Shift F10", "ContextMenu"]], ["clear", ["Escape"]],
] as const;

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
    const letter = e.code.startsWith("Key");
    const key = letter ? e.code.slice(3) : e.key === " " ? "Space" : e.key;
    const chord = `${ctrl ? "Ctrl " : ""}${e.altKey ? "Alt " : ""}${e.shiftKey && !letter ? "Shift " : ""}${key}`;
    const command = CHART_KEYS.find(([, keys]) => (keys as readonly string[]).includes(chord))?.[0];
    const handled = () => e.preventDefault();
    switch (command) {
      case "reorder":
        g.order?.(n, e.key === "ArrowUp" ? -1 : 1)?.();
        return handled();
      case "select": {
        if (key === "Space") c.select(n.id, "toggle", true);
        else if (key === "A") {
          if (!parent) return;
          c.setByKeys(true);
          c.setSel(new Set(parent.children.map((x) => x.id)));
        } else {
          const next = c.order[at + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) c.select(next.id, "extend", true);
          go(next);
        }
        return handled();
      }
      case "navigate": switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const next = c.order[at + (e.key === "ArrowDown" ? 1 : -1)];
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
      } return;
      case "open": return (g.open(n), handled());
      case "expand":
        if (n.children.length && n.id !== c.focus.id) c.toggle(n.id);
        return handled();
      case "clear": return c.clear();
      case "rename": return (g.rename(n), handled());
      case "end": return (g.remove(n), handled());
      case "menu": return (g.menu(n), handled());
      case "find": return (g.find(), handled());
      case "add": return (g.add(n), handled());
      case "move": return (g.move(n), handled());
      case "focus": return (g.focusOn(n), handled());
    }
  };
}
