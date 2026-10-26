import { readRequirement } from "./route-reads";
// Admin > Access (decision #26 pilot roles): roles, grants (one person or several), each account's access, and the
// go-live readiness list. The server decides every read and write; these routes only compose the screens.
import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { app, screen, str } from "./app";

const load = () => import("../features/access/ui/access-routes");
const home = createRoute({ getParentRoute: () => app, path: "/access", staticData: { access: readRequirement("/access") }, beforeLoad: () => { throw redirect({ to: "/access/roles" }); } });
const roles = createRoute({ getParentRoute: () => app, path: "/access/roles", staticData: { access: readRequirement("/access/roles") }, component: lazyRouteComponent(screen(load), "RolesScreen") });
// `copy`: start from an existing role (duplicate); the copy gets its own name and is saved as a new role.
const roleNew = createRoute({
  getParentRoute: () => app,
  path: "/access/roles/new", staticData: { access: readRequirement("/access/roles/new") },
  validateSearch: (s: Record<string, unknown>): { copy?: string } => ({ copy: str(s.copy) }),
  component: lazyRouteComponent(screen(load), "RoleNewScreen"),
});
const role = createRoute({ getParentRoute: () => app, path: "/access/roles/$roleId", staticData: { access: readRequirement("/access/roles/$roleId") }, component: lazyRouteComponent(screen(load), "RoleScreen") });
// `role`: the holders of one role (the roles list links its holder count here).
const grants = createRoute({
  getParentRoute: () => app,
  path: "/access/grants", staticData: { access: readRequirement("/access/grants") },
  validateSearch: (s: Record<string, unknown>): { role?: string } => ({ role: str(s.role) }),
  component: lazyRouteComponent(screen(load), "GrantsScreen"),
});
const bulk = createRoute({ getParentRoute: () => app, path: "/access/grants/bulk", staticData: { access: readRequirement("/access/grants/bulk") }, component: lazyRouteComponent(screen(load), "BulkScreen") });
// `grant`: open the grant sheet at once (the readiness list's grant button on a person with none).
const person = createRoute({
  getParentRoute: () => app,
  path: "/access/people/$accountId", staticData: { access: readRequirement("/access/people/$accountId") },
  validateSearch: (s: Record<string, unknown>): { grant?: boolean } => ({ grant: s.grant === true || undefined }),
  component: lazyRouteComponent(screen(load), "PersonScreen"),
});
const ready = createRoute({ getParentRoute: () => app, path: "/access/ready", staticData: { access: readRequirement("/access/ready") }, component: lazyRouteComponent(screen(load), "ReadyScreen") });

export const accessRoutes = [home, roles, roleNew, role, grants, bulk, person, ready];
