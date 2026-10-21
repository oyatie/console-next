// The org chart layout (spec §0 D3, D4): siblings in a row under the focus, a spine (stack) below it, and a 2-column tile
// grid under one bracket above the compact threshold (8 workplace, SAP CSO). Level of detail changes content, never
// type size. Pure, so the canvas, minimap, export and fit all read the same geometry.
import { deptCount, type ChartNode, type Structure } from "./model";

/** §4 widths: department 192 · workplace 224 · legal entity 256 · root 352 · tile (224 − 8) / 2. */
export const W = { dept: 192, site: 224, entity: 256, root: 352, tile: 108 } as const;
/**
 * A legal entity's first-workplace slot (S10-first-entity): its line, what happens, and its two entries. As wide as
 * the workplace that replaces it, so nothing above or beside it moves.
 */
const SLOT = { w: W.site, h: 176 } as const;
const ADD_HEIGHT = 108;
const GY = 52, BUS = 16, GS = 10, IND = 24, SPINE = 12, GX = 16, MORE = 12, PAD = 40;
/** Above this many workplace a legal entity's workplace wrap into tiles (far) or a grid (one legal entity in focus). */
export const WRAP_SITES = 8;

export type Lod = "full" | "m" | "xs" | "tile";
export type Depth = "sites" | "one" | "two" | "all";
export type Box = {
  node: ChartNode;
  lod: Lod;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Collapsed children to show on its expander ("11 departments", "3 below"). */
  more?: number;
  /** An inline add box before this node's children (the caller draws the input). */
  ghost?: boolean;
  /** An empty level's next step under this node (a legal entity with no workplace yet: "first workplace"). */
  slot?: boolean;
};
export type Line = { d: string };
export type Layout = { boxes: Box[]; lines: Line[]; w: number; h: number; lod: "near" | "far" };
type Mode = "row" | "stack" | "grid";
type T = Box & { adding: boolean; kids: T[]; mode: Mode; cols: number; sw: number; sh: number; cw: number; cellW: number; rowH: number[]; gx0: number };

/** Box heights from the lines each level of detail shows (12 px padding, 1 px gaps). */
function height(n: ChartNode, lod: Lod): number {
  if (lod === "tile") return 48;
  if (lod === "xs") return 36;
  const chips = n.chips.length > 0 || n.unplaced != null;
  switch (n.kind) {
    case "tenant": return 96;
    case "entity": return lod === "full" ? 12 + 18 + 26 + 20 + 18 + (chips ? 24 : 0) + 4 : 74;
    case "site": return lod === "full" ? 12 + 18 + 24 + 18 + (chips ? 24 : 0) + 4 : 12 + 24 + 18 + (chips ? 24 : 0) + 2;
    case "dept": return lod === "full" ? 74 : 56;
  }
}

export type LayoutInput = {
  s: Structure;
  focus: ChartNode;
  /** Nodes whose children are drawn. */
  expanded: ReadonlySet<string>;
  /** The node under which an add box is open. */
  ghostUnder?: string;
};

/** Far at the tenant level when it does not fit one screen as full boxes: more than 3 legal entity, or a legal entity above the wrap. */
export const isFar = (s: Structure, focus: ChartNode) =>
  focus.kind === "tenant" && (focus.children.length > 3 || focus.children.some((e) => e.children.length > WRAP_SITES));

function build(n: ChartNode, inp: LayoutInput, far: boolean, inRow: boolean): T {
  const isFocus = n.id === inp.focus.id;
  const open = inp.expanded.has(n.id) || isFocus;
  const kids = open ? n.children : [];
  let lod: Lod = "m";
  if (n.kind === "tenant") lod = "full";
  else if (n.kind === "entity") lod = far ? "m" : "full";
  else if (n.kind === "dept") lod = inRow && !far ? "full" : "m";
  else if (n.kind === "site") lod = far ? (inp.focus.kind === "tenant" && (n.parentId ? (inp.s.byId.get(n.parentId)?.children.length ?? 0) > WRAP_SITES : false) ? "tile" : "xs") : inRow ? "full" : "m";
  const w = n.kind === "tenant" ? W.root : n.kind === "entity" ? (far ? W.site : W.entity) : n.kind === "site" ? (lod === "tile" ? W.tile : W.site) : W.dept;
  // The focus spreads its children in a row; below it everything stacks; many workplace wrap.
  let mode: Mode = isFocus ? "row" : "stack";
  let cols = 1;
  if (n.kind === "entity" && kids.length > WRAP_SITES && far) [mode, cols] = ["grid", 2];
  else if (n.kind === "entity" && isFocus && kids.length > 6) [mode, cols] = ["grid", 4];
  const childInRow = mode === "row";
  const t: T = {
    node: n, lod, x: 0, y: 0, w, h: height(n, lod),
    more: !open && n.children.length > 0 && !(far && n.kind !== "entity" && n.kind !== "tenant") ? (n.kind === "site" ? deptCount(n) : n.children.length) : undefined,
    adding: inp.ghostUnder === n.id || (n.kind === "entity" && !far && n.children.length === 0),
    kids: kids.map((k) => build(k, inp, far, childInRow)),
    mode, cols, sw: 0, sh: 0, cw: 0, cellW: 0, rowH: [], gx0: 0,
  };
  if (far && n.kind === "site") t.kids = [];
  return t;
}

