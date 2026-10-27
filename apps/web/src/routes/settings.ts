// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent, type AnyRoute } from "@tanstack/react-router";
import { app, screen } from "./app";
import { settingsRequirement } from "../shell/settings-views";

export const settingsRoute = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  staticData: {
    // Read after the app's children are registered, so an unserved page cannot open the hub.
    get access() { return settingsRequirement((app.children as AnyRoute[] | undefined) ?? []); },
  },
  component: lazyRouteComponent(screen(() => import("../features/settings/ui/settings-hub")), "SettingsHub"),
});
