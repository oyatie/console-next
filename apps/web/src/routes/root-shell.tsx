// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, type ReactNode } from "react";
import { CatchBoundary, useLocation, useMatches, useRouterState } from "@tanstack/react-router";
import { CrashScreen } from "../lib/react/crash-screen";
import { RouteFrame } from "../lib/react/route-ready";
import { ReadSkeleton } from "../ui/skeleton/skeleton";
import { useActiveExperienceId } from "../experience/dom";
import { ExperienceShell } from "../experience/pack";

/** Keep application chrome outside the router's pending screen boundary. */
export function RootShell({ children }: { children: ReactNode }): ReactNode {
  const experienceId = useActiveExperienceId();
  const inApp = useMatches({ select: matches => matches.some(match => match.routeId === "/app") });
  const href = useLocation({ select: location => location.href });
  const loading = useRouterState({ select: state => state.isLoading });
  const pending = useMatches({ select: matches => matches.some(match => match.status === "pending") }) && loading;
  return <RouteFrame>{inApp ? <CatchBoundary getResetKey={() => href} errorComponent={CrashScreen}>
    <Suspense fallback={<ReadSkeleton />}><ExperienceShell experienceId={experienceId} pending={pending}>{children}</ExperienceShell></Suspense>
  </CatchBoundary> : children}</RouteFrame>;
}
