// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Block browser history movement ONLY while `guarded` is true; otherwise let Back/Forward pass through
 * untouched and run `afterPop` once the destination rendered if `shouldCloseOnPop` held when the pop began.
 */
export function useBackBlock(
  guarded: boolean,
  beforeUnload: boolean,
  onBlock: () => boolean,
  shouldCloseOnPop: () => boolean,
  afterPop: () => void,
) {
  const router = useRouter({ warn: false });
  const onBlockRef = useRef(onBlock);
  const shouldCloseRef = useRef(shouldCloseOnPop);
  const afterPopRef = useRef(afterPop);
  useLayoutEffect(() => {
    onBlockRef.current = onBlock;
    shouldCloseRef.current = shouldCloseOnPop;
    afterPopRef.current = afterPop;
  }, [onBlock, shouldCloseOnPop, afterPop]);

  useLayoutEffect(() => {
    if (!router || !guarded) return;
    return router.history.block({
      blockerFn: ({ action }) => action !== "PUSH" && action !== "REPLACE" && onBlockRef.current(),
      enableBeforeUnload: beforeUnload,
    });
  }, [router, guarded, beforeUnload]);

  useEffect(() => {
    if (!router) return;
    const keyOf = (location: typeof router.history.location) => `${location.state["__TSR_key"] ?? ""}:${location.href}`;
    let locationKey = keyOf(router.history.location);
    let closeAfter = false;
    const unsubscribeHistory = router.history.subscribe(({ location, action }) => {
      const nextKey = keyOf(location);
      const moved = nextKey !== locationKey;
      locationKey = nextKey;
      if (moved && action.type !== "PUSH" && action.type !== "REPLACE") closeAfter = shouldCloseRef.current();
    });
    const unsubscribeRendered = router.subscribe("onRendered", () => {
      if (!closeAfter) return;
      closeAfter = false;
      afterPopRef.current();
    });
    return () => {
      closeAfter = false;
      unsubscribeHistory();
      unsubscribeRendered();
    };
  }, [router]);
}
