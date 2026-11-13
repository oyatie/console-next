// SPDX-License-Identifier: LicenseRef-Proprietary
import { elementVisible } from "../element-visible";
export function readyHref(committedHref: string, browserHref: string) {
  const browser = new URL(browserHref);
  const committed = new URL(committedHref, browserHref);
  const href = browser.pathname + browser.search + browser.hash;
  browser.search = browser.searchParams.toString();
  committed.search = committed.searchParams.toString();
  return committed.href === browser.href ? href : undefined;
}

/** Observe rendered content only after the route guards and active reads settle. */
export function observeRouteReady(signal: HTMLSpanElement, committedHref: string) {
  let frame = 0;
  const renderedHref = () => {
    // Idle router state can precede a lazy screen's first render (and its first query).
    const main = document.querySelector("main");
    if (!main || !elementVisible(main)) return;
    const pending = [main, ...main.querySelectorAll('[aria-busy=true]')].some(element =>
      element.matches('[aria-busy=true]') && !element.closest('[hidden],[inert],[aria-hidden=true]') && elementVisible(element));
    return !pending
      ? readyHref(committedHref, window.location.href) : undefined;
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
}
