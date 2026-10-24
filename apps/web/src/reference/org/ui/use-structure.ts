import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrgStructure } from "@console/api/pending";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { orgStructureRef as structureQuery } from "../../entity/api";
import { unitsQuery } from "../api";
import { locate, placesOf, without } from "../domain/structure";

/**
 * The structure tree with every node's place, and the selection `sel` located in it (a workplace also by its own unit).
 * A tree a command changed since it was cached (going live turns every verb governed) is used only once re-read: drawn
 * stale, the first add-department after go-live opened the setup field instead of the change sheet.
 */
export function useStructure(sel?: string, snapshot?: OrgStructure) {
  const q = useFreshOnArrival(useQuery({ ...structureQuery, enabled: !snapshot }), structureQuery);
  const units = useQuery({ ...unitsQuery, enabled: !snapshot });
  const tree = snapshot ?? q.data;
  const places = useMemo(() => {
    if (snapshot) return placesOf(snapshot);
    const gone = new Set((units.data?.items ?? []).filter((u) => u.status !== "ACTIVE").map((u) => u.id));
    return q.data ? placesOf(without(q.data, gone)) : new Map();
  }, [q.data, units.data, snapshot]);
  return { q, places, at: locate(places, sel), setup: tree?.phase !== "OPERATING", tenant: tree?.tenant_name ?? "" };
}
