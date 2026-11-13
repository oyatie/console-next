// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { readyHref } from "./route-href";
import { elementVisible } from "../element-visible";
import { Announcer } from "../../ui/announcer";
import { bindAnnouncer, useRoutePresentation } from "./announce";

/**
 * Shared per-route ready marker: content rendered for this history entry and the screen's active reads settled.
 * The history key distinguishes revisiting the same URL; inactive prefetches do not hold up the screen.
 * Visible aria-busy regions in main hold readiness until content or a settled failure state replaces them.
 */
export function RouteFrame() {
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
    let frame = 0;
    const renderedHref = () => {
      // Idle router state can precede a lazy screen's first render (and its first query).
      const main = document.querySelector("main");
      if (status !== "idle" || isLoading || reading || !main || !elementVisible(main)) return;
      const pending = [main, ...main.querySelectorAll('[aria-busy=true]')].some(element =>
        element.matches('[aria-busy=true]') && !element.closest('[hidden],[inert],[aria-hidden=true]') && elementVisible(element));
      return !pending
        ? readyHref(location.href, window.location.href) : undefined;
    };
    const update = () => {
      if (signal.dataset.routeReady !== renderedHref()) signal.removeAttribute("data-route-ready");
      cancelAnimationFrame(frame);
      // Let a newly mounted screen subscribe to its reads before publishing its first ready marker.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const href = renderedHref();
          if (href && signal.dataset.routeReady !== href) signal.dataset.routeReady = href;
        });
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-busy", "aria-hidden", "hidden", "inert", "style", "class"] });
    update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  };
  return <>
    <Outlet />
    <Announcer bind={bindAnnouncer} />
    <span hidden ref={bind} data-route-key={location.state.__TSR_key} />
  </>;
}
