// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent, type AnyRoute } from "@tanstack/react-router";
import { app, screen } from "./app";
import { overtimeReadAccess, servedRouteAccess } from "./route-reads";
import { settingsRequirement } from "../shell/settings-views";

export const settingsRoute = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  staticData: {
    // Read after the app's children are registered, so an unserved page cannot open the hub.
    get access() { return settingsRequirement((app.children as AnyRoute[] | undefined) ?? []); },
    floorplan: "P-05",
    pattern: "settings",
  },
  validateSearch: (search: Record<string, unknown>) => ({
    section: typeof search.section === "string" ? search.section : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/settings/ui/settings-hub")), "SettingsHub"),
});

export const overtimeSettingsRoute = createRoute({
  getParentRoute: () => app,
  path: "/settings/overtime",
  staticData: { access: overtimeReadAccess, floorplan: "P-05", pattern: "settings" },
  component: lazyRouteComponent(screen(() => import("../features/settings/ui/overtime-work-rule")), "OvertimeWorkRule"),
});

export const benefitsRoute = createRoute({
  getParentRoute: () => app,
  path: "/benefits",
  staticData: { access: servedRouteAccess["/benefits"], floorplan: "P-05", pattern: "settings" },
  component: lazyRouteComponent(screen(() => import("../features/benefits/ui/benefits-page")), "BenefitsPage"),
});
