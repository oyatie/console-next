// The sibling order (review R15): a node moved one place up or down among its siblings, as the full list the server
// takes. Pure; no copy.
import type { ReorderRequest } from "@console/api/pending";
import type { Node } from "./structure";

/** `ids` with `id` moved by `step` (−1 up, +1 down); unchanged at either end. */
export function moved(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return [...ids];
  const out = [...ids];
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

/** Who a parent's order names: a legal entity orders its workplaces; a workplace or a department its departments. */
export function orderOf(parent: Node, kind: "WORKPLACE" | "DEPARTMENT"): { parent: Omit<ReorderRequest, "children">; ids: string[] } {
  const key = parent.kind === "LEGAL_ENTITY" ? { legal_entity_id: parent.id } : parent.kind === "WORKPLACE" ? { workplace_id: parent.id } : { org_unit_id: parent.id };
  return { parent: key, ids: parent.children.filter((c) => c.kind === kind).map((c) => c.id) };
}
