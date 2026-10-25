import { get } from "../../../lib/query";
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { buildStructure } from "../domain/model";
import { entitiesAt, kindsRef, orgStructureAt, type AsOf } from "../../../reference/entity/api";
import { kindName } from "../../../reference/entity/present";

/**
 * The structure tree, enriched from the entity list once that arrives (the boxes keep their size either way: the
 * enrichment fills lines the layout already reserves, so nothing moves under the pointer).
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
  const entities = useQuery({ ...entitiesAt(q), placeholderData: keepPreviousData });
  const kinds = useQuery({ ...kindsRef, retry: false }).data?.items;
  const s = useMemo(() => {
    if (!tree.data) return undefined;
    const structure = buildStructure(tree.data, entities.data?.items ?? [], (code) => (kinds ? kindName(kinds, code) : undefined));
    if (comparing) {
      structure.readOnly = true;
      for (const mark of diff.data?.marks ?? []) {
        const node = structure.byId.get(mark.id);
        if (node) node.diffMarks = mark.marks;
      }
    }
    return structure;
  }, [tree.data, entities.data, kinds, comparing, diff.data]);
  return { s, tree, entities, diff: comparing ? diff.data : undefined };
}
