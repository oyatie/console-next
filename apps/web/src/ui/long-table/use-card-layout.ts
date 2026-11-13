// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useState, type RefObject } from "react";

/** Use cards below the CSS threshold or when the declared columns cannot fit beside other content. */
export function useCardLayout(region: RefObject<HTMLElement | null>, grid: RefObject<HTMLElement | null>, minimumWidth = 0) {
  const [cards, setCards] = useState(false);
  useLayoutEffect(() => {
    const container = region.current;
    if (!container) return;
    const measure = () => setCards(grid.current != null && (container.clientWidth < minimumWidth || getComputedStyle(grid.current).getPropertyValue("--table-cards").trim() === "1"));
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [region, grid, minimumWidth]);
  return cards;
}
