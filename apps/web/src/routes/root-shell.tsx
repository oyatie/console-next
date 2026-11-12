// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { CatchBoundary, getRouteApi, useLocation, useMatches } from "@tanstack/react-router";
import { screen } from "../lib/fonts";
import { CrashScreen } from "../lib/react/crash-screen";
import { RouteFrame } from "../lib/react/route-ready";
import { ReadSkeleton } from "../ui/skeleton/skeleton";

const app = getRouteApi("/app");
const Shell = lazy(() => screen(() => import("../shell/shell"))().then(module => ({ default: module.Shell })));

/** Keep application chrome outside the router's pending screen boundary. */
export function RootShell({ children }: { children: ReactNode }): ReactNode {
  const inApp = useMatches({ select: matches => matches.some(match => match.routeId === app.id) });
  const href = useLocation({ select: location => location.href });
  const pending = useMatches({ select: matches => matches.some(match => match.status === "pending") });
  return <RouteFrame>{inApp ? <CatchBoundary getResetKey={() => href} errorComponent={CrashScreen}>
    <Suspense fallback={<ReadSkeleton />}><Shell pending={pending}>{children}</Shell></Suspense>
  </CatchBoundary> : children}</RouteFrame>;
}
