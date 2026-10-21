// Org sheet import (UX-R3 org-06): a sheet that names each department's parent instead of spelling the path.
// Each row's path is rebuilt by walking its parents — those named by other rows of the same workplace, then one already on
// the chart under it (by exact name, once) — so the hierarchy is kept. A parent found nowhere, found twice on the chart,
// or a loop refuses the row by that name; nothing is placed under the workplace instead. Pure.
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { nameKey } from "./outline";

/** The names from under the workplace down to `name` on the chart, or why not: "none" or "twice". */
function chartPath(workplace: Node | undefined, name: string): string[] | "none" | "twice" {
  const found: string[][] = [];
  const walk = (n: Node, above: string[]) => {
    for (const c of n.children.filter((x) => x.kind === "DEPARTMENT")) {
      const path = [...above, c.name];
      if (nameKey(c.name) === name) found.push(path);
      walk(c, path);
    }
  };
  if (workplace) walk(workplace, []);
  return found.length === 1 ? found[0]! : found.length ? "twice" : "none";
}

/** Each sheet row's own unit (its last path level) by workplace, mapped to the parent it names ("" for none). */
export function sheetParents(rows: readonly { workplace: string; path: string[]; parent: string }[]) {
  const m = new Map<string, string>();
  for (const r of rows) {
    const leaf = r.path[r.path.length - 1];
    if (leaf) m.set(`${r.workplace}\u0000${leaf}`, r.parent);
  }
  return m;
}

/**
 * The row's full path under its workplace: its parents' chain, then its own levels. `{ refused }` names the parent that
 * could not be placed.
 */
export function withParents(r: { workplace: string; path: string[]; parent: string }, parents: ReadonlyMap<string, string>, workplace: Node | undefined): string[] | { refused: string } {
  const chain: string[] = [];
  let p = r.parent;
  while (p) {
    if (chain.includes(p) || r.path.includes(p) || chain.length > 30) return { refused: p };
    const next = parents.get(`${r.workplace}\u0000${p}`);
    if (next !== undefined) {
      chain.unshift(p);
      p = next;
      continue;
    }
    const onChart = chartPath(workplace, p);
    if (typeof onChart === "string") return { refused: p };
    chain.unshift(...onChart);
    p = "";
  }
  return [...chain, ...r.path];
}
