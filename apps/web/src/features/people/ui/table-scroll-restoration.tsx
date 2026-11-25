// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type RefObject } from "react";
import { useElementScrollRestoration, useLocation, useRouter } from "@tanstack/react-router";

/**
 * Puts a virtual table's own scroll back on Back: the router restores it before the rows that give it height have
 * rendered, so it is applied again once per history entry, a frame after the route has rendered.
 */
export function TableScrollRestoration({ id, grid }: { id: string; grid: RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const key = useLocation({ select: location => location.state["__TSR_key"] });
  const entry = useElementScrollRestoration({ id });
  const applied = useRef<string | undefined>(undefined);
  const [, setRendered] = useState(0);
  useEffect(() => router.subscribe("onRendered", () => setRendered(value => value + 1)), [router]);
  useEffect(() => {
    if (!key || !entry || applied.current === key) return;
    const frame = requestAnimationFrame(() => {
      if (!grid.current) return;
      applied.current = key;
      grid.current.scrollTop = entry.scrollY;
    });
    return () => cancelAnimationFrame(frame);
  }, [entry, grid, key]);
  return null;
}

/**
 * Runs `apply` once a virtual grid has drawn a row. The grid measures itself before it draws any, and a scroll position
 * set before then is lost to the top. Returns a function that stops waiting.
 */
export function whenRowsDrawn(grid: HTMLElement, apply: () => void): () => void {
  const drawn = () => grid.querySelector("[data-row-id]") !== null;
  if (drawn()) {
    apply();
    return () => {};
  }
  const rows = new MutationObserver(() => {
    if (!drawn()) return;
    rows.disconnect();
    apply();
  });
  rows.observe(grid, { childList: true, subtree: true });
  return () => rows.disconnect();
}
