import { useEffect, useMemo, useRef, useState } from "react";
import { expandedFor, layout, type Depth } from "../domain/layout";
import { pathTo, type ChartNode, type Structure } from "../domain/model";
import { findHits } from "../domain/search";

/**
 * What the chart shows and what is chosen on it: the focus (crumbs), the depth, the open boxes, the selection
 * (several with Shift/Ctrl), the keyboard cursor (separate from the selection, D15), an open add box or rename, and
 * the search with its current hit. The layout is derived, never stored. The caller keys it by focus, so a new focus
 * starts from its own default depth — unless this tab has shown that focus before: then the depth and the open boxes
 * it was left with come back (org-22: after a sheet or the move page returns to the chart, it keeps its depth and
 * opens the way to, and under, the unit the change selected).
 */
const kept = new Map<string, { depth: Depth; expanded: string[] }>();

export function useChartState(
  s: Structure,
  focusId: string | undefined,
  onFocus: (id: string | undefined) => void,
  /** The selection is the page's (one across org chart, list and the outline). */
  sel: ReadonlySet<string>,
  /** `gather`: chosen with Shift or Ctrl, the start of several (no side panel for a single one). */
  setSel: (next: ReadonlySet<string>, gather?: boolean) => void,
) {
  const focus = (focusId && s.byId.get(focusId)) || s.root;
  const before = kept.get(focus.id);
  const [depth, setDepthRaw] = useState<Depth>(before?.depth ?? (focus.kind === "tenant" ? "sites" : "one"));
  // A single selection arriving with the view (⌘K, a change's result) opens its path and itself, and takes the cursor.
  const arrived = sel.size === 1 ? s.byId.get([...sel][0]!) : undefined;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...(before?.expanded ?? expandedFor(focus, depth)), ...(arrived ? pathTo(s, arrived.id).map((n) => n.id) : [])]));
  useEffect(() => void kept.set(focus.id, { depth, expanded: [...expanded] }), [focus.id, depth, expanded]);
  // A unit that appears in a re-read (a change just applied) is drawn: the way to it opens (org-22).
  const known = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const prev = known.current;
    known.current = new Set(s.byId.keys());
    const fresh = prev ? [...s.byId.keys()].filter((id) => !prev.has(id)) : [];
    if (fresh.length) setExpanded((e) => new Set([...e, ...fresh.flatMap((id) => pathTo(s, id).slice(0, -1).map((n) => n.id))]));
  }, [s]);
  const [cursor, setCursor] = useState<string>(arrived?.id ?? focus.id);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  /** Counts every find or pick that asks for a box to be shown, even one the cursor is already on (it may be off screen). */
  const [seek, setSeek] = useState(0);
  /** The last change to the selection came from the keyboard (the selection bar then shows the keys). */
  const [byKeys, setByKeys] = useState(false);

  const L = useMemo(() => layout({ s, focus, expanded, ghostUnder: adding ?? undefined }), [s, focus, expanded, adding]);
  const hits = useMemo(() => findHits(s, q), [s, q]);
  const shown = useMemo(() => new Map(L.boxes.filter((b) => !b.ghost && !b.slot).map((b) => [b.node.id, b])), [L]);
  /** Tree order of the drawn boxes (the arrow keys walk it). */
  const order = useMemo(() => {
    const out: ChartNode[] = [];
    const walk = (n: ChartNode) => {
      if (!shown.has(n.id)) return;
      out.push(n);
      n.children.forEach(walk);
    };
    walk(focus);
    return out;
  }, [focus, shown]);

  const setDepth = (d: Depth) => {
    setDepthRaw(d);
    setExpanded(expandedFor(focus, d));
  };
  const toggle = (id: string, open?: boolean) =>
    setExpanded((e) => {
      const next = new Set(e);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  /** Opens every box on the way to `id` inside the focus (a search hit, a node picked elsewhere). */
  const reveal = (id: string) => {
    const path = pathTo(s, id);
    if (!path.some((n) => n.id === focus.id)) onFocus(undefined);
    setExpanded((e) => new Set([...e, ...path.slice(0, -1).map((n) => n.id)]));
    setCursor(id);
    setSeek((n) => n + 1);
  };
  const select = (id: string, mode: "only" | "toggle" | "extend" = "only", keys = false) => {
    setByKeys(keys);
    if (mode === "only") return setSel(new Set([id]));
    const next = new Set(sel);
    if (mode === "toggle" && next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next, true);
  };
  const clear = () => setSel(new Set());
  const stepHit = (d: number) => {
    if (!hits.ids.length) return;
    const i = (hit + d + hits.ids.length) % hits.ids.length;
    setHit(i);
    reveal(hits.ids[i]!);
  };
  const search = (text: string) => {
    setQ(text);
    setHit(0);
  };

  return { focus, depth, setDepth, expanded, toggle, setExpanded, L, shown, order, sel, select, setSel, clear, byKeys, setByKeys, cursor, setCursor, adding, setAdding, renaming, setRenaming, q, search, hits, hit, stepHit, reveal, seek };
}
export type ChartState = ReturnType<typeof useChartState>;
