// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Block browser history movement while leaving programmatic save/navigation alone. */
export function useBackBlock(beforeUnload: boolean, shouldBlock: () => boolean) {
  const router = useRouter({ warn: false });
  useEffect(() => {
    if (!router) return;
    return router.history.block({
      blockerFn: ({ action }) => action !== "PUSH" && action !== "REPLACE" && shouldBlock(),
      enableBeforeUnload: beforeUnload,
    });
  }, [router, beforeUnload, shouldBlock]);
}
