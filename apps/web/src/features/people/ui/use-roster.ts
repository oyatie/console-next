import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { components, paths } from "@console/api/schema";
import { get, pages } from "../../../lib/query";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { todayKst } from "../../../lib/pure/today";
import { MAX_LINES } from "../domain/bulk";
import { facetQueries, listQuery, reviewCounts, reviewTotals, statusCounts, statusTotals, type RosterFilter } from "../domain/roster";

type Employee = components["schemas"]["Employee"];
type FacetQuery = NonNullable<paths["/api/v1/employees/facets"]["get"]["parameters"]["query"]>;
/** `display.page_size` (data-display §9). */
export const PAGE = 100;
/** `bulk.max_lines`: the bulk lifecycle command takes up to this many employees. */
export const BULK_MAX = MAX_LINES;
/** Home's renewal queue window (`hr.contract_soon_days`; Employee.tsx CONTRACT_SOON_DAYS). */
export const SOON_DAYS = 60;

const NONE: Employee[] = [];
const employees = (query: object) => get("/api/v1/employees", { params: { query } });

/**
 * The roster's reads. Rows: offset pages of 100 that never re-read on focus or polling (that would re-read every
 * loaded page, ~30 reads per Alt-Tab at 3,000 rows); only a command's invalidation reloads them. Counts: two facet
 * reads (domain/roster facetQueries), which do follow focus and polling; the list filter's total is the probe, so a
 * change by someone else shows as a banner instead of reshuffling the rows under the cursor.
 */
export function useRoster(f: RosterFilter) {
  const today = todayKst();
  const query = listQuery(f, today, SOON_DAYS);
  const list = useInfiniteQuery({
    ...pages("/api/v1/employees", query, PAGE),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    // Coming back re-reads the pages only if a command changed people meanwhile; age alone shows the banner.
    refetchOnMount: (q) => q.state.isInvalidated,
  });
  // Offset pages can repeat a row when one was inserted mid-scroll: keep the first.
  const rows: Employee[] = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((p) => p.items).filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [list.data]);
  const total = list.data?.pages[0]?.total;
  // Rows a command changed since they were cached are re-read on arrival: until that read lands they are not shown,
  // or the new people would land under a pointer already aimed at a row. Latched, so a later re-read keeps the rows.
  const [arrived, setArrived] = useState(false);
  if (!arrived && !list.isFetching) setArrived(true);
  const rereading = !arrived && !list.isFetchedAfterMount;
  // The facets read takes the same status filter as the list, PRE_HIRE included (read_filters.rs); its OpenAPI enum
  // has not caught up with the list's, hence the cast.
  const facets = facetQueries(f, today, SOON_DAYS) as unknown as Record<"list" | "review", FacetQuery>;
  // Counts a command changed since they were cached are shown only once re-read (as the rows): the old ones would
  // redraw the filter chips under the pointer when the new ones land.
  const probeRead = get("/api/v1/employees/facets", { params: { query: facets.list } });
  const reviewRead = get("/api/v1/employees/facets", { params: { query: facets.review } });
  const probe = useFreshOnArrival(useQuery(probeRead), probeRead);
  const review = useFreshOnArrival(useQuery(reviewRead), reviewRead);
  /** A count read after the rows says this filter moved (someone else added or changed people); an older one never does. */
  const changed = total !== undefined && probe.data !== undefined && probe.data.total !== total && !list.isFetching && probe.dataUpdatedAt > list.dataUpdatedAt;
  // An empty list that the counts say has people (an import from another tab) re-reads at once: no row is under the pointer.
  const { refetch } = list;
  useEffect(() => {
    if (changed && total === 0) void refetch();
  }, [changed, total, refetch]);
  return {
    list,
    /** No rows to show yet: the first read, or the re-read on arrival of rows a command changed. */
    loading: list.isPending || rereading,
    rows: rereading ? NONE : rows,
    total: rereading ? undefined : total,
    changed,
    status: { totals: statusTotals(statusCounts(probe.data?.status)), failed: statusCounts().map(() => probe.isError) },
    review: { totals: reviewTotals(reviewCounts(review.data?.review)), failed: reviewCounts().map(() => review.isError) },
    query,
  };
}

/** The most rows one `GET /employees` returns. */
const LIST_MAX = 1000;

/**
 * Every person matching the filter, once `on`: a select-all-matching selection becomes ids when the bulk dialog
 * opens, so its count and names are seen before commit. Reads the whole total (not just BULK_MAX), because the
 * caller drops the exclusions afterwards and the filter may have grown since select-all was offered.
 */
export function useMatching(query: object, total: number | undefined, on: boolean) {
  return useQuery({ ...employees({ ...query, limit: Math.min(total ?? BULK_MAX, LIST_MAX) }), enabled: on && total !== undefined });
}
