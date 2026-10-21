import { useQuery } from "@tanstack/react-query";
import { entitiesRef } from "../api";
import { eiUnitOf, type EiUnit } from "../domain/ei-unit";

/** The employment insurance reporting unit of each workplace of the legal entity `entityId` (its own until read). */
export function useEiUnit(entityId?: string): EiUnit {
  const q = useQuery({ ...entitiesRef, enabled: Boolean(entityId) });
  return eiUnitOf(q.data?.items.find((e) => e.id === entityId));
}
