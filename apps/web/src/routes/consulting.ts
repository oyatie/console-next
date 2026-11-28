// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { servedRouteAccess } from "./route-reads";

const register = createRoute({
  getParentRoute: () => app, path: "/consulting",
  staticData: { access: servedRouteAccess["/consulting"], floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/consulting/ui/register")), "ConsultingRegister"),
});
const detail = createRoute({
  getParentRoute: () => app, path: "/consulting/engagements/$engagementId",
  staticData: { access: servedRouteAccess["/consulting/engagements/$engagementId"], floorplan: "P-02", pattern: "record" },
  component: lazyRouteComponent(screen(() => import("../features/consulting/ui/engagement")), "ConsultingEngagement"),
});
export const consultingRoutes = [register, detail] as const;
