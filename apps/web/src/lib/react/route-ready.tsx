// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";

/**
 * Shared per-route ready marker: the router committed this history entry and the screen's active reads settled.
 * The history key distinguishes revisiting the same URL; inactive prefetches do not hold up the screen.
 */
export function RouteFrame() {
  const { location, status, isLoading } = useRouterState();
  const cache = useQueryClient().getQueryCache();
  const reading = useSyncExternalStore(
    useCallback((changed: () => void) => cache.subscribe(notifyManager.batchCalls(changed)), [cache]),
    // A paused read still owes an answer; useIsFetching counts only requests currently on the wire.
    () => cache.findAll({ type: "active", predicate: q => q.state.fetchStatus !== "idle" }).length,
  );
  return <>
    <Outlet />
    <span hidden data-route-ready={status === "idle" && !isLoading && !reading ? location.href : undefined} data-route-key={location.state.__TSR_key} />
  </>;
}
