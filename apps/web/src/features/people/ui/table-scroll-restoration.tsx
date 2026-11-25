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
