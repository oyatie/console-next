// SPDX-License-Identifier: LicenseRef-Proprietary
import { createLazyRoute, lazyRouteComponent } from "@tanstack/react-router";
import { screen } from "../lib/fonts";

// Keep the personnel card's preload dependencies off the initial route bundle.
export const employee = createLazyRoute("/app/people/$id")({
  component: lazyRouteComponent(screen(() => import("../features/people/ui/card-page")), "EmployeeCard"),
});
