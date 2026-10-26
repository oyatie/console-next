// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useState, type RefObject } from "react";

/** CSS owns the threshold; React Aria needs the same container state to measure virtual rows. */
export function useCardLayout(region: RefObject<HTMLElement | null>, grid: RefObject<HTMLElement | null>) {
  const [cards, setCards] = useState(false);
  useLayoutEffect(() => {
    const container = region.current;
    if (!container) return;
    const measure = () => setCards(grid.current != null && getComputedStyle(grid.current).getPropertyValue("--table-cards").trim() === "1");
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [region, grid]);
  return cards;
}
