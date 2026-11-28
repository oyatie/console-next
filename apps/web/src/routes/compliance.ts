// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { servedRouteAccess } from "./route-reads";

const catalog = createRoute({
  getParentRoute: () => app, path: "/compliance",
  staticData: { access: servedRouteAccess["/compliance"], floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/catalog")), "ComplianceCatalog"),
});
const create = createRoute({
  getParentRoute: () => app, path: "/compliance/new",
  staticData: { access: servedRouteAccess["/compliance/new"], floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/catalog-form")), "ComplianceCatalogForm"),
});
export const complianceRoutes = [catalog, create] as const;
