// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type InfiniteData, type Query, type QueryClient } from "@tanstack/react-query";
import { cachedQueriesWithPrefix, isQueryForPrefix } from "../query";

type Activation = { time: number; seq: number };
const EMPTY: readonly never[] = [];
const activations = new WeakMap<QueryClient, Map<string, Activation>>();
let activationSeq = 0;

/** Records that `identity` (`readIdentity(descriptor)`) is the currently presented cached query. */
export function markActiveCachedQuery(qc: QueryClient, identity: string) {
  let map = activations.get(qc);
  if (!map) {
    map = new Map();
    activations.set(qc, map);
  }
  map.set(identity, { time: Date.now(), seq: ++activationSeq });
}

/** Marks `identity` as active whenever its cached data is displayed on screen. */
export function useMarkActiveCachedQuery(identity: string, ready: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (ready) markActiveCachedQuery(qc, identity);
  }, [qc, identity, ready]);
}

function sortedQueriesForPrefix(qc: QueryClient, prefix: string): Query[] {
  const map = activations.get(qc);
  return cachedQueriesWithPrefix(qc, prefix)
    .map((query, index) => {
      const act = map?.get(query.queryHash);
      return {
        query,
        index,
        effectiveTime: Math.max(query.state.dataUpdatedAt, act?.time ?? 0),
        observers: query.getObserversCount() > 0 ? 1 : 0,
        seq: act?.seq ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.effectiveTime - a.effectiveTime ||
        b.observers - a.observers ||
        b.seq - a.seq ||
        b.index - a.index,
    )
    .map(entry => entry.query);
}

/** Selects the single most recently updated cached infinite query matching `prefix` (and optional `match`). */
export function selectCachedInfinitePages<T>(
  qc: QueryClient,
  prefix: string,
  match?: (pages: readonly T[]) => boolean,
): readonly T[] {
  for (const query of sortedQueriesForPrefix(qc, prefix)) {
    const data = query.state.data as InfiniteData<T> | undefined;
    if (!data?.pages?.length) continue;
    if (!match || match(data.pages)) return data.pages;
  }
  return EMPTY;
}

/** Reads the single most recently updated cached infinite query matching `prefix` without issuing network reads. */
export function useCachedInfinitePages<T>(prefix: string, match?: (pages: readonly T[]) => boolean): readonly T[] {
  const qc = useQueryClient();
  const version = useSyncExternalStore(
    cb =>
      qc.getQueryCache().subscribe(event => {
        if (isQueryForPrefix(event.query, prefix)) cb();
      }),
    () =>
      cachedQueriesWithPrefix(qc, prefix)
        .map(query => {
          const act = activations.get(qc)?.get(query.queryHash);
          return `${query.queryHash}:${query.state.dataUpdatedAt}:${act?.seq ?? 0}:${query.getObserversCount() > 0 ? 1 : 0}`;
        })
        .join("|"),
    () => "",
  );
  if (!version) return EMPTY;
  return selectCachedInfinitePages(qc, prefix, match);
}
