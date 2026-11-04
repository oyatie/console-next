// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";

export const gridViewport = (grid: HTMLDivElement) => {
  let scroller: HTMLElement | null = grid.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const padding = getComputedStyle(scroller ?? document.documentElement);
  const top = (scroller ? Math.max(0, scroller.getBoundingClientRect().top + scroller.clientTop) : 0) + (parseFloat(padding.scrollPaddingTop) || 0);
  const bottom = (scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight) : window.innerHeight) - (parseFloat(padding.scrollPaddingBottom) || 0);
  const rowsTop = grid.getBoundingClientRect().top + grid.clientTop + (grid.firstElementChild?.firstElementChild?.getBoundingClientRect().height ?? 0);
  return { scroller: scroller ?? window, top, bottom: bottom - (grid.querySelector<HTMLElement>(':scope > [role="status"]')?.offsetHeight ?? 0), rowsTop };
};

export function useGridWindow(
  gridRef: RefObject<HTMLDivElement | null>, count: number, minimum: number, overscan: number, activeRow: number | null,
  onViewport: (top: number, bottom: number) => void,
) {
  const [rowHeight, setRowHeight] = useState(1), [scrollTop, setScrollTop] = useState(0);
  const [viewportRows, setViewportRows] = useState(minimum);
  const windowSize = viewportRows + overscan;
  const first = Math.max(0, Math.min(count - windowSize, Math.floor(scrollTop / rowHeight) - Math.floor(overscan / 2)));
  const last = Math.min(count, first + windowSize);

  const onScroll = useEffectEvent((minimumRows: number, rowCount: number, resized = false) => {
    const grid = gridRef.current;
    if (!grid) return;
    const height = parseFloat(getComputedStyle(grid).getPropertyValue("--row-h"));
    const { scroller, top, bottom, rowsTop } = gridViewport(grid);
    if (resized && activeRow !== null && grid.contains(document.activeElement) && document.activeElement !== grid) {
      const cellTop = rowsTop + activeRow * height;
      const delta = cellTop < top ? cellTop - top : Math.max(0, cellTop + height - bottom);
      if (delta) scroller.scrollBy({ top: delta, behavior: "instant" });
    }
    const next = gridViewport(grid);
    onViewport(next.top, next.bottom);
    setRowHeight(height);
    setScrollTop(Math.max(0, Math.min(rowCount * height, next.top - next.rowsTop)));
    setViewportRows(Math.max(minimumRows, Math.ceil((next.bottom - next.top) / height) + 1));
  });
  useLayoutEffect(() => {
    const update = () => onScroll(minimum, count);
    const onResize = () => onScroll(minimum, count, true);
    update();
    const observer = new ResizeObserver(onResize);
    observer.observe(gridRef.current!.firstElementChild!.firstElementChild!);
    observer.observe(gridRef.current!.parentElement!);
    // Scroll does not bubble; capture also observes the document and any scrollable ancestor.
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", onResize);
    };
  }, [gridRef, minimum, count]);

  return { first, last, rowHeight, viewportRows, setScrollTop };
}
