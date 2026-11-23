// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { cachedQueriesWithPrefix, isQueryForPrefix, queryParams } from "../query";

export interface CachedRecordSpec {
  path: string;
  match: (params: unknown) => boolean;
}

/** Selects the most recently updated cached query matching `spec` without issuing network reads. */
function selectCachedRecordData<T>(qc: QueryClient, spec: CachedRecordSpec): T | undefined {
  let best: Query | undefined;
  for (const query of cachedQueriesWithPrefix(qc, spec.path)) {
    if (query.state.data === undefined) continue;
    if (!spec.match(queryParams(query))) continue;
    if (!best || query.state.dataUpdatedAt > best.state.dataUpdatedAt) {
      best = query;
    }
  }
  return best?.state.data as T | undefined;
}

/** Passively observes cached record data for `spec` via `QueryClient` without triggering fetches. */
export function useCachedRecordData<T>(spec: CachedRecordSpec | null): T | undefined {
  const qc = useQueryClient();
  const path = spec?.path ?? "";
  const getSnapshot = () => {
    if (!spec) return "";
    return cachedQueriesWithPrefix(qc, spec.path)
      .filter(query => query.state.data !== undefined && spec.match(queryParams(query)))
      .map(query => `${query.queryHash}:${query.state.dataUpdatedAt}`)
      .join("|");
  };
  const version = useSyncExternalStore(
    cb =>
      qc.getQueryCache().subscribe(event => {
        if (path && isQueryForPrefix(event.query, path)) cb();
      }),
    getSnapshot,
    getSnapshot,
  );
  if (!spec || !version) return undefined;
  return selectCachedRecordData<T>(qc, spec);
}
