// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { servedRouteReads } from "./route-reads";

const register = createRoute({
  getParentRoute: () => app, path: "/consulting",
  staticData: { access: servedRouteReads["/consulting"].access, floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/consulting/ui/register")), "ConsultingRegister"),
});
const detail = createRoute({
  getParentRoute: () => app, path: "/consulting/engagements/$engagementId",
  staticData: { access: servedRouteReads["/consulting/engagements/$engagementId"].access, floorplan: "P-02", pattern: "record" },
  component: lazyRouteComponent(screen(() => import("../features/consulting/ui/engagement")), "ConsultingEngagement"),
});
export const consultingRoutes = [register, detail] as const;
