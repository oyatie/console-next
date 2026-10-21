// Where an org unit sits in the composed tree (entity › workplace › department › team): the employer and workplace it implies.
import type { OrgStructure } from "@console/api/pending";

type Node = OrgStructure["entities"][number];

/** The legal entity and workplace above `unitId`, or null when the unit is not placed at one workplace. Pure. */
export function placementOfUnit(roots: readonly Node[], unitId: string): { entityId: string; workplaceId: string } | null {
  const walk = (n: Node, entity: string | null, workplace: string | null): { entityId: string; workplaceId: string } | null => {
    const e = n.kind === "LEGAL_ENTITY" ? n.id : entity;
    const w = n.kind === "WORKPLACE" ? n.id : workplace;
    if (n.id === unitId || n.org_unit_id === unitId) return e && w ? { entityId: e, workplaceId: w } : null;
    for (const c of n.children) {
      const hit = walk(c, e, w);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of roots) {
    const hit = walk(r, null, null);
    if (hit) return hit;
  }
  return null;
}

/** The legal entity `unitId` sits under (a workplace's own unit counts as that workplace), or null when it is under none. Pure. */
export function entityOfUnit(roots: readonly Node[], unitId: string): string | null {
  const has = (n: Node): boolean => n.id === unitId || n.org_unit_id === unitId || n.children.some(has);
  return roots.find((e) => e.children.some(has))?.id ?? null;
}

/**
 * Whether a transfer may take a person employed by `entityId` to `unitId` (decisions #30: a transfer never crosses legal entities;
 * that move is a group transfer). Unknown on either side is left to the server, which refuses with transfer_cross_entity.
 */
export function withinEntity(roots: readonly Node[], unitId: string, entityId: string | null | undefined): boolean {
  const at = entityOfUnit(roots, unitId);
  return !entityId || !at || at === entityId;
}