function measure(n: T) {
  const [ghost, gh] = !n.adding ? [0, 0] : n.node.kind === "entity" ? [SLOT.w, SLOT.h] : [W.dept, ADD_HEIGHT];
  if (!n.kids.length && !ghost) {
    n.sw = n.w;
    n.sh = n.h + (n.more ? MORE : 0);
    return;
  }
  n.kids.forEach(measure);
  if (n.mode === "grid") {
    const rows = Math.ceil(n.kids.length / n.cols);
    n.cellW = Math.max(...n.kids.map((k) => k.sw));
    n.rowH = Array.from({ length: rows }, (_, r) => Math.max(...n.kids.slice(r * n.cols, r * n.cols + n.cols).map((k) => k.sh)));
    n.cw = n.cols * n.cellW + (n.cols - 1) * GX;
    n.sw = Math.max(n.w, n.cw);
    n.sh = n.h + GY + n.rowH.reduce((s, h) => s + h, 0) + (rows - 1) * 8;
  } else if (n.mode === "stack") {
    n.sw = Math.max(n.w, IND + Math.max(ghost, ...n.kids.map((k) => k.sw)));
    n.sh = n.h + n.kids.reduce((s, k) => s + GS + k.sh, 0) + (ghost ? GS + gh : 0);
  } else {
    const widths = [...n.kids.map((k) => k.sw), ...(ghost ? [ghost] : [])];
    n.cw = widths.reduce((s, w) => s + w, 0) + GX * (widths.length - 1);
    n.sw = Math.max(n.w, n.cw);
    n.sh = n.h + GY + Math.max(gh, ...n.kids.map((k) => k.sh));
  }
  // The root is an unboxed header over its legal-entity row (decision #29), as wide as the row.
  if (n.node.kind === "tenant") n.w = n.sw;
}

function place(n: T, x: number, y: number, out: Box[], ghosts: Box[]) {
  n.y = y;
  if (n.mode === "grid" && n.kids.length) {
    n.x = x + (n.sw - n.w) / 2;
    n.gx0 = x + (n.sw - n.cw) / 2;
    let cy = y + n.h + GY;
    n.rowH.forEach((rh, r) => {
      n.kids.slice(r * n.cols, r * n.cols + n.cols).forEach((k, c) => place(k, n.gx0 + c * (n.cellW + GX), cy, out, ghosts));
      cy += rh + 8;
    });
  } else if (n.mode === "stack") {
    n.x = x;
    let cy = y + n.h + GS;
    // New children land after the open input, so another read never inserts above the cursor.
    if (n.adding) {
      const g = ghostBox(n.node, x + IND, cy);
      ghosts.push(g);
      cy += g.h + GS;
    }
    for (const k of n.kids) {
      place(k, x + IND, cy, out, ghosts);
      cy += k.sh + GS;
    }
  } else {
    n.x = x + (n.sw - n.w) / 2;
    let cx = n.adding && n.node.kind !== "entity" ? x : x + (n.sw - n.cw) / 2;
    if (n.adding) {
      const g = ghostBox(n.node, cx, y + n.h + GY);
      ghosts.push(g);
      cx += g.w + GX;
    }
    for (const k of n.kids) {
      place(k, cx, y + n.h + GY, out, ghosts);
      cx += k.sw + GX;
    }
  }
  out.push(n);
}

const ghostBox = (parent: ChartNode, x: number, y: number): Box =>
  parent.kind === "entity" ? { node: parent, lod: "m", x, y, w: SLOT.w, h: SLOT.h, slot: true } : { node: parent, lod: "m", x, y, w: W.dept, h: ADD_HEIGHT, ghost: true };

