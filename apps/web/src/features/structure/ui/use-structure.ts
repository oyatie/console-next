import { readGroup } from "../../../lib/react/query-view";
import { get } from "../../../lib/query";
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { buildStructure } from "../domain/model";
import { entitiesAt, kindsRef, orgStructureAt, type AsOf } from "../../../reference/entity/api";
import { kindName } from "../../../reference/entity/present";

/**
 * The first structure paint waits for both reads, so identity facts never arrive as a second layout.
 */
export function useStructure({ as_of, known_at, compare_a, compare_b }: AsOf & { compare_a?: string; compare_b?: string } = {}) {
  const comparing = Boolean(compare_a || compare_b);
  const q = { as_of: comparing ? compare_b : as_of, known_at };
  const structureQuery = orgStructureAt(q);
  // A tree a command changed since it was cached (go-live flips the phase) is drawn only once re-read: drawn stale,
  // a gesture made in that first frame acted in the old phase (an inline setup add on an operating tenant).
  const base = useFreshOnArrival(useQuery({ ...structureQuery, placeholderData: keepPreviousData, enabled: !comparing }), structureQuery);
  const diffQuery = get("/api/v1/org-structure/diff", { params: { query: { a: compare_a ?? "", b: compare_b ?? "", known_at } } });
  const diff = useFreshOnArrival(useQuery({ ...diffQuery, placeholderData: keepPreviousData, enabled: comparing }), diffQuery);
  const tree = comparing ? { ...diff, data: diff.data?.structure } : base;
  const entityQuery = entitiesAt(q);
  const entities = useFreshOnArrival(useQuery({ ...entityQuery, placeholderData: keepPreviousData }), entityQuery);
  const kinds = useQuery({ ...kindsRef, retry: false }).data?.items;
  const s = useMemo(() => {
    if (!tree.data || !entities.data || tree.isPlaceholderData || entities.isPlaceholderData) return undefined;
    const structure = buildStructure(tree.data, entities.data.items, (code) => (kinds ? kindName(kinds, code) : undefined));
    if (comparing) {
      structure.readOnly = true;
      for (const mark of diff.data?.marks ?? []) {
        const node = structure.byId.get(mark.id);
        if (node) node.diffMarks = mark.marks;
      }
    }
    return structure;
  }, [tree.data, tree.isPlaceholderData, entities.data, entities.isPlaceholderData, kinds, comparing, diff.data]);
  const ready = readGroup([tree, entities]);
  return { s, tree, ready: !s && !ready.error ? { ...ready, data: undefined, isPending: true } : ready, entities, diff: comparing ? diff.data : undefined };
}
