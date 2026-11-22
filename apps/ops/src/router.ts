// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { OpsAlertState, OpsHealth, OpsSeverity } from "./lib/api";
import { OpsRootLayout } from "./routes/root-layout";
import {
  AlertDetailRouteView,
  AlertsRouteView,
  JobsRouteView,
  NowRouteView,
  RunningRouteView,
  SilencesRouteView,
  SourcesRouteView,
} from "./routes/route-views";

const ALERT_STATES = new Set<OpsAlertState>(["Firing", "Acked", "Silenced", "Inhibited", "Resolved"]);
const SEVERITIES = new Set<OpsSeverity>(["Page", "Ticket"]);
const HEALTHS = new Set<OpsHealth>(["Healthy", "Progressing", "Suspended", "Degraded", "Missing", "Unknown"]);

const rootRoute = createRootRoute({
  component: OpsRootLayout,
});

const nowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: NowRouteView,
});

const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts",
  validateSearch: (raw: Record<string, unknown>) => ({
    state: typeof raw.state === "string" && ALERT_STATES.has(raw.state as OpsAlertState) ? (raw.state as OpsAlertState) : undefined,
    severity: typeof raw.severity === "string" && SEVERITIES.has(raw.severity as OpsSeverity) ? (raw.severity as OpsSeverity) : undefined,
    component: typeof raw.component === "string" && raw.component.trim() ? raw.component : undefined,
  }),
  component: AlertsRouteView,
});

const silencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts/silences",
  component: SilencesRouteView,
});

const alertDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts/$key",
  component: AlertDetailRouteView,
});

const runningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/running",
  validateSearch: (raw: Record<string, unknown>) => ({
    group: typeof raw.group === "string" && raw.group.trim() ? raw.group : undefined,
    state: typeof raw.state === "string" && HEALTHS.has(raw.state as OpsHealth) ? (raw.state as OpsHealth) : undefined,
  }),
  component: RunningRouteView,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/running/jobs",
  component: JobsRouteView,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesRouteView,
});

const routeTree = rootRoute.addChildren([
  nowRoute,
  alertsRoute,
  silencesRoute,
  alertDetailRoute,
  runningRoute,
  jobsRoute,
  sourcesRoute,
]);

export function createOpsRouter() {
  return createRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createOpsRouter>;
  }
}
