// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, type ReactNode } from "react";
import { lazyRouteComponent } from "@tanstack/react-router";
import { chunk } from "../../../lib/chunk-guard";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { useCan } from "../../../reference/authz/ui/use-can";
import { RosterExport } from "./roster-export";
import { useRosterScreen } from "./use-roster-screen";

export const RosterScreen = lazyRouteComponent(() => chunk(import("./roster-screen")), "RosterScreen");

export function RosterPage(props: { manage: boolean; scoped?: boolean; switcher?: ReactNode; notice?: ReactNode; tabs?: ReactNode }) {
  const screen = useRosterScreen();
  const can = useCan();
  return (
    <Suspense fallback={<ReadSkeleton layout="list" />}>
      <RosterScreen {...props} screen={screen} actions={can("excel_download") && <RosterExport query={screen.r.query} total={screen.r.total} />} />
    </Suspense>
  );
}
