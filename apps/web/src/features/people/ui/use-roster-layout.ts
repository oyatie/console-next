// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useActiveExperienceId } from "../../../experience/dom";
import { chunk } from "../../../lib/chunk-guard";
import type { RosterScreen } from "./roster-screen";

function layout(load: () => Promise<typeof RosterScreen>) {
  let screen: typeof RosterScreen | undefined;
  const preload = () => chunk(load()).then(value => { screen = value; });
  return { preload, get screen() { return screen; } };
}

export const baselineRosterLayout = layout(() => import("./roster-screen").then(m => m.RosterScreen));
const consoleRosterLayout = layout(() => import("./roster-console").then(m => m.RosterConsole));

/** Start the selected table's imports after the authorized roster has subscribed to its reads. */
export function useRosterLayout() {
  const selected = useActiveExperienceId() === "baseline" ? baselineRosterLayout : consoleRosterLayout;
  const [result, setResult] = useState<{ layout: typeof selected; error?: unknown }>();
  useEffect(() => {
    if (selected.screen) return;
    let current = true;
    void selected.preload().then(
      () => { if (current) setResult({ layout: selected }); },
      error => { if (current) setResult({ layout: selected, error }); },
    );
    return () => { current = false; };
  }, [selected]);
  if (result?.layout === selected && "error" in result) throw result.error;
  return selected.screen;
}
