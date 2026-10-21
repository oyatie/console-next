import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Warms a detail read before the user opens it (data-display §6.1: row and card links prefetch on hover or
 * focus). Already-fresh data is not re-read (`staleTime`).
 */
export function usePrefetch() {
  const qc = useQueryClient();
  return (q: Parameters<QueryClient["prefetchQuery"]>[0]) => void qc.prefetchQuery(q);
}
