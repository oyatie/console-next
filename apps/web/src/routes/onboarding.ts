import { readRequirement } from "./route-reads";
import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { app, screen } from "./app";

const goLive = createRoute({ getParentRoute: () => app, path: "/setup/go-live", staticData: { access: readRequirement("/setup/go-live") }, component: lazyRouteComponent(screen(() => import("../features/onboarding/ui/go-live")), "GoLive") });

// The setup org list became the company structure chart (one editor, decisions #18): old links land there.
const orgSetup = createRoute({ getParentRoute: () => app, path: "/setup/org", staticData: { access: readRequirement("/setup/org") }, beforeLoad: () => { throw redirect({ to: "/org", search: {} }); } });
// Legal names are owned by the entity record; retained bookmarks resolve there.
const companyNames = createRoute({ getParentRoute: () => app, path: "/setup/company-names", staticData: { access: readRequirement("/setup/company-names") }, beforeLoad: ({ location }) => { throw redirect({ to: "/org", search: { tab: "entities" }, hash: location.hash, replace: true }); } });

export const onboardingRoutes = [goLive, orgSetup, companyNames];
