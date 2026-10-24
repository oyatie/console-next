// Where a new person can go (spec E3 "where does this person go"): the open departments and teams, or a workplace itself, each with its company. Pure.
import type { components } from "@console/api/schema";
import type { OrgStructure } from "@console/api/pending";
import { placementOfUnit } from "../../../reference/entity/domain/placement";
import type { Where } from "./register";
import { entityName } from "../../../reference/entity/domain/names";

type Unit = components["schemas"]["OrgUnitHead"];
type Entity = components["schemas"]["LegalEntity"];
export type PlaceOption = { unit: Unit; entity: string; entityRecord?: Entity; entityId: string | null; workplaceId: string | null; site: string };

/** The options for `where` (both kinds before a chip is picked), with the company and workplace each unit sits at (from the composed tree). */
export function placeOptions(units: Unit[], roots: OrgStructure["entities"], entities: readonly Entity[], where: Where | null): PlaceOption[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  return units
    .filter((u) => u.status === "ACTIVE" && (where === "site" ? u.kind === "SITE" : where === "unit" ? u.kind === "DEPARTMENT" || u.kind === "TEAM" : u.kind !== "COMPANY"))
    .map((unit) => {
      const at = placementOfUnit(roots, unit.id);
      const e = entities.find((x) => x.id === at?.entityId);
      let site: Unit | undefined = unit;
      while (site && site.kind !== "SITE") site = site.parentId ? byId.get(site.parentId) : undefined;
      return { unit, entity: entityName(e), entityRecord: e, entityId: at?.entityId ?? null, workplaceId: at?.workplaceId ?? null, site: site?.name ?? "" };
    });
}

/** The workplaces a person can be registered at: each with the branch their leave routes to. */
export const workplaceChoices = (entities: readonly Entity[]) =>
  entities.flatMap((e) => e.workplaces.filter((w) => w.default_branch_id).map((w) => ({ entityId: e.id, entity: entityName(e), entityRecord: e, workplaceId: w.id, site: w.current?.name ?? "", opensOn: w.placement_opens_on, branchId: w.default_branch_id! })));

/**
 * The place a registration is sent with: the unit's own workplace when it sits under a registered one with a branch,
 * else the workplace the user picked for it (a unit made in the org chart before its workplace was registered).
 */
export function resolvePlace(place: PlaceOption | undefined, entities: readonly Entity[], picked: string) {
  if (!place) return undefined;
  const all = workplaceChoices(entities);
  const own = all.find((w) => w.workplaceId === place.workplaceId);
  const w = own ?? all.find((x) => x.workplaceId === picked);
  return { ...place, own: own !== undefined, opensOn: w?.opensOn, ...(w ? { entityId: w.entityId, entity: w.entity, entityRecord: w.entityRecord, workplaceId: w.workplaceId, branchId: w.branchId } : { branchId: null }) };
}
