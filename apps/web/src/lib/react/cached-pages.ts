// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { cachedQueriesWithPrefix, isQueryForPrefix } from "../query";

/** Reads already-cached infinite query pages matching `prefix` without issuing network reads. */
export function useCachedInfinitePages<T>(prefix: string): readonly T[] {
  const qc = useQueryClient();
  const version = useSyncExternalStore(
    cb =>
      qc.getQueryCache().subscribe(event => {
        if (isQueryForPrefix(event.query, prefix)) cb();
      }),
    () =>
      cachedQueriesWithPrefix(qc, prefix)
        .map(query => `${query.queryHash}:${query.state.dataUpdatedAt}`)
        .join("|"),
    () => "",
  );
  if (!version) return [];
  const pages: T[] = [];
  for (const query of cachedQueriesWithPrefix(qc, prefix)) {
    const data = query.state.data as InfiniteData<T> | undefined;
    if (data?.pages?.length) pages.push(...data.pages);
  }
  return pages;
}
