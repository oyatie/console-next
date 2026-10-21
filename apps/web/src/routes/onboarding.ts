import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { app, screen } from "./app";

const goLive = createRoute({ getParentRoute: () => app, path: "/setup/go-live", component: lazyRouteComponent(screen(() => import("../features/onboarding/ui/go-live")), "GoLive") });

// The setup org list became the company structure chart (one editor, decisions #18): old links land there.
const orgSetup = createRoute({ getParentRoute: () => app, path: "/setup/org", beforeLoad: () => { throw redirect({ to: "/org", search: {} }); } });
const companyNames = createRoute({ getParentRoute: () => app, path: "/setup/company-names", component: lazyRouteComponent(screen(() => import("../features/onboarding/ui/company-names")), "CompanyNames") });

export const onboardingRoutes = [goLive, orgSetup, companyNames];
