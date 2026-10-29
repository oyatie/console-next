// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";
import { readRequirement } from "./route-reads";
export const payrollRoutes = [
  createRoute({ getParentRoute: () => app, path: "/payroll", staticData: { access: readRequirement("/payroll") }, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/payroll-home")), "PayrollHome") }),
  createRoute({ getParentRoute: () => app, path: "/payroll/reference", staticData: { access: readRequirement("/payroll/reference") }, validateSearch: (s: Record<string, unknown>) => ({ entity: str(s.entity) }), component: lazyRouteComponent(screen(() => import("../features/payroll/ui/reference-page")), "PayrollReference") }),
];
