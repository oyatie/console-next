// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, useEffect, useState, type ComponentProps } from "react";
import { chunk } from "../../../lib/chunk-guard";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import type { RosterScreen } from "./roster-screen";

type ScreenProps = ComponentProps<typeof RosterScreen>;
function layout(load: () => Promise<typeof RosterScreen>) {
  let screen: typeof RosterScreen | undefined;
  const preload = () => chunk(load()).then(value => { screen = value; });
  const render = (props: ScreenProps) => screen && createElement(screen, props);
  return { preload, render, isLoaded: () => !!screen };
}

export const baselineRosterLayout = layout(() => import("./roster-screen").then(m => m.RosterScreen));
export const consoleRosterLayout = layout(() => import("./roster-console").then(m => m.RosterConsole));

/** A selected table begins loading after its authorized rows have subscribed. */
export function useRosterLayout(selected: typeof baselineRosterLayout, screenProps: ScreenProps) {
  const [result, setResult] = useState<{ layout: typeof selected; error?: unknown }>();
  useEffect(() => {
    if (selected.isLoaded()) return;
    let current = true;
    void selected.preload().then(
      () => { if (current) setResult({ layout: selected }); },
      error => { if (current) setResult({ layout: selected, error }); },
    );
    return () => { current = false; };
  }, [selected]);
  if (result?.layout === selected && "error" in result) throw result.error;
  return selected.render(screenProps) ?? createElement(ReadSkeleton, { layout: "list" });
}
