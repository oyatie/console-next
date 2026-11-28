// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, type ReactNode } from "react";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { useCan } from "../../../reference/authz/ui/use-can";
import { RosterExport } from "./roster-export";
import { useRosterScreen } from "./use-roster-screen";
import { loadedRosterLayout, deferredRosterLayout } from "./use-roster-layout";

export function RosterPage(props: { manage: boolean; scoped?: boolean; switcher?: ReactNode; notice?: ReactNode; tabs?: ReactNode }) {
  const RosterScreen = loadedRosterLayout ?? deferredRosterLayout;
  const screen = useRosterScreen();
  const can = useCan();
  return (
    <Suspense fallback={<ReadSkeleton layout="list" />}>
      <RosterScreen {...props} screen={screen} actions={can("excel_download") && <RosterExport query={screen.r.query} total={screen.r.total} />} />
    </Suspense>
  );
}
