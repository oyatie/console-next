// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, type ReactNode } from "react";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { useCan } from "../../../reference/authz/ui/use-can";
import { RosterExport } from "./roster-export";
import { useRosterScreen } from "./use-roster-screen";
import { baselineRosterLayout, consoleRosterLayout, useRosterLayout } from "./use-roster-layout";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";

type RosterPageProps = { manage: boolean; scoped?: boolean; switcher?: ReactNode; notice?: ReactNode; tabs?: ReactNode };

export function RosterPage(props: RosterPageProps) {
  return <ExperienceSwitch baseline={() => <SelectedRosterPage {...props} layout={baselineRosterLayout} />}>
    {() => <SelectedRosterPage {...props} layout={consoleRosterLayout} />}
  </ExperienceSwitch>;
}

function SelectedRosterPage({ layout, ...props }: RosterPageProps & { layout: typeof baselineRosterLayout }) {
  if (!performance.getEntriesByName("dir:permitted-screen").length) performance.mark("dir:permitted-screen");
  const screen = useRosterScreen(layout.isLoaded());
  const can = useCan();
  const content = useRosterLayout(layout, { ...props, screen, actions: can("excel_download") && <RosterExport query={screen.r.query} total={screen.r.total} /> });
  return <Suspense fallback={<ReadSkeleton layout="list" />}>{content}</Suspense>;
}
