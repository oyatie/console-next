import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { placeOptions } from "../domain/register-place";

type Employee = components["schemas"]["Employee"];

/**
 * Where a transfer can move the employee (spec E5-transfer): only places that can take them — open units of their own
 * legal entity, not the current one. Other legal entities are not listed: a change of legal entity is a group transfer
 * (decisions #30).
 */
export function useTransferOptions(employee: Employee) {
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const places = placeOptions(units, roots, entities, null).filter((o) => o.unit.id !== employee.org_unit_id);
  return { units, options: places.filter((o) => !employee.legal_entity_id || !o.entityId || o.entityId === employee.legal_entity_id), workplaces: entities.flatMap((e) => e.workplaces) };
}
