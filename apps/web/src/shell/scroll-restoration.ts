import { useEffect } from "react";
import type { useRouter } from "@tanstack/react-router";

// Main scroll restoration starts with the shell, after its lazy chunk has loaded.
const mainPositions = new Map<string, number>();
let stopMainRestore: () => void = () => undefined;
function restoreMain(key: string, top: number) {
  stopMainRestore();
  let main: HTMLElement | null = null;
  const resize = new ResizeObserver(() => apply());
  const mutation = new MutationObserver(() => { observe(); apply(); });
  const events = ["keydown", "pointerdown", "touchstart", "wheel"] as const;
  const timer = window.setTimeout(stop, 3000);
  function stop() {
    window.clearTimeout(timer);
    resize.disconnect();
    mutation.disconnect();
    if (main) for (const event of events) main.removeEventListener(event, stop);
  }
  function observe() {
    resize.disconnect();
    if (main) for (const child of main.children) resize.observe(child);
  }
  function bind() {
    const marker = document.querySelector<HTMLElement>("[data-route-key]");
    if (marker?.dataset.routeKey !== key || !marker.dataset.routeReady) return;
    const next = document.getElementById("main");
    if (!next || next === main) return;
    main = next;
    mutation.disconnect();
    mutation.observe(main, { attributes: true, childList: true });
    for (const event of events) main.addEventListener(event, stop);
    observe();
  }
  function apply() {
    bind();
    if (!main) return;
    main.scrollTop = top;
    if (main.scrollTop === top) stop();
  }
  stopMainRestore = stop;
  mutation.observe(document.body, { attributes: true, attributeFilter: ["data-route-key", "data-route-ready"], childList: true, subtree: true });
  apply();
}

export function useMainScrollRestoration(router: ReturnType<typeof useRouter>) {
  useEffect(() => {
    const beforeLoad = router.subscribe("onBeforeLoad", ({ fromLocation }) => {
      const key = fromLocation?.state["__TSR_key"];
      const main = document.getElementById("main");
      if (key && main) mainPositions.set(key, main.scrollTop);
    });
    const rendered = router.subscribe("onRendered", ({ fromLocation, toLocation }) => {
      if (!fromLocation || fromLocation.pathname === toLocation.pathname) return;
      const key = toLocation.state["__TSR_key"];
      if (key) restoreMain(key, mainPositions.get(key) ?? 0);
    });
    return () => { beforeLoad(); rendered(); };
  }, [router]);
}
