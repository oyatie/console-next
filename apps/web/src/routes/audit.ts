// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";
import { readRequirement, servedRouteReads } from "./route-reads";

const audit = createRoute({
  getParentRoute: () => app,
  path: "/audit",
  staticData: { access: readRequirement("/audit"), floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/audit/ui/audit-page")), "AuditPage"),
});

const accessLog = createRoute({
  getParentRoute: () => app,
  path: "/audit/access-log",
  staticData: { access: readRequirement("/audit/access-log"), floorplan: "P-01" },
  validateSearch: (s: Record<string, unknown>): { period?: string; view?: "all"; search?: string; actor?: string; action?: string; target_type?: string; from?: string; to?: string } => ({
    period: str(s.period),
    view: s.view === "all" ? "all" : undefined,
    search: str(s.search),
    actor: str(s.actor),
    action: str(s.action),
    target_type: str(s.target_type),
    from: str(s.from),
    to: str(s.to),
  }),
  component: lazyRouteComponent(screen(() => import("../features/access-log/ui/access-log-page")), "AccessLogPage"),
});

const supportAccess = createRoute({
  getParentRoute: () => app,
  path: "/audit/support-access",
  staticData: { access: "signed-in", floorplan: "P-01" },
  validateSearch: (s: Record<string, unknown>): { review?: string } => ({ review: str(s.review) }),
  component: lazyRouteComponent(screen(() => import("../features/support-access/ui/support-access")), "SupportAccess"),
});

const evidence = createRoute({
  getParentRoute: () => app,
  path: "/audit/evidence",
  staticData: { access: servedRouteReads["/audit/evidence"].access, floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/audit/ui/evidence-vault")), "EvidenceVault"),
});

export const auditRoutes = [audit, accessLog, supportAccess, evidence];
