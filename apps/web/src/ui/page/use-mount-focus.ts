// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, useEffectEvent, useLayoutEffect, type RefObject } from "react";
import { PagePhase } from "./page-scope";

/** Focus each newly opened record once its page is interactive. A dismissible panel can also restore its opener. */
export function useMountFocus(open: string | boolean, target: () => HTMLElement | null, panel?: RefObject<HTMLElement | null>, returnFocus?: () => HTMLElement | null, scroll = false) {
  const { settled } = useContext(PagePhase);
  const focus = useEffectEvent(() => {
    const element = target();
    if (!element) return;
    const container = panel?.current;
    const origin = returnFocus?.() ?? document.activeElement;
    element.focus({ preventScroll: !scroll });
    if (container) return () => {
      if (origin instanceof HTMLElement && origin.isConnected && (container.contains(document.activeElement) || document.activeElement === document.body)) origin.focus();
    };
  });
  useLayoutEffect(() => {
    if (open && settled) return focus();
  }, [open, settled]);
}
