import { readRequirement } from "./route-reads";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
export const companyDomainRoute = createRoute({
  getParentRoute: () => app,
  path: "/settings/company-domain", staticData: { access: readRequirement("/settings/company-domain") },
  component: lazyRouteComponent(screen(() => import("../features/company-domain/ui/domain-page").then((m) => ({ default: m.CompanyDomainPage })))),
});
