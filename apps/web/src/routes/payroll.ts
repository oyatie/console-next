// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";
import { readRequirement } from "./route-reads";
export const payrollRoutes = [
  createRoute({ getParentRoute: () => app, path: "/payroll/employees/$employeeId", staticData: { access: readRequirement("/payroll/employees/$employeeId"), floorplan: "P-02", module: "payroll" }, validateSearch: (s: Record<string, unknown>) => ({ period: str(s.period), pay_date: str(s.pay_date) }), remountDeps: ({ params }) => params.employeeId, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/employee-pay-page")), "EmployeePayPage") }),
  createRoute({ getParentRoute: () => app, path: "/payroll", staticData: { access: readRequirement("/payroll"), floorplan: "P-01" }, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/payroll-home")), "PayrollHome") }),
  createRoute({ getParentRoute: () => app, path: "/payroll/runs/new", staticData: { access: readRequirement("/payroll/runs/new"), floorplan: "P-04" }, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/run-create-page")), "PayrollRunCreatePage") }),
  createRoute({ getParentRoute: () => app, path: "/payroll/runs/$id", staticData: { access: readRequirement("/payroll/runs/$id"), floorplan: "P-02" }, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/run-page")), "PayrollRunPage") }),
  createRoute({ getParentRoute: () => app, path: "/payroll/setup", staticData: { access: readRequirement("/payroll/setup"), floorplan: "P-05" }, component: lazyRouteComponent(screen(() => import("../features/payroll/ui/payroll-setup")), "PayrollSetup") }),
  createRoute({ getParentRoute: () => app, path: "/payroll/reference", staticData: { access: readRequirement("/payroll/reference"), floorplan: "P-01" }, validateSearch: (s: Record<string, unknown>) => ({ entity: str(s.entity) }), component: lazyRouteComponent(screen(() => import("../features/payroll/ui/reference-page")), "PayrollReference") }),
];
