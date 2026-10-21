import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { freshOnOpen, isInvalidated, readIdentity } from "../query";

/**
 * A read that a command invalidated since it was cached is shown only once re-read on arrival: drawn from the old
 * cache, the screen can flip (an empty state turning into a chart) under a pointer or a form already in use.
 * Decided on arrival at each query key; a later invalidation keeps what is on screen until its re-read lands.
 */
export function useFreshOnArrival<R extends { isFetchedAfterMount: boolean; isError: boolean; isFetching: boolean; data: unknown }>(q: R, read: Parameters<typeof isInvalidated>[1]) {
  const qc = useQueryClient();
  const key = readIdentity(read);
  const [arrival, setArrival] = useState(() => ({ key, changed: isInvalidated(qc, read) }));
  if (arrival.key !== key) {
    setArrival({ key, changed: isInvalidated(qc, read) });
  }
  return arrival.key === key && arrival.changed ? freshOnOpen(q) : q;
}
