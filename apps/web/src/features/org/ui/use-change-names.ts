import { useQuery } from "@tanstack/react-query";
import { branchesQuery, regionsQuery, unitsQuery } from "../../../reference/org/api";
import type { Names } from "../present";

/** Names for the ids a change carries, over the loaded org (dissolved units and closed branches included). */
export function useChangeNames(): Names {
  const regions = useQuery(regionsQuery);
  const branches = useQuery(branchesQuery);
  const units = useQuery(unitsQuery);
  const lookup = (items: { id: string; name: string }[] | undefined) => {
    const m = new Map(items?.map((i) => [i.id, i.name]));
    return (id?: string | null) => (id ? m.get(id) : undefined);
  };
  return { region: lookup(regions.data), branch: lookup(branches.data), unit: lookup(units.data?.items) };
}
