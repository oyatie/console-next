import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";

export const statutoryRoute = createRoute({
  getParentRoute: () => app,
  path: "/statutory",
  validateSearch: (s: Record<string, unknown>): { tab?: "register"; site?: string; date?: string; event?: string; filing?: string } => ({
    tab: s.tab === "register" ? "register" : undefined, site: str(s.site), date: str(s.date), event: str(s.event), filing: str(s.filing),
  }),
  component: lazyRouteComponent(screen(() => import("../features/statutory/ui/statutory-page")), "StatutoryPage"),
});
