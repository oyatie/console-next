// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, type RefObject } from "react";

export type WindowSlice = {
  start: number;
  end: number;
  topHeight: number;
  bottomHeight: number;
};

export function useWindowedRows(
  total: number,
  rowHeight: number,
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): WindowSlice {
  const active = enabled && total > 40;
  const [range, setRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: Math.min(total, 36),
  });

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    const recompute = () => {
      const scrollTop = el ? el.scrollTop : 0;
      const height = el && el.clientHeight > 0 ? el.clientHeight : 720;
      const overscan = 10;
      const visible = Math.ceil(height / rowHeight);
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const end = Math.min(total, start + visible + overscan * 2);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    recompute();
    if (!el) return;
    el.addEventListener("scroll", recompute, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", recompute);
      ro?.disconnect();
    };
  }, [active, total, rowHeight, containerRef]);

  if (!active) {
    return { start: 0, end: total, topHeight: 0, bottomHeight: 0 };
  }
  const start = Math.min(range.start, total);
  const end = Math.min(range.end, total);
  return {
    start,
    end,
    topHeight: start * rowHeight,
    bottomHeight: Math.max(0, (total - end) * rowHeight),
  };
}
