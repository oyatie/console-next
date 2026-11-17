// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef } from "react";
import { FOCUS_SETTLE_MS } from "./row-keys";

export function useSettledHover(onHover?: (id: string) => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    cancel,
    start: (id: string) => {
      cancel();
      // Scrolling rows under a resting pointer must not trigger audited detail reads.
      timer.current = setTimeout(() => onHover?.(id), FOCUS_SETTLE_MS);
    },
  };
}