function connectors(n: T, out: Line[], ghosts: Box[]) {
  // No line hangs from the root's header: the legal entities are the top boxes, not children of a company box (decision #29).
  if (n.node.kind === "tenant") return n.kids.forEach((k) => connectors(k, out, ghosts));
  const g = ghosts.find((b) => b.node.id === n.node.id);
  const ends = [...(g ? [g] : []), ...n.kids.map((k) => ({ x: k.x, y: k.y, w: k.w }))];
  if (!ends.length) return;
  if (n.mode === "grid") {
    const px = n.x + n.w / 2, by = n.y + n.h + BUS;
    out.push({ d: `M${px} ${n.y + n.h} V${by}` }, { d: `M${n.gx0} ${by + 8} V${by} H${n.gx0 + n.cw} V${by + 8}` });
  } else if (n.mode === "stack") {
    const sx = n.x + SPINE, last = ends[ends.length - 1]!;
    out.push({ d: `M${sx} ${n.y + n.h} V${last.y + 18}` }, ...ends.map((k) => ({ d: `M${sx} ${k.y + 18} H${k.x}` })));
  } else {
    const px = n.x + n.w / 2, my = n.y + n.h + BUS, xs = ends.map((k) => k.x + k.w / 2);
    out.push({ d: `M${px} ${n.y + n.h} V${my}` });
    if (xs.length > 1) out.push({ d: `M${Math.min(...xs)} ${my} H${Math.max(...xs)}` });
    ends.forEach((k, i) => out.push({ d: `M${xs[i]} ${my} V${k.y}` }));
  }
  n.kids.forEach((k) => connectors(k, out, ghosts));
}

/** Lays out the subtree at `focus`: boxes (parents after children, so a parent's toolbar paints on top) and connectors. */
export function layout(inp: LayoutInput): Layout {
  const far = isFar(inp.s, inp.focus);
  const root = build(inp.focus, inp, far, true);
  measure(root);
  const boxes: Box[] = [];
  const ghosts: Box[] = [];
  place(root, PAD, PAD, boxes, ghosts);
  const lines: Line[] = [];
  connectors(root, lines, ghosts);
  const strip = ({ node, lod, x, y, w, h, more }: Box): Box => ({ node, lod, x, y, w, h, more });
  return { boxes: [...boxes.map(strip), ...ghosts], lines, w: root.sw + PAD * 2, h: root.sh + PAD * 2, lod: far ? "far" : "near" };
}

/** The ids drawn open for a depth choice: workplaces / one or two department levels / all departments (the focus is always open). */
export function expandedFor(focus: ChartNode, depth: Depth): Set<string> {
  const out = new Set<string>([focus.id]);
  // `level`: how many department levels lie above `n` inside its workplace.
  const walk = (n: ChartNode, level: number) => {
    const open = n.kind === "tenant" || n.kind === "entity" || depth === "all" || (depth !== "sites" && n.kind === "site") || (depth === "two" && n.kind === "dept" && level === 0);
    if (open) out.add(n.id);
    if (open) n.children.forEach((c) => walk(c, n.kind === "dept" ? level + 1 : 0));
  };
  walk(focus, 0);
  return out;
}

export type Spot = "above" | "below" | "right" | "left" | "inside";
/** Whether a `w` × `h` rect at (x, y) covers no box other than `except`. */
export const freeAt = (L: Layout, x: number, y: number, w: number, h: number, except?: Box) =>
  !L.boxes.some((o) => o !== except && o.x < x + w && o.x + o.w > x && o.y < y + h && o.y + o.h > y);

/**
 * Where a box's toolbar (about `w` × `h`, `scale` times that when a zoomed-out chart scales its controls back up)
 * goes without covering another box: above its top edge, right-aligned (spec S2), else below, to the right, to the
 * left; otherwise on its own top-right corner, so adding a child always stays reachable.
 */
export function toolsSpot(L: Layout, b: Box, scale = 1, w = 320 * scale, h = 36 * scale, visible?: { x: number; y: number; w: number; h: number }): Spot {
  // Inside the stage too: a spot past its edge is cut off by the canvas.
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x + w <= L.w && (!visible || (x >= visible.x && y >= visible.y && x + w <= visible.x + visible.w && y + h <= visible.y + visible.h)) && freeAt(L, x, y, w, h, b);
  const spots: [Spot, number, number][] = [["above", b.x + b.w - w, b.y - h - 4], ["below", b.x + b.w - w, b.y + b.h + 14], ["right", b.x + b.w + 8, b.y], ["left", b.x - w - 8, b.y]];
  return spots.find(([, x, y]) => free(x, y))?.[0] ?? "inside";
}
