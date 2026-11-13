// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { chunk } from "../chunk-guard";
import { Announcer } from "../../ui/announcer";
import { bindAnnouncer, useRoutePresentation } from "./announce";

/**
 * Shared per-route ready marker: content rendered for this history entry and the screen's active reads settled.
 * The history key distinguishes revisiting the same URL; inactive prefetches do not hold up the screen.
 * Visible aria-busy regions in main hold readiness until content or a settled failure state replaces them.
 */
export function RouteFrame({ children = <Outlet /> }: { children?: ReactNode }) {
  const { location, status, isLoading } = useRouterState();
  useRoutePresentation(location.pathname, status === "idle" && !isLoading);
  const cache = useQueryClient().getQueryCache();
  const reading = useSyncExternalStore(
    useCallback((changed: () => void) => cache.subscribe(notifyManager.batchCalls(changed)), [cache]),
    // A paused read still owes an answer; useIsFetching counts only requests currently on the wire.
    () => cache.findAll({ type: "active", predicate: q => q.state.fetchStatus !== "idle" }).length,
  );
  const bind = (signal: HTMLSpanElement | null) => {
    if (!signal) return;
    if (status !== "idle" || isLoading || reading) {
      delete signal.dataset.routeReady;
      return;
    }
    let bound = true;
    let dispose: (() => void) | undefined;
    // The route guards already load this chunk; DOM observation stays out of the entry bundle.
    void chunk(import("./session")).then(module => {
      if (bound) dispose = module.observeRouteReady(signal, location.href);
    });
    return () => { bound = false; dispose?.(); };
  };
  return <>
    {children}
    <Announcer bind={bindAnnouncer} />
    <span hidden ref={bind} data-route-key={location.state.__TSR_key} />
  </>;
}
