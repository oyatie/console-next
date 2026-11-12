// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { inboxView, type InboxView } from "../features/home/domain/inbox-filter";

export const inboxRoute = createRoute({
  getParentRoute: () => app,
  path: "/inbox",
  staticData: { access: "signed-in", floorplan: "P-03" },
  validateSearch: (search: Record<string, unknown>): { tab?: InboxView; sel?: string } => ({ sel: typeof search.sel === "string" ? search.sel : undefined, tab: inboxView(search.tab) === "turn" ? undefined : inboxView(search.tab) }),
  component: lazyRouteComponent(screen(() => import("./inbox-screen")), "InboxScreen"),
});
