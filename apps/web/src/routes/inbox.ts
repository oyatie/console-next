// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { inboxFilter, type InboxFilter } from "../features/home/domain/inbox-filter";

export const inboxRoute = createRoute({
  getParentRoute: () => app,
  path: "/inbox",
  staticData: { access: "signed-in" },
  validateSearch: (search: Record<string, unknown>): { tab?: InboxFilter } => ({ tab: inboxFilter(search.tab) === "turn" ? undefined : inboxFilter(search.tab) }),
  component: lazyRouteComponent(screen(() => import("./inbox-screen")), "InboxScreen"),
});
