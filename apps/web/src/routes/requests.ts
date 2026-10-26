import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
const lookup = createRoute({ getParentRoute: () => app, path: "/requests", staticData: { access: "signed-in" }, component: lazyRouteComponent(screen(() => import("../features/requests/ui/request-page")), "RequestLookup") });
const outcome = createRoute({ getParentRoute: () => app, path: "/requests/$id", staticData: { access: "signed-in" }, component: lazyRouteComponent(screen(() => import("../features/requests/ui/request-page")), "RequestPage") });
export const requestRoutes = [lookup, outcome];
