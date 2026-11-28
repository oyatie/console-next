// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, useEffect } from "react";
import { chunk } from "../../../lib/chunk-guard";
import type { RosterScreen } from "./roster-screen";

export let loadedRosterLayout: typeof RosterScreen | undefined;

// Keep an already loaded table synchronous when the permission decisions settle.
export const preloadRosterLayout = () => chunk(import("./roster-screen")).then(module => {
  loadedRosterLayout = module.RosterScreen;
  return { default: module.RosterScreen };
});
export const deferredRosterLayout = lazy(preloadRosterLayout);

export function usePreloadRosterLayout(enabled: boolean) {
  useEffect(() => {
    if (enabled) void preloadRosterLayout().catch(() => undefined);
  }, [enabled]);
}
