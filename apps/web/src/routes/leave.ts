// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";

export const leaveRoute = createRoute({
  getParentRoute: () => app,
  path: "/leave",
  staticData: { access: "signed-in", floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(() => import("../features/leave/ui/leave-request-page")), "LeaveRequestPage"),
});
