// SPDX-License-Identifier: LicenseRef-Proprietary
import { useIsFetching } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";

/**
 * Shared per-route ready marker: the router committed this history entry and the screen's active reads settled.
 * The history key distinguishes revisiting the same URL; inactive prefetches do not hold up the screen.
 */
export function RouteFrame() {
  const { location, status, isLoading } = useRouterState();
  const fetching = useIsFetching({ type: "active" });
  return <>
    <Outlet />
    <span hidden data-route-ready={status === "idle" && !isLoading && !fetching ? location.href : undefined} data-route-key={location.state.__TSR_key} />
  </>;
}
