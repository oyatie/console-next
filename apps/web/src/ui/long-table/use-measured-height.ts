// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useState } from "react";

/** Use the mounted CSS box before paint and follow later density or theme changes. */
export function useMeasuredHeight() {
  const [height, setHeight] = useState(0);
  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setHeight(element.getBoundingClientRect().height);
    const resize = new ResizeObserver(([entry]) => setHeight(entry?.borderBoxSize[0]?.blockSize ?? 0));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  return [height, measure] as const;
}
