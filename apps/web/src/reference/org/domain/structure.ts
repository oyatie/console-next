// The company structure (tenant → legal entity → workplace → department, decision 18) as the editor reads it: where a node sits, what
// is under it, and who is placed where. Pure; no copy.
import type { Structure, StructureNode } from "@console/api/pending";

export type Node = StructureNode;
export type Place = {
  node: Node;
  parent?: Node;
  entity: Node;
  /** The workplace a department is in (itself for a workplace); none for a legal entity. */
  workplace?: Node;
  /** Names from the legal entity down to the node's parent. */
  path: string[];
};
export type Located = (Place & { kind: "entity" | "workplace" | "dept" }) | undefined;

/** Every node by id, with its place. A workplace is also found by its own org unit's id (the old chart's SITE). */
export function placesOf(s: Structure): Map<string, Place> {
  const out = new Map<string, Place>();
  const walk = (n: Node, parent: Node | undefined, entity: Node, workplace: Node | undefined, path: string[]) => {
    const wp = n.kind === "WORKPLACE" ? n : workplace;
    const place: Place = { node: n, parent, entity, workplace: wp, path };
    out.set(n.id, place);
    if (n.kind === "WORKPLACE" && n.org_unit_id) out.set(n.org_unit_id, place);
    for (const c of n.children) walk(c, n, entity, wp, [...path, n.name]);
  };
  for (const e of s.entities) walk(e, undefined, e, undefined, []);
  return out;
}

const KIND = { LEGAL_ENTITY: "entity", WORKPLACE: "workplace", SITE: "workplace", DEPARTMENT: "dept" } as const;
export function locate(places: Map<string, Place>, id: string | undefined): Located {
  const p = id ? places.get(id) : undefined;
  return p && { ...p, kind: KIND[p.node.kind] };
}

export const depts = (n: Node) => n.children.filter((c) => c.kind === "DEPARTMENT");
/** Placed at the node itself: a department's direct members, or a workplace's people with no department (placed directly at the workplace). */
export const direct = (n: Node) => Math.max(0, n.headcount - depts(n).reduce((sum, c) => sum + c.headcount, 0));
/** Every department under the node, at any depth. */
export const descendants = (n: Node): Node[] => depts(n).flatMap((c) => [c, ...descendants(c)]);
export const isClosed = (n: Node) => n.chips.includes("closed");

/** Where a department sits, as a setup op names it: a workplace by its id, a department by its org unit id. */
export const parentRef = (parent: Node): { workplace_id: string } | { parent_org_unit_id: string } =>
  parent.kind === "WORKPLACE" ? { workplace_id: parent.id } : { parent_org_unit_id: parent.id };
/** The org unit a governed op names for a parent: a workplace's own unit, else the department itself. */
export const unitIdOf = (n: Node) => (n.kind === "WORKPLACE" ? (n.org_unit_id ?? n.id) : n.id);

/**
 * Where `units` (department) may go together: any open workplace or department of the same legal entity, except the units themselves and
 * everything under them (I-3, I-4). Units of different legal entity have no common target.
 */
export function targetsFor(places: Map<string, Place>, units: readonly Node[]): { entity?: Node; excluded: Set<string> } {
  const entities = new Set(units.map((u) => places.get(u.id)?.entity.id));
  if (entities.size !== 1) return { excluded: new Set() };
  const excluded = new Set(units.flatMap((u) => [u.id, ...descendants(u).map((d) => d.id)]));
  return { entity: places.get(units[0]!.id)?.entity, excluded };
}

/** Units chosen together collapse into a chosen ancestor: what actually moves (I-3). */
export function collapse(places: Map<string, Place>, ids: readonly string[]): { roots: Node[]; carried: Node[] } {
  const chosen = new Set(ids);
  const roots: Node[] = [];
  const carried: Node[] = [];
  for (const id of ids) {
    const p = places.get(id);
    if (!p || p.node.kind !== "DEPARTMENT") continue;
    let up = p.parent;
    let inside = false;
    while (up) {
      if (chosen.has(up.id)) inside = true;
      up = places.get(up.id)?.parent;
    }
    (inside ? carried : roots).push(p.node);
  }
  return { roots, carried };
}

/** Who must go somewhere before a workplace closes: each top department (everyone under it) and the people placed directly (no name). */
export type Group = { id: string; name?: string; count: number };
export const closeGroups = (n: Node): Group[] => [
  ...depts(n).map((d) => ({ id: d.id, name: d.name, count: d.headcount })),
  ...(direct(n) > 0 ? [{ id: n.id, count: direct(n) }] : []),
];

/** The structure acts `?act=` names on the selection `sel` of the company structure page (routes/org.ts validates them). */
export const STRUCTURE_ACTS = ["wp-create", "wp-primary", "wp-delete", "wp-close", "wp-kind", "wp-kinds", "dept-add", "dept-rename", "dept-delete", "dept-merge", "dept-dissolve"] as const;
export type StructureAct = (typeof STRUCTURE_ACTS)[number];

/**
 * The structure without the units in `gone` (closed elsewhere but still listed).
 * trunk's structure read skips only setup-dissolved units (status "dissolved"); a unit dissolved by an applied
 * proposal still appears, so the editor drops what the unit list says is not ACTIVE until the read does.
 */
export function without(s: Structure, gone: ReadonlySet<string>): Structure {
  if (gone.size === 0) return s;
  const strip = (n: Node): Node => ({ ...n, children: n.children.filter((c) => !gone.has(c.id)).map(strip) });
  return { ...s, entities: s.entities.map(strip) };
}
