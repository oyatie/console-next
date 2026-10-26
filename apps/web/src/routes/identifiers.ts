import { readRequirement } from "./route-reads";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";

// Employee identifiers (IMPORT-2): one person's employee number and resident registration number, and the
// company's numbering rules and SETUP renumbering.
const personIdentifiers = createRoute({
  getParentRoute: () => app,
  path: "/people/$id/identifiers", staticData: { access: "signed-in" },
  component: lazyRouteComponent(screen(() => import("../features/identifiers/ui/identifiers-page")), "IdentifiersPage"),
});
const numbering = createRoute({
  getParentRoute: () => app,
  path: "/people/numbering", staticData: { access: readRequirement("/people/numbering") },
  component: lazyRouteComponent(screen(() => import("../features/identifiers/ui/numbering-page")), "NumberingPage"),
});

export const identifierRoutes = [numbering, personIdentifiers];
