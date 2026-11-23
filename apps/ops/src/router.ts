// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type {
  OpsAlertState,
  OpsHealth,
  OpsObligationKind,
  OpsObligationState,
  OpsSeverity,
} from "./lib/api";
import { OpsRootLayout } from "./routes/root-layout";
import {
  ActionsRouteView,
  AlertAckRouteView,
  AlertDetailRouteView,
  AlertsRouteView,
  ChangesRouteView,
  HealthRouteView,
  IncidentDetailRouteView,
  IncidentsRouteView,
  JobsRouteView,
  NowRouteView,
  ObligationDetailRouteView,
  ObligationsRouteView,
  OncallRouteView,
  PromoteRouteView,
  RecoveryRouteView,
  RunbooksRouteView,
  RunningRouteView,
  SilenceDeepLinkRouteView,
  SilencesRouteView,
  SourcesRouteView,
} from "./routes/route-views";

const ALERT_STATES = new Set<OpsAlertState>(["Firing", "Acked", "Silenced", "Inhibited", "Resolved"]);
const SEVERITIES = new Set<OpsSeverity>(["Page", "Ticket"]);
const HEALTHS = new Set<OpsHealth>(["Healthy", "Progressing", "Suspended", "Degraded", "Missing", "Unknown"]);
const OBLIGATION_KINDS = new Set<OpsObligationKind>([
  "professional-review",
  "credential-rotation",
  "escrow",
  "drill",
  "launch-gate",
  "owner-decision",
  "regulatory-watch",
]);
const OBLIGATION_STATES = new Set<OpsObligationState>(["open", "in-review", "done", "waived"]);

const rootRoute = createRootRoute({ component: OpsRootLayout });
const nowRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: NowRouteView });
const healthRoute = createRoute({ getParentRoute: () => rootRoute, path: "/health", component: HealthRouteView });

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

const silencesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/alerts/silences", component: SilencesRouteView });
const silenceDeepLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts/silence",
  validateSearch: (raw: Record<string, unknown>) => {
    const m = raw.matcher;
    const matchers = Array.isArray(m)
      ? m.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : typeof m === "string" && m.trim().length > 0
        ? [m]
        : [];
    return { matcher: matchers };
  },
  component: SilenceDeepLinkRouteView,
});
const alertDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/alerts/$key", component: AlertDetailRouteView });
const alertAckRoute = createRoute({ getParentRoute: () => rootRoute, path: "/alerts/$key/ack", component: AlertAckRouteView });
const oncallRoute = createRoute({ getParentRoute: () => rootRoute, path: "/oncall", component: OncallRouteView });

const incidentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/incidents", component: IncidentsRouteView });
const incidentDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/incidents/$id", component: IncidentDetailRouteView });

const runningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/running",
  validateSearch: (raw: Record<string, unknown>) => ({
    group: typeof raw.group === "string" && raw.group.trim() ? raw.group : undefined,
    state: typeof raw.state === "string" && HEALTHS.has(raw.state as OpsHealth) ? (raw.state as OpsHealth) : undefined,
  }),
  component: RunningRouteView,
});
const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/running/jobs", component: JobsRouteView });
const changesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/changes", component: ChangesRouteView });
const promoteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/promote", component: PromoteRouteView });
const actionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/actions", component: ActionsRouteView });
const runbooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runbooks",
  validateSearch: (raw: Record<string, unknown>): { doc?: string; anchor?: string } => ({
    doc: typeof raw.doc === "string" && raw.doc.trim() ? raw.doc : undefined,
    anchor: typeof raw.anchor === "string" && raw.anchor.trim() ? raw.anchor : undefined,
  }),
  component: RunbooksRouteView,
});

const obligationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/obligations",
  validateSearch: (raw: Record<string, unknown>): { kind?: OpsObligationKind; state?: OpsObligationState } => ({
    kind: typeof raw.kind === "string" && OBLIGATION_KINDS.has(raw.kind as OpsObligationKind) ? (raw.kind as OpsObligationKind) : undefined,
    state: typeof raw.state === "string" && OBLIGATION_STATES.has(raw.state as OpsObligationState) ? (raw.state as OpsObligationState) : undefined,
  }),
  component: ObligationsRouteView,
});
const obligationDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/obligations/$id", component: ObligationDetailRouteView });
const recoveryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/recovery", component: RecoveryRouteView });
const sourcesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sources", component: SourcesRouteView });

const routeTree = rootRoute.addChildren([
  nowRoute,
  healthRoute,
  alertsRoute,
  silencesRoute,
  silenceDeepLinkRoute,
  alertDetailRoute,
  alertAckRoute,
  oncallRoute,
  incidentsRoute,
  incidentDetailRoute,
  runningRoute,
  jobsRoute,
  changesRoute,
  promoteRoute,
  actionsRoute,
  runbooksRoute,
  obligationsRoute,
  obligationDetailRoute,
  recoveryRoute,
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
