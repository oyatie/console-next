// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { TeamSearch, TeamStatusFilter, TeamView } from "../features/team/domain/team-scope";
import { app, screen, str } from "./app";
import { readRequirement } from "./route-reads";

const VIEWS: readonly TeamView[] = ["all", "direct", "concurrent"];
const STATUSES: readonly TeamStatusFilter[] = ["all", "ACTIVE", "ON_LEAVE", "SOON", "MISSING"];

const teamRoute = createRoute({
  getParentRoute: () => app,
  path: "/team",
  staticData: { access: readRequirement("/team"), floorplan: "P-01", pattern: "list-record" },
  validateSearch: (s: Record<string, unknown>): TeamSearch => ({
    view: VIEWS.find(v => v === s.view),
    scopeId: str(s.scopeId),
    status: STATUSES.find(v => v === s.status),
    q: str(s.q),
    sort: str(s.sort),
    sel: str(s.sel),
  }),
  component: lazyRouteComponent(screen(() => import("../features/team/ui/team-page")), "TeamPage"),
});

export const teamRoutes = [teamRoute];
